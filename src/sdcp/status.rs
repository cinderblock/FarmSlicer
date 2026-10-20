//! An Elegoo Centauri Carbon's state as SDCP reports it, summarized as a
//! vendor-neutral [`PrinterStatus`].
//!
//! Two fields make the state: `CurrentStatus` (an array, the machine: 0
//! idle, 1 a print task is on, 2 receiving a file, 8 checking a file, others
//! calibrations and the like) and `PrintInfo.Status` (the print: 13
//! printing, 5/6 pausing/paused, 9 complete, 8 stopped, 14 error, ...),
//! which keeps its last value after the job ends. Codes from Elegoo's SDK
//! (the FDM table differs from the resin one in the SDCP spec).

use serde_json::{Map, Value};

use crate::printer::status::{PrinterStatus, Temperature, state};

/// Fold a status push into what we hold: objects merge key by key,
/// everything else replaces.
pub fn merge(target: &mut Map<String, Value>, delta: &Map<String, Value>) {
    for (k, v) in delta {
        match (target.get_mut(k), v) {
            (Some(Value::Object(t)), Value::Object(d)) => merge(t, d),
            _ => {
                target.insert(k.clone(), v.clone());
            }
        }
    }
}

/// What the machine is doing: `CurrentStatus[0]`, or `[1]` while a file
/// comes in alongside a print.
pub fn machine_state(status: &Map<String, Value>) -> i64 {
    let codes: Vec<i64> = match status.get("CurrentStatus") {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_i64).collect(),
        Some(v) => v.as_i64().into_iter().collect(),
        None => Vec::new(),
    };
    match codes.as_slice() {
        [2, other, ..] => *other,
        [first, ..] => *first,
        [] => 0,
    }
}

/// Whether any `CurrentStatus` code says so (a transfer shows next to the
/// print).
pub fn has_code(status: &Map<String, Value>, code: i64) -> bool {
    match status.get("CurrentStatus") {
        Some(Value::Array(a)) => a.iter().any(|c| c.as_i64() == Some(code)),
        Some(v) => v.as_i64() == Some(code),
        None => false,
    }
}

/// A temperature as current/target, from `TempOfX` + `TempTargetX`, or the
/// older `[target, actual]` pair.
fn temperature(status: &Map<String, Value>, current: &str, target: &str) -> Option<Temperature> {
    match status.get(current)? {
        Value::Array(pair) if pair.len() == 2 => {
            Some(Temperature { current: pair[1].as_f64()?, target: pair[0].as_f64().unwrap_or(0.0) })
        }
        v => Some(Temperature {
            current: v.as_f64()?,
            target: status.get(target).and_then(Value::as_f64).unwrap_or(0.0),
        }),
    }
}

fn stem(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    base.strip_suffix(".gcode").unwrap_or(base).to_string()
}

/// The speed presets (Elegoo calls them silent, balanced, sport,
/// ludicrous), as Bambu's speed levels 1-4.
pub const SPEED_PRESETS: [i64; 4] = [50, 100, 130, 160];

const FILE_ERRORS: [&str; 6] = ["", "the file's MD5 didn't match", "the file couldn't be read", "wrong resolution", "unknown file format", "sliced for another printer model"];

pub fn summarize(connected: bool, error: Option<String>, updated_at: Option<String>, status: &Map<String, Value>) -> PrinterStatus {
    let info = status.get("PrintInfo").and_then(Value::as_object).cloned().unwrap_or_default();
    let print = info.get("Status").and_then(Value::as_i64).unwrap_or(0);
    let machine = machine_state(status);
    let task = has_code(status, 1);

    let busy = |what: &str| (None, Some(what.to_string()));
    let (st, message): (Option<&str>, Option<String>) = if !connected || status.is_empty() {
        (None, None)
    } else if task {
        match print {
            13 | 12 | 7 => (Some(state::RUNNING), None),
            5 | 6 => (Some(state::PAUSE), None),
            9 => (Some(state::FINISH), None),
            8 => (Some(state::CANCELLED), None),
            14 => (Some(state::FAILED), None),
            // Homing, checking, levelling, heating, ...
            _ => (Some(state::PREPARE), None),
        }
    } else {
        match machine {
            0 => match print {
                // The last print's end stays until the next one.
                9 => (Some(state::FINISH), None),
                8 => (Some(state::CANCELLED), None),
                14 => (Some(state::FAILED), None),
                _ => (Some(state::IDLE), None),
            },
            2 => busy("receiving a file"),
            8 => busy("checking a file"),
            4 => busy("self-checking"),
            5 => busy("levelling the bed"),
            6 => busy("testing resonance"),
            9 => busy("homing"),
            10 => busy("unloading filament"),
            11 => busy("tuning the heaters"),
            _ => busy("busy"),
        }
    };
    let message = message.or_else(|| {
        let code = info.get("ErrorNumber").and_then(Value::as_i64).unwrap_or(0);
        (code > 0).then(|| FILE_ERRORS.get(code as usize).copied().unwrap_or("file error").to_string())
    });

    let filename = info.get("Filename").and_then(Value::as_str).map(str::trim).filter(|f| !f.is_empty());
    let shown = matches!(st, Some(state::RUNNING | state::PAUSE | state::PREPARE | state::FINISH | state::CANCELLED | state::FAILED));
    let filename = filename.filter(|_| shown);
    let active = matches!(st, Some(state::RUNNING | state::PAUSE | state::PREPARE));
    let layer = info.get("CurrentLayer").and_then(Value::as_i64);
    let total = info.get("TotalLayer").and_then(Value::as_i64).filter(|&t| t > 0);
    let percent = info
        .get("Progress")
        .and_then(Value::as_f64)
        .or_else(|| Some(layer? as f64 * 100.0 / total? as f64));
    // Ticks are seconds on the Centauri Carbon (the spec says ms).
    let remaining = match (info.get("TotalTicks").and_then(Value::as_f64), info.get("CurrentTicks").and_then(Value::as_f64)) {
        (Some(t), Some(c)) if t > 0.0 => Some(((t - c).max(0.0) / 60.0).round() as i64),
        _ => None,
    };
    let speed = info.get("PrintSpeedPct").and_then(Value::as_i64);

    PrinterStatus {
        printer_id: String::new(),
        online: connected,
        connection_error: error,
        updated_at,
        state: st.map(String::from),
        vendor_state: Some(format!("{machine}/{print}")),
        stage: None,
        percent: if st == Some(state::FINISH) { Some(100) } else if active { percent.map(|p| p.round() as i64) } else { None },
        remaining_minutes: if active { remaining } else { None },
        layer: if active { layer } else { None },
        total_layers: if active { total } else { None },
        job_name: filename.map(stem),
        job_key: filename.map(stem),
        job_file: filename.map(String::from),
        message,
        print_error: None,
        print_error_message: None,
        hms: Vec::new(),
        nozzles: temperature(status, "TempOfNozzle", "TempTargetNozzle").into_iter().collect(),
        bed: temperature(status, "TempOfHotbed", "TempTargetHotbed"),
        chamber: temperature(status, "TempOfBox", "TempTargetBox").map(|t| t.current),
        speed_level: speed.and_then(|s| SPEED_PRESETS.iter().position(|&p| p == s)).map(|i| i as i64 + 1),
        speed_percent: speed,
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

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn s(v: Value) -> PrinterStatus {
        summarize(true, None, None, &obj(v))
    }

    #[test]
    fn printing_from_a_real_capture() {
        let st = s(json!({"CurrentStatus": [1], "TempOfHotbed": 50.04, "TempTargetHotbed": 50, "TempOfNozzle": 255.01,
            "TempTargetNozzle": 255, "TempOfBox": 29.2, "PrintInfo": {"Status": 13, "CurrentLayer": 34, "TotalLayer": 438,
            "CurrentTicks": 364.98, "TotalTicks": 4504, "Filename": "/local/Clip-1a2b3c4d.gcode", "TaskId": "295cb186",
            "PrintSpeedPct": 130, "Progress": 9, "ErrorNumber": 0}}));
        assert_eq!((st.state.as_deref(), st.percent, st.remaining_minutes), (Some("RUNNING"), Some(9), Some(69)));
        assert_eq!((st.layer, st.total_layers, st.chamber), (Some(34), Some(438), Some(29.2)));
        assert_eq!((st.job_key.as_deref(), st.job_file.as_deref()), (Some("Clip-1a2b3c4d"), Some("/local/Clip-1a2b3c4d.gcode")));
        assert_eq!((st.speed_level, st.speed_percent), (Some(3), Some(130)));
        assert_eq!(st.nozzles, vec![Temperature { current: 255.01, target: 255.0 }]);
    }

    #[test]
    fn states_from_both_fields() {
        let at = |cs: Value, ps: i64| s(json!({"CurrentStatus": cs, "PrintInfo": {"Status": ps, "Filename": "a.gcode"}})).state;
        assert_eq!(at(json!([1]), 16).as_deref(), Some("PREPARE"));
        assert_eq!(at(json!([1]), 6).as_deref(), Some("PAUSE"));
        // The end sticks after the task: finished, stopped, failed.
        assert_eq!(at(json!([0]), 9).as_deref(), Some("FINISH"));
        assert_eq!(at(json!([0]), 8).as_deref(), Some("CANCELLED"));
        assert_eq!(at(json!([0]), 14).as_deref(), Some("FAILED"));
        assert_eq!(at(json!([0]), 0).as_deref(), Some("IDLE"));
        // A file coming in while printing: still printing.
        assert_eq!(at(json!([2, 1]), 13).as_deref(), Some("RUNNING"));
        let checking = s(json!({"CurrentStatus": [8], "PrintInfo": {"Status": 9}}));
        assert_eq!((checking.state, checking.message.as_deref()), (None, Some("checking a file")));
    }

    #[test]
    fn older_temperature_pairs_and_merging() {
        let mut held = obj(json!({"CurrentStatus": [0], "TempOfNozzle": [210, 25.5], "PrintInfo": {"Status": 0, "Filename": "x"}}));
        merge(&mut held, &obj(json!({"PrintInfo": {"Status": 13}, "CurrentStatus": [1]})));
        let st = summarize(true, None, None, &held);
        assert_eq!(st.nozzles, vec![Temperature { current: 25.5, target: 210.0 }]);
        assert_eq!((st.state.as_deref(), st.job_key.as_deref()), (Some("RUNNING"), Some("x")));
    }
}
