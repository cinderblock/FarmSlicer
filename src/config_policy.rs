//! What per-job overrides and custom profiles may change.
//!
//! Members may only set the settings the Slice page offers
//! (`web/src/data/settings-schema.json`), with values inside its ranges:
//! anything else could carry G-code (`machine_start_gcode`,
//! `change_filament_gcode`, `filament_start_gcode`, ...) or run on the host
//! (`post_process`). Admins may set any key except the host-side ones. The
//! G-code checker (src/gcode/) still verifies every slice.

use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
struct SettingDef {
    key: String,
    #[serde(rename = "type")]
    kind: String,
    min: Option<f64>,
    max: Option<f64>,
    #[serde(default)]
    options: Vec<String>,
}

fn schema() -> &'static HashMap<String, SettingDef> {
    static SCHEMA: OnceLock<HashMap<String, SettingDef>> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        let defs: Vec<SettingDef> = serde_json::from_str(include_str!("../web/src/data/settings-schema.json"))
            .expect("settings-schema.json parses");
        defs.into_iter().map(|d| (d.key.clone(), d)).collect()
    })
}

/// Keys nobody sets through FarmSlicer: they act on the machine that
/// slices, not on the print.
const HOST_KEYS: &[&str] = &["post_process", "filename_format", "printhost_apikey", "print_host", "printhost_cafile"];

/// Parse an overrides object (as the Slice page and custom profiles send it).
pub fn parse(json: &str) -> Result<Map<String, Value>, String> {
    if json.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(json) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err("overrides must be a JSON object".into()),
        Err(e) => Err(format!("overrides aren't valid JSON: {e}")),
    }
}

/// Whether overrides set anything beyond the Slice page's settings (an
/// admin's custom start G-code and the like).
pub fn beyond_schema(overrides: &Map<String, Value>) -> bool {
    overrides.keys().any(|k| !schema().contains_key(k))
}

/// Why these overrides aren't allowed, if they aren't.
pub fn check(overrides: &Map<String, Value>, admin: bool) -> Result<(), String> {
    let mut problems = Vec::new();
    for (key, value) in overrides {
        if HOST_KEYS.contains(&key.as_str()) {
            problems.push(format!("{key} can't be set here"));
            continue;
        }
        match schema().get(key) {
            Some(def) => {
                if let Err(e) = check_value(def, value) {
                    problems.push(format!("{key}: {e}"));
                }
            }
            None if admin => {}
            None => problems.push(format!("{key} isn't a setting you can change (ask an admin)")),
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

/// Values arrive as strings ("0.2", "15%", "1"), numbers, or per-filament
/// lists of those; a string may also be a comma-separated list.
fn elements(value: &Value) -> Result<Vec<String>, String> {
    match value {
        Value::String(s) => Ok(s.split(',').map(|x| x.trim().to_string()).collect()),
        Value::Number(n) => Ok(vec![n.to_string()]),
        Value::Bool(b) => Ok(vec![if *b { "1" } else { "0" }.to_string()]),
        Value::Array(items) if !items.is_empty() && items.len() <= 64 => {
            let mut out = Vec::new();
            for item in items {
                match item {
                    Value::Array(_) | Value::Object(_) | Value::Null => return Err("unexpected nested value".into()),
                    other => out.extend(elements(other)?),
                }
            }
            Ok(out)
        }
        _ => Err("unexpected value".into()),
    }
}

fn check_value(def: &SettingDef, value: &Value) -> Result<(), String> {
    for v in elements(value)? {
        match def.kind.as_str() {
            "bool" => {
                if !matches!(v.as_str(), "0" | "1" | "true" | "false") {
                    return Err(format!("{v:?} isn't on or off"));
                }
            }
            "enum" => {
                if !def.options.iter().any(|o| o == &v) {
                    return Err(format!("{v:?} isn't one of {}", def.options.join(", ")));
                }
            }
            "float" | "int" | "percent" => {
                let number = if def.kind == "percent" { v.strip_suffix('%').unwrap_or(&v) } else { &v };
                let n: f64 = number.trim().parse().map_err(|_| format!("{v:?} isn't a number"))?;
                if !n.is_finite() {
                    return Err(format!("{v:?} isn't a number"));
                }
                if def.kind == "int" && n.fract() != 0.0 {
                    return Err(format!("{v:?} isn't a whole number"));
                }
                if def.min.is_some_and(|min| n < min) || def.max.is_some_and(|max| n > max) {
                    return Err(format!(
                        "{v} is outside {}..{}",
                        def.min.map(|m| m.to_string()).unwrap_or_default(),
                        def.max.map(|m| m.to_string()).unwrap_or_default()
                    ));
                }
            }
            other => return Err(format!("unknown setting type {other}")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn members_may_set_schema_settings_in_range() {
        assert!(check(&obj(json!({"layer_height": "0.2", "sparse_infill_density": "15%", "enable_support": "1"})), false).is_ok());
        assert!(check(&obj(json!({"nozzle_temperature": ["220", "225"]})), false).is_ok());
        assert!(check(&obj(json!({"wall_loops": 3})), false).is_ok());
        assert!(check(&obj(json!({"seam_position": "aligned"})), false).is_ok());
    }

    #[test]
    fn members_may_not_inject_gcode() {
        for key in ["machine_start_gcode", "change_filament_gcode", "filament_start_gcode", "layer_change_gcode"] {
            let e = check(&obj(json!({key: "M104 S300\nG4 S36000"})), false).unwrap_err();
            assert!(e.contains(key), "{e}");
        }
    }

    #[test]
    fn values_are_checked() {
        assert!(check(&obj(json!({"layer_height": "5"})), false).is_err());
        assert!(check(&obj(json!({"nozzle_temperature": "999"})), false).is_err());
        assert!(check(&obj(json!({"wall_loops": "2.5"})), false).is_err());
        assert!(check(&obj(json!({"enable_support": "yes"})), false).is_err());
        assert!(check(&obj(json!({"seam_position": "random\nM104 S300"})), false).is_err());
        assert!(check(&obj(json!({"layer_height": "NaN"})), false).is_err());
        assert!(check(&obj(json!({"layer_height": {"x": 1}})), false).is_err());
        // Schema keys are range-checked for admins too.
        assert!(check(&obj(json!({"layer_height": "5"})), true).is_err());
    }

    #[test]
    fn admins_may_set_more_but_not_host_keys() {
        assert!(check(&obj(json!({"machine_start_gcode": "G28"})), true).is_ok());
        assert!(check(&obj(json!({"post_process": "/bin/sh -c id"})), true).is_err());
        assert!(check(&obj(json!({"post_process": "x"})), false).is_err());
    }

    #[test]
    fn parse_rejects_non_objects() {
        assert!(parse("").unwrap().is_empty());
        assert!(parse("[1]").is_err());
        assert!(parse("{nope").is_err());
        assert_eq!(parse(r#"{"a":"1"}"#).unwrap().len(), 1);
    }
}
