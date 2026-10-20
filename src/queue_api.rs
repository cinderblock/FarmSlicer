//! `/api/queue`: plates waiting for printers (src/queue.rs has the rules),
//! a printer's "send next", and reprints of a project's missing copies.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::CurrentUser;
use crate::db::{Job, QueueEntry, User};
use crate::groups::{Tree, Viewer};
use crate::groups_api;
use crate::prints_api::{SendRequest, send_plate};
use crate::printing::PrintOptions;
use crate::server::AppState;

type ApiError = (StatusCode, Json<Value>);

fn api_err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

/// Most entries one request adds.
const MAX_ADD: i64 = 200;

fn entry_job(state: &AppState, e: &QueueEntry) -> Option<Job> {
    state.db.get_job(&e.job_id)
}

/// Who sees an entry in full: whoever sees its job, admins, and the
/// operators of a printer it could go to.
fn can_see_entry(state: &AppState, tree: &Tree, viewer: &Viewer, e: &QueueEntry) -> bool {
    viewer.admin
        || entry_job(state, e).is_some_and(|j| viewer.can_see_job(tree, &j))
        || crate::pools::operates_entry(state, viewer, e)
}

/// Who changes or removes it: whoever queued it, the job's creator, the
/// job's group's managers, admins, operators.
fn can_manage_entry(state: &AppState, tree: &Tree, viewer: &Viewer, e: &QueueEntry) -> bool {
    viewer.admin
        || e.created_by.as_deref() == Some(viewer.user.id.as_str())
        || e.job_user_id.as_deref() == Some(viewer.user.id.as_str())
        || e.job_group_id.as_deref().is_some_and(|g| viewer.can_manage(tree, g))
        || crate::pools::operates_entry(state, viewer, e)
}

/// An entry as the queue page shows it: what the plate holds, the projects
/// it is for, and how it fits each printer (`fits`, when asked for).
fn entry_json(state: &AppState, tree: &Tree, viewer: &Viewer, e: &QueueEntry, fits: Option<&[crate::queue::Fit]>) -> Value {
    if !can_see_entry(state, tree, viewer, e) {
        return json!({
            "id": e.id, "status": e.status, "plate": e.plate, "priority": e.priority, "held": e.held,
            "printer_id": e.printer_id, "pool_id": e.pool_id, "created_at": e.created_at, "job_name": null,
            "visible": false, "can_manage": false,
        });
    }
    let mut v = json!(e);
    v["visible"] = json!(true);
    v["name"] = json!(crate::printing::display_name(&e.job_name));
    v["can_manage"] = json!(can_manage_entry(state, tree, viewer, e));
    if let Some(job) = entry_job(state, e) {
        let lines = crate::outcomes::job_plate_lines(state, &job, e.plate as u32);
        let mut projects: Vec<Value> = Vec::new();
        for l in &lines {
            let Some(item) = l.item_id.as_deref().and_then(|i| state.db.get_item(i)) else { continue };
            if projects.iter().any(|p| p["id"] == item.project_id) {
                continue;
            }
            if let Some(p) = state.db.get_project(&item.project_id) {
                if crate::projects::can_see(tree, viewer, &p) {
                    projects.push(json!({"id": p.id, "name": p.name, "status": p.status, "due_at": p.due_at}));
                }
            }
        }
        v["lines"] = json!(lines);
        v["projects"] = json!(projects);
        let pkg = crate::printing::package_of(&job);
        let plate = pkg.as_ref().and_then(|p| p.plate(e.plate as u32));
        v["print_time_sec"] = json!(plate.and_then(|p| p.print_time_sec));
        v["weight_g"] = json!(plate.and_then(|p| p.weight_g));
        v["filaments"] = json!(plate.map(|p| &p.filaments));
        v["has_thumbnail"] = json!(plate.is_some_and(|p| p.has_thumbnail));
    }
    if let Some(f) = fits {
        v["fits"] = json!(f);
    }
    v
}

#[derive(Deserialize)]
struct QueueQuery {
    /// Only entries that could go to this printer, with how they fit it.
    printer: Option<String>,
    /// queued (default) | sent | done (printed, failed, cancelled) | all
    status: Option<String>,
    limit: Option<i64>,
}

/// `GET /api/queue?printer=&status=`: entries in queue order, and per
/// printer whether it is free and the entry it would take next.
async fn list_queue(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Query(q): Query<QueueQuery>,
) -> Json<Value> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let statuses: &[&str] = match q.status.as_deref().unwrap_or("queued") {
        "sent" => &["sent"],
        "done" => &["printed", "failed", "cancelled"],
        "all" => &["queued", "sent", "printed", "failed", "cancelled"],
        _ => &["queued"],
    };
    let entries = state.db.list_queue(statuses, q.limit.unwrap_or(500).clamp(1, 2000));
    let printers: Vec<_> = state
        .db
        .list_printers()
        .into_iter()
        .filter(|p| q.printer.as_deref().is_none_or(|id| id == p.id))
        .collect();
    let queued = statuses == ["queued"];
    let fits: Vec<Vec<crate::queue::Fit>> = entries
        .iter()
        .map(|e| if queued { printers.iter().map(|p| crate::queue::fit(&state, e, p)).collect() } else { Vec::new() })
        .collect();
    let printer_rows: Vec<Value> = printers
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let next = entries
                .iter()
                .zip(&fits)
                .find(|(e, f)| !e.held && f.get(i).is_some_and(|f| f.refused.is_none()))
                .map(|(e, _)| e.id.clone());
            json!({
                "printer_id": p.id,
                "name": p.name,
                "busy": crate::prints_api::busy_reason(&state, p),
                "next": next,
                "operates": viewer.admin || crate::pools::operates(&state, &viewer, Some(&p.id)),
                "send_mode": crate::dispatch::send_mode(p),
            })
        })
        .collect();
    let list: Vec<Value> = entries
        .iter()
        .zip(&fits)
        .filter(|(_, f)| q.printer.is_none() || f.iter().any(|f| f.refused.is_none()) || !queued)
        .map(|(e, f)| entry_json(&state, &tree, &viewer, e, queued.then_some(f.as_slice())))
        .collect();
    let counts: serde_json::Map<String, Value> =
        state.db.queue_counts().into_iter().map(|(s, n)| (s, json!(n))).collect();
    Json(json!({ "entries": list, "printers": printer_rows, "counts": counts }))
}

#[derive(Deserialize)]
struct AddBody {
    job_id: String,
    /// One plate, or several (`plates`); neither = every plate of the job.
    #[serde(default)]
    plate: Option<i64>,
    #[serde(default)]
    plates: Option<Vec<i64>>,
    /// How many times each plate is to be printed.
    #[serde(default)]
    count: Option<i64>,
    #[serde(default)]
    priority: Option<i64>,
    #[serde(default)]
    printer_id: Option<String>,
    #[serde(default)]
    pool_id: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

fn check_pin(state: &AppState, printer: Option<&str>, pool: Option<&str>) -> Result<(), ApiError> {
    if let Some(p) = printer {
        if state.db.get_printer(p).is_none() {
            return Err(api_err(StatusCode::BAD_REQUEST, "no such printer"));
        }
    }
    if let Some(p) = pool {
        if !crate::pools::exists(state, p) {
            return Err(api_err(StatusCode::BAD_REQUEST, "no such pool"));
        }
    }
    Ok(())
}

fn note_of(n: Option<&str>) -> Option<String> {
    n.map(|n| n.trim().chars().take(500).collect::<String>()).filter(|n| !n.is_empty())
}

/// `POST /api/queue`: queue plates of a job the caller can see.
async fn add_entries(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<AddBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (job, tree, viewer) = crate::prints_api::visible_job(&state, &user, &body.job_id)?;
    let pkg = crate::printing::package_of(&job)
        .ok_or_else(|| api_err(StatusCode::CONFLICT, "the job has nothing printable yet"))?;
    let plates: Vec<i64> = match (body.plate, &body.plates) {
        (Some(p), None) => vec![p],
        (None, Some(list)) => list.clone(),
        (None, None) => pkg.plates.iter().map(|p| p.index as i64).collect(),
        _ => return Err(api_err(StatusCode::BAD_REQUEST, "give plate or plates, not both")),
    };
    if plates.is_empty() {
        return Err(api_err(StatusCode::BAD_REQUEST, "no plates"));
    }
    if let Some(bad) = plates.iter().find(|n| pkg.plate(**n as u32).is_none()) {
        return Err(api_err(StatusCode::BAD_REQUEST, format!("the job has no plate {bad}")));
    }
    let count = body.count.unwrap_or(1);
    if count < 1 || count * plates.len() as i64 > MAX_ADD {
        return Err(api_err(StatusCode::BAD_REQUEST, format!("count: 1 to {MAX_ADD} entries at a time")));
    }
    let priority = body.priority.unwrap_or(0);
    if !(-100..=100).contains(&priority) {
        return Err(api_err(StatusCode::BAD_REQUEST, "priority: -100 to 100"));
    }
    let pin = body.printer_id.as_deref().filter(|p| !p.is_empty());
    let pool = body.pool_id.as_deref().filter(|p| !p.is_empty());
    check_pin(&state, pin, pool)?;
    let note = note_of(body.note.as_deref());
    let mut added = Vec::new();
    for plate in &plates {
        for _ in 0..count {
            let e = state.db.add_queue_entry(&job.id, *plate, priority, pin, pool, note.as_deref(), Some(&user.id));
            added.push(entry_json(&state, &tree, &viewer, &e, None));
        }
    }
    println!("Queue: {} queues {} entr{} of {}", user.username, added.len(), if added.len() == 1 { "y" } else { "ies" }, job.model_name);
    crate::projects::refresh_for_job(&state, Some(&job.id));
    crate::dispatch::poke(&state);
    Ok((StatusCode::CREATED, Json(json!(added))))
}

fn managed_entry(state: &AppState, user: &User, id: &str) -> Result<(QueueEntry, Tree, Viewer), ApiError> {
    let (tree, viewer) = groups_api::context(state, user);
    let e = state
        .db
        .get_queue_entry(id)
        .filter(|e| can_see_entry(state, &tree, &viewer, e))
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such queue entry"))?;
    if !can_manage_entry(state, &tree, &viewer, &e) {
        return Err(api_err(StatusCode::FORBIDDEN, "only whoever queued it, the job's owners, operators and admins can"));
    }
    Ok((e, tree, viewer))
}

/// A field that may be absent (None), `null` (Some(None)) or a value.
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
struct UpdateBody {
    #[serde(default)]
    priority: Option<i64>,
    /// "top": ahead of every other queued entry.
    #[serde(default)]
    position: Option<String>,
    #[serde(default, deserialize_with = "present")]
    printer_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pool_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    note: Option<Option<String>>,
}

/// `PATCH /api/queue/{id}`: priority (or `position: "top"`), pin, pool, note.
async fn update_entry(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> Result<Json<Value>, ApiError> {
    let (e, tree, viewer) = managed_entry(&state, &user, &id)?;
    if e.status != "queued" {
        return Err(api_err(StatusCode::CONFLICT, format!("the entry is {}", e.status)));
    }
    let mut priority = body.priority.unwrap_or(e.priority);
    if body.position.as_deref() == Some("top") {
        let top = state.db.list_queue(&["queued"], 1).first().map(|t| t.priority).unwrap_or(0);
        priority = if state.db.list_queue(&["queued"], 1).first().is_some_and(|t| t.id == e.id) { e.priority } else { (top + 1).min(100) };
    }
    if !(-100..=100).contains(&priority) {
        return Err(api_err(StatusCode::BAD_REQUEST, "priority: -100 to 100"));
    }
    let pin = match &body.printer_id {
        Some(p) => p.clone().filter(|p| !p.is_empty()),
        None => e.printer_id.clone(),
    };
    let pool = match &body.pool_id {
        Some(p) => p.clone().filter(|p| !p.is_empty()),
        None => e.pool_id.clone(),
    };
    check_pin(&state, pin.as_deref(), pool.as_deref())?;
    let note = match &body.note {
        Some(n) => note_of(n.as_deref()),
        None => e.note.clone(),
    };
    if !state.db.update_queue_entry(&id, priority, pin.as_deref(), pool.as_deref(), note.as_deref()) {
        return Err(api_err(StatusCode::CONFLICT, "the entry was sent meanwhile"));
    }
    crate::dispatch::poke(&state);
    let e = state.db.get_queue_entry(&id).expect("entry exists");
    Ok(Json(entry_json(&state, &tree, &viewer, &e, None)))
}

/// `DELETE /api/queue/{id}`: take a queued entry out (it ends `cancelled`).
async fn cancel_entry(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let (e, _, _) = managed_entry(&state, &user, &id)?;
    if e.status != "queued" || !state.db.end_queue_entry(&id, "cancelled", Some(&format!("removed by {}", user.username))) {
        return Err(api_err(StatusCode::CONFLICT, format!("the entry is {}", e.status)));
    }
    crate::projects::refresh_for_job(&state, Some(&e.job_id));
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
pub(crate) struct SendBody {
    #[serde(default)]
    pub printer_id: Option<String>,
    #[serde(default)]
    pub ams_mapping: Option<Vec<i64>>,
    #[serde(default)]
    pub options: Option<PrintOptions>,
    #[serde(default)]
    pub ignore_mapping_problems: bool,
    #[serde(default)]
    pub acknowledge_review: bool,
}

/// Send entry `e` to `printer_id` as `user` (the queue's sends go through
/// the same checks as any other).
pub(crate) async fn send_entry(
    state: &Arc<AppState>,
    user: &User,
    tree: &Tree,
    viewer: &Viewer,
    e: &QueueEntry,
    printer_id: &str,
    body: &SendBody,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let job = entry_job(state, e).ok_or_else(|| api_err(StatusCode::CONFLICT, "the job is gone"))?;
    let printer = state.db.get_printer(printer_id).ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such printer"))?;
    let fit = crate::queue::fit(state, e, &printer);
    if let Some(why) = fit.refused {
        return Err(api_err(StatusCode::CONFLICT, format!("can't print here: {why}")));
    }
    // Operators send on the farm's behalf: the print is theirs, the job's
    // rules are its group's.
    let request = SendRequest {
        printer_id: printer.id.clone(),
        plate: Some(e.plate as u32),
        ams_mapping: body.ams_mapping.clone(),
        options: body.options.clone().unwrap_or_default(),
        ignore_mapping_problems: body.ignore_mapping_problems,
        acknowledge_review: body.acknowledge_review,
    };
    let (code, print) = send_plate(state, user, tree, viewer, &job, request, Some(&e.id)).await?;
    println!("Queue entry {}: {} sends it to {}", e.id, user.username, printer.name);
    Ok((code, Json(json!({"entry": state.db.get_queue_entry(&e.id), "print": print}))))
}

/// `POST /api/queue/{id}/send`: send one entry to a printer.
async fn send_one(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    body: Option<Json<SendBody>>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let body = body.map(|b| b.0).unwrap_or_default();
    let (tree, viewer) = groups_api::context(&state, &user);
    let e = state
        .db
        .get_queue_entry(&id)
        .filter(|e| can_see_entry(&state, &tree, &viewer, e))
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such queue entry"))?;
    if e.status != "queued" {
        return Err(api_err(StatusCode::CONFLICT, format!("the entry is {}", e.status)));
    }
    let printer_id = body
        .printer_id
        .clone()
        .or_else(|| e.printer_id.clone())
        .ok_or_else(|| api_err(StatusCode::BAD_REQUEST, "which printer? (printer_id)"))?;
    may_send_to(&state, &tree, &viewer, &e, &printer_id)?;
    send_entry(&state, &user, &tree, &viewer, &e, &printer_id, &body).await
}

/// Sending an entry: whoever sees its job may (like any send), and
/// operators may send to their pools' printers.
fn may_send_to(state: &AppState, tree: &Tree, viewer: &Viewer, e: &QueueEntry, printer_id: &str) -> Result<(), ApiError> {
    let sees_job = entry_job(state, e).is_some_and(|j| viewer.can_see_job(tree, &j));
    if viewer.admin || sees_job || crate::pools::operates(state, viewer, Some(printer_id)) {
        Ok(())
    } else {
        Err(api_err(StatusCode::FORBIDDEN, "only the printer's operators, admins and whoever can see the job send it"))
    }
}

/// `POST /api/printers/{id}/send-next`: the first queued entry that fits
/// the printer goes to it.
async fn send_next(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    body: Option<Json<SendBody>>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let body = body.map(|b| b.0).unwrap_or_default();
    let (tree, viewer) = groups_api::context(&state, &user);
    let printer = state.db.get_printer(&id).ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such printer"))?;
    if !viewer.admin && !crate::pools::operates(&state, &viewer, Some(&id)) {
        return Err(api_err(StatusCode::FORBIDDEN, "only the printer's operators and admins send the queue to it"));
    }
    if let Some(why) = crate::prints_api::busy_reason(&state, &printer) {
        return Err(api_err(StatusCode::CONFLICT, why));
    }
    let (e, _) = crate::queue::next_for(&state, &printer)
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, format!("nothing in the queue fits {}", printer.name)))?;
    send_entry(&state, &user, &tree, &viewer, &e, &id, &body).await
}

#[derive(Deserialize, Default)]
struct ReprintBody {
    /// Entries to add; default: enough for the missing copies.
    #[serde(default)]
    count: Option<i64>,
    #[serde(default)]
    priority: Option<i64>,
}

/// `POST /api/projects/{id}/items/{item_id}/reprint`: queue a plate that
/// carries the item (the one with the most of its copies) as many times as
/// the missing copies need.
async fn reprint_item(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((id, item_id)): Path<(String, String)>,
    body: Option<Json<ReprintBody>>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let body = body.map(|b| b.0).unwrap_or_default();
    let (tree, viewer) = groups_api::context(&state, &user);
    let project = state
        .db
        .get_project(&id)
        .filter(|p| crate::projects::can_see(&tree, &viewer, p))
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "project not found"))?;
    if !crate::projects::can_edit(&tree, &viewer, &project) {
        return Err(api_err(StatusCode::FORBIDDEN, "only its creator, the group's managers and admins can"));
    }
    let view = crate::projects::item_views(&state, &id)
        .into_iter()
        .find(|i| i.item.id == item_id)
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such item"))?;
    // The plates carrying it whose job can be printed, most copies first.
    let mut plates: Vec<(crate::db::JobItem, Job)> = state
        .db
        .project_job_items(&id)
        .into_iter()
        .filter(|j| j.item_id == item_id)
        .filter_map(|j| {
            let job = state.db.get_job(&j.job_id)?;
            crate::printing::package_of(&job).is_some().then_some((j, job))
        })
        .collect();
    plates.sort_by_key(|(j, _)| -j.copies);
    let Some((plate, job)) = plates.into_iter().next() else {
        return Err(api_err(
            StatusCode::CONFLICT,
            "no printable plate carries this part yet: slice one for the project (Slice page, Project)",
        ));
    };
    let count = match body.count {
        Some(c) => c,
        None if view.missing == 0 => return Err(api_err(StatusCode::CONFLICT, "no copies are missing")),
        None => (view.missing + plate.copies - 1) / plate.copies,
    };
    if !(1..=MAX_ADD).contains(&count) {
        return Err(api_err(StatusCode::BAD_REQUEST, format!("count: 1 to {MAX_ADD}")));
    }
    let priority = body.priority.unwrap_or(0).clamp(-100, 100);
    let note = format!("for {} more {}", view.missing.max(count * plate.copies), view.item.name);
    let added: Vec<Value> = (0..count)
        .map(|_| {
            let e = state.db.add_queue_entry(&job.id, plate.plate, priority, None, None, Some(&note), Some(&user.id));
            entry_json(&state, &tree, &viewer, &e, None)
        })
        .collect();
    println!("Project {}: {} queues {count} × plate {} of {} for {}", id, user.username, plate.plate, job.model_name, view.item.name);
    crate::dispatch::poke(&state);
    Ok((StatusCode::CREATED, Json(json!(added))))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/queue", get(list_queue).post(add_entries))
        .route("/api/queue/{id}", axum::routing::patch(update_entry).delete(cancel_entry))
        .route("/api/queue/{id}/send", post(send_one))
        .route("/api/printers/{id}/send-next", post(send_next))
        .route("/api/projects/{id}/items/{item_id}/reprint", post(reprint_item))
}
