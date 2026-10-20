//! A Klipper printer's state as Moonraker reports it (the subscribed printer
//! objects, merged), summarized as a vendor-neutral [`PrinterStatus`].
//!
//! `print_stats.state` drives the job state: `standby`, `printing`,
//! `paused`, `complete`, `cancelled`, `error` (the last three persist until
//! the next print). `webhooks.state` is Klipper's own: `ready`, `startup`,
//! `shutdown` (an emergency stop or MCU error), `error` (config error).

use serde_json::{Map, Value};

use crate::printer::status::{PrinterStatus, Temperature, state};

/// The printer objects worth subscribing to, from those Klipper has
/// (`printer.objects.list`): `null` asks for every field.
pub fn subscription(available: &[String]) -> Map<String, Value> {
    let fixed = [
        "webhooks",
        "print_stats",
        "virtual_sdcard",
        "display_status",
        "pause_resume",
        "gcode_move",
        "heater_bed",
        "toolhead",
    ];
    available
        .iter()
        .filter(|o| {
            fixed.contains(&o.as_str())
                || o.starts_with("extruder")
                || ((o.starts_with("temperature_sensor ") || o.starts_with("heater_generic "))
                    && o.to_ascii_lowercase().contains("chamber"))
        })
        .map(|o| (o.clone(), Value::Null))
        .collect()
}

/// Fold a `notify_status_update` delta into the merged objects.
pub fn merge(objects: &mut Map<String, Value>, delta: &Map<String, Value>) {
    for (name, fields) in delta {
        match (objects.get_mut(name), fields) {
            (Some(Value::Object(have)), Value::Object(new)) => {
                for (k, v) in new {
                    // print_stats.info is an object of its own; replace whole.
                    have.insert(k.clone(), v.clone());
                }
            }
            _ => {
                objects.insert(name.clone(), fields.clone());
            }
        }
    }
}

/// What the file being printed says about itself (`server.files.metadata`).
#[derive(Debug, Clone, Default)]
pub struct FileInfo {
    pub filename: String,
    pub estimated_time: Option<f64>,
    pub layer_count: Option<i64>,
}

impl FileInfo {
    pub fn from_metadata(filename: &str, meta: &Value) -> Self {
        Self {
            filename: filename.to_string(),
            estimated_time: meta["estimated_time"].as_f64().filter(|&t| t > 0.0),
            layer_count: meta["layer_count"].as_i64().filter(|&n| n > 0),
        }
    }
}

/// Everything the summary is made from.
pub struct Snapshot<'a> {
    pub connected: bool,
    pub error: Option<String>,
    pub updated_at: Option<String>,
    /// From `server.info` (`ready`, `startup`, `shutdown`, `error`,
    /// `disconnected`) until `webhooks` says.
    pub klippy_state: &'a str,
    pub klippy_message: &'a str,
    pub objects: &'a Map<String, Value>,
    pub file: Option<&'a FileInfo>,
}

fn temperature(o: &Value) -> Option<Temperature> {
    Some(Temperature { current: o["temperature"].as_f64()?, target: o["target"].as_f64().unwrap_or(0.0) })
}

/// The file name without directories or extension.
fn stem(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    base.strip_suffix(".gcode").unwrap_or(base).to_string()
}

/// Minutes left: the slicer's estimate early on, then a blend with what
/// the time so far says at this progress (Klipper has no estimate of its own).
fn remaining_minutes(progress: f64, print_duration: f64, estimate: Option<f64>, speed: f64) -> Option<i64> {
    let p = progress.clamp(0.0, 1.0);
    let by_estimate = estimate.map(|e| e * (1.0 - p) / speed.max(0.1));
    let by_progress = (p >= 0.05 && print_duration > 0.0).then(|| print_duration * (1.0 - p) / p);
    let secs = match (by_estimate, by_progress) {
        (Some(e), Some(r)) => (e + r) / 2.0,
        (Some(e), None) => e,
        (None, Some(r)) => r,
        (None, None) => return None,
    };
    Some((secs / 60.0).round() as i64)
}

pub fn summarize(s: &Snapshot) -> PrinterStatus {
    let o = s.objects;
    let webhooks = o.get("webhooks");
    let klippy = webhooks.and_then(|w| w["state"].as_str()).unwrap_or(s.klippy_state);
    // Klipper's messages run on with advice; the first line says what happened.
    let first_line = |m: &str| m.trim().lines().next().unwrap_or("").trim().to_string();
    let klippy_message = first_line(
        webhooks
            .and_then(|w| w["state_message"].as_str())
            .unwrap_or(s.klippy_message),
    );
    let stats = o.get("print_stats").cloned().unwrap_or(Value::Null);
    let print_state = stats["state"].as_str().unwrap_or("");
    let print_duration = stats["print_duration"].as_f64().unwrap_or(0.0);

    let (state, message) = match klippy {
        "ready" => {
            let st = match print_state {
                "standby" => Some(state::IDLE),
                // Heating and homing: no extrusion yet.
                "printing" if print_duration <= 0.0 => Some(state::PREPARE),
                "printing" => Some(state::RUNNING),
                "paused" => Some(state::PAUSE),
                "complete" => Some(state::FINISH),
                "cancelled" => Some(state::CANCELLED),
                "error" => Some(state::FAILED),
                _ => None,
            };
            let msg = stats["message"].as_str().map(first_line).filter(|m| !m.is_empty() && print_state == "error");
            (st, msg)
        }
        // An emergency stop or MCU error ends whatever was printing.
        "shutdown" | "error" => (
            Some(state::FAILED),
            Some(if klippy_message.is_empty() { format!("Klipper {klippy}") } else { klippy_message }),
        ),
        _ => (None, None),
    };
    let vendor_state = match klippy {
        "ready" if !print_state.is_empty() => Some(print_state.to_string()),
        "ready" => None,
        other => Some(format!("Klipper {other}")),
    };

    let filename = stats["filename"].as_str().map(str::trim).filter(|f| !f.is_empty());
    let file = s.file.filter(|f| Some(f.filename.as_str()) == filename);
    let active = matches!(print_state, "printing" | "paused");
    let progress = o
        .get("display_status")
        .and_then(|d| d["progress"].as_f64())
        .or_else(|| o.get("virtual_sdcard").and_then(|v| v["progress"].as_f64()))
        .unwrap_or(0.0);
    let speed = o.get("gcode_move").and_then(|g| g["speed_factor"].as_f64());

    let mut extruders: Vec<(&String, &Value)> = o
        .iter()
        .filter(|(k, _)| *k == "extruder" || k.strip_prefix("extruder").is_some_and(|n| n.parse::<u32>().is_ok()))
        .collect();
    extruders.sort_by_key(|(k, _)| k.strip_prefix("extruder").and_then(|n| n.parse::<u32>().ok()).unwrap_or(0));
    let chamber = o
        .iter()
        .find(|(k, _)| k.starts_with("temperature_sensor ") || k.starts_with("heater_generic "))
        .and_then(|(_, v)| v["temperature"].as_f64());

    PrinterStatus {
        printer_id: String::new(),
        online: s.connected,
        connection_error: s.error.clone(),
        updated_at: s.updated_at.clone(),
        state: state.map(String::from),
        vendor_state,
        stage: None,
        percent: (active || print_state == "complete").then(|| (progress * 100.0).round() as i64),
        remaining_minutes: if active {
            remaining_minutes(progress, print_duration, file.and_then(|f| f.estimated_time), speed.unwrap_or(1.0))
        } else {
            None
        },
        layer: stats["info"]["current_layer"].as_i64(),
        total_layers: stats["info"]["total_layer"].as_i64().or_else(|| file.and_then(|f| f.layer_count)),
        job_name: filename.map(stem),
        job_key: filename.map(stem),
        job_file: filename.map(String::from),
        message,
        print_error: None,
        print_error_message: None,
        hms: Vec::new(),
        nozzles: extruders.iter().filter_map(|(_, v)| temperature(v)).collect(),
        bed: o.get("heater_bed").and_then(temperature),
        chamber,
        speed_level: None,
        speed_percent: speed.map(|f| (f * 100.0).round() as i64),
        wifi_signal: None,
        nozzle_diameter: None,
        ams: Vec::new(),
        external: Vec::new(),
        active_slot: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn objects(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn snap(objects: &Map<String, Value>, file: Option<&FileInfo>) -> PrinterStatus {
        summarize(&Snapshot {
            connected: true,
            error: None,
            updated_at: None,
            klippy_state: "ready",
            klippy_message: "",
            objects,
            file,
        })
    }

    #[test]
    fn subscribes_to_what_exists() {
        let list: Vec<String> = ["webhooks", "print_stats", "extruder", "extruder1", "fan", "temperature_sensor Chamber", "temperature_sensor mcu", "heater_bed", "gcode_move"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let sub = subscription(&list);
        let mut keys: Vec<&str> = sub.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, vec!["extruder", "extruder1", "gcode_move", "heater_bed", "print_stats", "temperature_sensor Chamber", "webhooks"]);
    }

    #[test]
    fn deltas_merge_and_states_normalize() {
        let mut o = objects(json!({
            "webhooks": {"state": "ready", "state_message": "Printer is ready"},
            "print_stats": {"state": "printing", "filename": "farmslicer/Clip-1a2b3c4d.gcode", "print_duration": 0.0, "info": {"current_layer": null, "total_layer": null}},
            "display_status": {"progress": 0.0},
            "extruder": {"temperature": 150.2, "target": 215.0},
            "heater_bed": {"temperature": 58.0, "target": 60.0},
            "gcode_move": {"speed_factor": 1.0}
        }));
        let file = FileInfo { filename: "farmslicer/Clip-1a2b3c4d.gcode".into(), estimated_time: Some(3600.0), layer_count: Some(50) };
        let s = snap(&o, Some(&file));
        assert_eq!(s.state.as_deref(), Some("PREPARE"));
        assert_eq!(s.job_key.as_deref(), Some("Clip-1a2b3c4d"));
        assert_eq!(s.total_layers, Some(50));
        assert_eq!(s.remaining_minutes, Some(60));
        assert_eq!(s.nozzles, vec![Temperature { current: 150.2, target: 215.0 }]);

        merge(&mut o, &objects(json!({"print_stats": {"print_duration": 1800.0}, "display_status": {"progress": 0.5}, "gcode_move": {"speed_factor": 1.5}})));
        let s = snap(&o, Some(&file));
        assert_eq!((s.state.as_deref(), s.percent, s.speed_percent), (Some("RUNNING"), Some(50), Some(150)));
        // Half done in 30 min: 30 min by progress, 20 by the estimate at 150%.
        assert_eq!(s.remaining_minutes, Some(25));
        assert_eq!(s.job_file.as_deref(), Some("farmslicer/Clip-1a2b3c4d.gcode"));

        merge(&mut o, &objects(json!({"print_stats": {"state": "cancelled"}})));
        assert_eq!(snap(&o, None).state.as_deref(), Some("CANCELLED"));
        merge(&mut o, &objects(json!({"print_stats": {"state": "error", "message": "Move out of range: 300 0 0"}})));
        let s = snap(&o, None);
        assert_eq!((s.state.as_deref(), s.message.as_deref()), (Some("FAILED"), Some("Move out of range: 300 0 0")));
    }

    #[test]
    fn klipper_down_or_shut_down() {
        let o = objects(json!({"webhooks": {"state": "shutdown", "state_message": "MCU 'mcu' shutdown: Timer too close
This often indicates the host computer is overloaded. Check
for other processes"}, "print_stats": {"state": "printing"}}));
        let s = snap(&o, None);
        assert_eq!((s.state.as_deref(), s.vendor_state.as_deref()), (Some("FAILED"), Some("Klipper shutdown")));
        assert_eq!(s.message.as_deref(), Some("MCU 'mcu' shutdown: Timer too close"));
        let empty = Map::new();
        let s = summarize(&Snapshot {
            connected: true,
            error: None,
            updated_at: None,
            klippy_state: "startup",
            klippy_message: "",
            objects: &empty,
            file: None,
        });
        assert_eq!((s.state, s.vendor_state.as_deref()), (None, Some("Klipper startup")));
    }
}
