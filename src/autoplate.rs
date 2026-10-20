//! Auto-plating: plates for the copies projects are missing. Each item's
//! recipe (a job and one of its models: the file, its rotation, the job's
//! settings) gives the copies; libslic3r's arrange (`AppState::arrange`,
//! the desktop app's packer, on the real shapes) puts them on as few plates
//! as fit; the new job is sliced on the server like any other, its plates
//! count for the items, and each plate is queued once.
//!
//! Items share a job only when they slice with the same settings (the
//! recipe jobs' configs are identical), and parts of different projects
//! share plates only as the mixing rule allows (`pools::site_mixing`, or
//! the pool's): `none` = one project per job, `group` = projects of the
//! same group and client, `any`.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::CurrentUser;
use crate::db::{Job, JobItem, Project, User};
use crate::groups_api;
use crate::placement::{JobPlates, Placement, PlateLayout, PlateObject};
use crate::projects::ItemView;
use crate::server::AppState;

/// Gap between copies, mm (more where the config's brim or skirt needs it).
pub const DEFAULT_SPACING: f64 = 4.0;

const IDENTITY: [f64; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

/// An item the auto-plater can make plates for.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub project: Project,
    pub item: ItemView,
    pub recipe: Job,
    pub model_path: String,
    pub model_name: String,
    pub rotation: [f64; 9],
}

/// Why an item with missing copies can't be auto-plated, or its candidate.
pub fn candidate(state: &AppState, project: &Project, item: &ItemView) -> Result<Candidate, String> {
    let name = &item.item.name;
    let recipe = item
        .item
        .job_id
        .as_deref()
        .and_then(|j| state.db.get_job(j))
        .ok_or_else(|| format!("{name}: it has no job to make plates from (slice it for the project)"))?;
    if recipe.source == "upload" {
        return Err(format!("{name}: it comes from an uploaded sliced file, which can't be re-plated"));
    }
    let idx = item.item.model_idx.unwrap_or(0) as usize;
    let models = state.db.job_models(&recipe.id);
    let model = models.get(idx).ok_or_else(|| format!("{name}: its job lost the model"))?;
    if !model.stored() {
        return Err(format!("{name}: its model stayed in the browser that sliced it"));
    }
    if recipe.config_json.as_deref().is_none_or(|c| c.trim().is_empty() || c.trim() == "{}") {
        return Err(format!("{name}: its job has no settings to slice with"));
    }
    let rotation = crate::server::job_plates(&recipe)
        .parts_by_plate()
        .find(|(_, o)| o.model == idx)
        .and_then(|(_, o)| o.placement.as_ref().map(|p| p.rotation))
        .unwrap_or(IDENTITY);
    Ok(Candidate {
        project: project.clone(),
        item: item.clone(),
        recipe,
        model_path: model.path.clone(),
        model_name: model.name.clone(),
        rotation,
    })
}

/// Which jobs the candidates go into: same settings, and mixing allowed.
pub fn batches(candidates: Vec<Candidate>, mixing: &str) -> Vec<Vec<Candidate>> {
    let mut out: BTreeMap<(String, String), Vec<Candidate>> = BTreeMap::new();
    for c in candidates {
        let settings = c.recipe.config_json.clone().unwrap_or_default();
        let who = match mixing {
            "any" => String::new(),
            "group" => format!(
                "{}\u{1f}{}",
                c.project.group_id.as_deref().unwrap_or(""),
                c.project.client_ref.as_deref().unwrap_or("")
            ),
            _ => c.project.id.clone(),
        };
        out.entry((settings, who)).or_default().push(c);
    }
    out.into_values().collect()
}

/// What one auto-plated job came to.
#[derive(Debug, Serialize)]
pub struct Plated {
    pub job_id: String,
    pub plates: u32,
    pub copies: i64,
    pub projects: Vec<String>,
    pub queued: usize,
}

/// Make, slice and queue one job for `batch` (as `user`, charged to the
/// first project's group). Blocking: arranging waits for the slicer.
pub fn plate_batch(state: &Arc<AppState>, user: &User, batch: &[Candidate], spacing: f64) -> Result<Plated, String> {
    let first = batch.first().ok_or("nothing to plate")?;
    let models_dir = state.data_dir.join("models");
    std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    // Each item is a model of its own in the new job (its copies count for
    // it alone), its file copied (jobs delete their own files).
    let mut paths = Vec::new();
    let mut inputs = Vec::new();
    for c in batch {
        let ext = std::path::Path::new(&c.model_path).extension().and_then(|e| e.to_str()).unwrap_or("stl");
        let dest = models_dir.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
        std::fs::copy(&c.model_path, &dest).map_err(|e| format!("can't copy {}: {e}", c.model_name))?;
        let copies = c.item.missing as usize;
        inputs.push(crate::slicer::ModelInput {
            path: dest.to_string_lossy().to_string(),
            name: c.model_name.clone(),
            rotations: c.rotation.repeat(copies),
            offsets: vec![0.0; copies * 2],
            plates: vec![0; copies],
        });
        paths.push(dest);
    }
    let cleanup = |paths: &[std::path::PathBuf]| {
        for p in paths {
            std::fs::remove_file(p).ok();
        }
    };
    let config = first.recipe.config_json.clone().unwrap_or_default();
    let arranged = state.arrange(&inputs, &config, spacing);
    if !arranged.success {
        cleanup(&paths);
        return Err(format!("arranging failed: {}", arranged.error));
    }
    let mut plates: Vec<PlateLayout> = (0..arranged.plates).map(|_| PlateLayout { objects: Vec::new() }).collect();
    for a in &arranged.parts {
        let c = &batch[a.model as usize];
        plates[a.plate as usize].objects.push(PlateObject {
            model: a.model as usize,
            placement: Some(Placement { rotation: c.rotation, offset: [a.offset_x, a.offset_y] }),
        });
    }
    plates.retain(|p| !p.objects.is_empty());
    let plates = JobPlates { plates };

    // The job, made the way POST /api/jobs makes a server job.
    let names: Vec<&str> = batch.iter().map(|c| c.item.item.name.as_str()).collect();
    let mut job_inputs: crate::server::JobInputs = first
        .recipe
        .inputs_json
        .as_deref()
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();
    job_inputs.group_id = first.project.group_id.clone();
    job_inputs.source = "server".into();
    job_inputs.printer_id = None;
    job_inputs.routing = "auto".into();
    let stored: i64 = paths.iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len() as i64).sum();
    let name = format!("Auto: {}", names.join(", "));
    let job = state.db.create_job(
        &name,
        &inputs[0].path,
        None,
        "auto",
        Some(&config),
        first.recipe.overrides_json.as_deref(),
        "server",
        Some(&user.id),
        first.project.group_id.as_deref(),
        stored,
        None,
    );
    for (i, (c, input)) in batch.iter().zip(&inputs).enumerate() {
        let bytes = std::fs::metadata(&input.path).map(|m| m.len() as i64).unwrap_or(0);
        state.db.add_job_model(&job.id, i as i64, &c.model_name, &input.path, bytes, None);
    }
    state.db.set_job_inputs(&job.id, &serde_json::to_string(&job_inputs).unwrap(), None, Some(&plates.to_json()));
    if let Some(plan) = first.recipe.nozzle_plan_json.as_deref() {
        state.db.set_job_nozzle_plan(&job.id, plan);
    }

    // Its plates count for the items...
    for (n, plate) in plates.plates.iter().enumerate() {
        for (i, c) in batch.iter().enumerate() {
            let copies = plate.objects.iter().filter(|o| o.model == i).count() as i64;
            if copies > 0 {
                state.db.link_job_item(&JobItem {
                    job_id: job.id.clone(),
                    plate: n as i64 + 1,
                    part: format!("model:{i}"),
                    item_id: c.item.item.id.clone(),
                    model_idx: Some(i as i64),
                    name: crate::outcomes::part_name(&c.model_name),
                    copies,
                });
            }
        }
    }
    // ...and each is queued once (they fit printers once sliced).
    let mut queued = 0;
    for n in 1..=plates.plates.len() {
        state.db.add_queue_entry(&job.id, n as i64, 0, None, None, Some("auto-plated"), Some(&user.id));
        queued += 1;
    }
    let mut projects: Vec<String> = batch.iter().map(|c| c.project.id.clone()).collect();
    projects.dedup();
    for p in &projects {
        crate::projects::refresh(state, p);
    }
    println!(
        "Auto-plate: {} makes job {} ({} plate(s), {} cop(ies)) for {}",
        user.username,
        job.id,
        plates.plates.len(),
        batch.iter().map(|c| c.item.missing).sum::<i64>(),
        names.join(", ")
    );
    let state_clone = state.clone();
    let job_id = job.id.clone();
    std::thread::spawn(move || crate::server::run_slice(&state_clone, &job_id, &config));
    crate::dispatch::poke(state);
    Ok(Plated {
        job_id: job.id,
        plates: plates.plates.len() as u32,
        copies: batch.iter().map(|c| c.item.missing).sum(),
        projects,
        queued,
    })
}

// -- API -----------------------------------------------------------------------------

type ApiError = (StatusCode, Json<Value>);

fn api_err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

#[derive(Deserialize, Default)]
struct PlateBody {
    /// Only these items (default: every item with missing copies).
    #[serde(default)]
    items: Option<Vec<String>>,
    /// Gap between copies, mm.
    #[serde(default)]
    spacing: Option<f64>,
    /// The pool whose mixing rule applies (farm-wide plating).
    #[serde(default)]
    pool_id: Option<String>,
}

fn spacing(body: &PlateBody) -> Result<f64, ApiError> {
    match body.spacing.unwrap_or(DEFAULT_SPACING) {
        s if (0.0..=50.0).contains(&s) => Ok(s),
        _ => Err(api_err(StatusCode::BAD_REQUEST, "spacing: 0 to 50 mm")),
    }
}

async fn run(state: Arc<AppState>, user: User, candidates: Vec<Candidate>, skipped: Vec<String>, mixing: String, gap: f64) -> Result<Json<Value>, ApiError> {
    if candidates.is_empty() {
        return Err(api_err(
            StatusCode::CONFLICT,
            if skipped.is_empty() { "nothing is missing a plate".to_string() } else { skipped.join("; ") },
        ));
    }
    let batches = batches(candidates, &mixing);
    let result = tokio::task::spawn_blocking(move || {
        let mut made = Vec::new();
        let mut errors = Vec::new();
        for b in &batches {
            match plate_batch(&state, &user, b, gap) {
                Ok(p) => made.push(p),
                Err(e) => errors.push(e),
            }
        }
        (made, errors)
    })
    .await
    .map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let (made, mut errors) = result;
    if made.is_empty() {
        return Err(api_err(StatusCode::CONFLICT, errors.join("; ")));
    }
    errors.extend(skipped);
    Ok(Json(json!({ "jobs": made, "skipped": errors })))
}

/// `POST /api/projects/{id}/autoplate`: plates for the project's missing
/// copies (`items` to choose some), sliced and queued.
async fn plate_project(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    body: Option<Json<PlateBody>>,
) -> Result<Json<Value>, ApiError> {
    let body = body.map(|b| b.0).unwrap_or_default();
    let gap = spacing(&body)?;
    let (tree, viewer) = groups_api::context(&state, &user);
    let project = state
        .db
        .get_project(&id)
        .filter(|p| crate::projects::can_see(&tree, &viewer, p))
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "project not found"))?;
    if !crate::projects::can_edit(&tree, &viewer, &project) {
        return Err(api_err(StatusCode::FORBIDDEN, "only its creator, the group's managers and admins can"));
    }
    let mut candidates = Vec::new();
    let mut skipped = Vec::new();
    for item in crate::projects::item_views(&state, &id) {
        if item.missing == 0 || body.items.as_ref().is_some_and(|l| !l.contains(&item.item.id)) {
            continue;
        }
        match candidate(&state, &project, &item) {
            Ok(c) => candidates.push(c),
            Err(e) => skipped.push(e),
        }
    }
    // One project: its parts may always share plates.
    run(state, user, candidates, skipped, "any".into(), gap).await
}

/// `POST /api/queue/autoplate` (admins, operators): plates for every open
/// project's missing copies, parts of different projects together as the
/// mixing rule allows (the pool's, with `pool_id`, else the site's).
async fn plate_farm(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    body: Option<Json<PlateBody>>,
) -> Result<Json<Value>, ApiError> {
    let body = body.map(|b| b.0).unwrap_or_default();
    let gap = spacing(&body)?;
    let (_, viewer) = groups_api::context(&state, &user);
    let operator = !state.db.operated_printers(&user.id).is_empty();
    if !viewer.admin && !operator {
        return Err(api_err(StatusCode::FORBIDDEN, "only admins and operators plate the farm's projects"));
    }
    let mixing = match body.pool_id.as_deref().and_then(|p| state.db.get_pool(p)) {
        Some(pool) => serde_json::from_str::<crate::pools::PoolSettings>(&pool.settings)
            .ok()
            .and_then(|s| s.mixing)
            .unwrap_or_else(|| crate::pools::site_mixing(&state)),
        None if body.pool_id.is_some() => return Err(api_err(StatusCode::BAD_REQUEST, "no such pool")),
        None => crate::pools::site_mixing(&state),
    };
    let filter = crate::db::ProjectFilter { status: Some(vec!["open".into()]), ..Default::default() };
    let mut candidates = Vec::new();
    let mut skipped = Vec::new();
    for project in state.db.list_projects(&filter, 1000) {
        for item in crate::projects::item_views(&state, &project.id) {
            if item.missing == 0 {
                continue;
            }
            match candidate(&state, &project, &item) {
                Ok(c) => candidates.push(c),
                Err(e) => skipped.push(format!("{}: {e}", project.name)),
            }
        }
    }
    run(state, user, candidates, skipped, mixing, gap).await
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/projects/{id}/autoplate", post(plate_project))
        .route("/api/queue/autoplate", post(plate_farm))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(project: &str, group: Option<&str>, client: Option<&str>, config: &str) -> Candidate {
        let project = Project {
            id: project.into(),
            name: project.into(),
            group_id: group.map(String::from),
            group_name: None,
            user_id: None,
            username: None,
            client_ref: client.map(String::from),
            external_ref: None,
            status: "open".into(),
            status_note: None,
            priority: 0,
            due_at: None,
            notes: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            printed_at: None,
            shipped_at: None,
        };
        let recipe: Job = serde_json::from_value(json!({
            "id": "j", "model_name": "m", "model_path": "", "status": "done", "progress": 100, "printer_id": null,
            "printer_name": null, "routing": "auto", "gcode_path": null, "print_time_sec": null,
            "filament_used_g": null, "error": null, "config_json": config, "overrides_json": null,
            "progress_message": null, "warnings": null, "source": "server", "created_at": "", "updated_at": "",
            "user_id": null, "username": null, "group_id": null, "group_name": null, "stored_bytes": 0,
            "package_json": null, "placement_json": null, "inputs_json": null, "proposed_json": null,
            "plate_json": null, "nozzle_plan_json": null, "model_count": 1, "local_models": 0
        }))
        .unwrap();
        let item: ItemView = ItemView {
            item: crate::db::Item {
                id: "i".into(),
                project_id: project.id.clone(),
                idx: 0,
                name: "x".into(),
                quantity: 1,
                job_id: None,
                model_idx: None,
                notes: String::new(),
                created_at: String::new(),
                done_at: None,
            },
            progress: Default::default(),
            missing: 1,
            done: false,
        };
        Candidate { project, item, recipe, model_path: String::new(), model_name: String::new(), rotation: IDENTITY }
    }

    #[test]
    fn batches_follow_settings_and_mixing() {
        let all = || {
            vec![
                cand("a", Some("g"), Some("acme"), "{pla}"),
                cand("b", Some("g"), Some("acme"), "{pla}"),
                cand("c", Some("g"), Some("other"), "{pla}"),
                cand("d", Some("g"), Some("acme"), "{petg}"),
            ]
        };
        let sizes = |b: Vec<Vec<Candidate>>| {
            let mut s: Vec<usize> = b.iter().map(|x| x.len()).collect();
            s.sort();
            s
        };
        assert_eq!(sizes(batches(all(), "any")), vec![1, 3], "settings always split");
        assert_eq!(sizes(batches(all(), "group")), vec![1, 1, 2], "same group and client share");
        assert_eq!(sizes(batches(all(), "none")), vec![1, 1, 1, 1]);
    }
}
