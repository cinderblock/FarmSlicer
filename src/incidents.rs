//! The G-code incident log: who sends custom G-code that fails its check
//! or a print. Admins see it per user (`GET /api/gcode-incidents`, the Users
//! page); each incident is also a server log line.
//!
//! Custom G-code is what FarmSlicer didn't produce from vetted profiles:
//! uploaded files, server slices whose overrides go beyond the Slice page's
//! settings, and any job whose check found something to hold it for (where
//! a tampered browser result shows up). A clean browser slice is
//! FarmSlicer's own engine's output and isn't logged.
//!
//! Kinds: `check` (blocked or review findings), `print_failed` (the printer
//! reported a failure, refused to start it, or never started it),
//! `printer_error` (error codes raised while it prints, once per code per
//! print). Re-checks and repeated reports don't duplicate entries.

use md5::{Digest, Md5};
use std::collections::HashSet;
use std::sync::Mutex;

use crate::db::{Job, NewIncident, PrintRecord};
use crate::gcode::Severity;
use crate::package::Package;
use crate::printer::status::PrinterStatus;
use crate::printing;
use crate::server::AppState;

/// Why the job's G-code counts as custom, if it does.
pub fn custom_reason(job: &Job, pkg: Option<&Package>) -> Option<&'static str> {
    if job.source == "upload" {
        return Some("uploaded");
    }
    let overrides = job.overrides_json.as_deref().and_then(|o| crate::config_policy::parse(o).ok());
    if overrides.is_some_and(|o| crate::config_policy::beyond_schema(&o)) {
        return Some("custom settings");
    }
    let held = pkg.is_some_and(|p| p.plates.iter().any(|pl| pl.check.as_ref().is_some_and(|c| c.needs_review())));
    held.then_some("held by its G-code check")
}

fn log(state: &AppState, i: &NewIncident<'_>) {
    if state.db.record_gcode_incident(i) {
        let who = i.user_id.and_then(|u| state.db.get_user(u)).map(|u| u.username).unwrap_or_else(|| "someone".into());
        println!(
            "G-code incident ({}, {}): {who}'s {} ({}{}): {}",
            i.kind,
            i.severity,
            i.job_name,
            i.source,
            i.printer_name.map(|p| format!(" on {p}")).unwrap_or_default(),
            i.summary
        );
    }
}

fn digest(s: &str) -> String {
    hex::encode(&Md5::digest(s.as_bytes())[..8])
}

/// After a check: log blocked or review findings. A plain server slice
/// that fails is FarmSlicer's own data's fault (safety.rs says so), not
/// its creator's.
pub fn after_check(state: &AppState, job: &Job, pkg: &Package) {
    if job.source == "server" && custom_reason(job, None).is_none() {
        return;
    }
    for plate in &pkg.plates {
        let Some(c) = &plate.check else { continue };
        let Some(verdict) = c.verdict.filter(|v| *v >= Severity::Review) else { continue };
        let messages: Vec<&str> = c
            .findings
            .iter()
            .filter(|f| f.severity >= Severity::Review)
            .map(|f| f.message.as_str())
            .collect();
        let plate_note = if pkg.plates.len() > 1 { format!("plate {}: ", plate.index) } else { String::new() };
        let summary = format!("{plate_note}{}", messages.join("; "));
        let severity = if verdict == Severity::Block { "block" } else { "review" };
        log(
            state,
            &NewIncident {
                user_id: job.user_id.as_deref(),
                sent_by: None,
                job_id: Some(&job.id),
                print_id: None,
                job_name: &job.model_name,
                printer_name: None,
                source: &job.source,
                kind: "check",
                severity,
                summary: &summary,
                dedupe: &format!("check:{}:{}:{}", job.id, plate.index, digest(&summary)),
            },
        );
    }
}

/// Failures that aren't the G-code's doing.
fn not_the_gcode(error: &str) -> bool {
    error.starts_with("another print replaced it")
        || error.starts_with("the upload was interrupted")
        || error.starts_with("upload failed")
        || error.starts_with("can't read the package")
        || error.contains("the printer was removed")
}

/// The job behind a print, when its G-code is custom.
fn custom_job(state: &AppState, print: &PrintRecord) -> Option<(Job, &'static str)> {
    let job = state.db.get_job(print.job_id.as_deref()?)?;
    let pkg = printing::package_of(&job);
    let reason = custom_reason(&job, pkg.as_ref())?;
    Some((job, reason))
}

/// A print of custom G-code failed.
pub fn print_failed(state: &AppState, print: &PrintRecord, error: &str) {
    if not_the_gcode(error) {
        return;
    }
    let Some((job, reason)) = custom_job(state, print) else { return };
    log(
        state,
        &NewIncident {
            user_id: job.user_id.as_deref(),
            sent_by: print.user_id.as_deref(),
            job_id: Some(&job.id),
            print_id: Some(&print.id),
            job_name: &job.model_name,
            printer_name: Some(&print.printer_name),
            source: &job.source,
            kind: "print_failed",
            severity: "error",
            summary: &format!("the print failed: {error} ({reason})"),
            dedupe: &format!("failed:{}", print.id),
        },
    );
}

/// An HMS code as Bambu writes it: `AAAA_AAAA_CCCC_CCCC`.
fn hms_code(attr: i64, code: i64) -> String {
    let h = |n: i64| format!("{:04X}", n & 0xFFFF);
    format!("{}_{}_{}_{}", h(attr >> 16), h(attr), h(code >> 16), h(code))
}

/// Error codes already logged for a print, so a status stream repeating
/// them costs no database write.
static SEEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Errors the printer raises while it prints custom G-code (HMS codes, a
/// print error), once per code per print.
pub fn printer_errors(state: &AppState, print: &PrintRecord, status: &PrinterStatus) {
    let mut codes: Vec<(String, Option<&str>)> = status
        .hms
        .iter()
        .map(|h| (hms_code(h.attr, h.code), h.message.as_deref()))
        .collect();
    if let Some(e) = status.print_error.filter(|e| *e != 0) {
        codes.push((format!("{:04X}_{:04X}", (e >> 16) & 0xFFFF, e & 0xFFFF), status.print_error_message.as_deref()));
    }
    if codes.is_empty() {
        return;
    }
    let fresh: Vec<(String, Option<&str>)> = {
        let mut seen = SEEN.lock().unwrap();
        let seen = seen.get_or_insert_with(HashSet::new);
        codes.into_iter().filter(|(c, _)| seen.insert(format!("{}:{c}", print.id))).collect()
    };
    if fresh.is_empty() {
        return;
    }
    let Some((job, reason)) = custom_job(state, print) else { return };
    for (code, text) in fresh {
        let error = match text {
            Some(text) => format!("{code} ({text})"),
            None => code.clone(),
        };
        log(
            state,
            &NewIncident {
                user_id: job.user_id.as_deref(),
                sent_by: print.user_id.as_deref(),
                job_id: Some(&job.id),
                print_id: Some(&print.id),
                job_name: &job.model_name,
                printer_name: Some(&print.printer_name),
                source: &job.source,
                kind: "printer_error",
                severity: "error",
                summary: &format!("the printer raised error {error} while printing it ({reason})"),
                dedupe: &format!("error:{}:{code}", print.id),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    struct TempDb(std::path::PathBuf, Db);
    impl Drop for TempDb {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }
    fn temp_db() -> TempDb {
        let dir = std::env::temp_dir().join(format!("farmslicer-incidents-{}", uuid::Uuid::new_v4()));
        let db = Db::open(&dir);
        TempDb(dir, db)
    }

    #[test]
    fn hms_codes_read_like_bambus() {
        assert_eq!(hms_code(0x0300_0100, 0x0001_0007), "0300_0100_0001_0007");
    }

    #[test]
    fn some_failures_arent_the_gcode() {
        assert!(not_the_gcode("another print replaced it on the printer"));
        assert!(not_the_gcode("upload failed: connection refused"));
        assert!(!not_the_gcode("printer error 0500_4038"));
        assert!(!not_the_gcode("the printer refused to start the print: SD busy"));
        assert!(!not_the_gcode("the printer never started this print"));
    }

    #[test]
    fn what_counts_as_custom() {
        let t = temp_db();
        let job = |source: &str, overrides: Option<&str>| t.1.create_job("part", "", None, "auto", None, overrides, source, None, None, 0, None);
        assert_eq!(custom_reason(&job("upload", None), None), Some("uploaded"));
        assert_eq!(custom_reason(&job("server", Some(r#"{"layer_height":"0.2"}"#)), None), None);
        assert_eq!(custom_reason(&job("server", Some(r#"{"machine_start_gcode":"G28"}"#)), None), Some("custom settings"));
        assert_eq!(custom_reason(&job("browser", None), None), None, "a clean browser slice is FarmSlicer's own");
    }

    #[test]
    fn incidents_are_recorded_once() {
        let t = temp_db();
        let i = NewIncident {
            user_id: Some("u1"),
            sent_by: None,
            job_id: None,
            print_id: None,
            job_name: "part",
            printer_name: None,
            source: "upload",
            kind: "check",
            severity: "review",
            summary: "heats the nozzle to 300 °C",
            dedupe: "check:j:1:abc",
        };
        assert!(t.1.record_gcode_incident(&i));
        assert!(!t.1.record_gcode_incident(&i), "a re-check doesn't log it again");
        assert!(t.1.record_gcode_incident(&NewIncident { dedupe: "check:j:1:def", ..i }));
        assert_eq!(t.1.list_gcode_incidents(Some("u1"), 10).len(), 2);
        assert_eq!(t.1.list_gcode_incidents(Some("u2"), 10).len(), 0);
        assert_eq!(t.1.gcode_incident_counts().get("u1").map(|c| c.0), Some(2));
    }
}
