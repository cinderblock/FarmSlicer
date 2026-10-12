use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{header, StatusCode},
    middleware,
    response::IntoResponse,
    routing::{delete, get, post},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::auth::{self, CurrentUser};
use crate::auth_api;
use crate::db::{Db, Job, JobFilter, User};
use crate::discovery;
use crate::groups::{Tree, Viewer};
use crate::groups_api;
use crate::join_api;
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
        rp: auth::Rp,
    ) -> Self {
        Self {
            db,
            data_dir,
            slicer: Mutex::new(SlicerHandle(slicer)),
            profile_store,
            discovered,
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
            json!({
                "serial": p.serial,
                "name": p.name,
                "model_code": p.model_code,
                "model_name": p.model_name,
                "machine_profile": p.machine_profile,
                "ip": p.ip,
                "signal": p.signal,
            })
        })
        .collect();
    Json(json!(printers))
}

// -- Printers --

async fn list_printers(State(state): State<Arc<AppState>>) -> Json<Value> {
    let printers = state.db.list_printers();
    Json(json!(printers))
}

#[derive(Deserialize)]
struct CreatePrinter {
    name: String,
    machine_profile: Option<String>,
    nozzle_diameter: Option<String>,
    protocol: Option<String>,
    address: Option<String>,
    serial_number: Option<String>,
    access_code: Option<String>,
}

async fn create_printer(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<CreatePrinter>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    auth::require_full(&user)?;
    let printer = state.db.create_printer(
        &body.name,
        body.machine_profile.as_deref().unwrap_or(""),
        body.nozzle_diameter.as_deref().unwrap_or(""),
        body.protocol.as_deref().unwrap_or("bambu"),
        body.address.as_deref().unwrap_or(""),
        body.serial_number.as_deref().unwrap_or(""),
        body.access_code.as_deref().unwrap_or(""),
    );
    Ok((StatusCode::CREATED, Json(json!(printer))))
}

async fn delete_printer(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> StatusCode {
    if auth::require_full(&user).is_err() {
        return StatusCode::FORBIDDEN;
    }
    if state.db.delete_printer(&id) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
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
) -> StatusCode {
    if auth::require_full(&user).is_err() {
        return StatusCode::FORBIDDEN;
    }
    let Some(existing) = state.db.get_custom_profile(&id) else {
        return StatusCode::NOT_FOUND;
    };
    let name = body.name.as_deref().unwrap_or(&existing.name);
    let overrides = body.overrides.as_deref().unwrap_or(&existing.overrides);
    if state.db.update_custom_profile(&id, name, overrides) {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
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
    #[serde(default)]
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
    let jobs = state.db.list_jobs_filtered(&job_filter(&tree, &viewer, &q));
    Json(json!(jobs))
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

/// Download the job's source model, when the server kept it.
async fn download_model(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let (job, _, _) = visible_job(&state, &user, &id)?;
    if !model_available(&job) {
        return Err(api_err(StatusCode::NOT_FOUND, "the model of this job was not kept"));
    }
    let data = std::fs::read(&job.model_path)
        .map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let filename: String = job
        .model_name
        .chars()
        .filter(|c| !matches!(c, '"' | '\\' | '\r' | '\n'))
        .collect();
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{filename}\"")),
        ],
        data,
    ))
}

async fn create_job(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    let models_dir = state.data_dir.join("models");
    std::fs::create_dir_all(&models_dir).ok();

    let mut model_name = String::new();
    let mut model_path = String::new();
    let mut printer_id: Option<String> = None;
    let mut routing = "auto".to_string();
    let mut machine_profile = String::new();
    let mut process_profile = String::new();
    let mut filament_profile = String::new();
    let mut overrides_str = String::new();
    // "server" (default): the model is uploaded and sliced here.
    // "browser": the client slices with the WebAssembly engine and only
    // uploads the G-code (POST /api/jobs/{id}/result); the model never
    // leaves the user's machine.
    let mut source = "server".to_string();
    let mut group_id: Option<String> = None;
    let mut model_bytes: i64 = 0;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "model" => {
                let file_name = field.file_name().unwrap_or("model.stl").to_string();
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))))?;

                let id = uuid::Uuid::new_v4().to_string();
                let ext = std::path::Path::new(&file_name)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("stl");
                let dest = models_dir.join(format!("{id}.{ext}"));

                std::fs::write(&dest, &data).map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({"error": e.to_string()})),
                    )
                })?;

                model_name = file_name;
                model_path = dest.to_string_lossy().to_string();
                model_bytes = data.len() as i64;
            }
            "group_id" => {
                let val = field.text().await.unwrap_or_default();
                if !val.is_empty() {
                    group_id = Some(val);
                }
            }
            "printer_id" => {
                let val = field.text().await.unwrap_or_default();
                if !val.is_empty() {
                    printer_id = Some(val);
                }
            }
            "routing" => {
                routing = field.text().await.unwrap_or("auto".into());
            }
            "machine" => {
                machine_profile = field.text().await.unwrap_or_default();
            }
            "process" => {
                process_profile = field.text().await.unwrap_or_default();
            }
            "filament" => {
                filament_profile = field.text().await.unwrap_or_default();
            }
            "overrides" => {
                overrides_str = field.text().await.unwrap_or_default();
            }
            "source" => {
                source = field.text().await.unwrap_or_default();
            }
            "model_name" => {
                // Browser jobs send the file name only.
                let val = field.text().await.unwrap_or_default();
                if model_name.is_empty() {
                    model_name = val;
                }
            }
            _ => {}
        }
    }

    // The group the job is charged to, and every quota on the way.
    let (tree, viewer) = groups_api::context(&state, &user);
    let admission = match &group_id {
        Some(g) if tree.get(g).is_none() || !viewer.can_charge(g) => Err(api_err(
            StatusCode::FORBIDDEN,
            "you are not an active member of that group",
        )),
        _ => quota::check(&state.db, &tree, &user, group_id.as_deref())
            .map_err(|e| api_err(StatusCode::TOO_MANY_REQUESTS, e)),
    };
    if let Err(e) = admission {
        if !model_path.is_empty() {
            std::fs::remove_file(&model_path).ok();
        }
        return Err(e);
    }
    let keep_model = group_id
        .as_deref()
        .is_some_and(|g| tree.effective(g).keep_models);

    if !matches!(source.as_str(), "server" | "browser") {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "source must be 'server' or 'browser'"})),
        ));
    }

    if source == "server" && model_path.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "No model file provided"})),
        ));
    }
    if source == "browser" && model_name.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "model_name is required for browser jobs"})),
        ));
    }

    let config_json = if !machine_profile.is_empty()
        && !process_profile.is_empty()
        && !filament_profile.is_empty()
    {
        let mut config_str = state
            .profile_store
            .resolve_config(&machine_profile, &process_profile, &filament_profile)
            .map_err(|e| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": format!("Profile error: {e}")})),
                )
            })?;

        // Merge per-job overrides on top of resolved config
        if !overrides_str.is_empty() {
            if let Ok(overrides) = serde_json::from_str::<serde_json::Map<String, Value>>(&overrides_str) {
                if let Ok(mut config) = serde_json::from_str::<serde_json::Map<String, Value>>(&config_str) {
                    for (k, v) in overrides {
                        config.insert(k, v);
                    }
                    config_str = serde_json::to_string(&Value::Object(config)).unwrap();
                }
            }
        }

        config_str
    } else {
        "{}".to_string()
    };

    let overrides_json = if overrides_str.is_empty() {
        None
    } else {
        Some(overrides_str)
    };

    let mut job = state.db.create_job(
        &model_name,
        &model_path,
        printer_id.as_deref(),
        &routing,
        Some(&config_json),
        overrides_json.as_deref(),
        &source,
        Some(&user.id),
        group_id.as_deref(),
        model_bytes,
    );

    if source == "browser" {
        // The client owns the slicing; the job just tracks it. When the
        // group keeps models, the client uploads the model with the result.
        state.db.update_job_status(&job.id, "slicing", 0);
        state.db.update_job_progress(&job.id, 0, "Slicing in browser");
        job.status = "slicing".to_string();
        job.progress_message = Some("Slicing in browser".to_string());
        let mut body = json!(job);
        body["keep_model"] = json!(keep_model);
        return Ok((StatusCode::CREATED, Json(body)));
    }

    let job_id = job.id.clone();
    let state_clone = state.clone();
    let model_path_clone = model_path.clone();
    tokio::task::spawn_blocking(move || {
        run_slice(&state_clone, &job_id, &model_path_clone, &config_json);
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
fn finish_job(
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

fn run_slice(state: &Arc<AppState>, job_id: &str, model_path: &str, config_json: &str) {
    // One slice at a time: wait for the engine before leaving "queued".
    let handle = state.slicer.lock().unwrap();

    // Cancelled while waiting in the queue? Then don't start.
    match state.db.get_job(job_id) {
        Some(job) if job.status == "queued" => {}
        _ => {
            progress::clear(job_id);
            return;
        }
    }
    state.db.update_job_status(job_id, "slicing", 0);

    let output_path = gcode_output_path(state, job_id);
    let result = handle.0.slice(job_id, model_path, config_json, &output_path);
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
/// computed (and the model, when the job's group keeps models), and file
/// them exactly like a server-sliced job.
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
    let keep_model = job
        .group_id
        .as_deref()
        .is_some_and(|g| Tree::load(&state.db).effective(g).keep_models);
    if job.source != "browser" {
        return Err(err(StatusCode::BAD_REQUEST, "not a browser job"));
    }
    if job.status != "slicing" {
        return Err(err(StatusCode::CONFLICT, &format!("job is {}", job.status)));
    }

    let mut gcode: Option<axum::body::Bytes> = None;
    let mut model: Option<(String, axum::body::Bytes)> = None;
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
            "model" if keep_model => {
                let file_name = field.file_name().unwrap_or("model.stl").to_string();
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| err(StatusCode::BAD_REQUEST, &e.to_string()))?;
                model = Some((file_name, data));
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

    if let Some((file_name, data)) = model.filter(|(_, d)| !d.is_empty()) {
        let models_dir = state.data_dir.join("models");
        std::fs::create_dir_all(&models_dir).ok();
        let ext = std::path::Path::new(&file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("stl");
        let dest = models_dir.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
        std::fs::write(&dest, &data)
            .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        state
            .db
            .set_job_model(&id, &dest.to_string_lossy(), data.len() as i64);
    }

    finish_job(&state, &id, &output_path, print_time_sec, filament_used_g, &warnings);
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
    // Public routes — no auth required
    let public = Router::new()
        .route("/api/health", get(health))
        .merge(auth_api::public_routes())
        .merge(join_api::public_routes())
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
        .route("/api/printers", get(list_printers).post(create_printer))
        .route("/api/printers/{id}", delete(delete_printer))
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
        .route("/api/jobs", get(list_jobs).post(create_job))
        .route("/api/jobs/{id}", axum::routing::put(update_job))
        .route("/api/jobs/{id}/model", get(download_model))
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
