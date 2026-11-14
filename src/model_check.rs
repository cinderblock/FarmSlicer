//! Model files uploaded for slicing. A 3MF may carry settings per object and
//! per part (`Metadata/model_settings.config`, PrusaSlicer's
//! `Metadata/Slic3r_PE_model.config`) that libslic3r applies on top of the
//! job's config, so they get the same policy as the job's overrides
//! (`config_policy`): members only the Slice page's settings, nobody the
//! host-side ones. The package's structure is checked first (zipcheck).
//! Painting and per-part filaments are checked by the slicer itself
//! (`check_filaments` in cxx/slice_core.cpp).

use quick_xml::events::Event;
use serde_json::{Map, Value};
use std::io::Read;
use std::path::Path;

/// Keys in the settings files that describe the part rather than set a
/// profile option (names, matrices, where it came from, its type), and the
/// filament (checked by the slicer against the job's filaments).
const STRUCTURAL: &[&str] = &[
    "name",
    "matrix",
    "source_file",
    "source_object_id",
    "source_volume_id",
    "source_offset_x",
    "source_offset_y",
    "source_offset_z",
    "source_in_inches",
    "source_in_meters",
    "mesh_shared",
    "module",
    "volume_type",
    "part_type",
    "modifier",
    "extruder",
];

const SETTINGS_FILES: &[&str] = &["Metadata/model_settings.config", "Metadata/Slic3r_PE_model.config"];

/// The most a settings file may hold (they are a few kB in practice).
const MAX_SETTINGS_BYTES: u64 = 16 * 1024 * 1024;

/// Every profile setting the package's objects and parts set, by key (the
/// last value seen per key; the policy only looks at keys and ranges).
pub fn settings(path: &Path) -> Result<Map<String, Value>, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("can't read the model: {e}"))?;
    crate::package::zipcheck::verify(&mut file)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("can't read the 3MF package: {e}"))?;
    let mut out = Map::new();
    for name in SETTINGS_FILES {
        let Ok(entry) = zip.by_name(name) else { continue };
        if entry.size() > MAX_SETTINGS_BYTES {
            return Err(format!("the 3MF's {name} is too large"));
        }
        let mut xml = String::new();
        entry
            .take(MAX_SETTINGS_BYTES)
            .read_to_string(&mut xml)
            .map_err(|e| format!("can't read the 3MF's {name}: {e}"))?;
        collect(&xml, &mut out).map_err(|e| format!("the 3MF's {name} is damaged: {e}"))?;
    }
    Ok(out)
}

fn collect(xml: &str, out: &mut Map<String, Value>) -> Result<(), String> {
    let mut reader = quick_xml::Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) if e.name().as_ref() == "metadata" => {
                let mut key = None;
                let mut value = String::new();
                for a in e.attributes().flatten() {
                    let v = quick_xml::escape::unescape(&a.value).map_err(|e| e.to_string())?.into_owned();
                    match a.key.as_ref() {
                        "key" => key = Some(v),
                        "value" => value = v,
                        _ => {}
                    }
                }
                if let Some(k) = key.filter(|k| !STRUCTURAL.contains(&k.as_str())) {
                    out.insert(k, Value::String(value));
                }
            }
            Ok(Event::Eof) => return Ok(()),
            Err(e) => return Err(e.to_string()),
            _ => {}
        }
    }
}

/// Whether an uploaded model may be sliced as it is: a 3MF's own settings
/// must pass the overrides policy (`admin`: may set beyond the Slice page's
/// settings). Other formats carry no settings.
pub fn check(path: &Path, file_name: &str, admin: bool) -> Result<(), String> {
    if !file_name.to_ascii_lowercase().ends_with(".3mf") {
        return Ok(());
    }
    let found = settings(path).map_err(|e| format!("{file_name}: {e}"))?;
    crate::config_policy::check(&found, admin).map_err(|e| format!("{file_name}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_object_and_part_settings() {
        let xml = r#"<?xml version="1.0"?><config>
            <object id="3"><metadata key="name" value="Widget"/><metadata key="extruder" value="2"/>
              <metadata key="wall_loops" value="4"/>
              <part id="1" subtype="modifier_part"><metadata key="name" value="box"/>
                <metadata key="sparse_infill_density" value="50%"/><mesh_stat edges_fixed="0"/></part>
            </object></config>"#;
        let mut out = Map::new();
        collect(xml, &mut out).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out["wall_loops"], "4");
        assert_eq!(out["sparse_infill_density"], "50%");
    }

    #[test]
    fn prusa_settings_and_escapes() {
        let xml = r#"<config><object id="1"><metadata type="object" key="machine_start_gcode" value="G28&#10;M104"/>
            <volume firstid="0" lastid="11"><metadata type="volume" key="extruder" value="1"/></volume></object></config>"#;
        let mut out = Map::new();
        collect(xml, &mut out).unwrap();
        assert_eq!(out["machine_start_gcode"], "G28\nM104");
        // Members can't, admins can (the G-code check still reads the slice).
        assert!(crate::config_policy::check(&out, false).is_err());
        assert!(crate::config_policy::check(&out, true).is_ok());
    }

    #[test]
    fn host_keys_refused_for_everyone() {
        let mut out = Map::new();
        collect(r#"<config><object id="1"><metadata key="post_process" value="rm -rf /"/></object></config>"#, &mut out)
            .unwrap();
        assert!(crate::config_policy::check(&out, true).is_err());
    }
}
