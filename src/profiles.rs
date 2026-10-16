use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// OrcaSlicer's shared filament library: generic and brand filaments for
/// printers of every vendor.
const FILAMENT_LIBRARY: &str = "OrcaFilamentLibrary";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub profile_type: String,
    pub vendor: String,
    #[serde(skip)]
    pub path: PathBuf,
    #[serde(skip)]
    pub instantiable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatible_printers: Option<Vec<String>>,
    /// For machine profiles: the base model name (e.g., "Bambu Lab A1")
    #[serde(skip)]
    pub printer_model: Option<String>,
    /// For machine profiles: the nozzle variant (e.g., "0.4")
    #[serde(skip)]
    pub printer_variant: Option<String>,
}

/// A base printer model with its available nozzle sizes.
#[derive(Debug, Clone, Serialize)]
pub struct MachineModel {
    pub name: String,
    pub vendor: String,
    pub vendor_display: String,
    pub nozzle_diameters: Vec<String>,
    /// Nozzle size → the instantiable machine profile for it (what slicing
    /// takes), e.g. "0.4" → "Bambu Lab A1 0.4 nozzle". Sizes a model's
    /// `machine_model` JSON lists without a matching profile are absent.
    pub variants: BTreeMap<String, String>,
    /// The vendor's id for the model, which sliced files and printers report
    /// (Bambu: "BL-P001" = X1 Carbon, "C12" = P1S, "N1" = A1 mini, ...).
    pub model_id: Option<String>,
}

pub struct ProfileStore {
    profiles_dir: PathBuf,
    machines: Vec<ProfileEntry>,
    processes: Vec<ProfileEntry>,
    filaments: Vec<ProfileEntry>,
    /// name → every (vendor, path) that defines it. Base profiles such as
    /// `fdm_process_common` exist in ~60 vendor directories with different
    /// contents, so inheritance must be resolved within the chain's vendor.
    by_name: HashMap<String, Vec<(String, PathBuf)>>,
    machine_models: Vec<MachineModel>,
    /// What each filament is, once resolved (`filament_info`).
    filament_info: Mutex<HashMap<String, FilamentInfo>>,
}

/// What a filament profile is, from its resolved settings: the Slice page
/// picks support materials and prices with it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FilamentInfo {
    /// `filament_type` ("PLA", "PETG", "PLA-CF", ...).
    pub material: String,
    /// A support material (`filament_is_support`).
    pub support: bool,
    /// Dissolves in water (`filament_soluble`: PVA, BVOH).
    pub soluble: bool,
    /// The material printers name it by: `material`, or "PLA-S"/"PA-S"/...
    /// for support materials, as libslic3r's `get_filament_type` and the
    /// AMS report them (and `filament_prices` lists them).
    pub tray_material: String,
}

impl ProfileStore {
    pub fn load(profiles_dir: &Path) -> Self {
        let mut machines = Vec::new();
        let mut processes = Vec::new();
        let mut filaments = Vec::new();
        let mut by_name: HashMap<String, Vec<(String, PathBuf)>> = HashMap::new();
        // Collect machine_model entries: model_name → (vendor, nozzle_diameters)
        let mut model_nozzles: HashMap<String, (String, Vec<String>)> = HashMap::new();
        // Model name → vendor model id (Bambu: "BL-P001", "C12", "N1", ...).
        let mut model_ids: HashMap<String, String> = HashMap::new();

        let Ok(vendors) = std::fs::read_dir(profiles_dir) else {
            return Self {
                profiles_dir: profiles_dir.to_path_buf(),
                machines,
                processes,
                filaments,
                by_name,
                machine_models: Vec::new(),
                filament_info: Mutex::new(HashMap::new()),
            };
        };

        for vendor_entry in vendors.flatten() {
            if !vendor_entry.path().is_dir() {
                continue;
            }
            let vendor = vendor_entry.file_name().to_string_lossy().to_string();

            for (subdir, target) in [
                ("machine", &mut machines as &mut Vec<ProfileEntry>),
                ("process", &mut processes),
                ("filament", &mut filaments),
            ] {
                // Vendors file presets in subdirectories too (Elegoo's
                // machine/ECC/, BBL's filament/Polymaker/, ...).
                for path in json_files(&vendor_entry.path().join(subdir)) {
                    // Check for machine_model entries (base models with nozzle lists)
                    if subdir == "machine" {
                        if let Some((name, nozzles, model_id)) = load_machine_model_nozzles(&path) {
                            if let Some(id) = model_id {
                                model_ids.insert(name.clone(), id);
                            }
                            model_nozzles.insert(name, (vendor.clone(), nozzles));
                        }
                    }

                    if let Some(pe) = load_profile_entry(&path, &vendor, subdir) {
                        by_name
                            .entry(pe.name.clone())
                            .or_default()
                            .push((vendor.clone(), path));
                        target.push(pe);
                    }
                }
            }
        }

        // Build machine_models: merge nozzle sizes from machine_model entries and
        // instantiable machine variants into a single list per base model.
        let mut model_variants: HashMap<String, BTreeMap<String, String>> = HashMap::new();
        for m in &machines {
            if !m.instantiable {
                continue;
            }
            if let (Some(model_name), Some(variant)) = (&m.printer_model, &m.printer_variant) {
                let entry = model_nozzles
                    .entry(model_name.clone())
                    .or_insert_with(|| (m.vendor.clone(), Vec::new()));
                if !entry.1.contains(variant) {
                    entry.1.push(variant.clone());
                }
                model_variants
                    .entry(model_name.clone())
                    .or_default()
                    .insert(variant.clone(), m.name.clone());
            }
        }

        // Compute vendor display names from the common prefix of model names.
        // E.g., BBL models all start with "Bambu Lab" → vendor_display = "Bambu Lab".
        let mut vendor_model_names: HashMap<String, Vec<String>> = HashMap::new();
        for (model_name, (vendor, _)) in &model_nozzles {
            vendor_model_names
                .entry(vendor.clone())
                .or_default()
                .push(model_name.clone());
        }
        let vendor_display_names: HashMap<String, String> = vendor_model_names
            .into_iter()
            .map(|(vendor, names)| {
                let display = common_prefix(&names);
                let display = if display.is_empty() {
                    vendor.clone()
                } else {
                    display
                };
                (vendor, display)
            })
            .collect();

        let mut machine_models: Vec<MachineModel> = model_nozzles
            .into_iter()
            .map(|(name, (vendor, mut nozzles))| {
                // Sort nozzle sizes numerically
                nozzles.sort_by(|a, b| {
                    a.parse::<f32>()
                        .unwrap_or(0.0)
                        .partial_cmp(&b.parse::<f32>().unwrap_or(0.0))
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                let vendor_display = vendor_display_names
                    .get(&vendor)
                    .cloned()
                    .unwrap_or_else(|| vendor.clone());
                MachineModel {
                    variants: model_variants.remove(&name).unwrap_or_default(),
                    model_id: model_ids.remove(&name),
                    name,
                    vendor,
                    vendor_display,
                    nozzle_diameters: nozzles,
                }
            })
            .collect();
        machine_models.sort_by(|a, b| a.name.cmp(&b.name));

        machines.sort_by(|a, b| a.name.cmp(&b.name));
        processes.sort_by(|a, b| a.name.cmp(&b.name));
        filaments.sort_by(|a, b| a.name.cmp(&b.name));

        println!(
            "Profiles loaded: {} machines ({} models), {} processes, {} filaments",
            machines.len(),
            machine_models.len(),
            processes.len(),
            filaments.len()
        );

        Self {
            profiles_dir: profiles_dir.to_path_buf(),
            machines,
            processes,
            filaments,
            by_name,
            machine_models,
            filament_info: Mutex::new(HashMap::new()),
        }
    }

    /// What a filament is (resolved once per name, then remembered).
    pub fn filament_info(&self, name: &str) -> Option<FilamentInfo> {
        if let Some(info) = self.filament_info.lock().unwrap().get(name) {
            return Some(info.clone());
        }
        let config = self.resolve_inheritance(name).ok()?;
        let first = |key: &str| -> String {
            match config.get(key) {
                Some(Value::Array(a)) => a.first().and_then(Value::as_str).unwrap_or("").to_string(),
                Some(Value::String(s)) => s.clone(),
                _ => String::new(),
            }
        };
        let material = first("filament_type");
        let support = first("filament_is_support") == "1";
        let soluble = first("filament_soluble") == "1";
        // libslic3r's get_filament_type: Bambu's support materials print as
        // "<type>-S" (PLA-S, PA-S, ABS-S); soluble ones keep their type.
        let tray_material = if support && !soluble && matches!(material.as_str(), "PLA" | "PA" | "ABS" | "PETG") {
            format!("{material}-S")
        } else {
            material.clone()
        };
        let info = FilamentInfo { material, support, soluble, tray_material };
        self.filament_info.lock().unwrap().insert(name.to_string(), info.clone());
        Some(info)
    }

    pub fn machine_models(&self) -> &[MachineModel] {
        &self.machine_models
    }

    pub fn machine_model(&self, name: &str) -> Option<&MachineModel> {
        self.machine_models.iter().find(|m| m.name == name)
    }

    /// The model a vendor model id belongs to (several vendors could reuse an
    /// id; the first match wins, so prefer checking the vendor too).
    pub fn machine_model_by_id(&self, model_id: &str) -> Option<&MachineModel> {
        self.machine_models
            .iter()
            .find(|m| m.model_id.as_deref() == Some(model_id))
    }

    pub fn machines(&self) -> &[ProfileEntry] {
        &self.machines
    }

    pub fn processes(&self) -> &[ProfileEntry] {
        &self.processes
    }

    pub fn filaments(&self) -> &[ProfileEntry] {
        &self.filaments
    }

    pub fn instantiable_machines(&self) -> Vec<&ProfileEntry> {
        self.machines.iter().filter(|m| m.instantiable).collect()
    }

    /// Resolve a base model name + nozzle variant into the full instantiable profile name.
    /// E.g., ("Bambu Lab A1", "0.4") → "Bambu Lab A1 0.4 nozzle"
    pub fn resolve_machine_variant(&self, model: &str, nozzle: &str) -> Option<String> {
        self.machines
            .iter()
            .find(|m| {
                m.instantiable
                    && m.printer_model.as_deref() == Some(model)
                    && m.printer_variant.as_deref() == Some(nozzle)
            })
            .map(|m| m.name.clone())
    }

    fn vendor_for_machine(&self, machine_name: &str) -> Option<&str> {
        self.machines
            .iter()
            .find(|m| m.name == machine_name)
            .map(|m| m.vendor.as_str())
    }

    pub fn processes_for_machine(&self, machine_name: &str) -> Vec<&ProfileEntry> {
        let vendor = self.vendor_for_machine(machine_name);
        self.processes
            .iter()
            .filter(|p| {
                if !p.instantiable {
                    return false;
                }
                match &p.compatible_printers {
                    Some(cp) if !cp.is_empty() => cp.contains(&machine_name.to_string()),
                    _ => vendor.is_some_and(|v| p.vendor == v),
                }
            })
            .collect()
    }

    /// Filaments for a machine, as OrcaSlicer offers them: the ones that
    /// name it, its vendor's general ones, and the shared library's, except
    /// library filaments the vendor has its own version of for this machine
    /// (same alias: "Generic PLA @System" gives way to "Generic PLA @BBL X1C").
    pub fn filaments_for_machine(&self, machine_name: &str) -> Vec<&ProfileEntry> {
        let vendor = self.vendor_for_machine(machine_name);
        let names_machine =
            |f: &ProfileEntry| f.compatible_printers.as_ref().is_some_and(|cp| cp.iter().any(|c| c == machine_name));
        let own_aliases: HashSet<&str> = self
            .filaments
            .iter()
            .filter(|f| f.vendor != FILAMENT_LIBRARY && names_machine(f))
            .map(|f| alias(&f.name))
            .collect();
        self.filaments
            .iter()
            .filter(|f| {
                if !f.instantiable {
                    return false;
                }
                match &f.compatible_printers {
                    Some(cp) if !cp.is_empty() => names_machine(f),
                    _ if f.vendor == FILAMENT_LIBRARY => vendor.is_some() && !own_aliases.contains(alias(&f.name)),
                    _ => vendor.is_some_and(|v| f.vendor == v),
                }
            })
            .collect()
    }

    /// One merged config for a machine, a process and the plate's filaments
    /// (in order: filament 1, 2, ...), like OrcaSlicer's
    /// `PresetBundle::full_fff_config` with `apply_extruder` off (libslic3r
    /// applies the extruders itself when slicing): machine, then process,
    /// then the filaments. A filament key that's a list gets every
    /// filament's entries one after the other; `filament_self_index` says
    /// which filament each entry belongs to (several per filament on
    /// printers with nozzle variants, like the H2D). A filament key that's a
    /// single value comes from the first filament.
    pub fn resolve_config(&self, machine: &str, process: &str, filaments: &[&str]) -> Result<String, String> {
        if filaments.is_empty() {
            return Err("no filament".into());
        }
        let mut merged = Map::new();

        let machine_config = self
            .resolve_inheritance(machine)
            .map_err(|e| format!("machine profile: {e}"))?;
        merge_into(&mut merged, &machine_config);

        let process_config = self
            .resolve_inheritance(process)
            .map_err(|e| format!("process profile: {e}"))?;
        merge_into(&mut merged, &process_config);

        let mut filament_configs = Vec::new();
        for f in filaments {
            let mut config = self
                .resolve_inheritance(f)
                .map_err(|e| format!("filament profile: {e}"))?;
            for key in PRESET_METADATA {
                config.remove(*key);
            }
            filament_configs.push(config);
        }
        merge_filaments(&mut merged, &filament_configs);
        for key in PRESET_METADATA {
            merged.remove(*key);
        }

        // What the desktop app records about the chosen presets: the Bambu
        // filament ids end up in slice_info's tray_info_idx (printers use
        // them to match AMS trays), the preset names in the G-code header.
        let ids: Vec<Value> = filament_configs
            .iter()
            .map(|c| c.get("filament_id").and_then(Value::as_str).unwrap_or("").into())
            .collect();
        if ids.iter().any(|id| id.as_str().is_some_and(|s| !s.is_empty())) {
            merged.insert("filament_ids".into(), Value::Array(ids));
        }
        let empty = |v: Option<&Value>| match v {
            None | Some(Value::Null) => true,
            Some(Value::String(s)) => s.is_empty(),
            Some(Value::Array(a)) => a.iter().all(|x| x.as_str().is_some_and(str::is_empty)),
            _ => false,
        };
        if empty(merged.get("printer_settings_id")) {
            merged.insert("printer_settings_id".into(), json!(machine));
        }
        if empty(merged.get("print_settings_id")) {
            merged.insert("print_settings_id".into(), json!(process));
        }
        merged.insert("filament_settings_id".into(), json!(filaments));

        Ok(serde_json::to_string(&Value::Object(merged)).unwrap())
    }

    pub fn resolve_single(&self, name: &str) -> Result<String, String> {
        let config = self.resolve_inheritance(name)?;
        Ok(serde_json::to_string(&Value::Object(config)).unwrap())
    }

    fn resolve_inheritance(&self, name: &str) -> Result<Map<String, Value>, String> {
        let mut chain = Vec::new();
        let mut current = name.to_string();
        let mut seen = std::collections::HashSet::new();
        // Vendor of the profile the chain started from; parents are looked up
        // in that vendor's directory first.
        let mut vendor: Option<String> = None;

        loop {
            if !seen.insert(current.clone()) {
                return Err(format!("circular inheritance at '{current}'"));
            }

            let candidates = self
                .by_name
                .get(&current)
                .ok_or_else(|| format!("profile '{current}' not found"))?;
            let (found_vendor, path) = vendor
                .as_deref()
                .and_then(|v| candidates.iter().find(|(cv, _)| cv == v))
                .or_else(|| candidates.first())
                .ok_or_else(|| format!("profile '{current}' not found"))?;
            if vendor.is_none() {
                vendor = Some(found_vendor.clone());
            }

            let content = std::fs::read_to_string(path)
                .map_err(|e| format!("reading '{}': {e}", path.display()))?;
            let obj: Map<String, Value> = serde_json::from_str(&content)
                .map_err(|e| format!("parsing '{}': {e}", path.display()))?;

            let parent = obj
                .get("inherits")
                .and_then(|v| v.as_str())
                .map(String::from);

            chain.push(obj);

            match parent {
                Some(p) if !p.is_empty() => current = p,
                _ => break,
            }
        }

        let mut result = Map::new();
        for obj in chain.into_iter().rev() {
            merge_into(&mut result, &obj);
        }
        Ok(result)
    }
}

/// Keys that describe a preset rather than configure the slicer.
const PRESET_METADATA: &[&str] = &[
    "type",
    "name",
    "inherits",
    "from",
    "instantiation",
    "setting_id",
    "compatible_printers",
    "compatible_printers_condition",
    "compatible_prints",
    "compatible_prints_condition",
];

/// Filament keys with an entry per nozzle variant (libslic3r's
/// `filament_options_with_variant`, PrintConfig.cpp). OrcaSlicer resizes
/// them to the filament's variant count when it loads a preset
/// (`Preset::normalize`); profiles often give one value for all variants.
const FILAMENT_VARIANT_KEYS: &[&str] = &[
    "filament_flow_ratio",
    "filament_max_volumetric_speed",
    "filament_extruder_variant",
    "filament_retraction_length",
    "filament_z_hop",
    "filament_z_hop_types",
    "filament_retract_lift_above",
    "filament_retract_lift_below",
    "filament_retract_lift_enforce",
    "filament_retract_restart_extra",
    "filament_retraction_speed",
    "filament_deretraction_speed",
    "filament_retraction_minimum_travel",
    "filament_retract_when_changing_layer",
    "filament_wipe",
    "filament_wipe_distance",
    "filament_retract_before_wipe",
    "filament_long_retractions_when_cut",
    "filament_retraction_distances_when_cut",
    "long_retractions_when_ec",
    "retraction_distances_when_ec",
    "nozzle_temperature_initial_layer",
    "nozzle_temperature",
    "filament_flush_volumetric_speed",
    "filament_flush_temp",
    "filament_cooling_before_tower",
    "volumetric_speed_coefficients",
    "filament_adaptive_volumetric_speed",
    "filament_ironing_flow",
    "filament_ironing_spacing",
    "filament_ironing_inset",
    "filament_ironing_speed",
    "activate_air_filtration",
    "activate_air_filtration_during_print",
    "activate_air_filtration_on_completion",
    "during_print_exhaust_fan_speed",
    "complete_print_exhaust_fan_speed",
];

/// libslic3r's defaults for filament keys whose value says what the
/// filament *is*: a filament profile that doesn't set them must not borrow
/// another filament's (a support material's "1").
const FILAMENT_FLAG_DEFAULTS: &[(&str, &str)] = &[("filament_is_support", "0"), ("filament_soluble", "0")];

/// Put the plate's filaments on top of `merged` (see
/// `ProfileStore::resolve_config`). Every key any filament sets counts as a
/// filament key. Per-variant keys (FILAMENT_VARIANT_KEYS) get exactly one
/// entry per nozzle variant of each filament, like OrcaSlicer's preset
/// loading makes them (the first value repeated, or cut short): libslic3r
/// finds a filament's entries by counting, so one short list would hand the
/// next filament's values to the wrong one. A filament that lacks a list key
/// another one sets gets libslic3r's default for flags
/// (FILAMENT_FLAG_DEFAULTS), else that one's first entry (what libslic3r
/// reads from a short list anyway), as many times as it needs.
fn merge_filaments(merged: &mut Map<String, Value>, filaments: &[Map<String, Value>]) {
    // How many entries each filament has per list key: one per nozzle
    // variant it has settings for (two on the H2D), else one.
    let variants: Vec<usize> = filaments
        .iter()
        .map(|f| match f.get("filament_extruder_variant") {
            Some(Value::Array(a)) if !a.is_empty() => a.len(),
            _ => 1,
        })
        .collect();
    let mut keys: Vec<&String> = filaments.iter().flat_map(|f| f.keys()).collect();
    keys.sort();
    keys.dedup();
    for key in keys {
        let source = filaments.iter().find_map(|f| f.get(key)).expect("a filament sets it");
        let value = match source {
            Value::Array(entries) => {
                let per_variant = FILAMENT_VARIANT_KEYS.contains(&key.as_str());
                let fill = FILAMENT_FLAG_DEFAULTS
                    .iter()
                    .find(|(k, _)| k == key)
                    .map(|(_, v)| json!(v))
                    .or_else(|| entries.first().cloned())
                    .unwrap_or(Value::Null);
                let mut all = Vec::new();
                for (f, n) in filaments.iter().zip(&variants) {
                    let own: Vec<Value> = match f.get(key) {
                        Some(Value::Array(a)) if !a.is_empty() => a.clone(),
                        Some(Value::Array(_)) | None => vec![fill.clone(); if per_variant { 1 } else { entries.len() }],
                        Some(other) => vec![other.clone()],
                    };
                    if per_variant {
                        let first = own[0].clone();
                        all.extend(own.into_iter().chain(std::iter::repeat(first)).take(*n));
                    } else {
                        all.extend(own);
                    }
                }
                Value::Array(all)
            }
            _ => filaments.iter().find_map(|f| f.get(key)).cloned().unwrap_or(Value::Null),
        };
        merged.insert(key.clone(), value);
    }
    let self_index: Vec<Value> = variants
        .iter()
        .enumerate()
        .flat_map(|(i, n)| std::iter::repeat_n(json!((i + 1).to_string()), *n))
        .collect();
    merged.insert("filament_self_index".into(), Value::Array(self_index));
    // A colour per filament (OrcaSlicer keeps them in the project, not the
    // presets): libslic3r sizes its filament grouping by this list and
    // works out purge volumes from it. The profile's own colour when it has
    // one, white for support materials, else grey.
    if filaments.len() > 1 && !filaments.iter().any(|f| f.contains_key("filament_colour")) {
        let colours: Vec<Value> = filaments
            .iter()
            .map(|f| {
                let own = match f.get("default_filament_colour") {
                    Some(Value::Array(a)) => a.first().and_then(Value::as_str).unwrap_or(""),
                    Some(Value::String(s)) => s.as_str(),
                    _ => "",
                };
                let support = matches!(f.get("filament_is_support"), Some(Value::Array(a)) if a.first().and_then(Value::as_str) == Some("1"));
                json!(if own.starts_with('#') {
                    own
                } else if support {
                    "#FFFFFF"
                } else {
                    "#808080"
                })
            })
            .collect();
        merged.insert("filament_colour".into(), Value::Array(colours));
    }
    // Which nozzle each filament prints from: libslic3r chooses on printers
    // with several ("Auto For Flush", its default); the list just has to be
    // as long as the filament list.
    merged.insert("filament_map".into(), Value::Array(vec![json!("1"); filaments.len()]));
}

fn merge_into(base: &mut Map<String, Value>, overlay: &Map<String, Value>) {
    for (key, value) in overlay {
        base.insert(key.clone(), value.clone());
    }
}

/// Extract nozzle diameters from a machine_model JSON file.
/// Returns (model_name, nozzle_diameters) if the file is a machine_model type.
/// A `machine_model` file: (name, nozzle sizes, vendor model id).
fn load_machine_model_nozzles(path: &Path) -> Option<(String, Vec<String>, Option<String>)> {
    let content = std::fs::read_to_string(path).ok()?;
    let obj: Map<String, Value> = serde_json::from_str(&content).ok()?;

    let profile_type = obj.get("type")?.as_str()?;
    if profile_type != "machine_model" {
        return None;
    }

    let name = obj.get("name")?.as_str()?.to_string();

    // nozzle_diameter is a semicolon-separated string in machine_model entries
    let nozzles = obj
        .get("nozzle_diameter")
        .and_then(|v| v.as_str())
        .map(|s| s.split(';').map(|n| n.trim().to_string()).collect())
        .unwrap_or_default();

    let model_id = obj
        .get("model_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);

    Some((name, nozzles, model_id))
}

fn load_profile_entry(path: &Path, vendor: &str, profile_type: &str) -> Option<ProfileEntry> {
    let content = std::fs::read_to_string(path).ok()?;
    let obj: Map<String, Value> = serde_json::from_str(&content).ok()?;

    let name = obj.get("name")?.as_str()?.to_string();

    let instantiable = obj
        .get("instantiation")
        .and_then(|v| v.as_str())
        .map(|v| v == "true")
        .unwrap_or(false);

    let description = obj
        .get("description")
        .and_then(|v| v.as_str())
        .map(String::from);

    let compatible_printers = obj.get("compatible_printers").and_then(|v| {
        v.as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
    });

    let printer_model = obj
        .get("printer_model")
        .and_then(|v| v.as_str())
        .map(String::from);

    let printer_variant = obj
        .get("printer_variant")
        .and_then(|v| v.as_str())
        .map(String::from);

    Some(ProfileEntry {
        name,
        profile_type: profile_type.to_string(),
        vendor: vendor.to_string(),
        path: path.to_path_buf(),
        instantiable,
        description,
        compatible_printers,
        printer_model,
        printer_variant,
    })
}

/// A preset's name without its " @..." qualifier, as OrcaSlicer matches
/// presets across vendors ("Generic PLA @System" → "Generic PLA").
fn alias(name: &str) -> &str {
    name.split(" @").next().unwrap_or(name).trim()
}

/// Every `.json` file under `dir`, at any depth, in a stable order.
fn json_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(d) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some("json") {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// Find the longest common prefix of a set of strings, trimmed of trailing whitespace.
/// Used to derive vendor display names from model names (e.g., "Bambu Lab" from
/// ["Bambu Lab A1", "Bambu Lab X1 Carbon", ...]).
fn common_prefix(strings: &[String]) -> String {
    if strings.is_empty() {
        return String::new();
    }
    let first = strings[0].as_bytes();
    let mut len = first.len();
    for s in &strings[1..] {
        let s = s.as_bytes();
        len = len.min(s.len());
        for i in 0..len {
            if first[i] != s[i] {
                len = i;
                break;
            }
        }
    }
    strings[0][..len].trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, json: Value) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, json.to_string()).unwrap();
    }

    #[test]
    fn several_filaments() {
        let root = std::env::temp_dir().join(format!("farmslicer-profiles-{}", uuid::Uuid::new_v4()));
        write(&root, "Acme/machine/Acme H2 0.4 nozzle.json", json!({
            "type": "machine", "name": "Acme H2 0.4 nozzle", "instantiation": "true",
            "nozzle_diameter": ["0.4", "0.4"], "printer_settings_id": "Acme H2 0.4 nozzle"
        }));
        write(&root, "Acme/process/0.20mm @Acme H2.json", json!({
            "type": "process", "name": "0.20mm @Acme H2", "instantiation": "true", "layer_height": "0.2"
        }));
        // Two variants each (like the H2D's Standard / High Flow nozzles).
        write(&root, "Acme/filament/Acme PLA @Acme H2.json", json!({
            "type": "filament", "name": "Acme PLA @Acme H2", "instantiation": "true", "filament_id": "A01",
            "filament_type": ["PLA"], "nozzle_temperature": ["220", "225"],
            "filament_extruder_variant": ["Direct Drive Standard", "Direct Drive High Flow"],
            "filament_vendor": ["Acme"], "filament_start_gcode": ["; PLA"],
            "filament_max_volumetric_speed": ["21", "25"], "filament_ironing_flow": ["10%"]
        }));
        write(&root, "Acme/filament/Acme Support @Acme H2.json", json!({
            "type": "filament", "name": "Acme Support @Acme H2", "instantiation": "true", "filament_id": "S01",
            "filament_type": ["PLA"], "filament_is_support": ["1"], "nozzle_temperature": ["210", "215"],
            "filament_extruder_variant": ["Direct Drive Standard", "Direct Drive High Flow"],
            "filament_start_gcode": ["; support"]
        }));
        let store = ProfileStore::load(&root);
        let one: Value = serde_json::from_str(
            &store.resolve_config("Acme H2 0.4 nozzle", "0.20mm @Acme H2", &["Acme PLA @Acme H2"]).unwrap(),
        )
        .unwrap();
        assert_eq!(one["nozzle_temperature"], json!(["220", "225"]));
        assert_eq!(one["filament_self_index"], json!(["1", "1"]));
        assert_eq!(one["filament_ids"], json!(["A01"]));
        assert_eq!(one["filament_settings_id"], json!(["Acme PLA @Acme H2"]));
        assert_eq!(one["filament_map"], json!(["1"]));
        assert!(one.get("name").is_none() && one.get("type").is_none());

        let two: Value = serde_json::from_str(
            &store
                .resolve_config("Acme H2 0.4 nozzle", "0.20mm @Acme H2", &["Acme PLA @Acme H2", "Acme Support @Acme H2"])
                .unwrap(),
        )
        .unwrap();
        assert_eq!(two["nozzle_temperature"], json!(["220", "225", "210", "215"]));
        assert_eq!(two["filament_type"], json!(["PLA", "PLA"]));
        assert_eq!(two["filament_self_index"], json!(["1", "1", "2", "2"]));
        // The PLA sets no filament_is_support: libslic3r's default, not the
        // support's "1". Nor does the support set a vendor: the PLA's.
        assert_eq!(two["filament_is_support"], json!(["0", "1"]));
        assert_eq!(two["filament_vendor"], json!(["Acme", "Acme"]));
        assert_eq!(two["filament_start_gcode"], json!(["; PLA", "; support"]));
        // A per-variant key the support lacks: one entry per variant.
        assert_eq!(two["filament_max_volumetric_speed"], json!(["21", "25", "21", "21"]));
        // One value for two variants: repeated, like OrcaSlicer loads it.
        assert_eq!(two["filament_ironing_flow"], json!(["10%", "10%", "10%", "10%"]));
        assert_eq!(one["filament_ironing_flow"], json!(["10%", "10%"]));
        assert_eq!(two["filament_ids"], json!(["A01", "S01"]));
        assert_eq!(two["filament_map"], json!(["1", "1"]));
        assert_eq!(two["layer_height"], json!("0.2"));
        // A colour each: libslic3r counts the filaments by them.
        assert_eq!(two["filament_colour"], json!(["#808080", "#FFFFFF"]));
        assert!(one.get("filament_colour").is_none());
        assert!(store.resolve_config("Acme H2 0.4 nozzle", "0.20mm @Acme H2", &[]).is_err());
    }

    #[test]
    fn nested_presets_and_the_filament_library() {
        let root = std::env::temp_dir().join(format!("farmslicer-profiles-{}", uuid::Uuid::new_v4()));
        let machine = |name: &str| json!({"type": "machine", "name": name, "instantiation": "true"});
        let filament = |name: &str, cp: Vec<&str>| {
            json!({"type": "filament", "name": name, "instantiation": "true", "compatible_printers": cp})
        };
        write(&root, "Acme/machine/A1/Acme A1 0.4 nozzle.json", machine("Acme A1 0.4 nozzle"));
        write(&root, "Acme/filament/Brand/Generic PLA @Acme A1.json", filament("Generic PLA @Acme A1", vec!["Acme A1 0.4 nozzle"]));
        write(&root, "Bolt/machine/Bolt 0.4 nozzle.json", machine("Bolt 0.4 nozzle"));
        write(&root, "OrcaFilamentLibrary/filament/Generic PLA @System.json", filament("Generic PLA @System", vec![]));
        write(&root, "OrcaFilamentLibrary/filament/Base/Generic PETG @System.json", filament("Generic PETG @System", vec![]));
        let store = ProfileStore::load(&root);
        let names = |m: &str| {
            let mut v: Vec<String> = store.filaments_for_machine(m).iter().map(|f| f.name.clone()).collect();
            v.sort();
            v
        };
        assert_eq!(names("Acme A1 0.4 nozzle"), vec!["Generic PETG @System", "Generic PLA @Acme A1"]);
        assert_eq!(names("Bolt 0.4 nozzle"), vec!["Generic PETG @System", "Generic PLA @System"]);
        assert!(names("No such printer").is_empty());
        std::fs::remove_dir_all(&root).ok();
    }
}
