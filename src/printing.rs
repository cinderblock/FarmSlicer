//! Sending jobs to printers: checks, the upload and start, and following the
//! print through the printer's reports.
//!
//! A print goes uploading → starting → printing ⇄ paused → finished |
//! failed | cancelled. The upload and start run in a background task; the
//! tracker ([`track`]) moves prints along as their printer reports.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::bambu::models;
use crate::db::{Job, Printer, PrintRecord};
use crate::package::{FilamentUse, Package, PackageFormat, Plate};
use crate::printer::status::{PrinterStatus, Tray, state};
use crate::printer::{Protocol, protocol_of};
use crate::profiles::ProfileStore;
use crate::server::AppState;

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

/// Why `plate` (of a package in `format`) can't print on `printer`, if it
/// can't.
pub fn incompatibility(store: &ProfileStore, printer: &Printer, format: PackageFormat, plate: &Plate) -> Option<String> {
    let Some(protocol) = protocol_of(printer) else {
        return Some(format!("FarmSlicer can't send prints to {} printers", printer.protocol));
    };
    // Other firmware takes plain G-code, or a project's plate sliced for it
    // (sent as its G-code).
    let takes = protocol.capabilities().package;
    let other_firmware = format == PackageFormat::Gcode || plate.for_other_firmware();
    match takes {
        PackageFormat::Bambu3mf if format == PackageFormat::Gcode => {
            return Some(format!("{} takes {}; this is {}", printer.name, takes.label(), format.label()));
        }
        PackageFormat::Bambu3mf if other_firmware => {
            let model = plate.printer_model.as_deref().unwrap_or("another make's printer");
            return Some(format!("sliced for {}; {} is a Bambu Lab printer", with_article(model), printer.name));
        }
        PackageFormat::Gcode if !other_firmware => {
            return Some(format!("{} takes {}; this is {}", printer.name, takes.label(), format.label()));
        }
        _ => {}
    }
    let model_problem =
        if other_firmware { model_problem(store, printer, plate) } else { bambu_model_problem(store, printer, plate) };
    if model_problem.is_some() {
        return model_problem;
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

/// "a Prusa MK4S", "an Elegoo Centauri Carbon".
fn with_article(model: &str) -> String {
    let vowel = model.chars().next().is_some_and(|c| "AEIOUaeiou".contains(c));
    format!("{} {model}", if vowel { "an" } else { "a" })
}

/// Plain G-code: the model it was sliced for must be the printer's, when
/// the slicer named a model OrcaSlicer's profiles know (other slicers name
/// models their own way: "MK4S" for "Prusa MK4S").
fn model_problem(store: &ProfileStore, printer: &Printer, plate: &Plate) -> Option<String> {
    let want = plate.printer_model.as_deref()?.trim();
    let have = printer.machine_profile.trim();
    if have.is_empty() || want.eq_ignore_ascii_case(have) || store.machine_model(want).is_none() {
        return None;
    }
    Some(format!("sliced for {want}; {} is {}", printer.name, with_article(have)))
}

/// Bambu projects carry the model id (`C12`); families print each other's.
fn bambu_model_problem(store: &ProfileStore, printer: &Printer, plate: &Plate) -> Option<String> {
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
                "sliced for {sliced_for}; {} is {}",
                printer.name,
                with_article(&printer.machine_profile)
            ));
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
pub(crate) fn color_distance(a: &str, b: &str) -> f64 {
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
    status.loaded_trays()
}

/// Can `tray` feed filament `f`'s nozzle? Unknown either way counts as yes.
fn same_nozzle(f: &FilamentUse, tray: &Tray) -> bool {
    match (f.nozzle, tray.nozzle) {
        (Some(want), Some(have)) => want == have,
        _ => true,
    }
}

fn nozzle_name(n: i64) -> &'static str {
    if n == 1 { "left" } else { "right" }
}

/// Does sending to `printer` map the plate's filaments to its trays (Bambu's
/// AMS)? Elsewhere the G-code names its tools and people load the spools.
pub fn maps_filaments(printer: &Printer) -> bool {
    protocol_of(printer).is_some_and(|p| p.capabilities().filament_mapping)
}

/// The filament mapping to send with a print: the one asked for, or the
/// suggestion; none for printers that don't map filaments.
pub fn mapping_for(printer: &Printer, plate: &Plate, asked: Option<Vec<i64>>, status: Option<&PrinterStatus>) -> Vec<i64> {
    if !maps_filaments(printer) {
        return Vec::new();
    }
    asked.unwrap_or_else(|| suggest_mapping(plate, status))
}

/// Everything wrong with sending `plate` to `printer` with `mapping` as
/// things stand: the build plate, and the trays (where mapped).
pub fn send_problems(plate: &Plate, printer: &Printer, mapping: &[i64], status: Option<&PrinterStatus>) -> Vec<String> {
    let mut problems: Vec<String> = plate_problem(plate, printer).into_iter().collect();
    if maps_filaments(printer) {
        problems.extend(check_mapping(plate, mapping, status));
    }
    problems
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
        // Same material, and on dual-nozzle printers an AMS that feeds the
        // nozzle the slicer gave the filament.
        let candidates = trays.iter().filter(|t| {
            t.material.as_deref().is_some_and(|m| m.eq_ignore_ascii_case(&f.material)) && same_nozzle(f, t)
        });
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
            Some(t) if !same_nozzle(f, t) => problems.push(format!(
                "filament {} prints from the {} nozzle but slot {slot} feeds the {} one",
                f.id,
                nozzle_name(f.nozzle.unwrap_or(1)),
                nozzle_name(t.nozzle.unwrap_or(2))
            )),
            Some(_) => {}
        }
    }
    problems
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
/// confused with another print of the same model, and plain ASCII
/// (PrusaLink refuses anything else).
pub fn file_name(display: &str, print_id: &str, format: PackageFormat) -> String {
    let safe: String = display
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "-_.".contains(c) { c } else { '_' })
        .collect();
    format!("{safe}-{}{}", &print_id[..8], format.extension())
}

/// The format `printer` receives a package in `format` as: other firmware
/// gets a project's plate as plain G-code.
pub fn sent_as(printer: &Printer, format: PackageFormat) -> PackageFormat {
    protocol_of(printer).map_or(format, |p| p.capabilities().package)
}

// -- Sending ---------------------------------------------------------------------

pub fn package_of(job: &Job) -> Option<Package> {
    serde_json::from_str(job.package_json.as_deref()?).ok()
}

/// How far a send has got, as the driver reports it.
pub enum SendStep {
    /// Upload progress in percent.
    Uploading(i64),
    /// Uploaded; the start command goes out.
    Starting,
}

/// Upload and start `print` (already recorded, status `uploading`) in the
/// background.
pub fn spawn_send(state: Arc<AppState>, print: PrintRecord, package_path: String, plate: Plate, mapping: Vec<i64>, options: PrintOptions) {
    tokio::spawn(async move {
        if let Err(e) = send(&state, &print, &package_path, &plate, &mapping, &options).await {
            eprintln!("Print {} ({} on {}): {e}", print.id, print.name, print.printer_name);
            state.db.update_print(&print.id, "failed", None, Some(&e));
            crate::incidents::print_failed(&state, &print, &e);
            crate::queue::print_ended(&state, &print, "failed");
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
    // Other firmware takes the plate's G-code, out of a project if need be.
    let path = std::path::PathBuf::from(package_path);
    let index = plate.index;
    let plain = sent_as(&printer, PackageFormat::Bambu3mf) == PackageFormat::Gcode;
    let data = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let format = crate::package::sniff(&path)?;
        if plain {
            crate::package::plate_gcode(&path, format, index)
        } else {
            std::fs::read(&path).map_err(|e| format!("can't read the package: {e}"))
        }
    })
    .await
    .map_err(|e| format!("can't read the package: {e}"))??;
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
    let mut step = move |step: SendStep| match step {
        SendStep::Uploading(pct) => {
            if pct / 5 != last / 5 {
                last = pct;
                db.update_print(&id, "uploading", Some(pct), None);
            }
        }
        SendStep::Starting => {
            db.update_print(&id, "starting", Some(0), None);
        }
    };
    match protocol_of(&printer) {
        Some(Protocol::Bambu) => {
            crate::bambu::send::send(state, &printer, print, &data, plate, mapping, options, &mut step).await
        }
        Some(Protocol::Moonraker) => crate::moonraker::send(state, &printer, print, &data, &mut step).await,
        Some(Protocol::OctoPrint) => crate::octoprint::send(state, &printer, print, &data, &mut step).await,
        Some(Protocol::PrusaLink) => crate::prusalink::send(state, &printer, print, &data, &mut step).await,
        Some(Protocol::Sdcp) => crate::sdcp::send(state, &printer, print, &data, plate, options, &mut step).await,
        None => Err(format!("FarmSlicer can't send prints to {} printers", printer.protocol)),
    }
}

/// Has the printer picked `print` up?
pub(crate) fn started_on_printer(state: &AppState, print: &PrintRecord) -> bool {
    print
        .printer_id
        .as_deref()
        .and_then(|id| state.printers.status(id))
        .is_some_and(|s| {
            match_print(print, &s) != Match::Other
                && matches!(s.state.as_deref(), Some(state::PREPARE | state::RUNNING | state::PAUSE))
        })
}

// -- Tracking --------------------------------------------------------------------

/// The job name we send (and the printer shows): the file's stem, unique per
/// print.
pub fn task_name(print: &PrintRecord) -> String {
    let name = &print.file_name;
    [PackageFormat::Bambu3mf, PackageFormat::Gcode]
        .iter()
        .find_map(|f| name.strip_suffix(f.extension()))
        .unwrap_or(name)
        .to_string()
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

/// Is the printer's current job this print? The file we sent, or the unique
/// job name (Bambu printers report the extracted plate as the file,
/// `/data/Metadata/plate_1.gcode`, so the name is what identifies it there).
fn match_print(print: &PrintRecord, status: &PrinterStatus) -> Match {
    if status.job_file.as_deref().is_some_and(|f| f.contains(&print.file_name)) {
        return Match::Ours;
    }
    match status.job_key.as_deref() {
        Some(s) if s == task_name(print) => Match::Ours,
        None => Match::Unnamed,
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
            return matches!(state, state::PREPARE | state::RUNNING).then(|| ("printing", status.percent, None));
        }
        // Bambu printers switch the job name to the new job a moment before
        // the state leaves the previous job's FINISH/FAILED: a print not yet
        // seen running can only start.
        Match::Ours if !started => {
            return match state {
                state::PREPARE | state::RUNNING | state::SLICING => Some(("printing", status.percent, None)),
                state::PAUSE => Some(("paused", status.percent, None)),
                _ => None,
            };
        }
        Match::Ours | Match::Unnamed => {}
        Match::Other => {
            if started && matches!(state, state::PREPARE | state::RUNNING | state::PAUSE) {
                return Some(("failed", None, Some("another print replaced it on the printer".to_string())));
            }
            return None;
        }
    }
    match state {
        state::PREPARE | state::RUNNING | state::SLICING => Some(("printing", status.percent, None)),
        state::PAUSE => Some(("paused", status.percent, None)),
        state::FINISH => Some(("finished", Some(100), None)),
        state::CANCELLED => Some(("cancelled", None, None)),
        state::FAILED => Some((
            "failed",
            None,
            Some(match (status.print_error, &status.message) {
                (Some(code), _) => {
                    let code = format!("printer error {:04X}_{:04X}", (code >> 16) & 0xFFFF, code & 0xFFFF);
                    match &status.print_error_message {
                        Some(text) => format!("{code}: {text}"),
                        None => code,
                    }
                }
                (None, Some(message)) => format!("the printer reported the print as failed: {message}"),
                (None, None) => "the printer reported the print as failed".to_string(),
            }),
        )),
        state::IDLE if matches!(print.status.as_str(), "printing" | "paused") => {
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
        // Errors the printer raises while it prints our job.
        if matches!(print.status.as_str(), "printing" | "paused") && match_print(&print, status) == Match::Ours {
            crate::incidents::printer_errors(state, &print, status);
        }
        if let Some((new_status, progress, error)) = transition(&print, status) {
            if new_status == "failed" && print.status != "failed" {
                crate::incidents::print_failed(state, &print, error.as_deref().unwrap_or("the print failed"));
            }
            if state.db.update_print(&print.id, new_status, progress, error.as_deref()) && new_status != print.status {
                if matches!(new_status, "finished" | "failed" | "cancelled") {
                    crate::outcomes::record_automatic(state, &print, new_status, error.as_deref());
                    crate::queue::print_ended(state, &print, new_status);
                }
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
                        crate::incidents::print_failed(&state, &print, "the printer never started this print");
                        crate::queue::print_ended(&state, &print, "failed");
                        eprintln!("Print {}: never started on {}; giving up", print.id, print.printer_name);
                    }
                    // A print whose upload task died with the process.
                    if print.status == "uploading" && age_secs(&print.updated_at) > 15 * 60 {
                        state.db.update_print(&print.id, "failed", None, Some("the upload was interrupted"));
                        crate::queue::print_ended(&state, &print, "failed");
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
    use crate::package::FilamentUse;
    use crate::printer::status::AmsUnit;

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
            nozzle: None,
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
            printer_model: None,
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
                    nozzle: None,
                })
                .collect(),
            has_thumbnail: false,
            gcode_md5: "X".into(),
            bed_type: None,
            check: None,
            objects: Vec::new(),
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
    fn dual_nozzle_mapping_keeps_each_filament_on_its_nozzle() {
        // An H2D: AMS 0 feeds the left nozzle, AMS 1 the right one.
        let on = |nozzle, t: Tray| Tray { nozzle: Some(nozzle), ..t };
        let mut s = status_with(vec![on(1, tray(0, "PLA", "#FF0000")), on(1, tray(1, "PLA-S", "#FFFFFF"))]);
        s.ams[0].nozzle = Some(1);
        s.ams.push(AmsUnit {
            id: 1,
            humidity: None,
            nozzle: Some(2),
            trays: vec![on(2, tray(4, "PLA", "#FF0000")), on(2, tray(5, "PLA-S", "#FFFFFF"))],
        });
        // The slicer put the part's PLA on the right nozzle, the support
        // interface on the left.
        let mut p = plate(vec![(1, "PLA", "#FF0000"), (2, "PLA-S", "#FFFFFF")]);
        p.filaments[0].nozzle = Some(2);
        p.filaments[1].nozzle = Some(1);
        let m = suggest_mapping(&p, Some(&s));
        assert_eq!(m, vec![4, 1]);
        assert!(check_mapping(&p, &m, Some(&s)).is_empty());
        let wrong = check_mapping(&p, &[0, 1], Some(&s));
        assert_eq!(wrong.len(), 1, "{wrong:?}");
        assert!(wrong[0].contains("right nozzle") && wrong[0].contains("left one"), "{wrong:?}");
        // Single-nozzle printers and older packages: no constraint.
        p.filaments[0].nozzle = None;
        assert!(check_mapping(&p, &[0, 1], Some(&s)).is_empty());
    }

    #[test]
    fn names_are_safe_and_unique() {
        assert_eq!(display_name("C:\\parts\\Bracket v2 (final).3mf"), "Bracket v2 (final)");
        assert_eq!(display_name("weird/na\"me.gcode.3mf"), "na_me");
        assert_eq!(file_name("Bracket v2", "1a2b3c4d-xxxx", PackageFormat::Bambu3mf), "Bracket_v2-1a2b3c4d.gcode.3mf");
        assert_eq!(file_name("Bracket v2", "1a2b3c4d-xxxx", PackageFormat::Gcode), "Bracket_v2-1a2b3c4d.gcode");
        assert_eq!(file_name("Ünïcode (v2)+", "1a2b3c4d-xxxx", PackageFormat::Gcode), "_n_code__v2__-1a2b3c4d.gcode");
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
            outcome: None,
            outcome_by: None,
            outcome_at: None,
            outcome_note: None,
        }
    }

    /// A report as Bambu printers send it: the plate as the file, the job
    /// as its name.
    fn report(state: &str, subtask: Option<&str>, error: Option<i64>) -> PrinterStatus {
        let mut s = PrinterStatus::offline("p", None);
        s.online = true;
        s.state = Some(state.into());
        s.job_file = Some("/data/Metadata/plate_1.gcode".into());
        s.job_key = subtask.map(String::from);
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
        assert_eq!(transition(&starting, &report("CANCELLED", ours, None)), None);
        assert_eq!(transition(&starting, &report("RUNNING", ours, None)).unwrap().0, "printing");
        let printing = record("printing");
        assert_eq!(transition(&printing, &report("PAUSE", ours, None)).unwrap().0, "paused");
        assert_eq!(transition(&printing, &report("FINISH", ours, None)).unwrap().0, "finished");
        assert_eq!(transition(&printing, &report("CANCELLED", ours, None)).unwrap().0, "cancelled");
        let failed = transition(&printing, &report("FAILED", ours, Some(0x0500_4038))).unwrap();
        assert_eq!((failed.0, failed.2.as_deref()), ("failed", Some("printer error 0500_4038")));
        assert_eq!(transition(&printing, &report("RUNNING", Some("Other job"), None)).unwrap().0, "failed");
    }

    #[test]
    fn unnamed_reports_only_start_a_print() {
        let starting = record("starting");
        // A finished, unnamed previous job must not finish our new print.
        assert_eq!(transition(&starting, &report("FINISH", None, None)), None);
        assert_eq!(transition(&starting, &report("PREPARE", None, None)).unwrap().0, "printing");
        // Once running, the unnamed job is ours.
        let printing = record("printing");
        assert_eq!(transition(&printing, &report("FINISH", None, None)).unwrap().0, "finished");
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
