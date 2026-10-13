//! Sending a print to a Bambu printer: FTPS upload of the `.gcode.3mf`,
//! then `project_file` with the plate, its MD5, the job name and the AMS
//! mapping, retried while the printer indexes the fresh upload.

use std::time::Duration;

use serde_json::{Value, json};

use super::ftps;
use crate::db::{PrintRecord, Printer};
use crate::package::Plate;
use crate::printer::{CommandError, DriverHandle};
use crate::printing::{self, PrintOptions, SendStep};
use crate::server::AppState;

const START_ATTEMPTS: u32 = 3;
const START_RETRY_DELAY: Duration = Duration::from_secs(2);
const ACK_WAIT: Duration = Duration::from_secs(5);

/// `ams_mapping` (tray id per filament, -1 for unused and external spools)
/// and `ams_mapping2` (`{ams_id, slot_id}`, 255/255 unused) as Bambu Studio
/// sends them, and whether any AMS tray is involved.
fn mapping_fields(mapping: &[i64]) -> (Vec<i64>, Vec<Value>, bool) {
    let mut v0 = Vec::new();
    let mut v1 = Vec::new();
    let mut use_ams = false;
    for &slot in mapping {
        match slot {
            s if s < 0 => {
                v0.push(-1);
                v1.push(json!({"ams_id": 255, "slot_id": 255}));
            }
            // External spools.
            254 | 255 => {
                v0.push(-1);
                v1.push(json!({"ams_id": slot, "slot_id": 0}));
            }
            // AMS HT units: one tray, numbered from 128.
            s if s >= 128 => {
                use_ams = true;
                v0.push(s);
                v1.push(json!({"ams_id": s, "slot_id": 0}));
            }
            s => {
                use_ams = true;
                v0.push(s);
                v1.push(json!({"ams_id": s / 4, "slot_id": s % 4}));
            }
        }
    }
    (v0, v1, use_ams)
}

pub fn start_command(print: &PrintRecord, plate: &Plate, mapping: &[i64], options: &PrintOptions) -> Value {
    let (v0, v1, use_ams) = mapping_fields(mapping);
    json!({"print": {
        "command": "project_file",
        "param": format!("Metadata/plate_{}.gcode", plate.index),
        "project_id": "0",
        "profile_id": "0",
        "task_id": "0",
        "subtask_id": "0",
        // Unique, so reports can be matched to this print (see
        // `printing::match_print`).
        "subtask_name": printing::task_name(print),
        "file": print.file_name,
        "url": format!("ftp://{}", print.file_name),
        "md5": plate.gcode_md5,
        "bed_type": "auto",
        "timelapse": options.timelapse,
        // Both spellings are seen in the wild.
        "bed_leveling": options.bed_leveling,
        "bed_levelling": options.bed_leveling,
        "flow_cali": options.flow_calibration,
        "vibration_cali": options.vibration_calibration,
        "layer_inspect": options.layer_inspect,
        "use_ams": use_ams,
        "ams_mapping": v0,
        "ams_mapping2": v1,
    }})
}

async fn request(state: &AppState, printer: &Printer, command: &Value) -> Result<Option<Value>, CommandError> {
    match state.printers.handle(&printer.id) {
        Some(DriverHandle::Bambu(h)) => h.request(command.clone(), ACK_WAIT).await,
        _ => Err(CommandError::NotConfigured),
    }
}

/// Upload the package and start the plate. `Ok` also when the printer
/// didn't confirm the start: the tracker decides from its reports.
#[allow(clippy::too_many_arguments)]
pub async fn send(
    state: &AppState,
    printer: &Printer,
    print: &PrintRecord,
    data: &[u8],
    plate: &Plate,
    mapping: &[i64],
    options: &PrintOptions,
    step: &mut (dyn FnMut(SendStep) + Send),
) -> Result<(), String> {
    ftps::upload(
        printer.address.trim(),
        ftps::FTPS_PORT,
        printer.access_code.trim(),
        &format!("/{}", print.file_name),
        data,
        |sent, total| step(SendStep::Uploading((sent * 100 / total.max(1)) as i64)),
    )
    .await
    .map_err(|e| format!("upload failed: {e}"))?;

    step(SendStep::Starting);
    println!("Print {}: uploaded; starting plate {} on {}", print.id, plate.index, printer.name);

    let command = start_command(print, plate, mapping, options);
    let mut last_problem = String::new();
    for attempt in 1..=START_ATTEMPTS {
        match request(state, printer, &command).await {
            Ok(Some(response)) => {
                let result = response["print"]["result"].as_str().unwrap_or("").to_ascii_uppercase();
                if result == "FAIL" {
                    let reason = response["print"]["reason"].as_str().unwrap_or("").trim().to_string();
                    last_problem = if reason.is_empty() {
                        "the printer refused to start the print".to_string()
                    } else {
                        format!("the printer refused to start the print: {reason}")
                    };
                } else {
                    println!("Print {}: the printer accepted the start ({result})", print.id);
                    return Ok(());
                }
            }
            // No answer: it may have started anyway; the tracker will tell.
            Ok(None) => {
                last_problem = "the printer didn't answer the start command".to_string();
                if printing::started_on_printer(state, print) {
                    return Ok(());
                }
            }
            Err(e) => last_problem = e.to_string(),
        }
        eprintln!("Print {}: start attempt {attempt}/{START_ATTEMPTS}: {last_problem}", print.id);
        // A fresh upload takes the printer a moment to index.
        if attempt < START_ATTEMPTS {
            tokio::time::sleep(START_RETRY_DELAY).await;
        }
    }
    if printing::started_on_printer(state, print) {
        return Ok(());
    }
    // A missing ack isn't proof of failure: leave the print `starting` for the
    // tracker, which gives up after a while.
    if last_problem.contains("didn't answer") {
        return Ok(());
    }
    Err(last_problem)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mapping_fields_match_bambu_studio() {
        let (v0, v1, use_ams) = mapping_fields(&[2, -1, 254, 129]);
        assert_eq!(v0, vec![2, -1, -1, 129]);
        assert_eq!(v1[0], json!({"ams_id": 0, "slot_id": 2}));
        assert_eq!(v1[1], json!({"ams_id": 255, "slot_id": 255}));
        assert_eq!(v1[2], json!({"ams_id": 254, "slot_id": 0}));
        assert_eq!(v1[3], json!({"ams_id": 129, "slot_id": 0}));
        assert!(use_ams);
        let (_, _, ext_only) = mapping_fields(&[255]);
        assert!(!ext_only);
    }
}
