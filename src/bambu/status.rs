//! A Bambu printer's state as reported over MQTT, and its summary as a
//! vendor-neutral [`PrinterStatus`].
//!
//! X1-class printers send a full `print` report about once a second; P1 and
//! A1 send only the fields that changed. We keep one merged report per printer
//! and fold every delta into it, so a partial report never resets fields it
//! didn't mention.

use serde_json::{Map, Value};

use crate::printer::status::{AmsUnit, HmsCode, PrinterStatus, Temperature, Tray, state};

/// Fold a `print` report (full or delta) into the merged report.
///
/// Objects merge key by key. Arrays of objects that carry an `"id"` (AMS
/// units) merge element by element: a delta element replaces the element
/// with the same id whole (an empty tray is sent as just its id, so merging
/// inside would keep the old spool) and new ids are appended; elements the
/// delta doesn't mention stay. Every other value replaces the old one.
pub fn merge(target: &mut Value, delta: &Value) {
    match (target, delta) {
        (Value::Object(t), Value::Object(d)) => {
            for (key, value) in d {
                match t.get_mut(key) {
                    Some(existing) => merge(existing, value),
                    None => {
                        t.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (Value::Array(t), Value::Array(d)) if is_id_array(t) && is_id_array(d) => {
            for element in d {
                let id = &element["id"];
                match t.iter_mut().find(|e| &e["id"] == id) {
                    Some(existing) => *existing = element.clone(),
                    None => t.push(element.clone()),
                }
            }
        }
        (t, d) => *t = d.clone(),
    }
}

fn is_id_array(items: &[Value]) -> bool {
    !items.is_empty() && items.iter().all(|e| e.get("id").is_some())
}

/// Bambu sends many numbers as strings ("tray_now": "255"); accept both.
fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn int(v: &Value) -> Option<i64> {
    num(v).map(|n| n as i64)
}

fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// `print_error` for a print stopped by a person (0300_400C).
pub const PRINT_CANCELLED: i64 = 0x0300_400C;

/// The normalized state for a `gcode_state`; unknown ones give `None`.
fn normalize_state(gcode_state: &str, print_error: Option<i64>) -> Option<&'static str> {
    Some(match gcode_state {
        "IDLE" => state::IDLE,
        "PREPARE" => state::PREPARE,
        "RUNNING" => state::RUNNING,
        "PAUSE" => state::PAUSE,
        "FINISH" => state::FINISH,
        "FAILED" if print_error == Some(PRINT_CANCELLED) => state::CANCELLED,
        "FAILED" => state::FAILED,
        "SLICING" => state::SLICING,
        _ => return None,
    })
}

/// The UI's summary of a merged report.
pub fn summarize(
    online: bool,
    connection_error: Option<String>,
    updated_at: Option<String>,
    report: &Value,
) -> PrinterStatus {
    let r = report;
    // LAN starts report "project_file" or nothing: no name to go by.
    let job_key = text(&r["subtask_name"]).filter(|s| s != "project_file");
    let job_name = job_key
        .clone()
        .or_else(|| text(&r["gcode_file"]).map(|f| strip_print_ext(&f)));

    let mut nozzles = Vec::new();
    // H2D and other multi-extruder printers: device.extruder.info[].temp
    // packs target << 16 | current.
    if let Some(info) = r["device"]["extruder"]["info"].as_array() {
        for e in info {
            if let Some(packed) = int(&e["temp"]) {
                nozzles.push(Temperature {
                    current: (packed & 0xFFFF) as f64,
                    target: ((packed >> 16) & 0xFFFF) as f64,
                });
            }
        }
    }
    if nozzles.is_empty() {
        if let Some(current) = num(&r["nozzle_temper"]) {
            nozzles.push(Temperature {
                current,
                target: num(&r["nozzle_target_temper"]).unwrap_or(0.0),
            });
        }
    }

    let bed = num(&r["bed_temper"]).map(|current| Temperature {
        current,
        target: num(&r["bed_target_temper"]).unwrap_or(0.0),
    });

    let dual = nozzles.len() > 1;
    let ams = r["ams"]["ams"]
        .as_array()
        .map(|units| units.iter().filter_map(|u| ams_unit(u, dual)).collect())
        .unwrap_or_default();

    // External spools on dual-nozzle printers: one holder per nozzle, 255
    // the main (right) one's, 254 the deputy's (left).
    let external_nozzle = |t: &Value| match int(&t["id"]) {
        Some(255) if dual => Some(2),
        Some(254) if dual => Some(1),
        _ => None,
    };
    let mut external = Vec::new();
    if let Some(slots) = r["vir_slot"].as_array() {
        external.extend(slots.iter().filter_map(|t| tray(t, None, external_nozzle(t))));
    } else if r["vt_tray"].is_object() {
        external.extend(tray(&r["vt_tray"], None, external_nozzle(&r["vt_tray"])));
    }

    let hms = r["hms"]
        .as_array()
        .map(|codes| {
            codes
                .iter()
                .filter_map(|h| Some(HmsCode { attr: int(&h["attr"])?, code: int(&h["code"])?, message: None }))
                .collect()
        })
        .unwrap_or_default();

    let print_error = int(&r["print_error"]).filter(|&e| e != 0);
    let gcode_state = text(&r["gcode_state"]);
    PrinterStatus {
        printer_id: String::new(),
        online,
        connection_error,
        updated_at,
        state: gcode_state.as_deref().and_then(|s| normalize_state(s, print_error)).map(String::from),
        vendor_state: gcode_state,
        stage: int(&r["stg_cur"]),
        percent: int(&r["mc_percent"]),
        remaining_minutes: int(&r["mc_remaining_time"]),
        layer: int(&r["layer_num"]),
        total_layers: int(&r["total_layer_num"]),
        job_name,
        job_key,
        job_file: text(&r["gcode_file"]),
        message: None,
        print_error,
        print_error_message: None,
        hms,
        nozzles,
        bed,
        chamber: num(&r["chamber_temper"]),
        speed_level: int(&r["spd_lvl"]),
        speed_percent: int(&r["spd_mag"]),
        wifi_signal: text(&r["wifi_signal"]),
        nozzle_diameter: text(&r["nozzle_diameter"]),
        ams,
        external,
        // 255 = nothing loaded.
        active_slot: int(&r["ams"]["tray_now"]).filter(|&s| s != 255),
    }
}

fn strip_print_ext(file: &str) -> String {
    let base = file.rsplit('/').next().unwrap_or(file);
    for ext in [".gcode.3mf", ".3mf", ".gcode"] {
        if let Some(stem) = base.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    base.to_string()
}

/// The nozzle an AMS unit feeds, from its `info` flags (hex; bits 8-11 are
/// the extruder, as Bambu's own device code reads them: 0 the main extruder,
/// the H2D's right nozzle; 1 the deputy, its left; 0xE not set up yet), in
/// the slicer's numbering: 1 left, 2 right.
fn ams_nozzle(info: &str) -> Option<i64> {
    let flags = u64::from_str_radix(info.trim(), 16).ok()?;
    match (flags >> 8) & 0xF {
        0 => Some(2),
        1 => Some(1),
        _ => None,
    }
}

fn ams_unit(u: &Value, dual: bool) -> Option<AmsUnit> {
    let id = int(&u["id"])?;
    let nozzle = if dual { u["info"].as_str().and_then(ams_nozzle) } else { None };
    let trays = u["tray"]
        .as_array()
        .map(|ts| ts.iter().filter_map(|t| tray(t, Some(id), nozzle)).collect())
        .unwrap_or_default();
    Some(AmsUnit {
        id,
        humidity: int(&u["humidity"]),
        nozzle,
        trays,
    })
}

fn tray(t: &Value, unit: Option<i64>, nozzle: Option<i64>) -> Option<Tray> {
    let index = int(&t["id"])?;
    let slot = match unit {
        // AMS-HT units are numbered from 128 and hold one tray.
        Some(u) if u >= 128 => u,
        Some(u) => u * 4 + index,
        None => index,
    };
    Some(Tray {
        slot,
        unit,
        index,
        material: text(&t["tray_type"]),
        color: text(&t["tray_color"])
            .filter(|c| c.len() >= 6)
            .map(|c| format!("#{}", &c[..6])),
        name: text(&t["tray_sub_brands"]),
        remain: int(&t["remain"]).filter(|&r| r >= 0),
        nozzle_temp_min: int(&t["nozzle_temp_min"]),
        nozzle_temp_max: int(&t["nozzle_temp_max"]),
        nozzle,
    })
}

/// The `print` object of a report, if the message is a status push (not a
/// command echo).
pub fn status_push(message: &Value) -> Option<&Map<String, Value>> {
    let print = message.get("print")?.as_object()?;
    match print.get("command").and_then(Value::as_str) {
        Some("push_status") | None => Some(print),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deltas_keep_unmentioned_fields() {
        let mut report = json!({
            "gcode_state": "RUNNING", "mc_percent": 10, "nozzle_temper": 219.5,
            "ams": {"tray_now": "2", "ams": [{"id": "0", "humidity": "4", "tray": [
                {"id": "0", "tray_type": "PLA", "tray_color": "FF0000FF"},
                {"id": "1", "tray_type": "PETG", "tray_color": "00FF00FF"}
            ]}]}
        });
        merge(&mut report, &json!({"mc_percent": 11, "ams": {"tray_now": "1"}}));
        assert_eq!(report["gcode_state"], "RUNNING");
        assert_eq!(report["mc_percent"], 11);
        assert_eq!(report["nozzle_temper"], 219.5);
        assert_eq!(report["ams"]["tray_now"], "1");
        assert_eq!(report["ams"]["ams"][0]["tray"][1]["tray_type"], "PETG");
    }

    #[test]
    fn id_arrays_merge_by_element() {
        let mut report = json!({"ams": {"ams": [
            {"id": "0", "tray": [{"id": "0", "tray_type": "PLA"}, {"id": "1", "tray_type": "ABS"}]},
            {"id": "1", "tray": [{"id": "0", "tray_type": "TPU"}]}
        ]}});
        // Unit 0's tray 1 emptied. A delta carries a changed unit whole (an
        // empty tray is just its id) and the unit replaces the old one;
        // unit 1, not mentioned, stays.
        merge(&mut report, &json!({"ams": {"ams": [
            {"id": "0", "tray": [{"id": "0", "tray_type": "PLA"}, {"id": "1"}]}
        ]}}));
        let s = summarize(true, None, None, &report);
        assert_eq!(s.ams.len(), 2);
        assert_eq!(s.ams[0].trays[0].material.as_deref(), Some("PLA"));
        assert_eq!(s.ams[0].trays[1].material, None);
        assert_eq!(s.ams[1].trays[0].slot, 4);
    }

    #[test]
    fn ams_units_feed_a_nozzle_on_dual_nozzle_printers() {
        // Bits 8-11 of the hex `info`: 0 the main extruder (right), 1 the
        // deputy (left), 0xE not set up.
        assert_eq!(ams_nozzle("0003"), Some(2));
        assert_eq!(ams_nozzle("1003"), Some(2));
        assert_eq!(ams_nozzle("0103"), Some(1));
        assert_eq!(ams_nozzle("0E03"), None);
        assert_eq!(ams_nozzle("junk"), None);
        let report = json!({
            "device": {"extruder": {"info": [{"temp": 0}, {"temp": 0}]}},
            "ams": {"ams": [{"id": "0", "info": "0103", "tray": [{"id": "0", "tray_type": "PLA"}]},
                            {"id": "1", "info": "0003", "tray": []}]},
            "vir_slot": [{"id": "254", "tray_type": "TPU"}, {"id": "255", "tray_type": "PETG"}]
        });
        let s = summarize(true, None, None, &report);
        assert_eq!(s.ams.iter().map(|u| u.nozzle).collect::<Vec<_>>(), vec![Some(1), Some(2)]);
        // Trays feed their unit's nozzle; external spools their holder's.
        assert_eq!(s.ams[0].trays[0].nozzle, Some(1));
        assert_eq!(s.external.iter().map(|t| (t.slot, t.nozzle)).collect::<Vec<_>>(), vec![(254, Some(1)), (255, Some(2))]);
        // One nozzle: the field means nothing.
        let single = json!({"nozzle_temper": 20, "ams": {"ams": [{"id": "0", "info": "0103", "tray": [{"id": "0"}]}]},
                            "vt_tray": {"id": "254", "tray_type": "TPU"}});
        let s = summarize(true, None, None, &single);
        assert_eq!((s.ams[0].nozzle, s.ams[0].trays[0].nozzle, s.external[0].nozzle), (None, None, None));
    }

    #[test]
    fn hms_list_is_replaced() {
        let mut report = json!({"hms": [{"attr": 1, "code": 2}]});
        merge(&mut report, &json!({"hms": []}));
        assert_eq!(report["hms"], json!([]));
    }

    #[test]
    fn summary_reads_strings_and_packed_temps() {
        let report = json!({
            "gcode_state": "RUNNING", "mc_percent": 42, "mc_remaining_time": 17,
            "layer_num": 5, "total_layer_num": 100,
            "subtask_name": "project_file", "gcode_file": "/sdcard/Bracket.gcode.3mf",
            "print_error": 0, "bed_temper": 55.0, "bed_target_temper": 55.0,
            "device": {"extruder": {"info": [{"id": 0, "temp": (220 << 16) | 218}]}},
            "ams": {"tray_now": "255", "ams": [{"id": "0", "info": "2001", "humidity": "3",
                "tray": [{"id": "2", "tray_type": "PLA", "tray_color": "0A0B0CFF", "remain": -1}]}]},
            "vt_tray": {"id": "254", "tray_type": "TPU", "tray_color": "000000FF"}
        });
        let s = summarize(true, None, None, &report);
        assert_eq!(s.job_name.as_deref(), Some("Bracket"));
        assert_eq!(s.print_error, None);
        assert_eq!(s.nozzles, vec![Temperature { current: 218.0, target: 220.0 }]);
        assert_eq!(s.active_slot, None);
        // One extruder: which nozzle an AMS feeds means nothing.
        assert_eq!(s.ams[0].nozzle, None);
        assert_eq!(s.ams[0].trays[0].slot, 2);
        assert_eq!(s.ams[0].trays[0].color.as_deref(), Some("#0A0B0C"));
        assert_eq!(s.ams[0].trays[0].remain, None);
        assert_eq!(s.external[0].slot, 254);
    }

    #[test]
    fn states_are_normalized() {
        let s = |report| summarize(true, None, None, &report);
        assert_eq!(s(json!({"gcode_state": "RUNNING"})).state.as_deref(), Some("RUNNING"));
        let stopped = s(json!({"gcode_state": "FAILED", "print_error": PRINT_CANCELLED}));
        assert_eq!(stopped.state.as_deref(), Some("CANCELLED"));
        assert_eq!(stopped.vendor_state.as_deref(), Some("FAILED"));
        assert_eq!(s(json!({"gcode_state": "FAILED", "print_error": 0x0500_4038})).state.as_deref(), Some("FAILED"));
        let odd = s(json!({"gcode_state": "INIT", "subtask_name": "project_file"}));
        assert_eq!((odd.state, odd.vendor_state.as_deref(), odd.job_key), (None, Some("INIT"), None));
    }

    #[test]
    fn command_echoes_are_not_status() {
        assert!(status_push(&json!({"print": {"command": "push_status", "mc_percent": 1}})).is_some());
        assert!(status_push(&json!({"print": {"command": "project_file", "result": "success"}})).is_none());
        assert!(status_push(&json!({"info": {"command": "get_version"}})).is_none());
    }
}
