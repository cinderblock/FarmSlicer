//! Labels (`plans/organization-and-access.md`, slice 3): named, coloured
//! tags on jobs, projects, printers and groups. Storage in
//! src/db/labels.rs.
//!
//! A label belongs to the site (everyone sees it; holders of
//! `labels.manage` make it), a group (its members and those of its
//! subgroups see it; holders of the group's `labels` capability make it),
//! or one person (only they see or use it). Putting a site or group label
//! on an item, or taking it off, takes being able to change the item
//! (a job's or project's editors, printer managers, a group's settings);
//! personal labels go on anything their owner can see. Nobody sees a
//! label, or what it's on, that they couldn't otherwise see.

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
use crate::auth::{self, CurrentUser};
use crate::db::Label;
use crate::groups::{Tree, Viewer};
use crate::groups_api;
use crate::permissions::{Cap, GroupCap};
use crate::server::AppState;

pub const KINDS: &[&str] = &["job", "project", "printer", "group"];
/// Colour names the web app maps to its label tokens.
pub const COLORS: &[&str] = &["gray", "red", "orange", "amber", "green", "teal", "blue", "indigo", "purple", "pink"];

type ApiError = (StatusCode, Json<Value>);

fn err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

pub fn can_see(tree: &Tree, viewer: &Viewer, l: &Label) -> bool {
    match l.scope.as_str() {
        "site" => true,
        "user" => l.owner_id == viewer.user.id,
        "group" => {
            tree.get(&l.owner_id).is_some()
                && (viewer.can(Cap::GroupsManageAll)
                    || viewer.manages(tree, &l.owner_id)
                    || viewer.memberships.iter().any(|m| m.status == "active" && tree.is_within(&m.group_id, &l.owner_id)))
        }
        _ => false,
    }
}

pub fn can_manage(tree: &Tree, viewer: &Viewer, l: &Label) -> bool {
    match l.scope.as_str() {
        "site" => viewer.can(Cap::LabelsManage),
        "user" => l.owner_id == viewer.user.id,
        "group" => tree.get(&l.owner_id).is_some() && viewer.can_in(tree, &l.owner_id, GroupCap::Labels),
        _ => false,
    }
}

/// May the viewer see this item?
fn sees_item(state: &AppState, tree: &Tree, viewer: &Viewer, kind: &str, id: &str) -> bool {
    match kind {
        "job" => state.db.get_job(id).is_some_and(|j| viewer.can_see_job(tree, &j)),
        "project" => state.db.get_project(id).is_some_and(|p| crate::projects::can_see(tree, viewer, &p)),
        "printer" => state.db.get_printer(id).is_some(),
        "group" => tree.get(id).is_some() && (viewer.membership(id).is_some() || viewer.manages(tree, id)),
        _ => false,
    }
}

/// May the viewer change this item (and so its shared labels)?
fn edits_item(state: &AppState, tree: &Tree, viewer: &Viewer, kind: &str, id: &str) -> bool {
    match kind {
        "job" => state.db.get_job(id).is_some_and(|j| viewer.can_see_job(tree, &j) && viewer.can_edit_job(tree, &j)),
        "project" => state.db.get_project(id).is_some_and(|p| crate::projects::can_see(tree, viewer, &p) && crate::projects::can_edit(tree, viewer, &p)),
        "printer" => state.db.get_printer(id).is_some() && viewer.can(Cap::PrintersManage),
        "group" => tree.get(id).is_some() && viewer.can_in(tree, id, GroupCap::Settings),
        _ => false,
    }
}

fn label_json(tree: &Tree, viewer: &Viewer, l: &Label) -> Value {
    let mut v = json!(l);
    v["can_manage"] = json!(can_manage(tree, viewer, l));
    v["owner_name"] = json!(match l.scope.as_str() {
        "group" => tree.get(&l.owner_id).map(|_| tree.display_path(&l.owner_id)),
        _ => None,
    });
    v
}

/// `GET /api/labels`: the labels the caller sees, and per kind which of
/// the items they see carry them: `{labels, links: {job: {id: [label]}}}`.
async fn list(State(state): State<Arc<AppState>>, Extension(CurrentUser(user)): Extension<CurrentUser>) -> Json<Value> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let labels: Vec<Label> = state.db.list_labels().into_iter().filter(|l| can_see(&tree, &viewer, l)).collect();
    let visible: std::collections::HashSet<&str> = labels.iter().map(|l| l.id.as_str()).collect();
    let mut links: BTreeMap<String, BTreeMap<String, Vec<String>>> = BTreeMap::new();
    let mut seen: std::collections::HashMap<(String, String), bool> = std::collections::HashMap::new();
    for (label, kind, target) in state.db.list_label_links() {
        if !visible.contains(label.as_str()) {
            continue;
        }
        let ok = *seen
            .entry((kind.clone(), target.clone()))
            .or_insert_with(|| sees_item(&state, &tree, &viewer, &kind, &target));
        if ok {
            links.entry(kind).or_default().entry(target).or_default().push(label);
        }
    }
    Json(json!({
        "labels": labels.iter().map(|l| label_json(&tree, &viewer, l)).collect::<Vec<_>>(),
        "links": links,
        "colors": COLORS,
        // Where the caller may make labels.
        "can_make_site": viewer.can(Cap::LabelsManage),
        "groups": tree.groups.values()
            .filter(|g| viewer.can_in(&tree, &g.id, GroupCap::Labels))
            .map(|g| json!({"id": g.id, "path": tree.display_path(&g.id)}))
            .collect::<Vec<_>>(),
    }))
}

#[derive(Deserialize)]
struct LabelBody {
    name: String,
    #[serde(default)]
    color: Option<String>,
    /// site | group | user (creation only).
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    group_id: Option<String>,
}

fn check_body(b: &LabelBody) -> Result<String, ApiError> {
    let n = b.name.trim();
    if n.is_empty() || n.chars().count() > 40 {
        return Err(err(StatusCode::BAD_REQUEST, "name: 1-40 characters"));
    }
    let color = b.color.clone().unwrap_or_else(|| "gray".into());
    if !COLORS.contains(&color.as_str()) {
        return Err(err(StatusCode::BAD_REQUEST, format!("color: one of {}", COLORS.join(", "))));
    }
    Ok(color)
}

/// Shared labels' changes go to the audit log; personal ones are nobody's business.
fn record(state: &AppState, user: &crate::db::User, action: &str, l: &Label, detail: Value) {
    if l.scope != "user" {
        audit::record(&state.db, user, action, Target { kind: "label", id: &l.id, name: &l.name }, detail);
    }
}

async fn create(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<LabelBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let color = check_body(&body)?;
    let scope = body.scope.clone().unwrap_or_else(|| "user".into());
    let owner_id = match scope.as_str() {
        "site" => String::new(),
        "user" => user.id.clone(),
        "group" => body.group_id.clone().filter(|g| tree.get(g).is_some()).ok_or_else(|| err(StatusCode::BAD_REQUEST, "group_id: no such group"))?,
        _ => return Err(err(StatusCode::BAD_REQUEST, "scope: site, group or user")),
    };
    let label = Label {
        id: uuid::Uuid::new_v4().to_string(),
        name: body.name.trim().to_string(),
        color,
        scope,
        owner_id,
        created_by: Some(user.id.clone()),
        created_at: String::new(),
    };
    if !can_manage(&tree, &viewer, &label) {
        return Err(match label.scope.as_str() {
            "site" => auth::missing(Cap::LabelsManage),
            _ => err(StatusCode::FORBIDDEN, "you can't make that group's labels"),
        });
    }
    state.db.save_label(&label).map_err(|e| err(StatusCode::CONFLICT, e))?;
    let label = state.db.get_label(&label.id).unwrap();
    record(&state, &user, "label.create", &label, json!({"scope": label.scope, "color": label.color}));
    Ok((StatusCode::CREATED, Json(label_json(&tree, &viewer, &label))))
}

fn managed(state: &AppState, tree: &Tree, viewer: &Viewer, id: &str) -> Result<Label, ApiError> {
    let l = state
        .db
        .get_label(id)
        .filter(|l| can_see(tree, viewer, l))
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "no such label"))?;
    if !can_manage(tree, viewer, &l) {
        return Err(err(StatusCode::FORBIDDEN, "you can't change this label"));
    }
    Ok(l)
}

async fn update(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<LabelBody>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let old = managed(&state, &tree, &viewer, &id)?;
    let color = check_body(&body)?;
    let label = Label { name: body.name.trim().to_string(), color, ..old.clone() };
    state.db.save_label(&label).map_err(|e| err(StatusCode::CONFLICT, e))?;
    record(&state, &user, "label.update", &label, json!({"from": {"name": old.name, "color": old.color}, "to": {"name": label.name, "color": label.color}}));
    Ok(Json(label_json(&tree, &viewer, &label)))
}

async fn remove(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let old = managed(&state, &tree, &viewer, &id)?;
    state.db.delete_label(&id);
    record(&state, &user, "label.delete", &old, json!({}));
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ItemBody {
    kind: String,
    target_id: String,
    /// true: put it on; false: take it off.
    on: bool,
}

/// `PUT /api/labels/{id}/items`: put the label on an item or take it off.
async fn set_item(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<ItemBody>,
) -> Result<StatusCode, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let label = state
        .db
        .get_label(&id)
        .filter(|l| can_see(&tree, &viewer, l))
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "no such label"))?;
    if !KINDS.contains(&body.kind.as_str()) {
        return Err(err(StatusCode::BAD_REQUEST, format!("kind: one of {}", KINDS.join(", "))));
    }
    if !sees_item(&state, &tree, &viewer, &body.kind, &body.target_id) {
        return Err(err(StatusCode::NOT_FOUND, format!("no such {}", body.kind)));
    }
    if label.scope != "user" && !edits_item(&state, &tree, &viewer, &body.kind, &body.target_id) {
        return Err(err(StatusCode::FORBIDDEN, format!("only those who can change this {} label it", body.kind)));
    }
    state.db.set_label_link(&id, &body.kind, &body.target_id, body.on, &user.id);
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/labels", get(list).post(create))
        .route("/api/labels/{id}", put(update).delete(remove))
        .route("/api/labels/{id}/items", put(set_item))
}
