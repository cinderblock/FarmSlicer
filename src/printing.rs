//! Sending jobs to printers: checks, the upload and start, and following the
//! print through the printer's reports.
//!
//! A print goes uploading → starting → printing ⇄ paused → finished |
//! failed | cancelled. The upload and start run in a background task; the
//! tracker ([`track`]) moves prints along as their printer reports.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::bambu::{ftps, models};
use crate::bambu::package::{Package, Plate};
use crate::bambu::status::{PrinterStatus, Tray};
use crate::db::{Job, Printer, PrintRecord};
use crate::profiles::ProfileStore;
use crate::server::AppState;

/// `print_error` for a print stopped by a person (0300_400C).
pub const PRINT_CANCELLED: i64 = 0x0300_400C;
const START_ATTEMPTS: u32 = 3;
const START_RETRY_DELAY: Duration = Duration::from_secs(2);
const ACK_WAIT: Duration = Duration::from_secs(5);
/// A print the printer hasn't picked up this long after the start command
/// is given up on.
const START_DEADLINE_SECS: i64 = 180;

/// Options for a print, as the send dialog offers them.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PrintOptions {
    #[serde(default = "yes")]
    pub bed_leveling: bool,
    #[serde(default = "yes")]
    pub flow_calibration: bool,
    #[serde(default = "yes")]
    pub vibration_calibration: bool,
    #[serde(default)]
    pub timelapse: bool,
    #[serde(default)]
    pub layer_inspect: bool,
}

fn yes() -> bool {
    true
}

impl Default for PrintOptions {
    fn default() -> Self {
        Self {
            bed_leveling: true,
            flow_calibration: true,
            vibration_calibration: true,
            timelapse: false,
            layer_inspect: false,
        }
    }
}

// -- Compatibility ---------------------------------------------------------------

/// Model ids that print each other's files: the X1 family, the P1 family.
const FAMILIES: &[&[&str]] = &[&["BL-P001", "BL-P002", "C13"], &["C11", "C12"]];

fn same_family(a: &str, b: &str) -> bool {
    a == b || FAMILIES.iter().any(|f| f.contains(&a) && f.contains(&b))
}

/// Why `plate` can't print on `printer`, if it can't.
pub fn incompatibility(store: &ProfileStore, printer: &Printer, plate: &Plate) -> Option<String> {
    if printer.protocol != "bambu" {
        return Some(format!("{} isn't a Bambu Lab printer", printer.name));
    }
    let have = store
        .machine_model(&printer.machine_profile)
        .and_then(|m| m.model_id.clone())
        .or_else(|| models::id_for(&printer.machine_profile).map(String::from));
    if let (Some(want), Some(have)) = (plate.printer_model_id.as_deref(), have.as_deref()) {
        if !same_family(want, have) {
            let sliced_for = store
                .machine_model_by_id(want)
                .map(|m| m.name.clone())
                .or_else(|| models::name_for(want).map(String::from))
                .unwrap_or_else(|| format!("model {want}"));
            return Some(format!(
                "sliced for {sliced_for}; {} is a {}",
                printer.name, printer.machine_profile
            ));
        }
    }
    if let Some(nozzles) = plate.nozzle_diameters.as_deref() {
        let wanted: Vec<f64> = nozzles.split([',', ';']).filter_map(|n| n.trim().parse().ok()).collect();
        if let Ok(have) = printer.nozzle_diameter.trim().parse::<f64>() {
            if !wanted.is_empty() && wanted.iter().any(|w| (w - have).abs() > 1e-6) {
                return Some(format!(
                    "sliced for a {nozzles} mm nozzle; {} has {} mm",
                    printer.name, printer.nozzle_diameter
                ));
            }
        }
    }
    None
}

// -- Rules -----------------------------------------------------------------------

fn minutes_text(m: u32) -> String {
    match (m / 60, m % 60) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

/// Why `plate` breaks `rules` (empty = it doesn't).
pub fn rule_violations(rules: &crate::groups::PrintRules, plate: &Plate) -> Vec<String> {
    let mut out = Vec::new();
    // The time the G-code check settled on: the package's own, unless its
    // G-code takes clearly longer.
    if let (Some(max), Some(secs)) = (rules.max_minutes, crate::gcode::effective_time(plate)) {
        let minutes = (secs / 60.0).ceil() as u32;
        if minutes > max {
            out.push(format!(
                "takes {}; the limit is {}",
                minutes_text(minutes),
                minutes_text(max)
            ));
        }
    }
    if let Some(allowed) = &rules.materials {
        for f in &plate.filaments {
            if !allowed.iter().any(|a| a.trim().eq_ignore_ascii_case(f.material.trim())) {
                out.push(format!("{} isn't allowed (allowed: {})", f.material, allowed.join(", ")));
            }
        }
    }
    out.dedup();
    out
}

// -- AMS mapping -----------------------------------------------------------------

fn rgb(hex: &str) -> Option<(f64, f64, f64)> {
    let h = hex.trim_start_matches('#');
    if h.len() < 6 {
        return None;
    }
    let c = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok().map(f64::from);
    Some((c(0)?, c(2)?, c(4)?))
}

/// Perceptual-ish distance ("redmean").
fn color_distance(a: &str, b: &str) -> f64 {
    match (rgb(a), rgb(b)) {
        (Some((r1, g1, b1)), Some((r2, g2, b2))) => {
            let rm = (r1 + r2) / 2.0;
            let (dr, dg, db) = (r1 - r2, g1 - g2, b1 - b2);
            ((2.0 + rm / 256.0) * dr * dr + 4.0 * dg * dg + (2.0 + (255.0 - rm) / 256.0) * db * db).sqrt()
        }
        _ => f64::MAX / 2.0,
    }
}

fn loaded_trays(status: &PrinterStatus) -> Vec<&Tray> {
    status
        .ams
        .iter()
        .flat_map(|u| u.trays.iter())
        .chain(status.external.iter())
        .filter(|t| t.material.is_some())
        .collect()
}

/// A tray for each filament the plate uses: same material, nearest colour,
/// each tray used once while unused ones remain. Index = filament id - 1;
/// -1 = not used by this plate (or nothing suitable is loaded).
pub fn suggest_mapping(plate: &Plate, status: Option<&PrinterStatus>) -> Vec<i64> {
    let len = plate.filaments.iter().map(|f| f.id as usize).max().unwrap_or(0);
    let mut mapping = vec![-1i64; len];
    let Some(status) = status else { return mapping };
    let trays = loaded_trays(status);
    let mut used: Vec<i64> = Vec::new();
    for f in &plate.filaments {
        let candidates = trays
            .iter()
            .filter(|t| t.material.as_deref().is_some_and(|m| m.eq_ignore_ascii_case(&f.material)));
        let best = candidates
            .map(|t| {
                let reuse_penalty = if used.contains(&t.slot) { 1e6 } else { 0.0 };
                (t.slot, color_distance(&f.color, t.color.as_deref().unwrap_or("")) + reuse_penalty)
            })
            .min_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((slot, _)) = best {
            mapping[f.id as usize - 1] = slot;
            used.push(slot);
        }
    }
    mapping
}

/// Build plates as libslic3r names them (`curr_bed_type`).
pub const BED_TYPES: &[&str] = &[
    "Textured PEI Plate",
    "Cool Plate",
    "Engineering Plate",
    "High Temp Plate",
    "Textured Cool Plate",
    "Supertack Plate",
];

/// The plate was sliced for another build plate than the printer has.
pub fn plate_problem(plate: &Plate, printer: &Printer) -> Option<String> {
    let want = plate.bed_type.as_deref()?;
    let have = printer.plate_type.trim();
    (!have.is_empty() && !want.eq_ignore_ascii_case(have))
        .then(|| format!("sliced for the {want}; {} has the {have}", printer.name))
}

/// Problems with a mapping against what's loaded. Empty = fine.
pub fn check_mapping(plate: &Plate, mapping: &[i64], status: Option<&PrinterStatus>) -> Vec<String> {
    let mut problems = Vec::new();
    let trays: Vec<&Tray> = status.map(loaded_trays).unwrap_or_default();
    for f in &plate.filaments {
        let slot = mapping.get(f.id as usize - 1).copied().unwrap_or(-1);
        if slot < 0 {
            problems.push(format!("filament {} ({}) has no tray", f.id, f.material));
            continue;
        }
        match trays.iter().find(|t| t.slot == slot) {
            None => problems.push(format!("filament {} ({}): slot {slot} is empty", f.id, f.material)),
            Some(t) if !t.material.as_deref().unwrap_or("").eq_ignore_ascii_case(&f.material) => {
                problems.push(format!(
                    "filament {} is {} but slot {slot} holds {}",
                    f.id,
                    f.material,
                    t.material.as_deref().unwrap_or("?")
                ))
            }
            Some(_) => {}
        }
    }
    problems
}

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
        // Unique, so reports can be matched to this print (see `match_print`).
        "subtask_name": task_name(print),
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

// -- Names -----------------------------------------------------------------------

/// What the printer shows: the model's name without extensions or odd
/// characters.
pub fn display_name(model_name: &str) -> String {
    let mut stem = model_name.rsplit(['/', '\\']).next().unwrap_or(model_name).to_string();
    for ext in [".gcode.3mf", ".3mf", ".gcode", ".stl", ".step", ".stp", ".obj", ".amf"] {
        if stem.to_ascii_lowercase().ends_with(ext) {
            stem.truncate(stem.len() - ext.len());
            break;
        }
    }
    let cleaned: String = stem
        .chars()
        .map(|c| if c.is_alphanumeric() || " _-().+".contains(c) { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim();
    let short: String = trimmed.chars().take(48).collect();
    if short.is_empty() { "print".to_string() } else { short }
}

/// The file's name on the printer: unique per print so reports can't be
/// confused with another print of the same model.
pub fn file_name(display: &str, print_id: &str) -> String {
    format!("{}-{}.gcode.3mf", display.replace(' ', "_"), &print_id[..8])
}

// -- Sending ---------------------------------------------------------------------

pub fn package_of(job: &Job) -> Option<Package> {
    serde_json::from_str(job.package_json.as_deref()?).ok()
}

/// Upload and start `print` (already recorded, status `uploading`) in the
/// background.
pub fn spawn_send(state: Arc<AppState>, print: PrintRecord, package_path: String, plate: Plate, mapping: Vec<i64>, options: PrintOptions) {
    tokio::spawn(async move {
        if let Err(e) = send(&state, &print, &package_path, &plate, &mapping, &options).await {
            eprintln!("Print {} ({} on {}): {e}", print.id, print.name, print.printer_name);
            state.db.update_print(&print.id, "failed", None, Some(&e));
        }
    });
}

async fn send(
    state: &Arc<AppState>,
    print: &PrintRecord,
    package_path: &str,
    plate: &Plate,
    mapping: &[i64],
    options: &PrintOptions,
) -> Result<(), String> {
    let printer = print
        .printer_id
        .as_deref()
        .and_then(|id| state.db.get_printer(id))
        .ok_or("the printer was removed")?;
    let data = tokio::fs::read(package_path)
        .await
        .map_err(|e| format!("can't read the package: {e}"))?;
    println!(
        "Print {}: uploading {} ({} bytes) to {} at {}",
        print.id,
        print.file_name,
        data.len(),
        printer.name,
        printer.address
    );

    let db = state.db.clone();
    let id = print.id.clone();
    let mut last = -1i64;
    ftps::upload(
        printer.address.trim(),
        ftps::FTPS_PORT,
        printer.access_code.trim(),
        &format!("/{}", print.file_name),
        &data,
        |sent, total| {
            let pct = (sent * 100 / total.max(1)) as i64;
            if pct / 5 != last / 5 {
                last = pct;
                db.update_print(&id, "uploading", Some(pct), None);
            }
        },
    )
    .await
    .map_err(|e| format!("upload failed: {e}"))?;

    state.db.update_print(&print.id, "starting", Some(0), None);
    println!("Print {}: uploaded; starting plate {} on {}", print.id, plate.index, printer.name);

    let command = start_command(print, plate, mapping, options);
    let mut last_problem = String::new();
    for attempt in 1..=START_ATTEMPTS {
        match state.printers.command(&printer.id, command.clone(), ACK_WAIT).await {
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
                if started_on_printer(state, print) {
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
    if started_on_printer(state, print) {
        return Ok(());
    }
    // A missing ack isn't proof of failure: leave the print `starting` for the
    // tracker, which gives up after START_DEADLINE_SECS.
    if last_problem.contains("didn't answer") {
        return Ok(());
    }
    Err(last_problem)
}

fn started_on_printer(state: &AppState, print: &PrintRecord) -> bool {
    print
        .printer_id
        .as_deref()
        .and_then(|id| state.printers.status(id))
        .is_some_and(|s| {
            match_print(print, &s) != Match::Other && matches!(s.state.as_deref(), Some("PREPARE" | "RUNNING" | "PAUSE"))
        })
}

// -- Tracking --------------------------------------------------------------------

/// The job name we send (and the printer shows): the file's stem, unique per
/// print.
pub fn task_name(print: &PrintRecord) -> String {
    print.file_name.strip_suffix(".gcode.3mf").unwrap_or(&print.file_name).to_string()
}

#[derive(Debug, PartialEq)]
enum Match {
    /// The report names this print.
    Ours,
    /// The report names no job we can tell apart (LAN starts may report
    /// "project_file" or nothing).
    Unnamed,
    /// The report names another job.
    Other,
}

/// Is the printer's current job this print? Real printers report the
/// extracted plate as `gcode_file` (`/data/Metadata/plate_1.gcode`), so the
/// unique job name we sent is what identifies it.
fn match_print(print: &PrintRecord, status: &PrinterStatus) -> Match {
    if status.gcode_file.as_deref().is_some_and(|f| f.contains(&print.file_name)) {
        return Match::Ours;
    }
    match status.subtask_name.as_deref() {
        Some(s) if s == task_name(print) => Match::Ours,
        None | Some("project_file") => Match::Unnamed,
        Some(_) => Match::Other,
    }
}

/// What a printer report means for one of our prints on it: the new status,
/// progress and error, or None to leave it alone.
pub fn transition(print: &PrintRecord, status: &PrinterStatus) -> Option<(&'static str, Option<i64>, Option<String>)> {
    if !status.online {
        return None;
    }
    let state = status.state.as_deref().unwrap_or("");
    let started = matches!(print.status.as_str(), "printing" | "paused");
    match match_print(print, status) {
        // Until the printer picks our file up it still reports the previous
        // job, which may be unnamed too: an unnamed report only starts our
        // print (it is the one just sent), it can't finish a print not yet
        // seen running.
        Match::Unnamed if !started => {
            return matches!(state, "PREPARE" | "RUNNING").then(|| ("printing", status.percent, None));
        }
        // Real printers switch subtask_name to the new job a moment before
        // gcode_state leaves the previous job's FINISH/FAILED: a print not
        // yet seen running can only start.
        Match::Ours if !started => {
            return match state {
                "PREPARE" | "RUNNING" | "SLICING" => Some(("printing", status.percent, None)),
                "PAUSE" => Some(("paused", status.percent, None)),
                _ => None,
            };
        }
        Match::Ours | Match::Unnamed => {}
        Match::Other => {
            if started && matches!(state, "PREPARE" | "RUNNING" | "PAUSE") {
                return Some(("failed", None, Some("another print replaced it on the printer".to_string())));
            }
            return None;
        }
    }
    match state {
        "PREPARE" | "RUNNING" | "SLICING" => Some(("printing", status.percent, None)),
        "PAUSE" => Some(("paused", status.percent, None)),
        "FINISH" => Some(("finished", Some(100), None)),
        "FAILED" => match status.print_error {
            Some(PRINT_CANCELLED) => Some(("cancelled", None, None)),
            None => Some(("failed", None, Some("the printer reported the print as failed".to_string()))),
            Some(code) => Some((
                "failed",
                None,
                Some(format!("printer error {:04X}_{:04X}", (code >> 16) & 0xFFFF, code & 0xFFFF)),
            )),
        },
        "IDLE" if matches!(print.status.as_str(), "printing" | "paused") => {
            Some(("cancelled", None, Some("the printer went idle before finishing".to_string())))
        }
        _ => None,
    }
}

fn apply(state: &AppState, status: &PrinterStatus) {
    for print in state.db.list_prints(Some(&status.printer_id), true, 20) {
        // The background task owns uploads.
        if print.status == "uploading" {
            continue;
        }
        if let Some((new_status, progress, error)) = transition(&print, status) {
            if state.db.update_print(&print.id, new_status, progress, error.as_deref()) && new_status != print.status {
                println!(
                    "Print {} ({} on {}): {} -> {new_status}{}",
                    print.id,
                    print.name,
                    print.printer_name,
                    print.status,
                    error.map(|e| format!(" ({e})")).unwrap_or_default()
                );
            }
        }
    }
}

/// Follow every active print through its printer's reports, and give up on
/// prints the printer never picked up.
pub async fn track(state: Arc<AppState>) {
    let mut events = state.printers.subscribe();
    let mut sweep = tokio::time::interval(Duration::from_secs(30));
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(status) => apply(&state, &status),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    for status in state.printers.statuses() {
                        apply(&state, &status);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            },
            _ = sweep.tick() => {
                for print in state.db.list_prints(None, true, 200) {
                    if print.status == "starting" && age_secs(&print.updated_at) > START_DEADLINE_SECS {
                        state.db.update_print(&print.id, "failed", None, Some("the printer never started this print"));
                        eprintln!("Print {}: never started on {}; giving up", print.id, print.printer_name);
                    }
                    // A print whose upload task died with the process.
                    if print.status == "uploading" && age_secs(&print.updated_at) > 15 * 60 {
                        state.db.update_print(&print.id, "failed", None, Some("the upload was interrupted"));
                    }
                }
            }
        }
    }
}

fn age_secs(sqlite_time: &str) -> i64 {
    chrono::NaiveDateTime::parse_from_str(sqlite_time, "%Y-%m-%d %H:%M:%S")
        .map(|t| (chrono::Utc::now().naive_utc() - t).num_seconds())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bambu::package::FilamentUse;
    use crate::bambu::status::AmsUnit;

    fn tray(slot: i64, material: &str, color: &str) -> Tray {
        Tray {
            slot,
            unit: Some(slot / 4),
            index: slot % 4,
            material: Some(material.into()),
            color: Some(color.into()),
            name: None,
            remain: None,
            nozzle_temp_min: None,
            nozzle_temp_max: None,
        }
    }

    fn status_with(trays: Vec<Tray>) -> PrinterStatus {
        let mut s = PrinterStatus::offline("p", None);
        s.online = true;
        s.ams = vec![AmsUnit { id: 0, humidity: None, nozzle: None, trays }];
        s
    }

    fn plate(filaments: Vec<(u32, &str, &str)>) -> Plate {
        Plate {
            index: 1,
            printer_model_id: Some("C12".into()),
            nozzle_diameters: Some("0.4".into()),
            print_time_sec: None,
            weight_g: None,
            filaments: filaments
                .into_iter()
                .map(|(id, m, c)| FilamentUse {
                    id,
                    material: m.into(),
                    color: c.into(),
                    filament_id: String::new(),
                    used_g: 1.0,
                    used_m: 1.0,
                })
                .collect(),
            has_thumbnail: false,
            gcode_md5: "X".into(),
            bed_type: None,
            check: None,
        }
    }

    #[test]
    fn mapping_prefers_material_then_colour() {
        let s = status_with(vec![
            tray(0, "PLA", "#FFFFFF"),
            tray(1, "PETG", "#FF0000"),
            tray(2, "PLA", "#FF1010"),
            tray(3, "PLA", "#000000"),
        ]);
        let p = plate(vec![(1, "PLA", "#EE0000"), (3, "PLA", "#FAFAFA"), (4, "ABS", "#000000")]);
        let m = suggest_mapping(&p, Some(&s));
        assert_eq!(m, vec![2, -1, 0, -1]);
        let problems = check_mapping(&p, &m, Some(&s));
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(problems[0].contains("ABS"));
    }

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

    #[test]
    fn names_are_safe_and_unique() {
        assert_eq!(display_name("C:\\parts\\Bracket v2 (final).3mf"), "Bracket v2 (final)");
        assert_eq!(display_name("weird/na\"me.gcode.3mf"), "na_me");
        assert_eq!(file_name("Bracket v2", "1a2b3c4d-xxxx"), "Bracket_v2-1a2b3c4d.gcode.3mf");
    }

    fn record(status: &str) -> PrintRecord {
        PrintRecord {
            id: "1a2b3c4d".into(),
            job_id: None,
            plate: 1,
            printer_id: Some("p".into()),
            printer_name: "P".into(),
            user_id: None,
            username: None,
            group_id: None,
            file_name: "Bracket-1a2b3c4d.gcode.3mf".into(),
            name: "Bracket".into(),
            ams_mapping: None,
            options: None,
            approval_reason: None,
            decided_by: None,
            safety_review: false,
            status: status.into(),
            progress: 0,
            error: None,
            created_at: String::new(),
            started_at: None,
            finished_at: None,
            updated_at: String::new(),
        }
    }

    /// A report as real printers send it: the plate as gcode_file, the job
    /// in subtask_name.
    fn report(state: &str, subtask: Option<&str>, error: Option<i64>) -> PrinterStatus {
        let mut s = PrinterStatus::offline("p", None);
        s.online = true;
        s.state = Some(state.into());
        s.gcode_file = Some("/data/Metadata/plate_1.gcode".into());
        s.subtask_name = subtask.map(String::from);
        s.percent = Some(40);
        s.print_error = error;
        s
    }

    #[test]
    fn transitions_follow_the_printer() {
        let ours = Some("Bracket-1a2b3c4d");
        let starting = record("starting");
        assert_eq!(task_name(&starting), "Bracket-1a2b3c4d");
        // The previous job is still on show: wait.
        assert_eq!(transition(&starting, &report("FINISH", Some("Rail Section"), None)), None);
        // Seen on an X1C: our name with the previous job's FINISH, for a second.
        assert_eq!(transition(&starting, &report("FINISH", ours, None)), None);
        assert_eq!(transition(&starting, &report("FAILED", ours, Some(PRINT_CANCELLED))), None);
        assert_eq!(transition(&starting, &report("RUNNING", ours, None)).unwrap().0, "printing");
        let printing = record("printing");
        assert_eq!(transition(&printing, &report("PAUSE", ours, None)).unwrap().0, "paused");
        assert_eq!(transition(&printing, &report("FINISH", ours, None)).unwrap().0, "finished");
        assert_eq!(transition(&printing, &report("FAILED", ours, Some(PRINT_CANCELLED))).unwrap().0, "cancelled");
        let failed = transition(&printing, &report("FAILED", ours, Some(0x0500_4038))).unwrap();
        assert_eq!((failed.0, failed.2.as_deref()), ("failed", Some("printer error 0500_4038")));
        assert_eq!(transition(&printing, &report("RUNNING", Some("Other job"), None)).unwrap().0, "failed");
    }

    #[test]
    fn unnamed_reports_only_start_a_print() {
        let starting = record("starting");
        // A finished, unnamed previous job must not finish our new print.
        assert_eq!(transition(&starting, &report("FINISH", Some("project_file"), None)), None);
        assert_eq!(transition(&starting, &report("FINISH", None, None)), None);
        assert_eq!(transition(&starting, &report("PREPARE", Some("project_file"), None)).unwrap().0, "printing");
        // Once running, the unnamed job is ours.
        let printing = record("printing");
        assert_eq!(transition(&printing, &report("FINISH", Some("project_file"), None)).unwrap().0, "finished");
    }

    #[test]
    fn rules_name_what_they_break() {
        use crate::groups::PrintRules;
        let mut p = plate(vec![(1, "PLA", "#FFFFFF"), (2, "PETG", "#000000")]);
        p.print_time_sec = Some(4.0 * 3600.0 + 61.0);
        let rules = PrintRules { max_minutes: Some(240), materials: Some(vec!["pla".into(), "PLA-CF".into()]) };
        let v = rule_violations(&rules, &p);
        assert_eq!(v, vec![
            "takes 4 h 2 min; the limit is 4 h".to_string(),
            "PETG isn't allowed (allowed: pla, PLA-CF)".to_string(),
        ]);
        assert!(rule_violations(&PrintRules::default(), &p).is_empty());
    }

    #[test]
    fn families_are_interchangeable() {
        assert!(same_family("BL-P001", "C13"));
        assert!(same_family("C11", "C12"));
        assert!(!same_family("C12", "N1"));
        assert!(!same_family("O1D", "O1E"));
    }
}
