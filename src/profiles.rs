use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

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
                let dir = vendor_entry.path().join(subdir);
                if !dir.is_dir() {
                    continue;
                }
                let Ok(entries) = std::fs::read_dir(&dir) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("json") {
                        continue;
                    }

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
        }
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

    pub fn filaments_for_machine(&self, machine_name: &str) -> Vec<&ProfileEntry> {
        let vendor = self.vendor_for_machine(machine_name);
        self.filaments
            .iter()
            .filter(|f| {
                if !f.instantiable {
                    return false;
                }
                match &f.compatible_printers {
                    Some(cp) if !cp.is_empty() => cp.contains(&machine_name.to_string()),
                    _ => vendor.is_some_and(|v| f.vendor == v),
                }
            })
            .collect()
    }

    pub fn resolve_config(
        &self,
        machine: &str,
        process: &str,
        filament: &str,
    ) -> Result<String, String> {
        let mut merged = Map::new();

        let machine_config = self
            .resolve_inheritance(machine)
            .map_err(|e| format!("machine profile: {e}"))?;
        merge_into(&mut merged, &machine_config);

        let process_config = self
            .resolve_inheritance(process)
            .map_err(|e| format!("process profile: {e}"))?;
        merge_into(&mut merged, &process_config);

        let filament_config = self
            .resolve_inheritance(filament)
            .map_err(|e| format!("filament profile: {e}"))?;
        merge_into(&mut merged, &filament_config);

        merged.remove("type");
        merged.remove("name");
        merged.remove("inherits");
        merged.remove("from");
        merged.remove("instantiation");
        merged.remove("setting_id");
        merged.remove("compatible_printers");
        merged.remove("compatible_printers_condition");
        merged.remove("compatible_prints");
        merged.remove("compatible_prints_condition");

        // What the desktop app records about the chosen presets: the Bambu
        // filament id ends up in slice_info's tray_info_idx (printers use it
        // to match AMS trays), the preset names in the G-code header.
        if let Some(id) = merged.get("filament_id").and_then(Value::as_str).map(String::from) {
            merged.entry("filament_ids").or_insert_with(|| json!([id]));
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
        if empty(merged.get("filament_settings_id")) {
            merged.insert("filament_settings_id".into(), json!([filament]));
        }

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
