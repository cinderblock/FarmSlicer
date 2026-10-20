//! A Prusa printer's state as PrusaLink reports it (`/api/v1/status`, plus
//! the job's file from `/api/v1/job`), summarized as a vendor-neutral
//! [`PrinterStatus`].
//!
//! Buddy firmware states: IDLE, BUSY (calibrating, loading filament, ...),
//! PRINTING (also while finishing or aborting), PAUSED, ATTENTION (a
//! question on the screen: wrong model or filament, runout, ...), FINISHED
//! and STOPPED (until someone closes the finish screen or the next print
//! starts). The job vanishes from the status once finished or stopped, so
//! the link remembers the last one.

use serde_json::Value;

use crate::printer::status::{PrinterStatus, Temperature, state};

/// The last job the printer reported.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LastJob {
    pub id: i64,
    /// The long file name (`display_name`); the short 8.3 one is useless.
    pub file: String,
}

pub struct Snapshot<'a> {
    pub connected: bool,
    pub error: Option<String>,
    pub updated_at: Option<String>,
    pub status: &'a Value,
    pub job: Option<&'a LastJob>,
}

fn stem(name: &str) -> String {
    let base = name.rsplit('/').next().unwrap_or(name);
    for ext in [".gcode", ".bgcode", ".gco", ".g"] {
        if let Some(s) = base.strip_suffix(ext) {
            return s.to_string();
        }
    }
    base.to_string()
}

pub fn summarize(s: &Snapshot) -> PrinterStatus {
    let printer = &s.status["printer"];
    let job = &s.status["job"];
    let vendor = printer["state"].as_str().unwrap_or("").to_string();
    let (st, message) = match vendor.as_str() {
        "IDLE" | "READY" => (Some(state::IDLE), None),
        "PRINTING" => (Some(state::RUNNING), None),
        "PAUSED" => (Some(state::PAUSE), None),
        // A question on the printer's screen holds the print until someone
        // answers it there.
        "ATTENTION" => (Some(state::PAUSE), Some("waiting for someone at the printer".to_string())),
        "FINISHED" => (Some(state::FINISH), None),
        "STOPPED" => (Some(state::CANCELLED), None),
        "ERROR" => (Some(state::FAILED), Some("the printer reports an error".to_string())),
        // Calibrating, loading filament, ...: not printing, not free.
        "BUSY" => (None, Some("busy at the printer (calibrating, loading filament, ...)".to_string())),
        _ => (None, None),
    };
    let active = matches!(vendor.as_str(), "PRINTING" | "PAUSED" | "ATTENTION");
    // The job's name while there is one, and after it ended until the
    // printer goes back to idle.
    let file = s.job.filter(|_| active || matches!(vendor.as_str(), "FINISHED" | "STOPPED")).map(|j| j.file.as_str());
    let temp = |current: &str, target: &str| {
        Some(Temperature { current: printer[current].as_f64()?, target: printer[target].as_f64().unwrap_or(0.0) })
    };

    PrinterStatus {
        printer_id: String::new(),
        online: s.connected,
        connection_error: s.error.clone(),
        updated_at: s.updated_at.clone(),
        state: st.map(String::from),
        vendor_state: Some(vendor.clone()).filter(|v| !v.is_empty()),
        stage: None,
        percent: if active {
            job["progress"].as_f64().map(|p| p.round() as i64)
        } else if vendor == "FINISHED" {
            Some(100)
        } else {
            None
        },
        remaining_minutes: if active { job["time_remaining"].as_f64().map(|t| (t / 60.0).round() as i64) } else { None },
        layer: None,
        total_layers: None,
        job_name: file.map(stem),
        job_key: file.map(stem),
        job_file: file.map(String::from),
        message,
        print_error: None,
        print_error_message: None,
        hms: Vec::new(),
        nozzles: temp("temp_nozzle", "target_nozzle").into_iter().collect(),
        bed: temp("temp_bed", "target_bed"),
        chamber: None,
        speed_level: None,
        speed_percent: printer["speed"].as_i64(),
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

    fn summary(status: Value, job: Option<&LastJob>) -> PrinterStatus {
        summarize(&Snapshot { connected: true, error: None, updated_at: None, status: &status, job })
    }

    #[test]
    fn states_and_the_remembered_job() {
        let job = LastJob { id: 312, file: "Clip-1a2b3c4d.gcode".into() };
        let printing = json!({"job": {"id": 312, "progress": 42.0, "time_remaining": 1840},
                              "printer": {"state": "PRINTING", "temp_nozzle": 214.8, "target_nozzle": 215.0,
                                          "temp_bed": 59.9, "target_bed": 60.0, "speed": 100}});
        let s = summary(printing, Some(&job));
        assert_eq!((s.state.as_deref(), s.percent, s.remaining_minutes), (Some("RUNNING"), Some(42), Some(31)));
        assert_eq!((s.job_key.as_deref(), s.job_file.as_deref()), (Some("Clip-1a2b3c4d"), Some("Clip-1a2b3c4d.gcode")));
        assert_eq!(s.bed, Some(Temperature { current: 59.9, target: 60.0 }));

        // Finished: the job is gone from the status, but it's still the last one.
        let s = summary(json!({"printer": {"state": "FINISHED"}}), Some(&job));
        assert_eq!((s.state.as_deref(), s.percent, s.job_key.as_deref()), (Some("FINISH"), Some(100), Some("Clip-1a2b3c4d")));
        let s = summary(json!({"printer": {"state": "STOPPED"}}), Some(&job));
        assert_eq!(s.state.as_deref(), Some("CANCELLED"));
        // Back to idle: no job to speak of.
        let s = summary(json!({"printer": {"state": "IDLE"}}), Some(&job));
        assert_eq!((s.state.as_deref(), s.job_key), (Some("IDLE"), None));
    }

    #[test]
    fn attention_and_busy() {
        let s = summary(json!({"job": {"id": 1}, "printer": {"state": "ATTENTION"}}), None);
        assert_eq!((s.state.as_deref(), s.message.as_deref()), (Some("PAUSE"), Some("waiting for someone at the printer")));
        let s = summary(json!({"printer": {"state": "BUSY"}}), None);
        assert_eq!(s.state, None);
        assert!(s.message.unwrap().contains("busy"));
    }
}
