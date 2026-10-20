//! Printing: upload a sliced project, see where a job can print, send it,
//! follow and control prints.
//!
//! Who may do what:
//! - send a job: anyone who can see it (its creator, the group, managers,
//!   admins), to an online, idle, compatible printer. Every plate's G-code
//!   is checked first (src/safety.rs): what can't be read safely is never
//!   sent, and what needs review waits for an admin;
//! - pause/resume/stop a print: whoever sent it, managers of its group,
//!   admins; anything on a printer (prints from elsewhere too): admins.

use std::sync::Arc;

use axum::extract::{Multipart, Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{self, CurrentUser};
use crate::package::{self, Package};
use crate::db::{Job, PrintRecord, Printer, User};
use crate::groups::{PrintRules, Tree, Viewer};
use crate::printer::status::state;
use crate::printer::{Command, CommandError, Speed};
use crate::printing::{self, PrintOptions};
use crate::server::{AppState, finish_job};
use crate::{groups_api, quota, safety};

type ApiError = (StatusCode, Json<Value>);

const NO_PACKAGE: &str = "this job has nothing printable (re-slice it, or upload a sliced .gcode.3mf or .gcode)";

fn api_err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

/// A job the caller may see, or 404.
pub(crate) fn visible_job(state: &AppState, user: &User, id: &str) -> Result<(Job, Tree, Viewer), ApiError> {
    let (tree, viewer) = groups_api::context(state, user);
    match state.db.get_job(id) {
        Some(job) if viewer.can_see_job(&tree, &job) => Ok((job, tree, viewer)),
        _ => Err(api_err(StatusCode::NOT_FOUND, "job not found")),
    }
}

// -- Uploading a sliced project --------------------------------------------------

/// `POST /api/uploads` (multipart `file`, optional `group_id`): a sliced
/// file becomes a finished job that can be sent to printers: a `.gcode.3mf`
/// from Bambu Studio or OrcaSlicer, or plain G-code from any slicer.
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
                let name = field.file_name().unwrap_or("upload.gcode").to_string();
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
    let exempt = viewer.admin || group_id.as_deref().is_some_and(|g| viewer.can_manage(&tree, g));
    if upload_policy(&tree, group_id.as_deref()) == "deny" && !exempt {
        return Err(api_err(
            StatusCode::FORBIDDEN,
            "sliced files can't be uploaded here: slice the model in FarmSlicer instead",
        ));
    }
    quota::check(&state.db, &tree, &user, group_id.as_deref())
        .map_err(|e| api_err(StatusCode::TOO_MANY_REQUESTS, e))?;

    let dir = state.data_dir.join("packages");
    std::fs::create_dir_all(&dir).map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let staging = dir.join(format!("upload-{}", uuid::Uuid::new_v4()));
    std::fs::write(&staging, &data).map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let inspect_path = staging.clone();
    let inspected = tokio::task::spawn_blocking(move || package::inspect(&inspect_path))
        .await
        .map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let pkg = match inspected {
        Ok(p) => p,
        Err(e) => {
            std::fs::remove_file(&staging).ok();
            return Err(api_err(StatusCode::BAD_REQUEST, e));
        }
    };

    let job = state
        .db
        .create_job(&name, "", None, "auto", None, None, "upload", Some(&user.id), group_id.as_deref(), 0, None);
    let path = dir.join(format!("{}{}", job.id, pkg.format.extension()));
    std::fs::rename(&staging, &path).map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let path = path.to_string_lossy().to_string();
    state
        .db
        .set_job_package(&job.id, &path, &serde_json::to_string(&pkg).expect("packages serialize"));
    finish_job(
        &state,
        &job.id,
        &path,
        pkg.total_time_sec(),
        pkg.total_grams(),
        &[],
    );
    // Check the G-code now, so the uploader sees what it found.
    let checker = state.clone();
    let job_id = job.id.clone();
    if let Ok(Err(e)) = tokio::task::spawn_blocking(move || safety::check_job(&checker, &job_id)).await {
        eprintln!("job {}: can't check its G-code: {e}", job.id);
    }
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
    let format = pkg.format;
    let img = tokio::task::spawn_blocking(move || package::thumbnail(std::path::Path::new(&path), format, index))
        .await
        .ok()
        .flatten()
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no thumbnail"))?;
    Ok((
        [
            (header::CONTENT_TYPE, img.content_type),
            (header::CACHE_CONTROL, "private, max-age=86400"),
        ],
        img.bytes,
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

/// The upload policy for jobs charged to `group` (personal: the site's).
fn upload_policy(tree: &Tree, group: Option<&str>) -> String {
    match group {
        Some(g) if tree.get(g).is_some() => tree.effective(g).uploads,
        _ => tree.site_uploads().to_string(),
    }
}

/// Why an uploaded job's prints need approval, or can't be sent, under the
/// upload policy (admins and the group's managers are exempt).
fn upload_hold(tree: &Tree, viewer: &Viewer, job: &Job) -> Result<Option<String>, ApiError> {
    if job.source != "upload" || viewer.admin || job.group_id.as_deref().is_some_and(|g| viewer.can_manage(tree, g)) {
        return Ok(None);
    }
    match upload_policy(tree, job.group_id.as_deref()).as_str() {
        "deny" => Err(api_err(StatusCode::FORBIDDEN, "uploaded files can't be printed here any more")),
        "review" => Ok(Some("uploaded files need approval here".to_string())),
        _ => Ok(None),
    }
}

/// The job's package, every plate's G-code checked.
async fn checked(state: &Arc<AppState>, job: &Job) -> Result<Package, ApiError> {
    if printing::package_of(job).is_none() {
        return Err(api_err(StatusCode::CONFLICT, NO_PACKAGE));
    }
    safety::checked_package(state, job).await.map_err(|e| api_err(StatusCode::CONFLICT, e))
}

/// What the plate's G-code check says against sending it: findings that
/// stop it outright, and findings an admin must review.
fn check_holds(plate: &package::Plate) -> (Vec<String>, Vec<String>) {
    use crate::gcode::Severity;
    let Some(c) = &plate.check else {
        return (vec!["its G-code hasn't been checked".to_string()], Vec::new());
    };
    let of = |s: Severity| -> Vec<String> {
        c.findings.iter().filter(|f| f.severity == s).map(|f| f.message.clone()).collect()
    };
    (of(Severity::Block), of(Severity::Review))
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
        None if crate::printer::protocol_of(printer).is_none() => {
            Some(format!("FarmSlicer can't talk to {} printers", printer.protocol))
        }
        None => Some(format!("{} isn't connected (its connection settings are incomplete)", printer.name)),
        Some(s) if !s.online => Some(format!(
            "{} is offline{}",
            printer.name,
            s.connection_error.map(|e| format!(": {e}")).unwrap_or_default()
        )),
        Some(s) if state::is_busy(s.state.as_deref()) => {
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
    let pkg = checked(&state, &job).await?;
    let plate = pkg
        .plate(q.plate.unwrap_or(pkg.plates[0].index))
        .ok_or_else(|| api_err(StatusCode::BAD_REQUEST, "no such plate"))?;
    let mut needs_approval = rules_for(&tree, &viewer, &job)
        .map(|r| printing::rule_violations(&r, plate))
        .unwrap_or_default();
    let upload = upload_hold(&tree, &viewer, &job);
    if let Ok(Some(why)) = &upload {
        needs_approval.push(why.clone());
    }
    let (blocked, needs_review) = check_holds(plate);
    let targets: Vec<Value> = state
        .db
        .list_printers()
        .iter()
        .map(|p| {
            let status = state.printers.status(&p.id);
            let mapping = printing::mapping_for(p, plate, None, status.as_ref());
            json!({
                "printer_id": p.id,
                "name": p.name,
                "machine_profile": p.machine_profile,
                "nozzle_diameter": p.nozzle_diameter,
                "capabilities": crate::printer::protocol_of(p).map(|proto| proto.capabilities()),
                "incompatible": printing::incompatibility(&state.profile_store, p, pkg.format, plate),
                "busy": busy_reason(&state, p),
                "ams_mapping": mapping,
                "problems": printing::send_problems(plate, p, &mapping, status.as_ref()),
                "status": status,
            })
        })
        .collect();
    let prices = crate::cost::Prices::load(&state.db);
    Ok(Json(json!({
        "format": pkg.format,
        "plates": pkg.plates,
        "targets": targets,
        "needs_approval": needs_approval,
        // G-code findings (src/gcode/): `blocked` can't be sent at all,
        // `needs_review` waits for an admin (who acknowledges it instead).
        "blocked": blocked,
        "needs_review": needs_review,
        "uploads_denied": upload.err().map(|(_, e)| e.0["error"].clone()),
        "gcode_check": plate.check,
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
    /// Admins: send even though the G-code check wants a review (recorded
    /// on the print).
    #[serde(default)]
    acknowledge_review: bool,
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
    let pkg = checked(&state, &job).await?;
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

    if let Some(why) = printing::incompatibility(&state.profile_store, &printer, pkg.format, &plate) {
        return Err(api_err(StatusCode::CONFLICT, format!("can't print here: {why}")));
    }
    let (blocked, review) = check_holds(&plate);
    if !blocked.is_empty() {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error": format!("this plate can't be sent: {}", blocked.join("; ")), "blocked": blocked})),
        ));
    }
    if viewer.admin && !review.is_empty() && !body.acknowledge_review {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({
                "error": format!("the G-code needs review: {}", review.join("; ")),
                "needs_review": review,
            })),
        ));
    }
    let violations = rules_for(&tree, &viewer, &job)
        .map(|r| printing::rule_violations(&r, &plate))
        .unwrap_or_default();
    let mut reasons = Vec::new();
    if !review.is_empty() {
        reasons.push(format!("G-code review: {}", review.join("; ")));
    }
    reasons.extend(violations);
    if let Some(why) = upload_hold(&tree, &viewer, &job)? {
        reasons.push(why);
    }
    let safety_review = !review.is_empty();
    // An admin who acknowledged the review sends it now, on the record.
    let decided_by = (viewer.admin && safety_review).then(|| user.username.clone());
    let reason = (!reasons.is_empty()).then(|| reasons.join("; "));
    let waits = reason.is_some() && decided_by.is_none();

    // A request that waits for approval doesn't need the printer now: the
    // approver's send checks availability and the trays again.
    let status = state.printers.status(&printer.id);
    let mapping = printing::mapping_for(&printer, &plate, body.ams_mapping.clone(), status.as_ref());
    if !waits {
        if let Some(why) = busy_reason(&state, &printer) {
            return Err(api_err(StatusCode::CONFLICT, why));
        }
        let problems = printing::send_problems(&plate, &printer, &mapping, status.as_ref());
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
        &printing::file_name(&name, &print_id, printing::sent_as(&printer, pkg.format)),
        &name,
        &serde_json::to_string(&mapping).expect("mappings serialize"),
        &serde_json::to_string(&body.options).expect("options serialize"),
        reason.as_deref(),
        safety_review,
        decided_by.as_deref(),
    );
    if waits {
        println!(
            "Print {}: {} asks to print {} on {}; needs approval: {}",
            print.id,
            user.username,
            job.model_name,
            printer.name,
            reason.as_deref().unwrap_or("")
        );
        return Ok((StatusCode::ACCEPTED, Json(json!(print))));
    }
    if decided_by.is_some() {
        println!("Print {}: {} sends it despite the G-code review: {}", print.id, user.username, review.join("; "));
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

/// Admins and the managers of the print's group approve requests; only
/// admins approve G-code that needs review (it's the farm's hardware).
fn can_approve_print(tree: &Tree, viewer: &Viewer, print: &PrintRecord) -> bool {
    viewer.admin || (!print.safety_review && print.group_id.as_deref().is_some_and(|g| viewer.can_manage(tree, g)))
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
    /// Only finished prints nobody has said the outcome of, oldest first.
    #[serde(default, deserialize_with = "crate::query::flag")]
    unchecked: Option<bool>,
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
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let list = if q.pending.unwrap_or(false) {
        state.db.pending_prints()
    } else if q.unchecked.unwrap_or(false) {
        state.db.unchecked_prints(limit)
    } else {
        state
            .db
            .list_prints(q.printer.as_deref(), q.active.unwrap_or(false), limit)
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
                add_outcome(&state, &tree, &viewer, &p, &mut v);
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
    add_outcome(&state, &tree, &viewer, &print, &mut v);
    Ok(Json(v))
}

// -- Outcomes --------------------------------------------------------------------

/// Whoever may control a print may say how it came out; so may the
/// operators of its printer (src/pools.rs).
fn can_record_outcome(state: &AppState, tree: &Tree, viewer: &Viewer, print: &PrintRecord) -> bool {
    can_control_print(tree, viewer, print) || crate::pools::operates(state, viewer, print.printer_id.as_deref())
}

/// Did the print get far enough to hold copies to count?
fn has_copies(print: &PrintRecord) -> bool {
    match print.status.as_str() {
        "finished" => true,
        "failed" | "cancelled" => print.started_at.is_some(),
        _ => false,
    }
}

/// The print's lines (`good`/`failed` null until recorded) and whether the
/// viewer may record its outcome.
fn add_outcome(state: &AppState, tree: &Tree, viewer: &Viewer, print: &PrintRecord, v: &mut Value) {
    let recorded = state.db.print_outcome_lines(&print.id);
    v["lines"] = if recorded.is_empty() {
        json!(crate::outcomes::print_lines(state, print)
            .into_iter()
            .map(|l| {
                let mut j = json!(l);
                j["good"] = Value::Null;
                j["failed"] = Value::Null;
                j["reason"] = Value::Null;
                j
            })
            .collect::<Vec<_>>())
    } else {
        json!(recorded)
    };
    v["can_record_outcome"] = json!(has_copies(print) && can_record_outcome(state, tree, viewer, print));
}

/// `POST /api/prints/{id}/outcome`: how the print came out
/// (src/outcomes.rs `OutcomeRequest`), replacing any earlier record.
async fn record_outcome(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<crate::outcomes::OutcomeRequest>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let print = state
        .db
        .get_print(&id)
        .filter(|p| can_see_print(&state, &tree, &viewer, p) || crate::pools::operates(&state, &viewer, p.printer_id.as_deref()))
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "print not found"))?;
    if !can_record_outcome(&state, &tree, &viewer, &print) {
        return Err(api_err(
            StatusCode::FORBIDDEN,
            "only whoever sent the print, its group's managers, the printer's operators or an admin can",
        ));
    }
    if !has_copies(&print) {
        return Err(api_err(
            StatusCode::CONFLICT,
            match print.status.as_str() {
                "failed" | "cancelled" => "the print never started: there is nothing to count".to_string(),
                s => format!("the print is {s}: say how it came out once it has ended"),
            },
        ));
    }
    let lines = crate::outcomes::print_lines(&state, &print);
    let outcomes = crate::outcomes::resolve(&lines, &body).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let note = body.note.as_deref().map(|n| n.trim().chars().take(1000).collect::<String>()).filter(|n| !n.is_empty());
    let summary = crate::outcomes::summary(&outcomes);
    state.db.set_print_outcome(&id, summary, &user.username, note.as_deref(), &outcomes);
    println!("Print {id}: {} says {summary}", user.username);
    let print = state.db.get_print(&id).expect("print exists");
    let mut v = json!(print);
    add_outcome(&state, &tree, &viewer, &print, &mut v);
    Ok(Json(v))
}

/// `GET /api/outcome-reasons`: why copies fail, with labels.
async fn outcome_reasons() -> Json<Value> {
    Json(json!(crate::outcomes::REASONS
        .iter()
        .map(|(id, label)| json!({"id": id, "label": label}))
        .collect::<Vec<_>>()))
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
        return Err(api_err(
            StatusCode::FORBIDDEN,
            if print.safety_review {
                "only an admin can approve a print whose G-code needs review"
            } else {
                "only admins and the group's managers approve prints"
            },
        ));
    }
    let job = print
        .job_id
        .as_deref()
        .and_then(|j| state.db.get_job(j))
        .ok_or_else(|| api_err(StatusCode::CONFLICT, "the job is gone"))?;
    let pkg = checked(&state, &job).await?;
    let package_path = job
        .package_path
        .clone()
        .filter(|p| std::path::Path::new(p).exists())
        .ok_or_else(|| api_err(StatusCode::CONFLICT, "the job's package file is gone"))?;
    let plate = pkg
        .plate(print.plate as u32)
        .ok_or_else(|| api_err(StatusCode::CONFLICT, "the plate is gone"))?
        .clone();
    // Checked again: the checker, its data or the limits may have changed.
    let (blocked, review) = check_holds(&plate);
    if !blocked.is_empty() {
        return Err(api_err(StatusCode::CONFLICT, format!("this plate can't be sent: {}", blocked.join("; "))));
    }
    if !review.is_empty() && !viewer.admin {
        return Err(api_err(
            StatusCode::FORBIDDEN,
            format!("the G-code now needs an admin's review: {}", review.join("; ")),
        ));
    }
    let printer = print
        .printer_id
        .as_deref()
        .and_then(|p| state.db.get_printer(p))
        .ok_or_else(|| api_err(StatusCode::CONFLICT, "the printer was removed"))?;
    if let Some(why) = printing::incompatibility(&state.profile_store, &printer, pkg.format, &plate) {
        return Err(api_err(StatusCode::CONFLICT, format!("can't print there any more: {why}")));
    }
    if let Some(why) = busy_reason(&state, &printer) {
        return Err(api_err(StatusCode::CONFLICT, format!("{why}; approve it when the printer is free")));
    }
    let mapping: Vec<i64> = serde_json::from_str(print.ams_mapping.as_deref().unwrap_or("[]")).unwrap_or_default();
    let options: PrintOptions = serde_json::from_str(print.options.as_deref().unwrap_or("{}")).unwrap_or_default();
    let problems = printing::send_problems(&plate, &printer, &mapping, state.printers.status(&printer.id).as_ref());
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
    /// For `speed` on Bambu printers: 1 silent, 2 standard, 3 sport, 4 ludicrous.
    level: Option<u8>,
    /// For `speed` on printers that take a speed factor.
    percent: Option<u16>,
}

fn control_command(body: &ControlRequest) -> Result<Command, ApiError> {
    Ok(match body.action.as_str() {
        "pause" => Command::Pause,
        "resume" => Command::Resume,
        "stop" => Command::Stop,
        "speed" => match (body.level, body.percent) {
            (Some(l @ 1..=4), _) => Command::Speed(Speed::Level(l)),
            (None, Some(p @ 10..=500)) => Command::Speed(Speed::Percent(p)),
            _ => {
                return Err(api_err(
                    StatusCode::BAD_REQUEST,
                    "speed needs a level (1 to 4) or a percent (10 to 500)",
                ));
            }
        },
        other => return Err(api_err(StatusCode::BAD_REQUEST, format!("unknown action {other:?}"))),
    })
}

/// A printer command's outcome as an API response.
pub(crate) fn command_response(result: Result<Option<Value>, CommandError>) -> Result<Json<Value>, ApiError> {
    match result {
        Ok(Some(response)) => Ok(Json(json!({"ok": true, "response": response}))),
        Ok(None) => Ok(Json(json!({"ok": true, "response": null, "note": "the printer didn't confirm"}))),
        Err(e @ CommandError::Refused(_)) => Err(api_err(StatusCode::BAD_GATEWAY, e.to_string())),
        Err(e) => Err(api_err(StatusCode::CONFLICT, e.to_string())),
    }
}

async fn run_control(state: &AppState, printer_id: &str, command: Command) -> Result<Json<Value>, ApiError> {
    command_response(state.printers.command(printer_id, &command).await)
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
#[derive(Deserialize)]
struct IncidentQuery {
    user: Option<String>,
    limit: Option<i64>,
}

/// `GET /api/gcode-incidents?user=&limit=` (admins): custom G-code that
/// failed its check or a print, newest first (src/incidents.rs).
async fn list_gcode_incidents(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Query(q): Query<IncidentQuery>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&user)?;
    let list = state
        .db
        .list_gcode_incidents(q.user.as_deref().filter(|u| !u.is_empty()), q.limit.unwrap_or(200).clamp(1, 2000));
    Ok(Json(json!(list)))
}

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
        .route("/api/prints/{id}/outcome", post(record_outcome))
        .route("/api/outcome-reasons", get(outcome_reasons))
        .route("/api/printers/{id}/control", post(control_printer))
        .route("/api/gcode-incidents", get(list_gcode_incidents))
}
