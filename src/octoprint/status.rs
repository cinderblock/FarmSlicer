//! An OctoPrint printer's state, summarized as a vendor-neutral
//! [`PrinterStatus`]. OctoPrint's state flags drive it (the state text is
//! translated and varies), and how the last print ended comes from the
//! link's events ([`Outcome`]).

use serde_json::Value;

use super::link::State;
use crate::printer::status::{PrinterStatus, Temperature, state};

/// How a print ended, as OctoPrint's events said.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Done,
    Cancelled,
    /// With OctoPrint's error text, if any.
    Failed(String),
    /// Seen only after a reconnect: the file is still selected but its
    /// progress is gone (OctoPrint clears it on cancel and on error).
    Unknown,
}

pub(super) struct Snapshot<'a> {
    pub(super) state: &'a State,
}

fn temperature(v: &Value) -> Option<Temperature> {
    Some(Temperature { current: v["actual"].as_f64()?, target: v["target"].as_f64().unwrap_or(0.0) })
}

fn stem(name: &str) -> String {
    let base = name.rsplit('/').next().unwrap_or(name);
    base.strip_suffix(".gcode").unwrap_or(base).to_string()
}

pub(super) fn summarize(snap: &Snapshot) -> PrinterStatus {
    let s = snap.state;
    let current = &s.current;
    let flags = &current["state"]["flags"];
    let flag = |k: &str| flags[k].as_bool() == Some(true);
    let text = current["state"]["text"].as_str().unwrap_or("").to_string();
    let error = current["state"]["error"].as_str().map(str::trim).filter(|e| !e.is_empty()).map(String::from);
    let path = current["job"]["file"]["path"].as_str().filter(|p| !p.is_empty());
    let name = current["job"]["file"]["display"]
        .as_str()
        .or_else(|| current["job"]["file"]["name"].as_str())
        .filter(|n| !n.is_empty());
    let outcome = s.outcome.as_ref().filter(|(p, _)| Some(p.as_str()) == path).map(|(_, o)| o);

    // OctoPrint up but not talking to the printer: as good as offline.
    let printer_gone = s.connected && !flag("operational") && !flag("error") && (flag("closedOrError") || text == "Offline");
    let (st, message) = if !s.connected || printer_gone {
        (None, None)
    } else if flag("error") {
        (Some(state::FAILED), error.or_else(|| Some(text.clone())))
    } else if flag("paused") || flag("pausing") {
        (Some(state::PAUSE), None)
    } else if flag("printing") || flag("resuming") || flag("finishing") || flag("cancelling") || flag("starting") {
        (Some(state::RUNNING), None)
    } else {
        match outcome {
            Some(Outcome::Done) => (Some(state::FINISH), None),
            Some(Outcome::Cancelled | Outcome::Unknown) => (Some(state::CANCELLED), None),
            Some(Outcome::Failed(e)) => (Some(state::FAILED), Some(e.clone()).filter(|e| !e.is_empty())),
            None => (Some(state::IDLE), None),
        }
    };

    let active = matches!(st, Some(state::RUNNING | state::PAUSE));
    let completion = current["progress"]["completion"].as_f64();
    let mut nozzles: Vec<(u32, Temperature)> = s
        .temps
        .as_object()
        .map(|t| {
            t.iter()
                .filter_map(|(k, v)| Some((k.strip_prefix("tool")?.parse().ok()?, temperature(v)?)))
                .collect()
        })
        .unwrap_or_default();
    nozzles.sort_by_key(|(i, _)| *i);

    PrinterStatus {
        printer_id: String::new(),
        online: s.connected && !printer_gone,
        connection_error: if printer_gone {
            Some(format!("OctoPrint is up but not connected to the printer ({text})"))
        } else {
            s.error.clone()
        },
        updated_at: s.updated_at.clone(),
        state: st.map(String::from),
        vendor_state: Some(text).filter(|t| !t.is_empty()),
        stage: None,
        // 2.0 takes progress from the file's M73 lines, which may stop at 99.
        percent: if st == Some(state::FINISH) {
            Some(100)
        } else if active {
            completion.map(|c| c.round() as i64)
        } else {
            None
        },
        remaining_minutes: if active {
            current["progress"]["printTimeLeft"].as_f64().map(|secs| (secs / 60.0).round() as i64)
        } else {
            None
        },
        layer: None,
        total_layers: None,
        job_name: name.map(stem),
        job_key: path.map(stem),
        job_file: path.map(String::from),
        message,
        print_error: None,
        print_error_message: None,
        hms: Vec::new(),
        nozzles: nozzles.into_iter().map(|(_, t)| t).collect(),
        bed: temperature(&s.temps["bed"]),
        chamber: s.temps["chamber"]["actual"].as_f64(),
        speed_level: None,
        speed_percent: if active { s.speed_percent } else { None },
        wifi_signal: None,
        nozzle_diameter: None,
        ams: Vec::new(),
        external: Vec::new(),
        active_slot: None,
        door_open: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(current: Value, outcome: Option<Outcome>) -> State {
        let path = current["job"]["file"]["path"].as_str().unwrap_or("").to_string();
        State {
            connected: true,
            current,
            temps: json!({"tool0": {"actual": 210.3, "target": 210.0}, "bed": {"actual": 60.1, "target": 60.0},
                          "chamber": {"actual": null, "target": null}}),
            outcome: outcome.map(|o| (path, o)),
            ..Default::default()
        }
    }

    fn flags(names: &[&str]) -> Value {
        let mut f = json!({"operational": true, "ready": true});
        for n in names {
            f[*n] = json!(true);
            if *n != "ready" {
                f["ready"] = json!(false);
            }
        }
        f
    }

    fn job(text: &str, f: Value, completion: Option<f64>) -> Value {
        json!({"state": {"text": text, "flags": f, "error": ""},
               "job": {"file": {"path": "farmslicer/Clip-1a2b3c4d.gcode", "display": "Clip-1a2b3c4d.gcode"}},
               "progress": {"completion": completion, "printTimeLeft": 600}})
    }

    fn summary(s: &State) -> PrinterStatus {
        summarize(&Snapshot { state: s })
    }

    #[test]
    fn printing_and_paused() {
        let s = summary(&state(job("Printing", flags(&["printing"]), Some(42.4)), None));
        assert_eq!((s.state.as_deref(), s.percent, s.remaining_minutes), (Some("RUNNING"), Some(42), Some(10)));
        assert_eq!((s.job_key.as_deref(), s.job_file.as_deref()), (Some("Clip-1a2b3c4d"), Some("farmslicer/Clip-1a2b3c4d.gcode")));
        assert_eq!(s.nozzles, vec![Temperature { current: 210.3, target: 210.0 }]);
        assert_eq!(s.chamber, None);
        assert_eq!(summary(&state(job("Paused", flags(&["paused"]), Some(50.0)), None)).state.as_deref(), Some("PAUSE"));
    }

    #[test]
    fn the_end_comes_from_events() {
        let idle = || job("Operational", flags(&[]), Some(100.0));
        assert_eq!(summary(&state(idle(), None)).state.as_deref(), Some("IDLE"));
        assert_eq!(summary(&state(idle(), Some(Outcome::Done))).state.as_deref(), Some("FINISH"));
        assert_eq!(summary(&state(idle(), Some(Outcome::Cancelled))).state.as_deref(), Some("CANCELLED"));
        let failed = summary(&state(idle(), Some(Outcome::Failed("Thermal runaway".into()))));
        assert_eq!((failed.state.as_deref(), failed.message.as_deref()), (Some("FAILED"), Some("Thermal runaway")));
        // An outcome for another file says nothing about this one.
        let mut other = state(idle(), Some(Outcome::Done));
        other.outcome = Some(("farmslicer/other.gcode".into(), Outcome::Done));
        assert_eq!(summary(&other).state.as_deref(), Some("IDLE"));
    }

    #[test]
    fn octoprint_without_its_printer_is_offline() {
        let offline = json!({"state": {"text": "Offline", "flags": {"closedOrError": true}}, "job": {}, "progress": {}});
        let s = summary(&state(offline, None));
        assert!(!s.online);
        assert!(s.connection_error.unwrap().contains("not connected to the printer"));
        let error = json!({"state": {"text": "Error", "flags": {"error": true, "closedOrError": true}, "error": "Heater failure"},
                           "job": {}, "progress": {}});
        let s = summary(&state(error, None));
        assert_eq!((s.online, s.state.as_deref(), s.message.as_deref()), (true, Some("FAILED"), Some("Heater failure")));
    }
}
