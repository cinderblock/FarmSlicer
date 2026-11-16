//! Sharing (`plans/organization-and-access.md`, slice 5): a job, a
//! project, a folder (with everything below it) or a whole group library
//! shared with a person, a group (with its subgroups' members), or anyone
//! holding a link. Storage in src/db/shares.rs; what a share grants is
//! worked out per request in `groups::Grants` and checked by the
//! `Viewer` (`can_see_job`, `can_use_job`, `can_edit_job`,
//! `projects::can_see/can_edit`).
//!
//! Levels: `view` (see it, its plates, preview and check), `use` (also
//! print it, queue it, download its model and slice it again; prints are
//! held to the printer's access rules and the sender's own groups), `edit`
//! (also rename, label and file it; deleting it, moving it to another
//! group and sharing it stay with its owners). Sharing takes owning the
//! item (a job's or project's creator or library editors), managing the
//! folder's library, or editing the group's library.
//!
//! Public links show a job, project or folder to anyone with the link:
//! names, facts and plate pictures, read only, no G-code or model. Their
//! codes are kept in plain text so they can be copied again, like join
//! links. Whether they work is the group setting `public_shares` of the
//! group the item is charged to (a folder: its library's group), inherited,
//! with the site setting `public_shares` (off by default) as the default
//! and for personal items. Turning a group's off stops its links working.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::audit::{self, Target};
use crate::auth::{self, CurrentUser};
use crate::db::{Db, Share};
use crate::groups::{Tree, Viewer};
use crate::groups_api;
use crate::permissions::GroupCap;
use crate::server::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    View,
    Use,
    Edit,
}

impl Level {
    pub fn parse(s: &str) -> Option<Level> {
        match s {
            "view" => Some(Level::View),
            "use" => Some(Level::Use),
            "edit" => Some(Level::Edit),
            _ => None,
        }
    }
}

pub const TARGET_KINDS: &[&str] = &["job", "project", "folder", "library"];

type ApiError = (StatusCode, Json<Value>);

fn err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

/// The site setting: public links for personal items, and the default for groups.
pub fn public_links_allowed(db: &Db) -> bool {
    db.get_setting("public_shares").as_deref() == Some("true")
}

/// Whether a job, project or folder may have working public links: its
/// group's `public_shares` (inherited), else the site's. Libraries never do.
pub fn public_links_for(db: &Db, tree: &Tree, kind: &str, id: &str) -> bool {
    let group = match kind {
        "job" => db.get_job(id).map(|j| j.group_id),
        "project" => db.get_project(id).map(|p| p.group_id),
        "folder" => db.get_folder(id).map(|f| (f.library_kind == "group").then_some(f.library_id)),
        _ => return false,
    };
    match group {
        None => false,
        Some(Some(g)) if tree.get(&g).is_some() => tree.effective(&g).public_shares,
        Some(_) => tree.site_public_shares(),
    }
}

/// The target's name, if the viewer may share it (None: not found or not theirs to share).
fn shareable(state: &AppState, tree: &Tree, viewer: &Viewer, kind: &str, id: &str) -> Result<String, ApiError> {
    let missing = || err(StatusCode::NOT_FOUND, format!("no such {kind}"));
    let refuse = || err(StatusCode::FORBIDDEN, format!("only its owners share this {kind}"));
    match kind {
        "job" => {
            let j = state.db.get_job(id).filter(|j| viewer.can_see_job(tree, j)).ok_or_else(missing)?;
            if viewer.owns_job(tree, &j) { Ok(j.model_name) } else { Err(refuse()) }
        }
        "project" => {
            let p = state.db.get_project(id).filter(|p| crate::projects::can_see(tree, viewer, p)).ok_or_else(missing)?;
            if crate::projects::owns(tree, viewer, &p) { Ok(p.name) } else { Err(refuse()) }
        }
        "folder" => {
            let f = state
                .db
                .get_folder(id)
                .filter(|f| crate::folders::can_see_library(tree, viewer, &f.library_kind, &f.library_id))
                .ok_or_else(missing)?;
            if crate::folders::can_manage_library(tree, viewer, &f.library_kind, &f.library_id) { Ok(f.name) } else { Err(refuse()) }
        }
        "library" => {
            tree.get(id).ok_or_else(missing)?;
            if viewer.can_in(tree, id, GroupCap::LibraryEdit) {
                Ok(format!("{}'s library", tree.display_path(id)))
            } else {
                Err(err(StatusCode::FORBIDDEN, "only those who edit the group's library share it"))
            }
        }
        _ => Err(err(StatusCode::BAD_REQUEST, format!("kind: one of {}", TARGET_KINDS.join(", ")))),
    }
}

fn share_json(state: &AppState, tree: &Tree, s: &Share) -> Value {
    let mut v = json!(s);
    v["who"] = json!(match s.principal_kind.as_str() {
        "user" => state.db.get_user(&s.principal_id).map(|u| u.username).unwrap_or_else(|| "a removed account".into()),
        "group" => if tree.get(&s.principal_id).is_some() { format!("members of {}", tree.display_path(&s.principal_id)) } else { "a removed group".into() },
        _ => "anyone with the link".into(),
    });
    if s.principal_kind == "link" {
        v["url"] = json!(format!("{}s/{}", state.rp.origin, s.principal_id));
        v.as_object_mut().unwrap().remove("principal_id");
        v["code"] = json!(s.principal_id);
    }
    v
}

#[derive(Deserialize)]
struct OnQuery {
    kind: String,
    id: String,
}

/// `GET /api/shares?kind=&id=`: a target's shares (for those who may share it).
async fn list_on(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Query(q): Query<OnQuery>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    shareable(&state, &tree, &viewer, &q.kind, &q.id)?;
    let shares: Vec<Value> = state.db.shares_on(&q.kind, &q.id).iter().map(|s| share_json(&state, &tree, s)).collect();
    Ok(Json(json!({"shares": shares, "public_links": public_links_for(&state.db, &tree, &q.kind, &q.id)})))
}

#[derive(Deserialize)]
struct Who {
    /// user | group | link
    kind: String,
    #[serde(default)]
    id: String,
}

#[derive(Deserialize)]
struct CreateBody {
    kind: String,
    target_id: String,
    with: Who,
    #[serde(default)]
    level: Option<String>,
    #[serde(default)]
    expires_days: Option<i64>,
}

async fn create(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<CreateBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    auth::require_full(&user)?;
    let (tree, viewer) = groups_api::context(&state, &user);
    let name = shareable(&state, &tree, &viewer, &body.kind, &body.target_id)?;
    let level = body.level.as_deref().unwrap_or("view");
    if Level::parse(level).is_none() {
        return Err(err(StatusCode::BAD_REQUEST, "level: view, use or edit"));
    }
    if body.expires_days.is_some_and(|d| !(1..=3650).contains(&d)) {
        return Err(err(StatusCode::BAD_REQUEST, "expires_days: 1-3650"));
    }
    let (principal_kind, principal_id) = match body.with.kind.as_str() {
        "user" => {
            let u = state
                .db
                .get_user(&body.with.id)
                .or_else(|| state.db.get_user_by_username(body.with.id.trim()))
                .ok_or_else(|| err(StatusCode::NOT_FOUND, "no such user"))?;
            if u.id == user.id {
                return Err(err(StatusCode::BAD_REQUEST, "it's already yours"));
            }
            ("user", u.id)
        }
        "group" => {
            tree.get(&body.with.id).ok_or_else(|| err(StatusCode::NOT_FOUND, "no such group"))?;
            ("group", body.with.id.clone())
        }
        "link" => {
            if body.kind == "library" {
                return Err(err(StatusCode::BAD_REQUEST, "whole libraries aren't shared by public link"));
            }
            if !public_links_for(&state.db, &tree, &body.kind, &body.target_id) {
                return Err(err(StatusCode::FORBIDDEN, "public links are off for this (its group's settings, or the site's)"));
            }
            if level != "view" {
                return Err(err(StatusCode::BAD_REQUEST, "public links are view only"));
            }
            ("link", auth::random_token()[..22].to_string())
        }
        _ => return Err(err(StatusCode::BAD_REQUEST, "with: user, group or link")),
    };
    let share = Share {
        id: uuid::Uuid::new_v4().to_string(),
        target_kind: body.kind.clone(),
        target_id: body.target_id.clone(),
        principal_kind: principal_kind.into(),
        principal_id,
        level: level.into(),
        created_by: Some(user.id.clone()),
        created_at: String::new(),
        expires_at: None,
    };
    let id = state.db.save_share(&share, body.expires_days);
    let saved = state.db.get_share(&id).unwrap();
    let v = share_json(&state, &tree, &saved);
    audit::record(
        &state.db,
        &user,
        "share.create",
        Target { kind: &saved.target_kind, id: &saved.target_id, name: &name },
        json!({"with": v["who"], "level": saved.level, "expires_at": saved.expires_at}),
    );
    Ok((StatusCode::CREATED, Json(v)))
}

async fn remove(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let s = state.db.get_share(&id).ok_or_else(|| err(StatusCode::NOT_FOUND, "no such share"))?;
    // Its owners take it back; whoever it's shared with may drop it.
    let mine = s.principal_kind == "user" && s.principal_id == user.id;
    let name = match shareable(&state, &tree, &viewer, &s.target_kind, &s.target_id) {
        Ok(n) => n,
        Err(_) if mine => String::new(),
        Err(e) => return Err(e),
    };
    let who = share_json(&state, &tree, &s)["who"].clone();
    state.db.delete_share(&id);
    audit::record(
        &state.db,
        &user,
        "share.delete",
        Target { kind: &s.target_kind, id: &s.target_id, name: &name },
        json!({"with": who, "level": s.level}),
    );
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/shares/mine`: what's shared with the caller (directly or
/// through their groups).
async fn mine(State(state): State<Arc<AppState>>, Extension(CurrentUser(user)): Extension<CurrentUser>) -> Json<Value> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let mut principals: Vec<String> = Vec::new();
    for m in viewer.memberships.iter().filter(|m| m.status == "active") {
        for g in tree.path(&m.group_id) {
            if !principals.contains(&g.id) {
                principals.push(g.id.clone());
            }
        }
    }
    let list: Vec<Value> = state
        .db
        .shares_for(&user.id, &principals)
        .iter()
        .filter_map(|s| {
            let name = match s.target_kind.as_str() {
                "job" => state.db.get_job(&s.target_id).map(|j| j.model_name),
                "project" => state.db.get_project(&s.target_id).map(|p| p.name),
                "folder" => state.db.get_folder(&s.target_id).map(|f| f.name),
                "library" => tree.get(&s.target_id).map(|_| tree.display_path(&s.target_id)),
                _ => None,
            }?;
            let by = s.created_by.as_deref().and_then(|u| state.db.get_user(u)).map(|u| u.username);
            // Where a shared folder is, to open it in the Library.
            let library = (s.target_kind == "folder")
                .then(|| state.db.get_folder(&s.target_id))
                .flatten()
                .map(|f| json!({"kind": f.library_kind, "id": f.library_id}));
            Some(json!({
                "id": s.id, "target_kind": s.target_kind, "target_id": s.target_id, "name": name,
                "level": s.level, "by": by, "expires_at": s.expires_at,
                "through_group": (s.principal_kind == "group").then(|| tree.display_path(&s.principal_id)),
                "library": library,
            }))
        })
        .collect();
    Json(json!(list))
}

// ---- public links ------------------------------------------------------------------

fn job_facts(j: &crate::db::Job, code: &str) -> Value {
    let plates = crate::printing::package_of(j).map(|p| p.plates.iter().map(|pl| pl.index).collect::<Vec<_>>()).unwrap_or_default();
    json!({
        "id": j.id,
        "name": j.model_name,
        "created_at": j.created_at,
        "print_time_sec": j.print_time_sec,
        "filament_used_g": j.filament_used_g,
        "plates": plates.iter().map(|i| json!({
            "index": i,
            "thumbnail": format!("/api/public/shares/{code}/jobs/{}/thumbnail?plate={i}", j.id),
        })).collect::<Vec<_>>(),
    })
}

/// Jobs and projects filed in a folder or below it.
fn folder_contents(db: &Db, folder: &str) -> (Vec<String>, Vec<String>) {
    let folders = db.list_folders();
    let mut within = vec![folder.to_string()];
    let mut i = 0;
    while i < within.len() {
        let id = within[i].clone();
        within.extend(folders.iter().filter(|f| f.parent_id.as_deref() == Some(id.as_str())).map(|f| f.id.clone()));
        i += 1;
    }
    let (mut jobs, mut projects) = (Vec::new(), Vec::new());
    for (kind, item, f) in db.list_folder_items() {
        if within.contains(&f) {
            match kind.as_str() {
                "job" => jobs.push(item),
                "project" => projects.push(item),
                _ => {}
            }
        }
    }
    (jobs, projects)
}

/// The jobs a public share shows.
fn shared_jobs(db: &Db, s: &Share) -> Vec<String> {
    match s.target_kind.as_str() {
        "job" => vec![s.target_id.clone()],
        "folder" => folder_contents(db, &s.target_id).0,
        "project" => db.project_items(&s.target_id).into_iter().filter_map(|i| i.job_id).collect(),
        _ => Vec::new(),
    }
}

fn live_link(state: &AppState, code: &str) -> Result<Share, ApiError> {
    let gone = || err(StatusCode::NOT_FOUND, "this link doesn't work any more");
    let s = state.db.share_by_code(code).ok_or_else(gone)?;
    if !public_links_for(&state.db, &Tree::load(&state.db), &s.target_kind, &s.target_id) {
        return Err(gone());
    }
    Ok(s)
}

/// `GET /api/public/shares/{code}`: what a public link shows.
async fn public_view(State(state): State<Arc<AppState>>, Path(code): Path<String>) -> Result<Json<Value>, ApiError> {
    let s = live_link(&state, &code)?;
    let by = s.created_by.as_deref().and_then(|u| state.db.get_user(u)).map(|u| u.username);
    let jobs: Vec<Value> = shared_jobs(&state.db, &s)
        .iter()
        .filter_map(|id| state.db.get_job(id))
        .map(|j| job_facts(&j, &code))
        .collect();
    let (name, projects) = match s.target_kind.as_str() {
        "job" => (state.db.get_job(&s.target_id).map(|j| j.model_name), Vec::new()),
        "project" => {
            let p = state.db.get_project(&s.target_id);
            let items: Vec<Value> = state
                .db
                .project_items(&s.target_id)
                .iter()
                .map(|i| json!({"name": i.name, "quantity": i.quantity}))
                .collect();
            (p.map(|p| p.name), vec![json!({"items": items})])
        }
        "folder" => {
            let names: Vec<Value> = folder_contents(&state.db, &s.target_id)
                .1
                .iter()
                .filter_map(|id| state.db.get_project(id))
                .map(|p| json!({"name": p.name}))
                .collect();
            (state.db.get_folder(&s.target_id).map(|f| f.name), names)
        }
        _ => (None, Vec::new()),
    };
    let name = name.ok_or_else(|| err(StatusCode::NOT_FOUND, "this link doesn't work any more"))?;
    Ok(Json(json!({
        "kind": s.target_kind,
        "name": name,
        "shared_by": by,
        "expires_at": s.expires_at,
        "jobs": jobs,
        "projects": projects,
    })))
}

#[derive(Deserialize)]
struct PlateQuery {
    plate: Option<u32>,
}

/// `GET /api/public/shares/{code}/jobs/{job}/thumbnail?plate=N`.
async fn public_thumbnail(
    State(state): State<Arc<AppState>>,
    Path((code, job_id)): Path<(String, String)>,
    Query(q): Query<PlateQuery>,
) -> Result<axum::response::Response, ApiError> {
    let s = live_link(&state, &code)?;
    if !shared_jobs(&state.db, &s).contains(&job_id) {
        return Err(err(StatusCode::NOT_FOUND, "not in this link"));
    }
    let job = state.db.get_job(&job_id).ok_or_else(|| err(StatusCode::NOT_FOUND, "not in this link"))?;
    Ok(crate::prints_api::plate_thumbnail(&job, q.plate).await?.into_response())
}

/// Behind `auth::require_auth`.
pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/shares", get(list_on).post(create))
        .route("/api/shares/mine", get(mine))
        .route("/api/shares/{id}", delete(remove))
}

/// No account needed; reachable from the internet (`auth::open_to_remote`).
pub fn public_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/public/shares/{code}", get(public_view))
        .route("/api/public/shares/{code}/jobs/{job}/thumbnail", get(public_thumbnail))
}
