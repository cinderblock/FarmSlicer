use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
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
}

pub struct ProfileStore {
    profiles_dir: PathBuf,
    machines: Vec<ProfileEntry>,
    processes: Vec<ProfileEntry>,
    filaments: Vec<ProfileEntry>,
    by_name: HashMap<String, PathBuf>,
}

impl ProfileStore {
    pub fn load(profiles_dir: &Path) -> Self {
        let mut machines = Vec::new();
        let mut processes = Vec::new();
        let mut filaments = Vec::new();
        let mut by_name: HashMap<String, PathBuf> = HashMap::new();

        let Ok(vendors) = std::fs::read_dir(profiles_dir) else {
            return Self {
                profiles_dir: profiles_dir.to_path_buf(),
                machines,
                processes,
                filaments,
                by_name,
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
                    if let Some(pe) = load_profile_entry(&path, &vendor, subdir) {
                        by_name.insert(pe.name.clone(), path);
                        target.push(pe);
                    }
                }
            }
        }

        machines.sort_by(|a, b| a.name.cmp(&b.name));
        processes.sort_by(|a, b| a.name.cmp(&b.name));
        filaments.sort_by(|a, b| a.name.cmp(&b.name));

        println!(
            "Profiles loaded: {} machines, {} processes, {} filaments",
            machines.len(),
            processes.len(),
            filaments.len()
        );

        Self {
            profiles_dir: profiles_dir.to_path_buf(),
            machines,
            processes,
            filaments,
            by_name,
        }
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

        Ok(serde_json::to_string(&Value::Object(merged)).unwrap())
    }

    fn resolve_inheritance(&self, name: &str) -> Result<Map<String, Value>, String> {
        let mut chain = Vec::new();
        let mut current = name.to_string();
        let mut seen = std::collections::HashSet::new();

        loop {
            if !seen.insert(current.clone()) {
                return Err(format!("circular inheritance at '{current}'"));
            }

            let path = self
                .by_name
                .get(&current)
                .ok_or_else(|| format!("profile '{current}' not found"))?;

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

    Some(ProfileEntry {
        name,
        profile_type: profile_type.to_string(),
        vendor: vendor.to_string(),
        path: path.to_path_buf(),
        instantiable,
        description,
        compatible_printers,
    })
}
