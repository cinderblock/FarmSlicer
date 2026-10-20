//! The print queue: plates waiting for a printer. One entry = the plate
//! printed once ("this plate five times" is five entries). Entries go
//! `queued` → `sent` (a print took it) → `printed` | `failed`, or
//! `cancelled`. A print that never started gives its entry back to the
//! queue; one that failed after starting ends it `failed` (and, with the
//! site setting `requeue_failed`, queues the plate again).
//!
//! Order: entries of projects on hold last; then the entry's priority, its
//! projects' priority and due date, and age (src/db/queue.rs).
//! Eligibility for a printer: the pin, the pool, whether the plate fits
//! the printer and its G-code may be sent at all; loaded filament that
//! doesn't match is shown, not refused (the operator swaps spools).

use serde::Serialize;

use crate::db::{Printer, PrintRecord, QueueEntry};
use crate::server::AppState;

/// Where an entry stands with one printer.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Fit {
    pub printer_id: String,
    /// Why it can't go there, if it can't (pin, pool, model, G-code).
    pub refused: Option<String>,
    /// Why not right now (busy, offline), if it can go there at all.
    pub busy: Option<String>,
    /// Filament the printer would need changed first.
    pub problems: Vec<String>,
}

/// The site's choice: queue a plate again when its print fails.
pub fn requeue_failed(state: &AppState) -> bool {
    state.db.get_setting("requeue_failed").as_deref() == Some("true")
}

/// How `entry` fits `printer`.
pub fn fit(state: &AppState, entry: &QueueEntry, printer: &Printer) -> Fit {
    let refuse = |why: String| Fit { printer_id: printer.id.clone(), refused: Some(why), busy: None, problems: Vec::new() };
    if let Some(pin) = &entry.printer_id {
        if pin != &printer.id {
            return refuse("pinned to another printer".into());
        }
    }
    if let Some(pool) = &entry.pool_id {
        if !crate::pools::has_printer(state, pool, &printer.id) {
            return refuse("for another pool's printers".into());
        }
    }
    let Some(job) = state.db.get_job(&entry.job_id) else { return refuse("the job is gone".into()) };
    let Some(pkg) = crate::printing::package_of(&job) else { return refuse("the job has nothing printable".into()) };
    let Some(plate) = pkg.plate(entry.plate as u32) else { return refuse(format!("the job has no plate {}", entry.plate)) };
    if let Some(why) = crate::printing::incompatibility(&state.profile_store, printer, pkg.format, plate) {
        return refuse(why);
    }
    if let Some(check) = &plate.check {
        let blocked: Vec<&str> = check
            .findings
            .iter()
            .filter(|f| f.severity == crate::gcode::Severity::Block)
            .map(|f| f.message.as_str())
            .collect();
        if !blocked.is_empty() {
            return refuse(format!("its G-code can't be sent: {}", blocked.join("; ")));
        }
    }
    let status = state.printers.status(&printer.id);
    let mapping = crate::printing::mapping_for(printer, plate, None, status.as_ref());
    Fit {
        printer_id: printer.id.clone(),
        refused: None,
        busy: crate::prints_api::busy_reason(state, printer),
        problems: crate::printing::send_problems(plate, printer, &mapping, status.as_ref()),
    }
}

/// The first queued entry (in queue order, projects on hold skipped) that
/// can go to `printer` now.
pub fn next_for(state: &AppState, printer: &Printer) -> Option<(QueueEntry, Fit)> {
    state.db.list_queue(&["queued"], 500).into_iter().filter(|e| !e.held).find_map(|e| {
        let f = fit(state, &e, printer);
        (f.refused.is_none()).then_some((e, f))
    })
}

/// A print has ended (or will never happen): move its queue entry along.
pub fn print_ended(state: &AppState, print: &PrintRecord, status: &str) {
    let Some(entry) = state.db.queue_entry_of_print(&print.id) else { return };
    if entry.status != "sent" {
        return;
    }
    let started = state.db.get_print(&print.id).is_some_and(|p| p.started_at.is_some());
    match status {
        "finished" => {
            state.db.end_queue_entry(&entry.id, "printed", None);
        }
        "rejected" => {
            state.db.end_queue_entry(&entry.id, "cancelled", Some("the print request was turned down"));
        }
        // Nothing printed: the plate waits for a printer again.
        "failed" | "cancelled" if !started => {
            state.db.release_queue_entry(&entry.id);
            println!("Queue entry {}: its print never started; queued again", entry.id);
        }
        "failed" | "cancelled" => {
            state.db.end_queue_entry(&entry.id, "failed", None);
            if requeue_failed(state) {
                let again = state.db.add_queue_entry(
                    &entry.job_id,
                    entry.plate,
                    entry.priority,
                    entry.printer_id.as_deref(),
                    entry.pool_id.as_deref(),
                    Some("again: the last print failed"),
                    entry.created_by.as_deref(),
                );
                println!("Queue entry {}: print failed; plate queued again as {}", entry.id, again.id);
            }
        }
        _ => {}
    }
}
