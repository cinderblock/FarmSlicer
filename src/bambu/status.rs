//! A printer's state as reported over MQTT, and the summary the UI shows.
//!
//! X1-class printers send a full `print` report about once a second; P1 and
//! A1 send only the fields that changed. We keep one merged report per printer
//! and fold every delta into it, so a partial report never resets fields it
//! didn't mention.

use serde::Serialize;
use serde_json::{Map, Value};

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

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Temperature {
    pub current: f64,
    pub target: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Tray {
    /// The slot number print commands use: `unit * 4 + index` for AMS trays,
    /// 254/255 for external spools.
    pub slot: i64,
    pub unit: Option<i64>,
    pub index: i64,
    /// Material ("PLA", "PETG-CF", ...); `None` for an empty slot.
    pub material: Option<String>,
    /// `#RRGGBB`
    pub color: Option<String>,
    pub name: Option<String>,
    /// Percent left, when the AMS knows (Bambu RFID spools).
    pub remain: Option<i64>,
    pub nozzle_temp_min: Option<i64>,
    pub nozzle_temp_max: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AmsUnit {
    pub id: i64,
    pub humidity: Option<i64>,
    /// Which nozzle the unit feeds on dual-nozzle printers (H2D): 1 left,
    /// 2 right. `None` on single-nozzle printers.
    pub nozzle: Option<i64>,
    pub trays: Vec<Tray>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HmsCode {
    pub attr: i64,
    pub code: i64,
}

/// What the UI shows for a printer.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PrinterStatus {
    pub printer_id: String,
    pub online: bool,
    /// Why the connection is down, while it is.
    pub connection_error: Option<String>,
    /// Time of the last report, RFC 3339.
    pub updated_at: Option<String>,
    /// `gcode_state`: IDLE, PREPARE, RUNNING, PAUSE, FINISH, FAILED, ...
    pub state: Option<String>,
    /// `stg_cur`: the current preparation stage (auto-levelling, heating, ...).
    pub stage: Option<i64>,
    pub percent: Option<i64>,
    pub remaining_minutes: Option<i64>,
    pub layer: Option<i64>,
    pub total_layers: Option<i64>,
    pub job_name: Option<String>,
    /// `subtask_name` as reported (LAN starts may report "project_file").
    pub subtask_name: Option<String>,
    /// Real printers report the extracted plate (`/data/Metadata/plate_1.gcode`),
    /// not the uploaded file.
    pub gcode_file: Option<String>,
    /// `print_error`, when non-zero.
    pub print_error: Option<i64>,
    pub hms: Vec<HmsCode>,
    pub nozzles: Vec<Temperature>,
    pub bed: Option<Temperature>,
    pub chamber: Option<f64>,
    /// 1 silent, 2 standard, 3 sport, 4 ludicrous.
    pub speed_level: Option<i64>,
    pub wifi_signal: Option<String>,
    pub nozzle_diameter: Option<String>,
    pub ams: Vec<AmsUnit>,
    pub external: Vec<Tray>,
    /// Slot feeding the nozzle now (see [`Tray::slot`]).
    pub active_slot: Option<i64>,
}

impl PrinterStatus {
    pub fn offline(printer_id: &str, error: Option<String>) -> Self {
        Self::summarize(printer_id, false, error, None, &Value::Null)
    }

    pub fn summarize(
        printer_id: &str,
        online: bool,
        connection_error: Option<String>,
        updated_at: Option<String>,
        report: &Value,
    ) -> Self {
        let r = report;
        let job_name = text(&r["subtask_name"])
            // LAN starts report "project_file" or nothing; fall back to the file.
            .filter(|s| s != "project_file")
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

        let ams = r["ams"]["ams"]
            .as_array()
            .map(|units| units.iter().filter_map(ams_unit).collect())
            .unwrap_or_default();

        let mut external = Vec::new();
        if let Some(slots) = r["vir_slot"].as_array() {
            external.extend(slots.iter().filter_map(|t| tray(t, None)));
        } else if r["vt_tray"].is_object() {
            external.extend(tray(&r["vt_tray"], None));
        }

        let hms = r["hms"]
            .as_array()
            .map(|codes| {
                codes
                    .iter()
                    .filter_map(|h| Some(HmsCode { attr: int(&h["attr"])?, code: int(&h["code"])? }))
                    .collect()
            })
            .unwrap_or_default();

        Self {
            printer_id: printer_id.to_string(),
            online,
            connection_error,
            updated_at,
            state: text(&r["gcode_state"]),
            stage: int(&r["stg_cur"]),
            percent: int(&r["mc_percent"]),
            remaining_minutes: int(&r["mc_remaining_time"]),
            layer: int(&r["layer_num"]),
            total_layers: int(&r["total_layer_num"]),
            job_name,
            subtask_name: text(&r["subtask_name"]),
            gcode_file: text(&r["gcode_file"]),
            print_error: int(&r["print_error"]).filter(|&e| e != 0),
            hms,
            nozzles,
            bed,
            chamber: num(&r["chamber_temper"]),
            speed_level: int(&r["spd_lvl"]),
            wifi_signal: text(&r["wifi_signal"]),
            nozzle_diameter: text(&r["nozzle_diameter"]),
            ams,
            external,
            // 255 = nothing loaded.
            active_slot: int(&r["ams"]["tray_now"]).filter(|&s| s != 255),
        }
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

fn ams_unit(u: &Value) -> Option<AmsUnit> {
    let id = int(&u["id"])?;
    let trays = u["tray"]
        .as_array()
        .map(|ts| ts.iter().filter_map(|t| tray(t, Some(id))).collect())
        .unwrap_or_default();
    Some(AmsUnit {
        id,
        humidity: int(&u["humidity"]),
        nozzle: u["info"]
            .as_str()
            .and_then(|i| i.chars().next())
            .and_then(|c| c.to_digit(10))
            .map(i64::from)
            .filter(|&n| n > 0),
        trays,
    })
}

fn tray(t: &Value, unit: Option<i64>) -> Option<Tray> {
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
        let s = PrinterStatus::summarize("p", true, None, None, &report);
        assert_eq!(s.ams.len(), 2);
        assert_eq!(s.ams[0].trays[0].material.as_deref(), Some("PLA"));
        assert_eq!(s.ams[0].trays[1].material, None);
        assert_eq!(s.ams[1].trays[0].slot, 4);
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
        let s = PrinterStatus::summarize("p", true, None, None, &report);
        assert_eq!(s.job_name.as_deref(), Some("Bracket"));
        assert_eq!(s.print_error, None);
        assert_eq!(s.nozzles, vec![Temperature { current: 218.0, target: 220.0 }]);
        assert_eq!(s.active_slot, None);
        assert_eq!(s.ams[0].nozzle, Some(2));
        assert_eq!(s.ams[0].trays[0].slot, 2);
        assert_eq!(s.ams[0].trays[0].color.as_deref(), Some("#0A0B0C"));
        assert_eq!(s.ams[0].trays[0].remain, None);
        assert_eq!(s.external[0].slot, 254);
    }

    #[test]
    fn command_echoes_are_not_status() {
        assert!(status_push(&json!({"print": {"command": "push_status", "mc_percent": 1}})).is_some());
        assert!(status_push(&json!({"print": {"command": "project_file", "result": "success"}})).is_none());
        assert!(status_push(&json!({"info": {"command": "get_version"}})).is_none());
    }
}
