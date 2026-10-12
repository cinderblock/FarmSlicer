//! Printing: upload a sliced project, see where a job can print, send it,
//! follow and control prints.
//!
//! Who may do what:
//! - send a job: anyone who can see it (its creator, the group, managers,
//!   admins), to an online, idle, compatible printer;
//! - pause/resume/stop a print: whoever sent it, managers of its group,
//!   admins; anything on a printer (prints from elsewhere too): admins.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Multipart, Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{self, CurrentUser};
use crate::bambu::package;
use crate::db::{Job, PrintRecord, Printer, User};
use crate::groups::{PrintRules, Tree, Viewer};
use crate::printing::{self, PrintOptions};
use crate::server::{AppState, finish_job};
use crate::{groups_api, quota};

type ApiError = (StatusCode, Json<Value>);

fn api_err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

fn visible_job(state: &AppState, user: &User, id: &str) -> Result<(Job, Tree, Viewer), ApiError> {
    let (tree, viewer) = groups_api::context(state, user);
    match state.db.get_job(id) {
        Some(job) if viewer.can_see_job(&tree, &job) => Ok((job, tree, viewer)),
        _ => Err(api_err(StatusCode::NOT_FOUND, "job not found")),
    }
}

// -- Uploading a sliced project --------------------------------------------------

/// `POST /api/uploads` (multipart `file`, optional `group_id`): a sliced
/// `.gcode.3mf` from Bambu Studio or OrcaSlicer becomes a finished job that
/// can be sent to printers.
async fn upload_package(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let mut file: Option<(String, axum::body::Bytes)> = None;
    let mut group_id: Option<String> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, e.to_string()))?
    {
        match field.name().unwrap_or("") {
            "file" => {
                let name = field.file_name().unwrap_or("upload.gcode.3mf").to_string();
                let data = field.bytes().await.map_err(|e| api_err(StatusCode::BAD_REQUEST, e.to_string()))?;
                file = Some((name, data));
            }
            "group_id" => {
                let v = field.text().await.unwrap_or_default();
                if !v.is_empty() {
                    group_id = Some(v);
                }
            }
            _ => {}
        }
    }
    let Some((name, data)) = file else {
        return Err(api_err(StatusCode::BAD_REQUEST, "no file"));
    };

    let (tree, viewer) = groups_api::context(&state, &user);
    if let Some(g) = &group_id {
        if tree.get(g).is_none() || !viewer.can_charge(g) {
            return Err(api_err(StatusCode::FORBIDDEN, "you are not an active member of that group"));
        }
    }
    quota::check(&state.db, &tree, &user, group_id.as_deref())
        .map_err(|e| api_err(StatusCode::TOO_MANY_REQUESTS, e))?;

    let dir = state.data_dir.join("packages");
    std::fs::create_dir_all(&dir).map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let staging = dir.join(format!("upload-{}.gcode.3mf", uuid::Uuid::new_v4()));
    std::fs::write(&staging, &data).map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let pkg = match package::inspect(&staging) {
        Ok(p) => p,
        Err(e) => {
            std::fs::remove_file(&staging).ok();
            return Err(api_err(StatusCode::BAD_REQUEST, e));
        }
    };

    let job = state
        .db
        .create_job(&name, "", None, "auto", None, None, "upload", Some(&user.id), group_id.as_deref(), 0);
    let path = dir.join(format!("{}.gcode.3mf", job.id));
    std::fs::rename(&staging, &path).map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let path = path.to_string_lossy().to_string();
    let first = &pkg.plates[0];
    state
        .db
        .set_job_package(&job.id, &path, &serde_json::to_string(&pkg).expect("packages serialize"));
    finish_job(
        &state,
        &job.id,
        &path,
        first.print_time_sec.unwrap_or(0.0),
        first.weight_g.unwrap_or(0.0),
        &[],
    );
    println!(
        "job {}: uploaded sliced project {name} ({} bytes, {} plate(s))",
        job.id,
        data.len(),
        pkg.plates.len()
    );
    Ok((StatusCode::CREATED, Json(json!(state.db.get_job(&job.id)))))
}

#[derive(Deserialize)]
struct PlateQuery {
    plate: Option<u32>,
}

/// The plate's preview image from the job's package.
async fn job_thumbnail(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Query(q): Query<PlateQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let (job, _, _) = visible_job(&state, &user, &id)?;
    let pkg = printing::package_of(&job).ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no package"))?;
    let index = q.plate.unwrap_or(pkg.plates[0].index);
    let path = job.package_path.clone().ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no package"))?;
    let png = tokio::task::spawn_blocking(move || package::thumbnail(std::path::Path::new(&path), index))
        .await
        .ok()
        .flatten()
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no thumbnail"))?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "private, max-age=86400"),
        ],
        png,
    ))
}

// -- Where a job can print -------------------------------------------------------

/// The rules a job is held to, unless the viewer is exempt (admins, and the
/// managers of the job's group).
fn rules_for(tree: &Tree, viewer: &Viewer, job: &Job) -> Option<PrintRules> {
    if viewer.admin || job.group_id.as_deref().is_some_and(|g| viewer.can_manage(tree, g)) {
        return None;
    }
    Some(match job.group_id.as_deref() {
        Some(g) if tree.get(g).is_some() => tree.effective(g).print_rules,
        _ => tree_site_rules(tree),
    })
}

fn tree_site_rules(tree: &Tree) -> PrintRules {
    // A personal job: the site default (what a group without rules inherits).
    tree.site_print_rules().clone()
}

fn active_print_on(state: &AppState, printer_id: &str) -> Option<PrintRecord> {
    state.db.list_prints(Some(printer_id), true, 1).into_iter().next()
}

/// Why a printer can't take a print right now, if it can't.
fn busy_reason(state: &AppState, printer: &Printer) -> Option<String> {
    if let Some(p) = active_print_on(state, &printer.id) {
        return Some(format!(
            "{} is {} {}{}",
            printer.name,
            p.status,
            p.name,
            p.username.map(|u| format!(" for {u}")).unwrap_or_default()
        ));
    }
    match state.printers.status(&printer.id) {
        None => Some(format!("{} isn't connected (address, serial or access code missing)", printer.name)),
        Some(s) if !s.online => Some(format!(
            "{} is offline{}",
            printer.name,
            s.connection_error.map(|e| format!(": {e}")).unwrap_or_default()
        )),
        Some(s) if matches!(s.state.as_deref(), Some("PREPARE" | "RUNNING" | "PAUSE" | "SLICING")) => {
            Some(format!("{} is busy with {}", printer.name, s.job_name.unwrap_or_else(|| "a print".into())))
        }
        Some(_) => None,
    }
}

/// `GET /api/jobs/{id}/targets?plate=N`: every printer with whether the
/// plate fits it, whether it's free, and a suggested AMS mapping.
async fn job_targets(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Query(q): Query<PlateQuery>,
) -> Result<Json<Value>, ApiError> {
    let (job, tree, viewer) = visible_job(&state, &user, &id)?;
    let pkg = printing::package_of(&job).ok_or_else(|| {
        api_err(StatusCode::CONFLICT, "this job has no printable package (re-slice it, or upload a .gcode.3mf)")
    })?;
    let plate = pkg
        .plate(q.plate.unwrap_or(pkg.plates[0].index))
        .ok_or_else(|| api_err(StatusCode::BAD_REQUEST, "no such plate"))?;
    let needs_approval = rules_for(&tree, &viewer, &job)
        .map(|r| printing::rule_violations(&r, plate))
        .unwrap_or_default();
    let targets: Vec<Value> = state
        .db
        .list_printers()
        .iter()
        .map(|p| {
            let status = state.printers.status(&p.id);
            let mapping = printing::suggest_mapping(plate, status.as_ref());
            json!({
                "printer_id": p.id,
                "name": p.name,
                "machine_profile": p.machine_profile,
                "nozzle_diameter": p.nozzle_diameter,
                "incompatible": printing::incompatibility(&state.profile_store, p, plate),
                "busy": busy_reason(&state, p),
                "ams_mapping": mapping,
                "problems": printing::check_mapping(plate, &mapping, status.as_ref()),
                "status": status,
            })
        })
        .collect();
    let prices = crate::cost::Prices::load(&state.db);
    Ok(Json(json!({
        "plates": pkg.plates,
        "targets": targets,
        "needs_approval": needs_approval,
        "estimated_cost": prices.plate(plate),
        "currency": prices.currency,
    })))
}

#[derive(Deserialize)]
struct SendRequest {
    printer_id: String,
    plate: Option<u32>,
    /// Tray slot per project filament (index = filament id - 1), -1 = none.
    /// Omitted: the suggestion.
    ams_mapping: Option<Vec<i64>>,
    #[serde(default)]
    options: PrintOptions,
    /// Send even though the mapping doesn't match what's loaded.
    #[serde(default)]
    ignore_mapping_problems: bool,
}

/// `POST /api/jobs/{id}/print`: upload the job's package to a printer and
/// start it. Returns the print (status `uploading`) right away.
async fn send_job(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<SendRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (job, tree, viewer) = visible_job(&state, &user, &id)?;
    let pkg = printing::package_of(&job).ok_or_else(|| {
        api_err(StatusCode::CONFLICT, "this job has no printable package (re-slice it, or upload a .gcode.3mf)")
    })?;
    let package_path = job
        .package_path
        .clone()
        .filter(|p| std::path::Path::new(p).exists())
        .ok_or_else(|| api_err(StatusCode::CONFLICT, "the job's package file is gone"))?;
    let plate = pkg
        .plate(body.plate.unwrap_or(pkg.plates[0].index))
        .ok_or_else(|| api_err(StatusCode::BAD_REQUEST, "no such plate"))?
        .clone();
    let printer = state
        .db
        .get_printer(&body.printer_id)
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such printer"))?;

    if let Some(why) = printing::incompatibility(&state.profile_store, &printer, &plate) {
        return Err(api_err(StatusCode::CONFLICT, format!("can't print here: {why}")));
    }
    let violations = rules_for(&tree, &viewer, &job)
        .map(|r| printing::rule_violations(&r, &plate))
        .unwrap_or_default();
    let reason = (!violations.is_empty()).then(|| violations.join("; "));

    // A request that waits for approval doesn't need the printer now: the
    // approver's send checks availability and the trays again.
    let status = state.printers.status(&printer.id);
    let mapping = body
        .ams_mapping
        .clone()
        .unwrap_or_else(|| printing::suggest_mapping(&plate, status.as_ref()));
    if reason.is_none() {
        if let Some(why) = busy_reason(&state, &printer) {
            return Err(api_err(StatusCode::CONFLICT, why));
        }
        let problems = printing::check_mapping(&plate, &mapping, status.as_ref());
        if !problems.is_empty() && !body.ignore_mapping_problems {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error": format!("filament mapping: {}", problems.join("; ")), "problems": problems})),
            ));
        }
    }

    let print_id = uuid::Uuid::new_v4().to_string();
    let name = printing::display_name(&job.model_name);
    let print = state.db.create_print(
        &print_id,
        &job.id,
        plate.index as i64,
        &printer,
        Some(&user.id),
        job.group_id.as_deref(),
        &printing::file_name(&name, &print_id),
        &name,
        &serde_json::to_string(&mapping).expect("mappings serialize"),
        &serde_json::to_string(&body.options).expect("options serialize"),
        reason.as_deref(),
    );
    if let Some(reason) = reason {
        println!(
            "Print {}: {} asks to print {} on {}; needs approval: {reason}",
            print.id, user.username, job.model_name, printer.name
        );
        return Ok((StatusCode::ACCEPTED, Json(json!(print))));
    }
    println!(
        "Print {}: {} sends {} (plate {}) to {}, AMS mapping {:?}",
        print.id, user.username, job.model_name, plate.index, printer.name, mapping
    );
    printing::spawn_send(state.clone(), print.clone(), package_path, plate, mapping, body.options);
    Ok((StatusCode::CREATED, Json(json!(print))))
}

// -- Prints ----------------------------------------------------------------------

fn can_see_print(state: &AppState, tree: &Tree, viewer: &Viewer, print: &PrintRecord) -> bool {
    viewer.admin
        || print.user_id.as_deref() == Some(viewer.user.id.as_str())
        || print
            .job_id
            .as_deref()
            .and_then(|j| state.db.get_job(j))
            .is_some_and(|job| viewer.can_see_job(tree, &job))
}

/// Admins and the managers of the print's group approve requests.
fn can_approve_print(tree: &Tree, viewer: &Viewer, print: &PrintRecord) -> bool {
    viewer.admin || print.group_id.as_deref().is_some_and(|g| viewer.can_manage(tree, g))
}

fn can_control_print(tree: &Tree, viewer: &Viewer, print: &PrintRecord) -> bool {
    viewer.admin
        || print.user_id.as_deref() == Some(viewer.user.id.as_str())
        || print.group_id.as_deref().is_some_and(|g| viewer.can_manage(tree, g))
}

#[derive(Deserialize)]
struct PrintsQuery {
    printer: Option<String>,
    #[serde(default, deserialize_with = "crate::query::flag")]
    active: Option<bool>,
    /// Only requests waiting for approval, oldest first.
    #[serde(default, deserialize_with = "crate::query::flag")]
    pending: Option<bool>,
    limit: Option<i64>,
}

/// `GET /api/prints?printer=&active=1&limit=`: newest first. Prints of
/// jobs the caller can't see show up anonymised (printer and status only),
/// so everyone can tell what's occupying a printer.
async fn list_prints(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Query(q): Query<PrintsQuery>,
) -> Json<Value> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let prices = crate::cost::Prices::load(&state.db);
    let list = if q.pending.unwrap_or(false) {
        state.db.pending_prints()
    } else {
        state
            .db
            .list_prints(q.printer.as_deref(), q.active.unwrap_or(false), q.limit.unwrap_or(100).clamp(1, 1000))
    };
    let prints: Vec<Value> = list
        .into_iter()
        .map(|p| {
            if can_see_print(&state, &tree, &viewer, &p) {
                let mut v = json!(p);
                v["estimated_cost"] = json!(p
                    .job_id
                    .as_deref()
                    .and_then(|j| state.db.get_job(j))
                    .and_then(|job| printing::package_of(&job))
                    .and_then(|pkg| pkg.plate(p.plate as u32).map(|pl| prices.plate(pl))));
                v["can_control"] = json!(can_control_print(&tree, &viewer, &p));
                v["can_approve"] = json!(p.status == "pending_approval" && can_approve_print(&tree, &viewer, &p));
                v
            } else {
                json!({
                    "id": p.id, "printer_id": p.printer_id, "printer_name": p.printer_name,
                    "status": p.status, "progress": p.progress, "created_at": p.created_at,
                    "name": null, "can_control": false, "can_approve": false,
                })
            }
        })
        .collect();
    Json(json!(prints))
}

async fn get_print(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let print = state
        .db
        .get_print(&id)
        .filter(|p| can_see_print(&state, &tree, &viewer, p))
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "print not found"))?;
    let mut v = json!(print);
    v["can_control"] = json!(can_control_print(&tree, &viewer, &print));
    v["can_approve"] = json!(print.status == "pending_approval" && can_approve_print(&tree, &viewer, &print));
    Ok(Json(v))
}

/// `POST /api/prints/{id}/approve`: send a print that was waiting for
/// approval, with the plate, mapping and options it was asked with. The
/// printer must still fit and be free.
#[derive(Deserialize, Default)]
struct ApproveRequest {
    /// Send even though the stored tray choice no longer matches what's loaded.
    #[serde(default)]
    ignore_mapping_problems: bool,
}

async fn approve_print(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    body: Option<Json<ApproveRequest>>,
) -> Result<Json<Value>, ApiError> {
    let body = body.map(|b| b.0).unwrap_or_default();
    let (tree, viewer) = groups_api::context(&state, &user);
    let print = state
        .db
        .get_print(&id)
        .filter(|p| can_see_print(&state, &tree, &viewer, p))
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "print not found"))?;
    if print.status != "pending_approval" {
        return Err(api_err(StatusCode::CONFLICT, format!("the print is {}", print.status)));
    }
    if !can_approve_print(&tree, &viewer, &print) {
        return Err(api_err(StatusCode::FORBIDDEN, "only admins and the group's managers approve prints"));
    }
    let job = print
        .job_id
        .as_deref()
        .and_then(|j| state.db.get_job(j))
        .ok_or_else(|| api_err(StatusCode::CONFLICT, "the job is gone"))?;
    let pkg = printing::package_of(&job).ok_or_else(|| api_err(StatusCode::CONFLICT, "the job has no package"))?;
    let package_path = job
        .package_path
        .clone()
        .filter(|p| std::path::Path::new(p).exists())
        .ok_or_else(|| api_err(StatusCode::CONFLICT, "the job's package file is gone"))?;
    let plate = pkg
        .plate(print.plate as u32)
        .ok_or_else(|| api_err(StatusCode::CONFLICT, "the plate is gone"))?
        .clone();
    let printer = print
        .printer_id
        .as_deref()
        .and_then(|p| state.db.get_printer(p))
        .ok_or_else(|| api_err(StatusCode::CONFLICT, "the printer was removed"))?;
    if let Some(why) = printing::incompatibility(&state.profile_store, &printer, &plate) {
        return Err(api_err(StatusCode::CONFLICT, format!("can't print there any more: {why}")));
    }
    if let Some(why) = busy_reason(&state, &printer) {
        return Err(api_err(StatusCode::CONFLICT, format!("{why}; approve it when the printer is free")));
    }
    let mapping: Vec<i64> = serde_json::from_str(print.ams_mapping.as_deref().unwrap_or("[]")).unwrap_or_default();
    let options: PrintOptions = serde_json::from_str(print.options.as_deref().unwrap_or("{}")).unwrap_or_default();
    let problems = printing::check_mapping(&plate, &mapping, state.printers.status(&printer.id).as_ref());
    if !problems.is_empty() && !body.ignore_mapping_problems {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error": format!("filament mapping: {}", problems.join("; ")), "problems": problems})),
        ));
    }
    if !state.db.decide_print(&id, true, &user.username, None) {
        return Err(api_err(StatusCode::CONFLICT, "someone else decided first"));
    }
    println!("Print {}: {} approved it; sending to {}", id, user.username, printer.name);
    let print = state.db.get_print(&id).expect("print exists");
    printing::spawn_send(state.clone(), print.clone(), package_path, plate, mapping, options);
    Ok(Json(json!(print)))
}

#[derive(Deserialize, Default)]
struct RejectRequest {
    #[serde(default)]
    note: Option<String>,
}

/// `POST /api/prints/{id}/reject`: turn a request down (approvers), or
/// withdraw it (whoever asked).
async fn reject_print(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    body: Option<Json<RejectRequest>>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let print = state
        .db
        .get_print(&id)
        .filter(|p| can_see_print(&state, &tree, &viewer, p))
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "print not found"))?;
    let own = print.user_id.as_deref() == Some(user.id.as_str());
    if !own && !can_approve_print(&tree, &viewer, &print) {
        return Err(api_err(StatusCode::FORBIDDEN, "only admins and the group's managers decide prints"));
    }
    let note = body.and_then(|b| b.0.note).map(|n| n.trim().chars().take(500).collect::<String>());
    let note = match (own && !can_approve_print(&tree, &viewer, &print), note.filter(|n| !n.is_empty())) {
        (true, _) => format!("withdrawn by {}", user.username),
        (false, Some(n)) => format!("rejected by {}: {n}", user.username),
        (false, None) => format!("rejected by {}", user.username),
    };
    if !state.db.decide_print(&id, false, &user.username, Some(&note)) {
        return Err(api_err(StatusCode::CONFLICT, format!("the print is {}", print.status)));
    }
    println!("Print {id}: {note}");
    Ok(Json(json!(state.db.get_print(&id))))
}

#[derive(Deserialize)]
struct ControlRequest {
    /// pause | resume | stop | speed
    action: String,
    /// For `speed`: 1 silent, 2 standard, 3 sport, 4 ludicrous.
    level: Option<u8>,
}

fn control_command(body: &ControlRequest) -> Result<Value, ApiError> {
    Ok(match body.action.as_str() {
        "pause" | "resume" | "stop" => json!({"print": {"command": body.action}}),
        "speed" => match body.level {
            // The firmware wants the level as a string.
            Some(l @ 1..=4) => json!({"print": {"command": "print_speed", "param": l.to_string()}}),
            _ => return Err(api_err(StatusCode::BAD_REQUEST, "speed level must be 1 to 4")),
        },
        other => return Err(api_err(StatusCode::BAD_REQUEST, format!("unknown action {other:?}"))),
    })
}

async fn run_control(state: &AppState, printer_id: &str, command: Value) -> Result<Json<Value>, ApiError> {
    match state.printers.command(printer_id, command, Duration::from_secs(5)).await {
        Ok(Some(response)) => {
            let body = response.as_object().and_then(|o| o.values().next()).cloned().unwrap_or(Value::Null);
            let result = body["result"].as_str().unwrap_or("").to_ascii_uppercase();
            if result == "FAIL" {
                let reason = body["reason"].as_str().unwrap_or("no reason given");
                return Err(api_err(StatusCode::BAD_GATEWAY, format!("the printer refused: {reason}")));
            }
            Ok(Json(json!({"ok": true, "response": body})))
        }
        Ok(None) => Ok(Json(json!({"ok": true, "response": null, "note": "the printer didn't confirm"}))),
        Err(e) => Err(api_err(StatusCode::CONFLICT, e.to_string())),
    }
}

/// `POST /api/prints/{id}/control`: pause, resume, stop or change speed.
async fn control_print(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<ControlRequest>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let print = state
        .db
        .get_print(&id)
        .filter(|p| can_see_print(&state, &tree, &viewer, p))
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "print not found"))?;
    if !can_control_print(&tree, &viewer, &print) {
        return Err(api_err(StatusCode::FORBIDDEN, "only whoever sent the print, its group's managers or an admin can"));
    }
    if !matches!(print.status.as_str(), "printing" | "paused" | "starting") {
        return Err(api_err(StatusCode::CONFLICT, format!("the print is {}", print.status)));
    }
    let printer_id = print.printer_id.clone().ok_or_else(|| api_err(StatusCode::CONFLICT, "the printer was removed"))?;
    // Don't act on someone else's job if the printer moved on.
    if let Some(s) = state.printers.status(&printer_id) {
        if printing::transition(&print, &s).is_some_and(|(st, _, _)| st == "failed")
            && !viewer.admin
        {
            return Err(api_err(StatusCode::CONFLICT, "the printer is running something else now"));
        }
    }
    let command = control_command(&body)?;
    println!("Print {}: {} asks to {} it", print.id, user.username, body.action);
    run_control(&state, &printer_id, command).await
}

/// `POST /api/printers/{id}/control` (admins): act on whatever the printer
/// is doing, including prints started elsewhere.
async fn control_printer(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<ControlRequest>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&user)?;
    state.db.get_printer(&id).ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such printer"))?;
    let command = control_command(&body)?;
    println!("Printer {id}: {} asks to {}", user.username, body.action);
    run_control(&state, &id, command).await
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/uploads", post(upload_package))
        .route("/api/jobs/{id}/thumbnail", get(job_thumbnail))
        .route("/api/jobs/{id}/targets", get(job_targets))
        .route("/api/jobs/{id}/print", post(send_job))
        .route("/api/prints", get(list_prints))
        .route("/api/prints/{id}", get(get_print))
        .route("/api/prints/{id}/control", post(control_print))
        .route("/api/prints/{id}/approve", post(approve_print))
        .route("/api/prints/{id}/reject", post(reject_print))
        .route("/api/printers/{id}/control", post(control_printer))
}
