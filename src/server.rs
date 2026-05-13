use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use cxx::UniquePtr;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tower_http::services::ServeDir;

use crate::db::Db;
use crate::slicer;

struct SlicerHandle(UniquePtr<slicer::Slicer>);
// Safety: Slicer is only accessed through Mutex, one thread at a time
unsafe impl Send for SlicerHandle {}
unsafe impl Sync for SlicerHandle {}

pub struct AppState {
    pub db: Db,
    pub data_dir: std::path::PathBuf,
    slicer: Mutex<SlicerHandle>,
    pub profiles_dir: String,
    pub profile_names: Vec<String>,
}

impl AppState {
    pub fn new(
        db: Db,
        data_dir: std::path::PathBuf,
        slicer: UniquePtr<slicer::Slicer>,
        profiles_dir: String,
        profile_names: Vec<String>,
    ) -> Self {
        Self {
            db,
            data_dir,
            slicer: Mutex::new(SlicerHandle(slicer)),
            profiles_dir,
            profile_names,
        }
    }
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

// -- Profiles --

async fn list_profiles(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!(state.profile_names))
}

// -- Printers --

async fn list_printers(State(state): State<Arc<AppState>>) -> Json<Value> {
    let printers = state.db.list_printers();
    Json(json!(printers))
}

#[derive(Deserialize)]
struct CreatePrinter {
    name: String,
    protocol: Option<String>,
    address: Option<String>,
}

async fn create_printer(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreatePrinter>,
) -> (StatusCode, Json<Value>) {
    let printer = state.db.create_printer(
        &body.name,
        body.protocol.as_deref().unwrap_or("bambu"),
        body.address.as_deref().unwrap_or(""),
    );
    (StatusCode::CREATED, Json(json!(printer)))
}

async fn delete_printer(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> StatusCode {
    if state.db.delete_printer(&id) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

// -- Jobs --

async fn list_jobs(State(state): State<Arc<AppState>>) -> Json<Value> {
    let jobs = state.db.list_jobs();
    Json(json!(jobs))
}

async fn create_job(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    let models_dir = state.data_dir.join("models");
    std::fs::create_dir_all(&models_dir).ok();

    let mut model_name = String::new();
    let mut model_path = String::new();
    let mut printer_id: Option<String> = None;
    let mut routing = "auto".to_string();

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
            _ => {}
        }
    }

    if model_path.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "No model file provided"})),
        ));
    }

    let job = state
        .db
        .create_job(&model_name, &model_path, printer_id.as_deref(), &routing);

    // Spawn slicing in background
    let job_id = job.id.clone();
    let state_clone = state.clone();
    let model_path_clone = model_path.clone();
    tokio::task::spawn_blocking(move || {
        run_slice(&state_clone, &job_id, &model_path_clone);
    });

    Ok((StatusCode::CREATED, Json(json!(job))))
}

fn run_slice(state: &Arc<AppState>, job_id: &str, model_path: &str) {
    state.db.update_job_status(job_id, "slicing", 10);

    let gcode_dir = state.data_dir.join("gcode");
    std::fs::create_dir_all(&gcode_dir).ok();
    let output_path = gcode_dir
        .join(format!("{job_id}.gcode"))
        .to_string_lossy()
        .to_string();

    let config_json = "{}";

    let result = {
        let handle = state.slicer.lock().unwrap();
        handle.0.slice(model_path, config_json, &output_path)
    };

    if result.success {
        let file_size = std::fs::metadata(&result.gcode_path)
            .map(|m| m.len() as i64)
            .unwrap_or(0);

        state.db.complete_job(
            job_id,
            &result.gcode_path,
            result.print_time_sec,
            result.filament_used_g,
        );

        let job = state.db.list_jobs().into_iter().find(|j| j.id == job_id);
        if let Some(job) = job {
            state.db.create_slice(
                job_id,
                &job.model_name,
                &result.gcode_path,
                result.print_time_sec,
                result.filament_used_g,
                file_size,
            );
        }
    } else {
        state.db.fail_job(job_id, &result.error);
    }
}

async fn cancel_job(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> StatusCode {
    if state.db.cancel_job(&id) {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    }
}

// -- Slices --

async fn list_slices(State(state): State<Arc<AppState>>) -> Json<Value> {
    let slices = state.db.list_slices();
    Json(json!(slices))
}

async fn download_gcode(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let slices = state.db.list_slices();
    let slice = slices.iter().find(|s| s.id == id);
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
    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/profiles", get(list_profiles))
        .route("/api/printers", get(list_printers).post(create_printer))
        .route("/api/printers/{id}", delete(delete_printer))
        .route("/api/jobs", get(list_jobs).post(create_job))
        .route("/api/jobs/{id}/cancel", post(cancel_job))
        .route("/api/slices", get(list_slices))
        .route("/api/slices/{id}/download", get(download_gcode))
        .layer(DefaultBodyLimit::max(100 * 1024 * 1024))
        .with_state(state);

    let static_files = ServeDir::new("dist/web").append_index_html_on_directories(true);

    api.fallback_service(static_files)
}
