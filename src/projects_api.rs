//! `/api/projects`: projects, their items and progress, linking jobs, and
//! fulfillment status (src/projects.rs has the rules).

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{CurrentUser, KeyScope};
use crate::integration::Scope;
use crate::db::{NewProject, Project, ProjectFilter, User};
use crate::groups::{Tree, Viewer};
use crate::groups_api;
use crate::projects::{self, LinkItem};
use crate::server::AppState;

type ApiError = (StatusCode, Json<Value>);

fn api_err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

fn bad(msg: impl Into<String>) -> ApiError {
    api_err(StatusCode::BAD_REQUEST, msg)
}

/// A project the caller may see, or 404.
fn visible(state: &AppState, user: &User, scope: &Option<Scope>, id: &str) -> Result<(Project, Tree, Viewer), ApiError> {
    let (tree, viewer) = groups_api::context(state, user);
    match state.db.get_project(id) {
        Some(p) if projects::can_see(&tree, &viewer, &p) && scope.as_ref().is_none_or(|s| s.covers(&p)) => Ok((p, tree, viewer)),
        _ => Err(api_err(StatusCode::NOT_FOUND, "project not found")),
    }
}

/// A project the caller may change, or 403/404.
fn editable(state: &AppState, user: &User, scope: &Option<Scope>, id: &str) -> Result<(Project, Tree, Viewer), ApiError> {
    let (p, tree, viewer) = visible(state, user, scope, id)?;
    if !projects::can_edit(&tree, &viewer, &p) {
        return Err(api_err(StatusCode::FORBIDDEN, "only its creator, the group's managers and admins can change it"));
    }
    Ok((p, tree, viewer))
}

/// Trimmed text, None when empty; `max` characters at most.
fn text(v: Option<&str>, field: &str, max: usize) -> Result<Option<String>, ApiError> {
    match v.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if s.chars().count() > max => Err(bad(format!("{field}: {max} characters at most"))),
        Some(s) => Ok(Some(s.to_string())),
        None => Ok(None),
    }
}

/// The project with its items, their progress and totals.
fn project_json(state: &AppState, tree: &Tree, viewer: &Viewer, p: &Project) -> Value {
    let items = projects::item_views(state, &p.id);
    let mut v = json!(p);
    v["summary"] = json!(projects::summarize(&items));
    v["items"] = json!(items);
    v["can_edit"] = json!(projects::can_edit(tree, viewer, p));
    v
}

#[derive(Deserialize)]
struct ListQuery {
    /// Comma-separated statuses; `active` = everything not shipped or
    /// cancelled.
    status: Option<String>,
    group: Option<String>,
    client_ref: Option<String>,
    external_ref: Option<String>,
    q: Option<String>,
    limit: Option<i64>,
}

/// `GET /api/projects?status=&group=&client_ref=&external_ref=&q=`: most
/// urgent first, each with its totals.
async fn list_projects(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(scope)): Extension<KeyScope>,
    Query(q): Query<ListQuery>,
) -> Json<Value> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let status = q.status.as_deref().filter(|s| !s.is_empty()).map(|s| {
        s.split(',')
            .flat_map(|x| match x.trim() {
                "active" => vec!["open", "printed", "ready", "on_hold"],
                other => vec![other],
            })
            .filter(|s| projects::STATUSES.contains(s))
            .map(String::from)
            .collect::<Vec<_>>()
    });
    let filter = ProjectFilter {
        status,
        group_ids: q.group.filter(|g| !g.is_empty()).map(|g| vec![g]),
        client_ref: q.client_ref.filter(|c| !c.is_empty()),
        external_ref: q.external_ref.filter(|c| !c.is_empty()),
        search: q.q.filter(|c| !c.trim().is_empty()),
    };
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    // Visibility is decided per project; fetch generously, then filter.
    let list: Vec<Value> = state
        .db
        .list_projects(&filter, if viewer.admin { limit } else { 5000 })
        .into_iter()
        .filter(|p| projects::can_see(&tree, &viewer, p) && scope.as_ref().is_none_or(|s| s.covers(p)))
        .take(limit as usize)
        .map(|p| {
            let items = projects::item_views(&state, &p.id);
            let mut v = json!(p);
            v["summary"] = json!(projects::summarize(&items));
            v["can_edit"] = json!(projects::can_edit(&tree, &viewer, &p));
            v
        })
        .collect();
    Json(json!(list))
}

#[derive(Deserialize, Default)]
struct ItemBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    quantity: Option<i64>,
    /// The recipe: a job (and which of its parts).
    #[serde(default)]
    job_id: Option<String>,
    #[serde(default)]
    model: Option<i64>,
    #[serde(default)]
    part: Option<String>,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(Deserialize)]
struct CreateProject {
    name: String,
    #[serde(default)]
    group_id: Option<String>,
    #[serde(default)]
    client_ref: Option<String>,
    #[serde(default)]
    external_ref: Option<String>,
    #[serde(default)]
    due_at: Option<String>,
    #[serde(default)]
    priority: Option<i64>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    items: Vec<ItemBody>,
}

/// The group a project may be charged to by this viewer.
fn check_group(tree: &Tree, viewer: &Viewer, group: Option<&str>) -> Result<(), ApiError> {
    match group {
        Some(g) if tree.get(g).is_none() => Err(bad("no such group")),
        Some(g) if !viewer.admin && !viewer.can_charge(g) && !viewer.can_manage(tree, g) => {
            Err(api_err(StatusCode::FORBIDDEN, "you are not an active member of that group"))
        }
        _ => Ok(()),
    }
}

fn check_priority(p: Option<i64>) -> Result<i64, ApiError> {
    match p.unwrap_or(0) {
        p @ -100..=100 => Ok(p),
        _ => Err(bad("priority: -100 to 100")),
    }
}

/// Add one item to `project` (a plain item, or one made from a job's part).
fn add_item(state: &AppState, user: &User, project: &Project, body: &ItemBody) -> Result<Value, ApiError> {
    if let Some(job_id) = &body.job_id {
        let (job, _, _) = crate::prints_api::visible_job(state, user, job_id)?;
        let w = LinkItem {
            model: body.model,
            part: body.part.clone(),
            item_id: None,
            name: body.name.clone(),
            quantity: body.quantity,
        };
        let (item, linked) = projects::recipe_item(state, project, &job, &w).map_err(bad)?;
        let mut v = json!(item);
        v["linked"] = json!(linked);
        return Ok(v);
    }
    let name = text(body.name.as_deref(), "name", 200)?.ok_or_else(|| bad("an item needs a name (or a job)"))?;
    let quantity = body.quantity.ok_or_else(|| bad("an item needs a quantity"))?;
    if !(1..=projects::MAX_QUANTITY).contains(&quantity) {
        return Err(bad(format!("quantity: 1 to {}", projects::MAX_QUANTITY)));
    }
    let notes = text(body.notes.as_deref(), "notes", 2000)?.unwrap_or_default();
    Ok(json!(state.db.add_item(&project.id, &name, quantity, None, None, &notes)))
}

/// `POST /api/projects`: a new project (with items), or the existing one
/// when its group already has a project with this `external_ref`
/// (ordering software can retry safely: 200 instead of 201).
async fn create_project(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(scope)): Extension<KeyScope>,
    Json(body): Json<CreateProject>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let name = text(Some(&body.name), "name", 200)?.ok_or_else(|| bad("a project needs a name"))?;
    let mut group = body.group_id.as_deref().filter(|g| !g.is_empty());
    let mut client_ref = text(body.client_ref.as_deref(), "client_ref", 200)?;
    // An integration key's projects are its group's and client's.
    if let Some(s) = &scope {
        if s.group_id.is_some() {
            if group.is_some() && group != s.group_id.as_deref() {
                return Err(api_err(StatusCode::FORBIDDEN, "this key makes projects for its own group only"));
            }
            group = s.group_id.as_deref();
        }
        if let Some(c) = &s.client_ref {
            if client_ref.as_ref().is_some_and(|x| x != c) {
                return Err(api_err(StatusCode::FORBIDDEN, "this key makes projects for its own client only"));
            }
            client_ref = Some(c.clone());
        }
    }
    check_group(&tree, &viewer, group)?;
    let external_ref = text(body.external_ref.as_deref(), "external_ref", 200)?;
    let due = body.due_at.as_deref().filter(|d| !d.trim().is_empty()).map(projects::parse_due).transpose().map_err(bad)?;
    let priority = check_priority(body.priority)?;
    let notes = text(body.notes.as_deref(), "notes", 10_000)?.unwrap_or_default();
    if body.items.len() > projects::MAX_ITEMS {
        return Err(bad(format!("a project holds at most {} items", projects::MAX_ITEMS)));
    }
    if let Some(ext) = &external_ref {
        if let Some(existing) = state.db.project_by_external_ref(group, ext) {
            if !projects::can_see(&tree, &viewer, &existing) || scope.as_ref().is_some_and(|s| !s.covers(&existing)) {
                return Err(api_err(StatusCode::CONFLICT, "a project with this external_ref exists"));
            }
            return Ok((StatusCode::OK, Json(project_json(&state, &tree, &viewer, &existing))));
        }
    }
    // Jobs named as recipes must be visible before anything is made.
    for i in &body.items {
        if let Some(j) = &i.job_id {
            crate::prints_api::visible_job(&state, &user, j)?;
        }
    }
    let (project, created) = state.db.create_project(&NewProject {
        name: &name,
        group_id: group,
        user_id: Some(&user.id),
        client_ref: client_ref.as_deref(),
        external_ref: external_ref.as_deref(),
        priority,
        due_at: due.as_deref(),
        notes: &notes,
    });
    if created {
        for i in &body.items {
            if let Err(e) = add_item(&state, &user, &project, i) {
                // All or nothing: a half-made order helps nobody.
                state.db.delete_project(&project.id);
                return Err(e);
            }
        }
        projects::refresh(&state, &project.id);
        println!("Project {} ({name}): created by {} with {} item(s)", project.id, user.username, body.items.len());
    }
    let project = state.db.get_project(&project.id).expect("project exists");
    Ok((if created { StatusCode::CREATED } else { StatusCode::OK }, Json(project_json(&state, &tree, &viewer, &project))))
}

/// `GET /api/projects/{id}`: the project, its items with progress, and the
/// job plates carrying them with their prints.
async fn get_project(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(scope)): Extension<KeyScope>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (p, tree, viewer) = visible(&state, &user, &scope, &id)?;
    let mut v = project_json(&state, &tree, &viewer, &p);
    // Per job: its plates, what each carries for this project, its prints.
    let mut jobs: BTreeMap<String, Vec<crate::db::JobItem>> = BTreeMap::new();
    for ji in state.db.project_job_items(&p.id) {
        jobs.entry(ji.job_id.clone()).or_default().push(ji);
    }
    let jobs: Vec<Value> = jobs
        .into_iter()
        .filter_map(|(job_id, parts)| {
            let job = state.db.get_job(&job_id)?;
            let visible_job = viewer.can_see_job(&tree, &job);
            let prints: Vec<Value> = state
                .db
                .prints_of_job(&job_id)
                .into_iter()
                .map(|pr| {
                    json!({
                        "id": pr.id, "plate": pr.plate, "printer_name": pr.printer_name, "status": pr.status,
                        "outcome": pr.outcome, "created_at": pr.created_at, "finished_at": pr.finished_at,
                    })
                })
                .collect();
            let sendable = crate::printing::package_of(&job).is_some();
            Some(json!({
                "job_id": job.id,
                "name": crate::printing::display_name(&job.model_name),
                "status": job.status,
                "sendable": sendable,
                "visible": visible_job,
                "plates": crate::projects::job_plate_numbers(&job),
                "parts": parts,
                "prints": prints,
            }))
        })
        .collect();
    v["jobs"] = json!(jobs);
    Ok(Json(v))
}

/// A field that may be absent (None), `null` (Some(None)) or a value.
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
struct UpdateProject {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, deserialize_with = "present")]
    group_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    client_ref: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    external_ref: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    due_at: Option<Option<String>>,
    #[serde(default)]
    priority: Option<i64>,
    #[serde(default)]
    notes: Option<String>,
}

/// `PATCH /api/projects/{id}`: change what's given (`null` clears).
async fn update_project(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(scope)): Extension<KeyScope>,
    Path(id): Path<String>,
    Json(body): Json<UpdateProject>,
) -> Result<Json<Value>, ApiError> {
    let (p, tree, viewer) = editable(&state, &user, &scope, &id)?;
    let name = match &body.name {
        Some(n) => text(Some(n), "name", 200)?.ok_or_else(|| bad("a project needs a name"))?,
        None => p.name.clone(),
    };
    let group = match &body.group_id {
        Some(g) => {
            let g = g.as_deref().filter(|g| !g.is_empty());
            check_group(&tree, &viewer, g)?;
            g.map(String::from)
        }
        None => p.group_id.clone(),
    };
    let opt = |given: &Option<Option<String>>, current: &Option<String>, field: &str| -> Result<Option<String>, ApiError> {
        match given {
            Some(v) => text(v.as_deref(), field, 200),
            None => Ok(current.clone()),
        }
    };
    let client_ref = opt(&body.client_ref, &p.client_ref, "client_ref")?;
    if let Some(s) = &scope {
        let moved = Project { group_id: group.clone(), client_ref: client_ref.clone(), ..p.clone() };
        if !s.covers(&moved) {
            return Err(api_err(StatusCode::FORBIDDEN, "this key keeps projects in its own group and client"));
        }
    }
    let external_ref = opt(&body.external_ref, &p.external_ref, "external_ref")?;
    let due = match &body.due_at {
        Some(Some(d)) if !d.trim().is_empty() => Some(projects::parse_due(d).map_err(bad)?),
        Some(_) => None,
        None => p.due_at.clone(),
    };
    let priority = match body.priority {
        Some(_) => check_priority(body.priority)?,
        None => p.priority,
    };
    let notes = match &body.notes {
        Some(n) => text(Some(n), "notes", 10_000)?.unwrap_or_default(),
        None => p.notes.clone(),
    };
    state
        .db
        .update_project(&id, &name, client_ref.as_deref(), external_ref.as_deref(), priority, due.as_deref(), &notes, group.as_deref())
        .map_err(|e| api_err(StatusCode::CONFLICT, e))?;
    let p = state.db.get_project(&id).expect("project exists");
    Ok(Json(project_json(&state, &tree, &viewer, &p)))
}

#[derive(Deserialize)]
struct StatusBody {
    status: String,
    #[serde(default)]
    note: Option<String>,
}

/// `POST /api/projects/{id}/status`: fulfillment (`ready`, `shipped`),
/// holding (`on_hold`), `cancelled`, or back to `open` (which becomes
/// `printed` again by itself if every item is done).
async fn set_status(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(scope)): Extension<KeyScope>,
    Path(id): Path<String>,
    Json(body): Json<StatusBody>,
) -> Result<Json<Value>, ApiError> {
    let (p, tree, viewer) = editable(&state, &user, &scope, &id)?;
    if !projects::SETTABLE.contains(&body.status.as_str()) {
        return Err(bad(format!(
            "status: one of {} (printed is set when every item is done)",
            projects::SETTABLE.join(", ")
        )));
    }
    let note = text(body.note.as_deref(), "note", 1000)?;
    if state.db.set_project_status(&id, &body.status, note.as_deref()) {
        println!("Project {} ({}): {} -> {} by {}", p.id, p.name, p.status, body.status, user.username);
        crate::events::project_status(&state, &id);
    }
    projects::refresh(&state, &id);
    let p = state.db.get_project(&id).expect("project exists");
    Ok(Json(project_json(&state, &tree, &viewer, &p)))
}

/// `DELETE /api/projects/{id}`: the project and its items; jobs and prints
/// stay (their outcomes keep what they were for).
async fn delete_project(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(scope)): Extension<KeyScope>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    editable(&state, &user, &scope, &id)?;
    state.db.delete_project(&id);
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/projects/{id}/items`: one item, plain or from a job's part.
async fn create_item(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(scope)): Extension<KeyScope>,
    Path(id): Path<String>,
    Json(body): Json<ItemBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (p, _, _) = editable(&state, &user, &scope, &id)?;
    if state.db.project_items(&id).len() >= projects::MAX_ITEMS {
        return Err(bad(format!("a project holds at most {} items", projects::MAX_ITEMS)));
    }
    let v = add_item(&state, &user, &p, &body)?;
    projects::refresh(&state, &id);
    Ok((StatusCode::CREATED, Json(v)))
}

#[derive(Deserialize)]
struct UpdateItem {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    quantity: Option<i64>,
    #[serde(default)]
    notes: Option<String>,
}

async fn update_item(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(scope)): Extension<KeyScope>,
    Path((id, item_id)): Path<(String, String)>,
    Json(body): Json<UpdateItem>,
) -> Result<Json<Value>, ApiError> {
    editable(&state, &user, &scope, &id)?;
    let item = state
        .db
        .get_item(&item_id)
        .filter(|i| i.project_id == id)
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such item"))?;
    let name = match &body.name {
        Some(n) => text(Some(n), "name", 200)?.ok_or_else(|| bad("an item needs a name"))?,
        None => item.name.clone(),
    };
    let quantity = body.quantity.unwrap_or(item.quantity);
    if !(1..=projects::MAX_QUANTITY).contains(&quantity) {
        return Err(bad(format!("quantity: 1 to {}", projects::MAX_QUANTITY)));
    }
    let notes = match &body.notes {
        Some(n) => text(Some(n), "notes", 2000)?.unwrap_or_default(),
        None => item.notes.clone(),
    };
    state.db.update_item(&item_id, &name, quantity, &notes);
    projects::refresh(&state, &id);
    Ok(Json(json!(state.db.get_item(&item_id))))
}

async fn delete_item(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(scope)): Extension<KeyScope>,
    Path((id, item_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    editable(&state, &user, &scope, &id)?;
    if !state.db.get_item(&item_id).is_some_and(|i| i.project_id == id) {
        return Err(api_err(StatusCode::NOT_FOUND, "no such item"));
    }
    state.db.delete_item(&item_id);
    projects::refresh(&state, &id);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct LinkBody {
    job_id: String,
    /// Which parts count for which items; omitted = every part becomes an
    /// item of its own.
    #[serde(default)]
    items: Vec<LinkItem>,
}

/// `POST /api/projects/{id}/jobs`: count an existing job's plates for the
/// project (prints already made count too).
async fn link_job(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(scope)): Extension<KeyScope>,
    Path(id): Path<String>,
    Json(body): Json<LinkBody>,
) -> Result<Json<Value>, ApiError> {
    let (p, tree, viewer) = editable(&state, &user, &scope, &id)?;
    let (job, _, _) = crate::prints_api::visible_job(&state, &user, &body.job_id)?;
    projects::link_job(&state, &p, &job, &body.items).map_err(|e| api_err(StatusCode::CONFLICT, e))?;
    let p = state.db.get_project(&id).expect("project exists");
    Ok(Json(project_json(&state, &tree, &viewer, &p)))
}

/// `DELETE /api/projects/{id}/jobs/{job_id}`: stop counting a job's plates.
async fn unlink_job(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(scope)): Extension<KeyScope>,
    Path((id, job_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let (p, tree, viewer) = editable(&state, &user, &scope, &id)?;
    if state.db.unlink_job(&id, &job_id) == 0 {
        return Err(api_err(StatusCode::NOT_FOUND, "the job carries nothing for this project"));
    }
    projects::refresh(&state, &id);
    let p = state.db.get_project(&p.id).expect("project exists");
    Ok(Json(project_json(&state, &tree, &viewer, &p)))
}

/// `GET /api/jobs/{id}/parts`: a job's parts (what can become items), each
/// with its copies per plate and the item it counts for, if any.
async fn job_parts(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(scope)): Extension<KeyScope>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (job, tree, viewer) = crate::prints_api::visible_job(&state, &user, &id)?;
    let linked: Vec<crate::db::JobItem> = projects::job_plate_numbers(&job)
        .into_iter()
        .flat_map(|n| state.db.job_plate_items(&job.id, n as i64))
        .collect();
    let parts: Vec<Value> = projects::job_parts(&state, &job)
        .into_iter()
        .map(|part| {
            let item = linked
                .iter()
                .find(|j| j.part == part.key)
                .and_then(|j| state.db.get_item(&j.item_id))
                .and_then(|i| {
                    let p = state.db.get_project(&i.project_id)?;
                    (projects::can_see(&tree, &viewer, &p) && scope.as_ref().is_none_or(|s| s.covers(&p)))
                        .then(|| json!({"id": i.id, "name": i.name, "project_id": p.id, "project_name": p.name}))
                });
            let mut v = json!(part);
            v["copies"] = json!(part.copies());
            v["item"] = item.unwrap_or(Value::Null);
            v
        })
        .collect();
    Ok(Json(json!(parts)))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/projects", get(list_projects).post(create_project))
        .route("/api/projects/{id}", get(get_project).patch(update_project).delete(delete_project))
        .route("/api/projects/{id}/status", post(set_status))
        .route("/api/projects/{id}/items", post(create_item))
        .route("/api/projects/{id}/items/{item_id}", patch(update_item).delete(delete_item))
        .route("/api/projects/{id}/jobs", post(link_job))
        .route("/api/projects/{id}/jobs/{job_id}", axum::routing::delete(unlink_job))
        .route("/api/jobs/{id}/parts", get(job_parts))
}
