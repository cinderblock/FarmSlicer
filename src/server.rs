use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{header, StatusCode},
    middleware,
    response::IntoResponse,
    routing::{get, post},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::auth::{self, CurrentUser};
use crate::auth_api;
use crate::config_policy;
use crate::db::{Db, Job, JobFilter, User};
use crate::discovery;
use crate::groups::{Tree, Viewer};
use crate::groups_api;
use crate::join_api;
use crate::overlay;
use crate::placement::{Placement, PlateLayout};
use crate::printer::PrinterHub;
use crate::printers_api;
use crate::prints_api;
use crate::profiles::ProfileStore;
use crate::progress;
use crate::quota;
use crate::slicer;

struct SlicerHandle(slicer::SlicerBox);
// Safety: Slicer is only accessed through Mutex, one thread at a time
unsafe impl Send for SlicerHandle {}
unsafe impl Sync for SlicerHandle {}

pub struct AppState {
    pub db: Arc<Db>,
    pub data_dir: std::path::PathBuf,
    slicer: Mutex<SlicerHandle>,
    pub profile_store: ProfileStore,
    pub discovered: Arc<discovery::DiscoveryMap>,
    /// Live links to the farm's printers (src/printer/).
    pub printers: PrinterHub,
    /// Camera feeds, started while someone watches.
    pub cameras: crate::camera::CameraHub,
    /// Pictures of prints started outside FarmSlicer, fetched from printers.
    pub printer_thumbs: crate::printer_thumbs::PrinterThumbs,
    /// WebAuthn relying party + in-flight ceremonies (src/auth.rs).
    pub rp: auth::Rp,
}

impl AppState {
    pub fn new(
        db: Arc<Db>,
        data_dir: std::path::PathBuf,
        slicer: slicer::SlicerBox,
        profile_store: ProfileStore,
        discovered: Arc<discovery::DiscoveryMap>,
        printers: PrinterHub,
        rp: auth::Rp,
    ) -> Self {
        Self {
            db,
            data_dir,
            slicer: Mutex::new(SlicerHandle(slicer)),
            profile_store,
            discovered,
            printers,
            cameras: Default::default(),
            printer_thumbs: Default::default(),
            rp,
        }
    }
}

// -- Health --

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

/// Load information the Slice page uses to suggest where to compute.
async fn server_status(State(state): State<Arc<AppState>>) -> Json<Value> {
    let jobs = state.db.list_jobs();
    let server_active = jobs
        .iter()
        .filter(|j| j.source == "server" && matches!(j.status.as_str(), "queued" | "slicing"))
        .count();
    let browser_engine = std::path::Path::new("dist/web/wasm/manifest.json").exists();
    Json(json!({
        "server_active_jobs": server_active,
        "slicer_busy": server_active > 0,
        "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        "browser_engine_available": browser_engine,
    }))
}

// -- Profiles --

async fn list_machine_models(State(state): State<Arc<AppState>>) -> Json<Value> {
    let models: Vec<_> = state
        .profile_store
        .machine_models()
        .iter()
        .map(|m| {
            json!({
                "name": m.name,
                "vendor": m.vendor,
                "vendor_display": m.vendor_display,
                "nozzle_diameters": m.nozzle_diameters,
                "variants": m.variants,
                "model_id": m.model_id,
            })
        })
        .collect();
    Json(json!(models))
}

async fn list_machines(State(state): State<Arc<AppState>>) -> Json<Value> {
    let machines: Vec<_> = state
        .profile_store
        .instantiable_machines()
        .into_iter()
        .map(|m| json!({"name": m.name, "vendor": m.vendor}))
        .collect();
    Json(json!(machines))
}

#[derive(Deserialize)]
struct ProfileQuery {
    machine: Option<String>,
}

#[derive(Deserialize)]
struct ResolveQuery {
    machine: String,
    process: String,
    filament: String,
}

async fn resolve_profiles(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ResolveQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let config_str = state
        .profile_store
        .resolve_config(&q.machine, &q.process, &q.filament)
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("Profile error: {e}")})),
            )
        })?;
    let config: Value = serde_json::from_str(&config_str).unwrap_or(json!({}));
    Ok(Json(config))
}

#[derive(Deserialize)]
struct ResolveSingleQuery {
    name: String,
}

async fn resolve_single_profile(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ResolveSingleQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let config_str = state
        .profile_store
        .resolve_single(&q.name)
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("Profile error: {e}")})),
            )
        })?;
    let config: Value = serde_json::from_str(&config_str).unwrap_or(json!({}));
    Ok(Json(config))
}

async fn list_processes(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ProfileQuery>,
) -> Json<Value> {
    let processes: Vec<_> = match &q.machine {
        Some(machine) => state
            .profile_store
            .processes_for_machine(machine)
            .into_iter()
            .map(|p| {
                json!({"name": p.name, "vendor": p.vendor, "description": p.description})
            })
            .collect(),
        None => state
            .profile_store
            .processes()
            .iter()
            .filter(|p| p.instantiable)
            .map(|p| {
                json!({"name": p.name, "vendor": p.vendor, "description": p.description})
            })
            .collect(),
    };
    Json(json!(processes))
}

async fn list_filaments(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ProfileQuery>,
) -> Json<Value> {
    let filaments: Vec<_> = match &q.machine {
        Some(machine) => state
            .profile_store
            .filaments_for_machine(machine)
            .into_iter()
            .map(|f| json!({"name": f.name, "vendor": f.vendor}))
            .collect(),
        None => state
            .profile_store
            .filaments()
            .iter()
            .filter(|f| f.instantiable)
            .map(|f| json!({"name": f.name, "vendor": f.vendor}))
            .collect(),
    };
    Json(json!(filaments))
}

// -- Discovery --

async fn list_discovered(State(state): State<Arc<AppState>>) -> Json<Value> {
    let map = state.discovered.lock().unwrap();
    let printers: Vec<_> = map
        .values()
        .map(|p| {
            json!(p)
        })
        .collect();
    Json(json!(printers))
}

// -- Custom Profiles --

async fn list_custom_profiles(State(state): State<Arc<AppState>>) -> Json<Value> {
    let profiles = state.db.list_custom_profiles();
    Json(json!(profiles))
}

#[derive(Deserialize)]
struct CreateCustomProfile {
    name: String,
    profile_type: String,
    base_profile: String,
    overrides: Option<String>,
}

async fn create_custom_profile(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<CreateCustomProfile>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    auth::require_full(&user)?;
    if body.name.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Name is required"})),
        ));
    }
    if !["process", "filament"].contains(&body.profile_type.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "profile_type must be 'process' or 'filament'"})),
        ));
    }
    let overrides = body.overrides.as_deref().unwrap_or("{}");
    config_policy::parse(overrides)
        .and_then(|m| config_policy::check(&m, auth::is_admin(&user)))
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let profile = state.db.create_custom_profile(
        &body.name,
        &body.profile_type,
        &body.base_profile,
        overrides,
    );
    Ok((StatusCode::CREATED, Json(json!(profile))))
}

#[derive(Deserialize)]
struct UpdateCustomProfile {
    name: Option<String>,
    overrides: Option<String>,
}

async fn update_custom_profile(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<UpdateCustomProfile>,
) -> Result<StatusCode, ApiError> {
    auth::require_full(&user)?;
    let Some(existing) = state.db.get_custom_profile(&id) else {
        return Err(api_err(StatusCode::NOT_FOUND, "no such profile"));
    };
    let name = body.name.as_deref().unwrap_or(&existing.name);
    let overrides = body.overrides.as_deref().unwrap_or(&existing.overrides);
    if body.overrides.is_some() {
        config_policy::parse(overrides)
            .and_then(|m| config_policy::check(&m, auth::is_admin(&user)))
            .map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    }
    if state.db.update_custom_profile(&id, name, overrides) {
        Ok(StatusCode::OK)
    } else {
        Err(api_err(StatusCode::NOT_FOUND, "no such profile"))
    }
}

async fn delete_custom_profile(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> StatusCode {
    if auth::require_full(&user).is_err() {
        return StatusCode::FORBIDDEN;
    }
    if state.db.delete_custom_profile(&id) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn get_custom_profile(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let Some(profile) = state.db.get_custom_profile(&id) else {
        return Err(StatusCode::NOT_FOUND);
    };

    // Resolve the base profile and overlay custom overrides
    let resolved = if let Ok(base_config_str) = state.profile_store.resolve_single(&profile.base_profile) {
        if let Ok(mut config) = serde_json::from_str::<serde_json::Map<String, Value>>(&base_config_str) {
            if let Ok(overrides) = serde_json::from_str::<serde_json::Map<String, Value>>(&profile.overrides) {
                for (k, v) in overrides {
                    config.insert(k, v);
                }
            }
            Some(Value::Object(config))
        } else {
            None
        }
    } else {
        None
    };

    Ok(Json(json!({
        "id": profile.id,
        "name": profile.name,
        "profile_type": profile.profile_type,
        "base_profile": profile.base_profile,
        "overrides": serde_json::from_str::<Value>(&profile.overrides).unwrap_or(json!({})),
        "resolved_config": resolved,
        "created_at": profile.created_at,
        "updated_at": profile.updated_at,
    })))
}

// -- Jobs --

type ApiError = (StatusCode, Json<Value>);

fn api_err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

/// Does the job have a model file on the server?
pub fn model_available(job: &Job) -> bool {
    !job.model_path.is_empty() && std::path::Path::new(&job.model_path).exists()
}

#[derive(Deserialize, Default)]
struct JobQuery {
    /// Only jobs charged to this group or its subgroups.
    #[serde(default)]
    group: Option<String>,
    /// Only the caller's own jobs.
    #[serde(default, deserialize_with = "crate::query::flag")]
    mine: Option<bool>,
}

/// What the caller may see, narrowed by the query.
fn job_filter(tree: &Tree, viewer: &Viewer, q: &JobQuery) -> JobFilter {
    JobFilter {
        visible_to: viewer
            .visible_groups(tree)
            .map(|groups| (viewer.user.id.clone(), groups)),
        user_id: q.mine.unwrap_or(false).then(|| viewer.user.id.clone()),
        group_ids: q.group.as_deref().map(|g| tree.subtree(g)),
    }
}

async fn list_jobs(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Query(q): Query<JobQuery>,
) -> Json<Value> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let prices = crate::cost::Prices::load(&state.db);
    let jobs: Vec<Value> = state
        .db
        .list_jobs_filtered(&job_filter(&tree, &viewer, &q))
        .into_iter()
        .map(|job| {
            let mut v = json!(job);
            v["estimated_cost"] = json!(prices.job(&job));
            v
        })
        .collect();
    Json(json!(jobs))
}

/// `GET /api/prices`: currency and price per kg (for showing estimates).
async fn get_prices(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!(crate::cost::Prices::load(&state.db)))
}

/// A job the caller may see, or 404.
fn visible_job(state: &AppState, user: &User, id: &str) -> Result<(Job, Tree, Viewer), ApiError> {
    let (tree, viewer) = groups_api::context(state, user);
    match state.db.get_job(id) {
        Some(job) if viewer.can_see_job(&tree, &job) => Ok((job, tree, viewer)),
        _ => Err(api_err(StatusCode::NOT_FOUND, "job not found")),
    }
}

/// Browser jobs are driven by the tab that created them.
fn own_job(state: &AppState, user: &User, id: &str) -> Result<Job, StatusCode> {
    match state.db.get_job(id) {
        Some(job) if job.user_id.as_deref() == Some(user.id.as_str()) || auth::auth_disabled() => Ok(job),
        _ => Err(StatusCode::NOT_FOUND),
    }
}

#[derive(Deserialize)]
struct UpdateJob {
    /// The group to charge the job to; null = personal.
    group_id: Option<String>,
}

/// Move a job to another group (or make it personal): its creator, into a
/// group they're an active member of; admins anywhere.
async fn update_job(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<UpdateJob>,
) -> Result<Json<Value>, ApiError> {
    let (job, tree, viewer) = visible_job(&state, &user, &id)?;
    let creator = job.user_id.as_deref() == Some(user.id.as_str());
    if !creator && !viewer.admin {
        return Err(api_err(StatusCode::FORBIDDEN, "only the job's creator or an admin can move it"));
    }
    if let Some(g) = &body.group_id {
        if tree.get(g).is_none() {
            return Err(api_err(StatusCode::BAD_REQUEST, "no such group"));
        }
        if !viewer.admin && !viewer.can_charge(g) {
            return Err(api_err(StatusCode::FORBIDDEN, "you are not an active member of that group"));
        }
    }
    state.db.set_job_group(&id, body.group_id.as_deref());
    Ok(Json(json!(state.db.get_job(&id))))
}

/// `GET /api/jobs/{id}`: one job, with its models, inputs and plate.
async fn get_job(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (job, _, _) = visible_job(&state, &user, &id)?;
    let models: Vec<Value> = state
        .db
        .job_models(&id)
        .iter()
        .map(|m| {
            let mut v = json!(m);
            v["stored"] = json!(m.stored());
            v
        })
        .collect();
    let mut v = json!(job);
    v["estimated_cost"] = json!(crate::cost::Prices::load(&state.db).job(&job));
    v["models"] = json!(models);
    v["inputs"] = job_inputs(&job).map_or(Value::Null, |i| json!(i));
    v["plate"] = json!(job_plate(&job));
    Ok(Json(v))
}

/// What a job was made from. Jobs from before `inputs_json` name their
/// profiles in the merged config (`*_settings_id`).
pub(crate) fn job_inputs(job: &Job) -> Option<JobInputs> {
    if let Some(inputs) = job.inputs_json.as_deref().and_then(|j| serde_json::from_str(j).ok()) {
        return Some(inputs);
    }
    let config: Value = serde_json::from_str(job.config_json.as_deref()?).ok()?;
    let text = |key: &str| -> String {
        match config.get(key) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(a)) => a.first().and_then(Value::as_str).unwrap_or_default().to_string(),
            _ => String::new(),
        }
    };
    let filaments = match config.get("filament_settings_id") {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(String::from).collect(),
        Some(Value::String(s)) => s.split(';').map(String::from).collect(),
        _ => Vec::new(),
    };
    let machine = text("printer_settings_id");
    if machine.is_empty() {
        return None;
    }
    Some(JobInputs {
        machine,
        process: text("print_settings_id"),
        filaments,
        bed_type: text("curr_bed_type"),
        printer_id: job.printer_id.clone(),
        routing: job.routing.clone(),
        color: String::new(),
        group_id: job.group_id.clone(),
        source: job.source.clone(),
    })
}

/// A file name safe inside a Content-Disposition header.
fn attachment_name(name: &str) -> String {
    name.chars().filter(|c| !matches!(c, '"' | '\\' | '\r' | '\n')).collect()
}

/// Send one stored model file.
fn model_response(path: &str, name: &str) -> Result<axum::response::Response, ApiError> {
    let data = std::fs::read(path).map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", attachment_name(name))),
        ],
        data,
    )
        .into_response())
}

/// `GET /api/jobs/{id}/model`: the job's (first) source model.
async fn download_model(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let (job, _, _) = visible_job(&state, &user, &id)?;
    match state.db.job_models(&id).into_iter().find(|m| m.stored()) {
        Some(m) => model_response(&m.path, &m.name),
        None if model_available(&job) => model_response(&job.model_path, &job.model_name),
        None => Err(api_err(StatusCode::NOT_FOUND, "the model of this job is not on the server")),
    }
}

/// `GET /api/jobs/{id}/models/{idx}`: one of the job's source models.
async fn download_job_model(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((id, idx)): Path<(String, i64)>,
) -> Result<axum::response::Response, ApiError> {
    visible_job(&state, &user, &id)?;
    match state.db.job_models(&id).into_iter().find(|m| m.idx == idx) {
        Some(m) if m.stored() => model_response(&m.path, &m.name),
        Some(_) => Err(api_err(StatusCode::NOT_FOUND, "this model stayed in the browser that sliced it")),
        None => Err(api_err(StatusCode::NOT_FOUND, "no such model")),
    }
}

/// Delete a job the caller may delete (its creator, whoever manages its
/// group, admins), with its files. Refused while it's slicing (cancel
/// first) or while a print still needs its package.
fn delete_one_job(state: &AppState, user: &User, id: &str) -> Result<(), ApiError> {
    let (job, tree, viewer) = visible_job(state, user, id)?;
    let creator = job.user_id.as_deref() == Some(user.id.as_str());
    let manager = job.group_id.as_deref().is_some_and(|g| viewer.can_manage(&tree, g));
    if !creator && !manager && !viewer.admin && !auth::auth_disabled() {
        return Err(api_err(StatusCode::FORBIDDEN, "only the job's creator, its group's managers or an admin can delete it"));
    }
    if matches!(job.status.as_str(), "queued" | "slicing") {
        return Err(api_err(StatusCode::CONFLICT, "the job is still slicing: cancel it first"));
    }
    if state.db.job_prints_in_progress(id) > 0 {
        return Err(api_err(StatusCode::CONFLICT, "a print of this job is waiting or in progress"));
    }
    let files = state.db.delete_job(id).ok_or_else(|| api_err(StatusCode::NOT_FOUND, "job not found"))?;
    for f in files {
        // Only ever files the server made, under its data directory.
        let path = std::path::Path::new(&f);
        if path.starts_with(&state.data_dir) {
            std::fs::remove_file(path).ok();
        } else {
            eprintln!("job {id}: not deleting {f}: outside the data directory");
        }
    }
    println!("job {id}: deleted by {}", user.username);
    Ok(())
}

/// `DELETE /api/jobs/{id}`.
async fn delete_job(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    delete_one_job(&state, &user, &id).map(|()| StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct DeleteJobs {
    ids: Vec<String>,
}

/// `POST /api/jobs/delete` `{"ids": [...]}`: delete several jobs; each one
/// is checked like a single delete. Answers which went and why the others
/// didn't.
async fn delete_jobs(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<DeleteJobs>,
) -> Result<Json<Value>, ApiError> {
    if body.ids.len() > 1000 {
        return Err(api_err(StatusCode::BAD_REQUEST, "at most 1000 jobs at a time"));
    }
    let mut deleted = Vec::new();
    let mut refused = Vec::new();
    for id in body.ids {
        match delete_one_job(&state, &user, &id) {
            Ok(()) => deleted.push(id),
            Err((_, Json(e))) => refused.push(json!({"id": id, "error": e["error"]})),
        }
    }
    Ok(Json(json!({"deleted": deleted, "refused": refused})))
}

/// What a job was made from: the Slice page's choices, recorded so the job
/// can be sliced again (`jobs.inputs_json`). Overrides live in
/// `overrides_json`, the parts in `plate_json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JobInputs {
    pub machine: String,
    pub process: String,
    pub filaments: Vec<String>,
    #[serde(default)]
    pub bed_type: String,
    #[serde(default)]
    pub printer_id: Option<String>,
    #[serde(default)]
    pub routing: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub group_id: Option<String>,
    /// "server" or "browser".
    #[serde(default)]
    pub source: String,
}

/// The most a `proposed` blob (the page's defaults, for the
/// defaults-changed report) may weigh.
const MAX_PROPOSED_BYTES: usize = 64 * 1024;

/// A model the browser kept ("keep on this device"): the server only knows
/// its name, size and digest.
#[derive(Deserialize)]
struct LocalModel {
    name: String,
    #[serde(default)]
    bytes: i64,
    #[serde(default)]
    sha256: Option<String>,
}

/// One of a new job's models.
struct NewModel {
    name: String,
    /// '' = kept in the browser.
    path: String,
    bytes: i64,
    sha256: Option<String>,
}

/// Files a request wrote; removed again unless the request succeeds.
#[derive(Default)]
struct Uploaded {
    paths: Vec<std::path::PathBuf>,
    keep: bool,
}

impl Drop for Uploaded {
    fn drop(&mut self) {
        if !self.keep {
            for p in &self.paths {
                std::fs::remove_file(p).ok();
            }
        }
    }
}

/// A job's display name: its model, or the first of several.
fn job_name(models: &[NewModel]) -> String {
    match models {
        [] => String::new(),
        [one] => one.name.clone(),
        [first, rest @ ..] => format!("{} + {} more", first.name, rest.len()),
    }
}

/// A model file's extension as stored (lowercase; STL when it has none).
fn model_extension(file_name: &str) -> String {
    std::path::Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| e.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "stl".into())
}

/// `POST /api/jobs` (multipart):
/// - `model` (repeatable): the source models, in order. Every job keeps them
///   so it can be sliced again.
/// - `local_models`: browser jobs whose models stay in the browser, JSON
///   `[{"name", "bytes", "sha256"}]` (`model_name`: one, from older pages).
/// - `machine`, `process`, `filament`, `overrides`, `bed_type`, `color`,
///   `printer_id`, `routing`, `group_id`, `source` ("server" | "browser").
/// - `plate`: the parts (src/placement.rs `PlateLayout`); `placement`: one
///   model's placement, from older pages.
/// - `proposed`: what the page proposed before the user changed anything
///   (JSON object; kept for the defaults-changed report).
async fn create_job(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let models_dir = state.data_dir.join("models");
    std::fs::create_dir_all(&models_dir).ok();
    let bad = |e: &dyn std::fmt::Display| api_err(StatusCode::BAD_REQUEST, e.to_string());

    let mut uploaded = Uploaded::default();
    let mut models: Vec<NewModel> = Vec::new();
    let mut local_models: Vec<NewModel> = Vec::new();
    let mut inputs = JobInputs {
        routing: "auto".into(),
        source: "server".into(),
        ..Default::default()
    };
    let mut overrides_str = String::new();
    let mut placement_str = String::new();
    let mut plate_str = String::new();
    let mut proposed_str = String::new();

    while let Some(field) = multipart.next_field().await.map_err(|e| bad(&e))? {
        let name = field.name().unwrap_or("").to_string();
        if name == "model" {
            let file_name = field.file_name().unwrap_or("model.stl").to_string();
            let data = field.bytes().await.map_err(|e| bad(&e))?;
            let dest = models_dir.join(format!("{}.{}", uuid::Uuid::new_v4(), model_extension(&file_name)));
            std::fs::write(&dest, &data).map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            uploaded.paths.push(dest.clone());
            models.push(NewModel {
                name: file_name,
                path: dest.to_string_lossy().to_string(),
                bytes: data.len() as i64,
                sha256: Some(hex::encode(Sha256::digest(&data))),
            });
            continue;
        }
        let text = field.text().await.unwrap_or_default();
        match name.as_str() {
            "group_id" if !text.is_empty() => inputs.group_id = Some(text),
            "printer_id" if !text.is_empty() => inputs.printer_id = Some(text),
            "routing" => inputs.routing = text,
            "machine" => inputs.machine = text,
            "process" => inputs.process = text,
            "filament" if !text.is_empty() => inputs.filaments.push(text),
            "color" => inputs.color = text.trim().to_string(),
            "overrides" => overrides_str = text,
            "bed_type" => inputs.bed_type = text.trim().to_string(),
            "placement" => placement_str = text.trim().to_string(),
            "plate" => plate_str = text.trim().to_string(),
            "proposed" => proposed_str = text.trim().to_string(),
            "source" => inputs.source = text,
            "local_models" => {
                let list: Vec<LocalModel> =
                    serde_json::from_str(&text).map_err(|e| bad(&format!("local_models: {e}")))?;
                local_models.extend(list.into_iter().map(|m| NewModel {
                    name: m.name,
                    path: String::new(),
                    bytes: m.bytes.max(0),
                    sha256: m.sha256.filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())),
                }));
            }
            // Browser jobs from older pages send the file name only.
            "model_name" if !text.is_empty() => local_models.push(NewModel {
                name: text,
                path: String::new(),
                bytes: 0,
                sha256: None,
            }),
            _ => {}
        }
    }

    if !matches!(inputs.source.as_str(), "server" | "browser") {
        return Err(bad(&"source must be 'server' or 'browser'"));
    }
    if !models.is_empty() && !local_models.is_empty() {
        return Err(bad(&"send the models or name local ones, not both"));
    }
    if models.is_empty() {
        if inputs.source == "server" {
            return Err(bad(&"No model file provided"));
        }
        if local_models.is_empty() {
            return Err(bad(&"model_name is required for browser jobs"));
        }
        models = local_models;
    }

    // The group the job is charged to, and every quota on the way.
    let (tree, viewer) = groups_api::context(&state, &user);
    match &inputs.group_id {
        Some(g) if tree.get(g).is_none() || !viewer.can_charge(g) => {
            return Err(api_err(StatusCode::FORBIDDEN, "you are not an active member of that group"));
        }
        _ => quota::check(&state.db, &tree, &user, inputs.group_id.as_deref())
            .map_err(|e| api_err(StatusCode::TOO_MANY_REQUESTS, e))?,
    }
    // Overrides may only touch what the caller is allowed to (no G-code).
    let overrides = config_policy::parse(&overrides_str)
        .and_then(|m| config_policy::check(&m, auth::is_admin(&user)).map(|()| m))
        .map_err(|e| bad(&e))?;
    let plate = if !plate_str.is_empty() {
        PlateLayout::parse(&plate_str, models.len()).map_err(|e| bad(&e))?
    } else if models.len() > 1 {
        return Err(bad(&"several models need a plate saying where each goes"));
    } else if placement_str.is_empty() {
        PlateLayout::single(None)
    } else {
        PlateLayout::single(Some(Placement::parse(&placement_str).map_err(|e| bad(&e))?))
    };
    let proposed = if proposed_str.is_empty() {
        None
    } else if proposed_str.len() > MAX_PROPOSED_BYTES
        || !serde_json::from_str::<Value>(&proposed_str).is_ok_and(|v| v.is_object())
    {
        return Err(bad(&"proposed must be a JSON object (64 KiB at most)"));
    } else {
        Some(proposed_str)
    };
    if inputs.filaments.len() > 1 {
        return Err(bad(&"several filaments per job aren't supported yet"));
    }
    if !inputs.bed_type.is_empty() && !crate::printing::BED_TYPES.contains(&inputs.bed_type.as_str()) {
        return Err(bad(&format!("unknown build plate {:?}", inputs.bed_type)));
    }

    let config_json = match inputs.filaments.first() {
        Some(filament) if !inputs.machine.is_empty() && !inputs.process.is_empty() => {
            let config_str = state
                .profile_store
                .resolve_config(&inputs.machine, &inputs.process, filament)
                .map_err(|e| bad(&format!("Profile error: {e}")))?;
            let mut config: serde_json::Map<String, Value> = serde_json::from_str(&config_str)
                .map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            // Per-job overrides on top of the resolved profiles.
            config.extend(overrides);
            if !inputs.bed_type.is_empty() {
                config.insert("curr_bed_type".into(), json!(inputs.bed_type));
            }
            serde_json::to_string(&Value::Object(config)).unwrap()
        }
        _ => "{}".to_string(),
    };

    let overrides_json = (!overrides_str.is_empty()).then_some(overrides_str);
    let first_stored = models.iter().find(|m| !m.path.is_empty()).map(|m| m.path.clone()).unwrap_or_default();
    let stored_bytes: i64 = models.iter().filter(|m| !m.path.is_empty()).map(|m| m.bytes).sum();
    let job = state.db.create_job(
        &job_name(&models),
        &first_stored,
        inputs.printer_id.as_deref(),
        &inputs.routing,
        Some(&config_json),
        overrides_json.as_deref(),
        &inputs.source,
        Some(&user.id),
        inputs.group_id.as_deref(),
        stored_bytes,
        None,
    );
    for (i, m) in models.iter().enumerate() {
        state.db.add_job_model(&job.id, i as i64, &m.name, &m.path, m.bytes, m.sha256.as_deref());
    }
    state.db.set_job_inputs(
        &job.id,
        &serde_json::to_string(&inputs).unwrap(),
        proposed.as_deref(),
        Some(&plate.to_json()),
    );
    uploaded.keep = true;
    let job_id = job.id.clone();

    if inputs.source == "browser" {
        // The client owns the slicing; the job just tracks it.
        state.db.update_job_status(&job_id, "slicing", 0);
        state.db.update_job_progress(&job_id, 0, "Slicing in browser");
        let job = state.db.get_job(&job_id).expect("job just created");
        let mut body = json!(job);
        body["slice_options"] = browser_slice_options(&state, &job, &config_json);
        return Ok((StatusCode::CREATED, Json(body)));
    }

    let job = state.db.get_job(&job_id).expect("job just created");
    let state_clone = state.clone();
    tokio::task::spawn_blocking(move || {
        run_slice(&state_clone, &job_id, &config_json);
    });

    Ok((StatusCode::CREATED, Json(json!(job))))
}

fn gcode_output_path(state: &AppState, job_id: &str) -> String {
    let gcode_dir = state.data_dir.join("gcode");
    std::fs::create_dir_all(&gcode_dir).ok();
    gcode_dir
        .join(format!("{job_id}.gcode"))
        .to_string_lossy()
        .to_string()
}

/// Record a finished slice: job row, slice-library row.
pub(crate) fn finish_job(
    state: &AppState,
    job_id: &str,
    gcode_path: &str,
    print_time_sec: f64,
    filament_used_g: f64,
    warnings: &[String],
) {
    let file_size = std::fs::metadata(gcode_path)
        .map(|m| m.len() as i64)
        .unwrap_or(0);
    let warnings_json = if warnings.is_empty() {
        None
    } else {
        Some(serde_json::to_string(warnings).unwrap())
    };
    state.db.complete_job(
        job_id,
        gcode_path,
        print_time_sec,
        filament_used_g,
        warnings_json.as_deref(),
    );
    state.db.add_job_stored_bytes(job_id, file_size);
    if let Some(job) = state.db.get_job(job_id) {
        state.db.create_slice(
            job_id,
            &job.model_name,
            gcode_path,
            print_time_sec,
            filament_used_g,
            file_size,
        );
    }
}

/// The vendor model id for a merged config's `printer_model`.
pub(crate) fn printer_model_id(state: &AppState, config_json: &str) -> Option<String> {
    let config: Value = serde_json::from_str(config_json).ok()?;
    let model = config.get("printer_model")?.as_str()?;
    state
        .profile_store
        .machine_model(model)
        .and_then(|m| m.model_id.clone())
        .or_else(|| crate::bambu::models::id_for(model).map(String::from))
}

/// A job's printable package path, next to its G-code.
pub(crate) fn package_output_path(state: &AppState, job_id: &str) -> String {
    let dir = state.data_dir.join("gcode");
    std::fs::create_dir_all(&dir).ok();
    dir.join(format!("{job_id}.gcode.3mf")).to_string_lossy().to_string()
}

/// Is the config for a Bambu Lab printer? (Sliced projects are their format.)
fn is_bambu_config(config_json: &str) -> bool {
    serde_json::from_str::<Value>(config_json)
        .ok()
        .and_then(|c| c.get("printer_model")?.as_str().map(|m| m.starts_with("Bambu Lab")))
        .unwrap_or(false)
}

/// What the browser engine should produce besides G-code for this job
/// (see `SliceOptions` in web/src/engine/types.ts).
fn browser_slice_options(state: &AppState, job: &Job, config_json: &str) -> Value {
    let bambu = is_bambu_config(config_json);
    let overlay = crate::overlay::overlay_for_job(state, job);
    json!({
        "package": bambu,
        "printer_model_id": if bambu { printer_model_id(state, config_json).unwrap_or_default() } else { String::new() },
        "model_name": job.model_name,
        // Every part on the plate, by model index (the engine stages the
        // models in that order); single-part jobs also send `placement` for
        // engines from before plates.
        "plate": job_plate(job),
        "models": state.db.job_models(&job.id).iter().map(|m| json!({"name": m.name})).collect::<Vec<_>>(),
        "label": overlay.label,
        "logo_url": overlay.logo.as_ref().and(job.group_id.as_ref()).map(|g| format!("/api/groups/{g}/overlay/logo")),
        "placement": job_placement(job),
    })
}

/// Package (Bambu printers only: the format is theirs) and thumbnail
/// overlay for a server slice.
fn slice_options(state: &AppState, job_id: &str, config_json: &str) -> slicer::SliceOptions {
    let mut options = slicer::SliceOptions::default();
    if is_bambu_config(config_json) {
        options.package_path = package_output_path(state, job_id);
        options.printer_model_id = printer_model_id(state, config_json).unwrap_or_default();
    }
    if let Some(job) = state.db.get_job(job_id) {
        let overlay = crate::overlay::overlay_for_job(state, &job);
        options.font_path = crate::overlay::font_path();
        options.label = overlay.label;
        if let Some((rgba, w, h)) = overlay.logo {
            options.logo_rgba = rgba;
            options.logo_width = w;
            options.logo_height = h;
        }
    }
    options
}

/// What the server's slicer gets for a job: each stored model with the
/// placements of its copies on the plate.
fn model_inputs(state: &AppState, job: &Job) -> Result<Vec<slicer::ModelInput>, String> {
    let mut models = state.db.job_models(&job.id);
    if models.is_empty() && !job.model_path.is_empty() {
        // A job from before job_models was backfilled.
        models.push(crate::db::JobModel {
            idx: 0,
            name: job.model_name.clone(),
            path: job.model_path.clone(),
            bytes: 0,
            sha256: None,
        });
    }
    let plate = job_plate(job);
    models
        .iter()
        .enumerate()
        .map(|(i, m)| {
            if m.path.is_empty() {
                return Err(format!("{} stayed in the browser that sliced it", m.name));
            }
            let mut input = slicer::ModelInput {
                path: m.path.clone(),
                name: m.name.clone(),
                rotations: Vec::new(),
                offsets: Vec::new(),
            };
            for o in plate.objects.iter().filter(|o| o.model == i) {
                if let Some(p) = &o.placement {
                    input.rotations.extend(p.rotation);
                    input.offsets.extend(p.offset);
                }
            }
            Ok(input)
        })
        .collect()
}

/// The job's parts; stored plates were checked when the job was created.
/// Jobs from before plates have one model, maybe placed.
pub(crate) fn job_plate(job: &Job) -> PlateLayout {
    job.plate_json
        .as_deref()
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_else(|| {
            PlateLayout::single(job.placement_json.as_deref().and_then(|j| serde_json::from_str(j).ok()))
        })
}

/// The placement of a single-part job (engines from before plates take
/// only that).
fn job_placement(job: &Job) -> Option<Placement> {
    let plate = job_plate(job);
    match plate.objects.as_slice() {
        [one] => one.placement.clone(),
        _ => None,
    }
}

/// Read a freshly written package, attach it to the job (sendable now) and
/// check its G-code (src/safety.rs). `own_file`: the package is a file of
/// its own (a `.gcode.3mf`), not the job's G-code itself, so it counts
/// towards the job's storage too. Blocking: the check reads all of the
/// G-code. Returns whether the job has a package now.
pub(crate) fn record_package(state: &AppState, job_id: &str, path: &str, own_file: bool) -> bool {
    match crate::package::inspect(std::path::Path::new(path)) {
        Ok(mut pkg) => {
            // The job's own G-code: where its comments are silent, what the
            // slicer reported stands (the check raises it if the G-code
            // takes more, never lowers it).
            if !own_file {
                if let Some(job) = state.db.get_job(job_id) {
                    for plate in &mut pkg.plates {
                        plate.print_time_sec = plate.print_time_sec.or(job.print_time_sec.filter(|t| *t > 0.0));
                        plate.weight_g = plate.weight_g.or(job.filament_used_g.filter(|g| *g > 0.0));
                    }
                }
            }
            state
                .db
                .set_job_package(job_id, path, &serde_json::to_string(&pkg).expect("packages serialize"));
            if own_file {
                let size = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
                state.db.add_job_stored_bytes(job_id, size);
            }
            if let Err(e) = crate::safety::check_job(state, job_id) {
                eprintln!("job {job_id}: can't check its G-code: {e}");
            }
            true
        }
        Err(e) => {
            eprintln!("job {job_id}: the sliced file {path} is unreadable: {e}");
            false
        }
    }
}

fn run_slice(state: &Arc<AppState>, job_id: &str, config_json: &str) {
    // One slice at a time: wait for the engine before leaving "queued".
    let handle = state.slicer.lock().unwrap();

    // Cancelled while waiting in the queue? Then don't start.
    let job = match state.db.get_job(job_id) {
        Some(job) if job.status == "queued" => job,
        _ => {
            progress::clear(job_id);
            return;
        }
    };
    state.db.update_job_status(job_id, "slicing", 0);
    let models = match model_inputs(state, &job) {
        Ok(models) => models,
        Err(e) => {
            drop(handle);
            progress::clear(job_id);
            state.db.fail_job(job_id, &e);
            println!("job {job_id}: failed: {e}");
            return;
        }
    };

    let output_path = gcode_output_path(state, job_id);
    let options = slice_options(state, job_id, config_json);
    let result = handle.0.slice(job_id, &models, config_json, &output_path, &options);
    drop(handle);
    progress::clear(job_id);

    let warnings: Vec<String> = result.warnings.iter().map(|w| w.to_string()).collect();
    for w in &warnings {
        println!("job {job_id}: slicer warning: {w}");
    }

    if result.success {
        finish_job(
            state,
            job_id,
            &result.gcode_path,
            result.print_time_sec,
            result.filament_used_g,
            &warnings,
        );
        // Bambu printers take the sliced project; everything else the G-code.
        if !result.package_path.is_empty() {
            record_package(state, job_id, &result.package_path, true);
        } else {
            record_package(state, job_id, &result.gcode_path, false);
        }
        println!(
            "job {job_id}: sliced OK ({} layers, {:.0} s, {:.1} g)",
            result.layer_count, result.print_time_sec, result.filament_used_g
        );
    } else if result.cancelled {
        state.db.cancel_job(job_id);
        println!("job {job_id}: cancelled");
    } else {
        state.db.fail_job(job_id, &result.error);
        println!("job {job_id}: failed: {}", result.error);
        crate::feedback::slice_failed(&state.db, job_id, &result.error, "server");
    }
}

async fn cancel_job(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> StatusCode {
    // The creator, whoever manages the job's group, and admins.
    let Ok((job, tree, viewer)) = visible_job(&state, &user, &id) else {
        return StatusCode::NOT_FOUND;
    };
    let creator = job.user_id.as_deref() == Some(user.id.as_str());
    let manager = job.group_id.as_deref().is_some_and(|g| viewer.can_manage(&tree, g));
    if !creator && !manager && !viewer.admin {
        return StatusCode::FORBIDDEN;
    }
    // Flag first so a running slice stops at its next checkpoint; the DB row
    // flips to "cancelled" here (queued/slicing only) and run_slice confirms.
    progress::request_cancel(&id);
    if state.db.cancel_job(&id) {
        StatusCode::OK
    } else {
        progress::clear(&id);
        StatusCode::NOT_FOUND
    }
}

// -- Browser-sourced jobs --

#[derive(Deserialize)]
struct ProgressUpdate {
    percent: i32,
    message: Option<String>,
}

/// Progress tick from the browser engine.
async fn update_job_progress(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<ProgressUpdate>,
) -> StatusCode {
    if let Err(code) = own_job(&state, &user, &id) {
        return code;
    }
    match state.db.get_job(&id) {
        Some(job) if job.source != "browser" => StatusCode::BAD_REQUEST,
        Some(job) if job.status == "slicing" => {
            state
                .db
                .update_job_progress(&id, body.percent, body.message.as_deref().unwrap_or(""));
            StatusCode::OK
        }
        // Cancelled or finished: tell the client to stop.
        Some(_) => StatusCode::CONFLICT,
        None => StatusCode::NOT_FOUND,
    }
}

/// The browser engine finished: receive the G-code and the statistics it
/// computed, and file them exactly like a server-sliced job. (The models
/// came with the job, unless they stayed in the browser.)
async fn upload_job_result(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    mut multipart: Multipart,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let err = |code: StatusCode, msg: &str| (code, Json(json!({"error": msg})));

    let Ok(job) = own_job(&state, &user, &id) else {
        return Err(err(StatusCode::NOT_FOUND, "job not found"));
    };
    if job.source != "browser" {
        return Err(err(StatusCode::BAD_REQUEST, "not a browser job"));
    }
    if job.status != "slicing" {
        return Err(err(StatusCode::CONFLICT, &format!("job is {}", job.status)));
    }

    let mut gcode: Option<axum::body::Bytes> = None;
    let mut package: Option<axum::body::Bytes> = None;
    let mut print_time_sec = 0.0_f64;
    let mut filament_used_g = 0.0_f64;
    let mut warnings: Vec<String> = Vec::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, &e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "gcode" => {
                gcode = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| err(StatusCode::BAD_REQUEST, &e.to_string()))?,
                );
            }
            "package" => {
                package = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| err(StatusCode::BAD_REQUEST, &e.to_string()))?,
                );
            }
            "print_time_sec" => {
                print_time_sec = field.text().await.ok().and_then(|t| t.parse().ok()).unwrap_or(0.0);
            }
            "filament_used_g" => {
                filament_used_g = field.text().await.ok().and_then(|t| t.parse().ok()).unwrap_or(0.0);
            }
            "warnings" => {
                if let Ok(text) = field.text().await {
                    warnings = serde_json::from_str(&text).unwrap_or_default();
                }
            }
            _ => {}
        }
    }

    let Some(gcode) = gcode else {
        return Err(err(StatusCode::BAD_REQUEST, "no gcode field"));
    };
    if gcode.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "empty gcode"));
    }

    let output_path = gcode_output_path(&state, &id);
    std::fs::write(&output_path, &gcode)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    finish_job(&state, &id, &output_path, print_time_sec, filament_used_g, &warnings);
    // The client's numbers and G-code are whatever it sent: check them
    // like an upload's (off the async runtime; it reads every line).
    let package = package.filter(|p| !p.is_empty());
    let checker = state.clone();
    let job_id = id.clone();
    tokio::task::spawn_blocking(move || match package {
        Some(pkg) => {
            let path = package_output_path(&checker, &job_id);
            match std::fs::write(&path, &pkg) {
                Ok(()) => {
                    record_package(&checker, &job_id, &path, true);
                }
                Err(e) => eprintln!("job {job_id}: can't store the sliced project: {e}"),
            }
        }
        // Plain G-code is its own package; if it can't be one, the job
        // can't be sent, but its numbers still count.
        None => {
            if !record_package(&checker, &job_id, &output_path, false) {
                crate::safety::settle_gcode_stats(&checker, &job_id, &output_path);
            }
        }
    })
    .await
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    println!(
        "job {id}: browser slice uploaded ({} bytes, {:.0} s, {:.1} g)",
        gcode.len(),
        print_time_sec,
        filament_used_g
    );

    let job = state.db.get_job(&id).unwrap();
    Ok(Json(json!(job)))
}

#[derive(Deserialize)]
struct FailRequest {
    error: String,
}

/// The browser engine failed.
async fn fail_job(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<FailRequest>,
) -> StatusCode {
    if let Err(code) = own_job(&state, &user, &id) {
        return code;
    }
    match state.db.get_job(&id) {
        Some(job) if job.source != "browser" => StatusCode::BAD_REQUEST,
        Some(job) if job.status == "slicing" => {
            state.db.fail_job(&id, &body.error);
            println!("job {id}: browser slice failed: {}", body.error);
            crate::feedback::slice_failed(&state.db, &id, &body.error, "browser");
            StatusCode::OK
        }
        Some(_) => StatusCode::CONFLICT,
        None => StatusCode::NOT_FOUND,
    }
}

// -- Slices --

async fn list_slices(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Query(q): Query<JobQuery>,
) -> Json<Value> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let slices = state.db.list_slices_filtered(&job_filter(&tree, &viewer, &q));
    Json(json!(slices))
}

async fn download_gcode(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let slice = state
        .db
        .get_slice(&id)
        .filter(|s| visible_job(&state, &user, &s.job_id).is_ok());
    match slice {
        Some(s) => {
            let path = std::path::Path::new(&s.gcode_path);
            if path.exists() {
                let data = std::fs::read(path).unwrap();
                let filename = path.file_name().unwrap().to_string_lossy().to_string();
                (
                    StatusCode::OK,
                    [
                        ("content-type", "application/octet-stream".to_string()),
                        (
                            "content-disposition",
                            format!("attachment; filename=\"{filename}\""),
                        ),
                    ],
                    data,
                )
                    .into_response()
            } else {
                (StatusCode::NOT_FOUND, "G-code file not found").into_response()
            }
        }
        None => (StatusCode::NOT_FOUND, "Slice not found").into_response(),
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    // Public routes — no auth required. From the internet only passkey
    // sign-in and invite links answer (auth::remote_gate).
    let public = Router::new()
        .route("/api/health", get(health))
        .merge(auth_api::public_routes())
        .merge(join_api::public_routes())
        .route_layer(middleware::from_fn(auth::remote_gate))
        .with_state(state.clone());

    // Protected routes — a session cookie or an API key (see src/auth.rs).
    // Admin-only handlers check the role themselves.
    let protected = Router::new()
        .merge(auth_api::protected_routes())
        .merge(groups_api::routes())
        .merge(join_api::protected_routes())
        .route("/api/profiles/machine-models", get(list_machine_models))
        .route("/api/profiles/machines", get(list_machines))
        .route("/api/profiles/processes", get(list_processes))
        .route("/api/profiles/filaments", get(list_filaments))
        .route("/api/profiles/resolve", get(resolve_profiles))
        .route("/api/profiles/resolve-single", get(resolve_single_profile))
        .route("/api/discovery", get(list_discovered))
        .merge(printers_api::routes())
        .merge(prints_api::routes())
        .merge(crate::preview_api::routes())
        .merge(overlay::routes())
        .merge(crate::farm_api::routes())
        .merge(crate::printer_thumbs::routes())
        .merge(crate::feedback_api::routes())
        .route(
            "/api/custom-profiles",
            get(list_custom_profiles).post(create_custom_profile),
        )
        .route(
            "/api/custom-profiles/{id}",
            get(get_custom_profile)
                .put(update_custom_profile)
                .delete(delete_custom_profile),
        )
        .route("/api/status", get(server_status))
        .route("/api/prices", get(get_prices))
        .route("/api/jobs", get(list_jobs).post(create_job))
        .route("/api/jobs/delete", post(delete_jobs))
        .route("/api/jobs/{id}", get(get_job).put(update_job).delete(delete_job))
        .route("/api/jobs/{id}/model", get(download_model))
        .route("/api/jobs/{id}/models/{idx}", get(download_job_model))
        .route("/api/jobs/{id}/cancel", post(cancel_job))
        .route("/api/jobs/{id}/progress", post(update_job_progress))
        .route("/api/jobs/{id}/result", post(upload_job_result))
        .route("/api/jobs/{id}/fail", post(fail_job))
        .route("/api/slices", get(list_slices))
        .route("/api/slices/{id}/download", get(download_gcode))
        .layer(DefaultBodyLimit::max(500 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), auth::require_auth))
        .with_state(state);

    let static_files = ServeDir::new("dist/web")
        .append_index_html_on_directories(true)
        .fallback(tower_http::services::ServeFile::new("dist/web/index.html"));

    public
        .merge(protected)
        .fallback_service(static_files)
        // Cross-origin isolation: the multithreaded WebAssembly engine needs
        // SharedArrayBuffer, which browsers only enable on isolated pages.
        // Every asset is same-origin, so require-corp costs nothing.
        .layer(SetResponseHeaderLayer::if_not_present(
            header::HeaderName::from_static("cross-origin-opener-policy"),
            header::HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::HeaderName::from_static("cross-origin-embedder-policy"),
            header::HeaderValue::from_static("require-corp"),
        ))
}
