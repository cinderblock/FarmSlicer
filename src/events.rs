//! What happened, for software listening in: prints, outcomes, projects.
//! Every event goes through [`emit`]; webhooks (src/webhooks.rs, step 6
//! of plans/plates-and-print-queue.md) deliver them.

use serde_json::{Value, json};

use crate::db::PrintRecord;
use crate::server::AppState;

/// Hand an event to whoever listens.
pub fn emit(_state: &AppState, event: &str, data: Value) {
    let _ = (event, data);
}

pub fn print_outcome(state: &AppState, print: &PrintRecord) {
    emit(state, "print.outcome", json!({ "print": print, "lines": state.db.print_outcome_lines(&print.id) }));
}

pub fn project_status(state: &AppState, project_id: &str) {
    if let Some(p) = state.db.get_project(project_id) {
        emit(state, "project.status", json!({ "project": p }));
    }
}
