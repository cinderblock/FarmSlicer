//! Folders (`plans/organization-and-access.md`, slice 4): a tree of
//! folders in each library. A library is a person's own (their jobs and
//! projects charged to no group) or a group's (what's charged to it).
//! Storage in src/db/folders.rs.
//!
//! A folder holds only its own library's items, so filing never disagrees
//! with who a job is charged to; an item moved to another group leaves its
//! folder. Seeing a group's folders takes seeing the group; making,
//! renaming, moving and deleting them takes the group's `folders`
//! capability (or "edit every job"); your own folders are yours. Filing
//! an item takes being able to change it. Deleting a folder moves its
//! contents up a level.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, put},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::audit::{self, Target};
use crate::auth::CurrentUser;
use crate::db::{Folder, Job, Project};
use crate::groups::{Tree, Viewer};
use crate::groups_api;
use crate::permissions::{Cap, GroupCap};
use crate::server::AppState;

type ApiError = (StatusCode, Json<Value>);

fn err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

/// The library an item lives in: ("group", id) or ("user", creator).
pub fn library_of(group_id: Option<&str>, user_id: Option<&str>) -> (&'static str, String) {
    match group_id {
        Some(g) => ("group", g.to_string()),
        None => ("user", user_id.unwrap_or("").to_string()),
    }
}

fn job_library(j: &Job) -> (&'static str, String) {
    library_of(j.group_id.as_deref(), j.user_id.as_deref())
}

fn project_library(p: &Project) -> (&'static str, String) {
    library_of(p.group_id.as_deref(), p.user_id.as_deref())
}

pub fn can_see_library(tree: &Tree, viewer: &Viewer, kind: &str, id: &str) -> bool {
    match kind {
        "user" => id == viewer.user.id || viewer.can(Cap::LibraryViewAll),
        "group" => {
            tree.get(id).is_some()
                && (viewer.can(Cap::LibraryViewAll) || viewer.is_active_member(id) || viewer.manages(tree, id))
        }
        _ => false,
    }
}

pub fn can_manage_library(tree: &Tree, viewer: &Viewer, kind: &str, id: &str) -> bool {
    match kind {
        "user" => id == viewer.user.id,
        "group" => tree.get(id).is_some() && (viewer.can(Cap::LibraryEditAll) || viewer.can_in(tree, id, GroupCap::Folders)),
        _ => false,
    }
}

fn folder_json(tree: &Tree, viewer: &Viewer, f: &Folder) -> Value {
    let mut v = json!(f);
    v["can_manage"] = json!(can_manage_library(tree, viewer, &f.library_kind, &f.library_id));
    v
}

/// The item, if the viewer sees it, with its library.
fn item(state: &AppState, tree: &Tree, viewer: &Viewer, kind: &str, id: &str) -> Option<((&'static str, String), bool)> {
    match kind {
        "job" => state
            .db
            .get_job(id)
            .filter(|j| viewer.can_see_job(tree, j))
            .map(|j| (job_library(&j), viewer.can_edit_job(tree, &j))),
        "project" => state
            .db
            .get_project(id)
            .filter(|p| crate::projects::can_see(tree, viewer, p))
            .map(|p| (project_library(&p), crate::projects::can_edit(tree, viewer, &p))),
        _ => None,
    }
}

/// `GET /api/folders`: the folders of every library the caller sees, the
/// libraries they may file into, and where the items they see are filed:
/// `{folders, libraries, items: {job: {id: folder}, project: {...}}}`.
async fn list(State(state): State<Arc<AppState>>, Extension(CurrentUser(user)): Extension<CurrentUser>) -> Json<Value> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let folders: Vec<Folder> = state
        .db
        .list_folders()
        .into_iter()
        .filter(|f| can_see_library(&tree, &viewer, &f.library_kind, &f.library_id))
        .collect();
    let by_id: std::collections::HashMap<&str, &Folder> = folders.iter().map(|f| (f.id.as_str(), f)).collect();
    let mut items: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for (kind, id, folder) in state.db.list_folder_items() {
        let Some(f) = by_id.get(folder.as_str()) else { continue };
        // Filed where it still belongs, and seen by the caller.
        if let Some(((lk, lid), _)) = item(&state, &tree, &viewer, &kind, &id) {
            if lk == f.library_kind && lid == f.library_id {
                items.entry(kind).or_default().insert(id, folder);
            }
        }
    }
    let mut libraries = vec![json!({"kind": "user", "id": user.id, "name": "My library", "can_manage": true})];
    let mut groups: Vec<(String, String)> = tree
        .groups
        .values()
        .filter(|g| can_see_library(&tree, &viewer, "group", &g.id) && (viewer.membership(&g.id).is_some() || viewer.manages(&tree, &g.id)))
        .map(|g| (g.id.clone(), tree.display_path(&g.id)))
        .collect();
    groups.sort_by(|a, b| crate::groups::natural_cmp(&a.1, &b.1));
    libraries.extend(groups.into_iter().map(|(id, path)| {
        json!({"kind": "group", "id": id, "name": path, "can_manage": can_manage_library(&tree, &viewer, "group", &id)})
    }));
    Json(json!({
        "folders": folders.iter().map(|f| folder_json(&tree, &viewer, f)).collect::<Vec<_>>(),
        "libraries": libraries,
        "items": items,
    }))
}

#[derive(Deserialize)]
struct CreateBody {
    name: String,
    #[serde(default)]
    parent_id: Option<String>,
    /// "user" (yours) | "group"
    #[serde(default)]
    library: Option<String>,
    #[serde(default)]
    group_id: Option<String>,
}

fn valid_name(name: &str) -> Result<(), ApiError> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 80 || n.contains('/') {
        return Err(err(StatusCode::BAD_REQUEST, "name: 1-80 characters, no /"));
    }
    Ok(())
}

fn target(f: &Folder) -> Target<'_> {
    Target { kind: "folder", id: &f.id, name: &f.name }
}

/// Group folders' changes go to the audit log; personal ones don't.
fn record(state: &AppState, user: &crate::db::User, action: &str, f: &Folder, detail: Value) {
    if f.library_kind == "group" {
        audit::record(&state.db, user, action, target(f), detail);
    }
}

async fn create(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<CreateBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    valid_name(&body.name)?;
    // A subfolder is in its parent's library.
    let (kind, id) = match &body.parent_id {
        Some(p) => {
            let parent = state
                .db
                .get_folder(p)
                .filter(|f| can_see_library(&tree, &viewer, &f.library_kind, &f.library_id))
                .ok_or_else(|| err(StatusCode::NOT_FOUND, "no such parent folder"))?;
            (parent.library_kind, parent.library_id)
        }
        None => match body.library.as_deref().unwrap_or("user") {
            "user" => ("user".to_string(), user.id.clone()),
            "group" => (
                "group".to_string(),
                body.group_id.clone().filter(|g| tree.get(g).is_some()).ok_or_else(|| err(StatusCode::BAD_REQUEST, "group_id: no such group"))?,
            ),
            _ => return Err(err(StatusCode::BAD_REQUEST, "library: user or group")),
        },
    };
    if !can_manage_library(&tree, &viewer, &kind, &id) {
        return Err(err(StatusCode::FORBIDDEN, "you can't make folders in that library"));
    }
    let f = Folder {
        id: uuid::Uuid::new_v4().to_string(),
        parent_id: body.parent_id.clone(),
        library_kind: kind,
        library_id: id,
        name: body.name.trim().to_string(),
        created_by: Some(user.id.clone()),
        created_at: String::new(),
    };
    state.db.create_folder(&f).map_err(|e| err(StatusCode::CONFLICT, e))?;
    let f = state.db.get_folder(&f.id).unwrap();
    record(&state, &user, "folder.create", &f, json!({"parent_id": f.parent_id}));
    Ok((StatusCode::CREATED, Json(folder_json(&tree, &viewer, &f))))
}

fn managed(state: &AppState, tree: &Tree, viewer: &Viewer, id: &str) -> Result<Folder, ApiError> {
    let f = state
        .db
        .get_folder(id)
        .filter(|f| can_see_library(tree, viewer, &f.library_kind, &f.library_id))
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "no such folder"))?;
    if !can_manage_library(tree, viewer, &f.library_kind, &f.library_id) {
        return Err(err(StatusCode::FORBIDDEN, "you can't change this library's folders"));
    }
    Ok(f)
}

#[derive(Deserialize)]
struct UpdateBody {
    #[serde(default)]
    name: Option<String>,
    /// Present: move under that folder (null = the library's top level).
    #[serde(default, deserialize_with = "some")]
    parent_id: Option<Option<String>>,
}

fn some<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

async fn update(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let old = managed(&state, &tree, &viewer, &id)?;
    let name = body.name.clone().unwrap_or_else(|| old.name.clone());
    valid_name(&name)?;
    let parent = match &body.parent_id {
        None => old.parent_id.clone(),
        Some(None) => None,
        Some(Some(p)) => {
            let to = state.db.get_folder(p).ok_or_else(|| err(StatusCode::BAD_REQUEST, "no such folder to move into"))?;
            if to.library_kind != old.library_kind || to.library_id != old.library_id {
                return Err(err(StatusCode::BAD_REQUEST, "folders move within their own library"));
            }
            // Not into itself or below it.
            let mut at = Some(to.clone());
            while let Some(f) = at {
                if f.id == old.id {
                    return Err(err(StatusCode::BAD_REQUEST, "a folder can't move inside itself"));
                }
                at = f.parent_id.as_deref().and_then(|p| state.db.get_folder(p));
            }
            Some(to.id)
        }
    };
    state.db.update_folder(&id, &name, parent.as_deref()).map_err(|e| err(StatusCode::CONFLICT, e))?;
    let f = state.db.get_folder(&id).unwrap();
    record(&state, &user, "folder.update", &f, json!({"from": {"name": old.name, "parent_id": old.parent_id}, "to": {"name": f.name, "parent_id": f.parent_id}}));
    Ok(Json(folder_json(&tree, &viewer, &f)))
}

async fn remove(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let old = managed(&state, &tree, &viewer, &id)?;
    state.db.delete_folder(&id);
    state.db.delete_shares_of("folder", &id);
    record(&state, &user, "folder.delete", &old, json!({}));
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct FileBody {
    kind: String,
    item_id: String,
    /// None: back to the library's top level.
    #[serde(default)]
    folder_id: Option<String>,
}

/// `PUT /api/folders/items`: file a job or project in a folder of its library.
async fn file(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<FileBody>,
) -> Result<StatusCode, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let Some(((lk, lid), edits)) = item(&state, &tree, &viewer, &body.kind, &body.item_id) else {
        return Err(err(StatusCode::NOT_FOUND, format!("no such {}", body.kind)));
    };
    if !edits {
        return Err(err(StatusCode::FORBIDDEN, format!("only those who can change this {} file it", body.kind)));
    }
    if let Some(f) = &body.folder_id {
        let folder = state
            .db
            .get_folder(f)
            .filter(|f| can_see_library(&tree, &viewer, &f.library_kind, &f.library_id))
            .ok_or_else(|| err(StatusCode::NOT_FOUND, "no such folder"))?;
        if folder.library_kind != lk || folder.library_id != lid {
            return Err(err(StatusCode::BAD_REQUEST, "that folder is in another library (move the item to its group first)"));
        }
    }
    state.db.file_item(&body.kind, &body.item_id, body.folder_id.as_deref(), &user.id);
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/folders", get(list).post(create))
        .route("/api/folders/items", put(file))
        .route("/api/folders/{id}", put(update).delete(remove))
}
