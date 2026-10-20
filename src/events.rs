//! What happened, for software listening in: every event goes through
//! [`emit`], and webhooks (src/webhooks.rs) deliver it. Events and their
//! `data`:
//!
//! - `print.started`, `print.finished`, `print.failed` (failed or stopped):
//!   `{print, projects}` (the ids of the projects the plate carries parts of)
//! - `print.outcome`: `{print, lines, projects}` when someone (or the
//!   printer) records how it came out
//! - `item.completed`: `{project, item}` when an item has enough good copies
//! - `project.printed`, `project.status`: `{project}` (with its `summary`)

use serde_json::{Value, json};

use crate::db::PrintRecord;
use crate::server::AppState;

/// Hand an event to whoever listens. `group`: whose event it is.
pub fn emit(state: &AppState, event: &str, group: Option<&str>, data: Value) {
    crate::webhooks::enqueue(state, event, group, &data);
}

fn print_data(state: &AppState, print: &PrintRecord) -> Value {
    let projects = print.job_id.as_deref().map(|j| state.db.projects_of_job(j)).unwrap_or_default();
    json!({ "print": print, "projects": projects })
}

/// A print started printing, finished, or failed (`status` as the print
/// now has it).
pub fn print_status(state: &AppState, print_id: &str, status: &str) {
    let Some(print) = state.db.get_print(print_id) else { return };
    let event = match status {
        "printing" => "print.started",
        "finished" => "print.finished",
        "failed" | "cancelled" => "print.failed",
        _ => return,
    };
    emit(state, event, print.group_id.as_deref(), print_data(state, &print));
}

pub fn print_outcome(state: &AppState, print: &PrintRecord) {
    let mut data = print_data(state, print);
    data["lines"] = json!(state.db.print_outcome_lines(&print.id));
    emit(state, "print.outcome", print.group_id.as_deref(), data);
}

fn project_data(state: &AppState, project_id: &str) -> Option<(Value, Option<String>)> {
    let p = state.db.get_project(project_id)?;
    let items = crate::projects::item_views(state, project_id);
    let mut v = json!(p);
    v["summary"] = json!(crate::projects::summarize(&items));
    Some((v, p.group_id))
}

pub fn project_status(state: &AppState, project_id: &str) {
    let Some((project, group)) = project_data(state, project_id) else { return };
    if project["status"] == "printed" {
        emit(state, "project.printed", group.as_deref(), json!({ "project": project }));
    }
    emit(state, "project.status", group.as_deref(), json!({ "project": project }));
}

pub fn item_completed(state: &AppState, project_id: &str, item: &crate::projects::ItemView) {
    let Some((project, group)) = project_data(state, project_id) else { return };
    emit(state, "item.completed", group.as_deref(), json!({ "project": project, "item": item }));
}
