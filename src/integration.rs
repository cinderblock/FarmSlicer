//! Software on either side of the farm: ordering tools that create projects
//! and follow them, fulfillment or billing tools that read usage.
//!
//! - **Integration keys**: API keys with a [`Scope`]: one group (or, made by
//!   an admin, every group), optionally one `client_ref`, and permissions
//!   (`projects:read`, `projects:write`, `usage:read`). A scoped key reaches
//!   only the routes its permissions name ([`allows`]) and only its
//!   group's (and client's) projects; the jobs it can read are its group's.
//!   Like every API key it works on the local network only. Admins and the
//!   group's managers make them (`/api/integrations/keys`).
//! - **Usage** (`GET /api/usage/prints`): per project and in total, over a
//!   period: prints, printer hours, grams by material (a failed print counts
//!   by how far it got), good and failed copies, estimated cost.
//!   FarmSlicer reports; billing is the other tool's.
//! - **Webhooks**: src/webhooks.rs.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{Method, StatusCode};
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::{self, CurrentUser, KeyScope};
use crate::db::{PrintRecord, Project};
use crate::groups::{Tree, Viewer};
use crate::groups_api;
use crate::server::AppState;

pub const PERMISSIONS: &[&str] = &["projects:read", "projects:write", "usage:read"];

/// What an integration key may reach.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Scope {
    /// The group whose projects it sees and creates; None = every group
    /// (admins' keys only).
    #[serde(default)]
    pub group_id: Option<String>,
    /// Only projects for this client (and new ones get it).
    #[serde(default)]
    pub client_ref: Option<String>,
    pub permissions: Vec<String>,
}

impl Scope {
    pub fn can(&self, permission: &str) -> bool {
        self.permissions.iter().any(|p| p == permission)
            || (permission == "projects:read" && self.permissions.iter().any(|p| p == "projects:write"))
    }

    /// Does this project fall inside the scope?
    pub fn covers(&self, p: &Project) -> bool {
        (self.group_id.is_none() || p.group_id == self.group_id)
            && self.client_ref.as_ref().is_none_or(|c| p.client_ref.as_ref() == Some(c))
    }

    /// Does a job of `group_id` fall inside it?
    pub fn covers_group(&self, group_id: Option<&str>) -> bool {
        self.group_id.is_none() || self.group_id.as_deref() == group_id
    }
}

/// May a request with this scope go to `method path`? (The route and the
/// permission; which projects is the handlers' business.)
pub fn allows(scope: &Scope, method: &Method, path: &str) -> Result<(), String> {
    let segments: Vec<&str> = path.trim_end_matches('/').split('/').skip(1).collect();
    let read = method == Method::GET || method == Method::HEAD;
    let need = match (segments.as_slice(), read) {
        (["api", "me"], true) | (["api", "outcome-reasons"], true) => None,
        (["api", "projects", ..], true) => Some("projects:read"),
        (["api", "projects", ..], false) => Some("projects:write"),
        (["api", "jobs"], false) if method == Method::POST => Some("projects:write"),
        (["api", "uploads"], false) if method == Method::POST => Some("projects:write"),
        (["api", "jobs", _], true) | (["api", "jobs", _, "parts" | "thumbnail"], true) => Some("projects:read"),
        (["api", "usage", "prints"], true) => Some("usage:read"),
        _ => return Err("this integration key doesn't reach that (it works with projects and usage)".into()),
    };
    match need {
        Some(p) if !scope.can(p) => Err(format!("this integration key lacks {p}")),
        _ => Ok(()),
    }
}

/// The data checks the route can't make: a job read through a scoped key
/// must be its group's.
pub fn check_data(state: &AppState, scope: &Scope, path: &str) -> Result<(), String> {
    let segments: Vec<&str> = path.trim_end_matches('/').split('/').skip(1).collect();
    if let ["api", "jobs", id, ..] = segments.as_slice() {
        if let Some(job) = state.db.get_job(id) {
            if !scope.covers_group(job.group_id.as_deref()) {
                return Err("job not found".into());
            }
        }
    }
    Ok(())
}

// -- Keys ----------------------------------------------------------------------------

type ApiError = (StatusCode, Json<Value>);

fn api_err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

fn scope_of(key: &crate::db::ApiKey) -> Option<Scope> {
    key.scope.as_deref().and_then(|s| serde_json::from_str(s).ok())
}

/// Admins see every key; managers the keys of groups they manage.
fn can_manage_key(tree: &Tree, viewer: &Viewer, scope: &Scope, owner: &str) -> bool {
    viewer.admin
        || owner == viewer.user.id
        || scope.group_id.as_deref().is_some_and(|g| viewer.can_manage(tree, g))
}

fn key_json(state: &AppState, tree: &Tree, key: &crate::db::ApiKey) -> Value {
    let scope = scope_of(key).unwrap_or_default();
    json!({
        "id": key.id,
        "name": key.name,
        "prefix": key.prefix,
        "created_at": key.created_at,
        "last_used": key.last_used,
        "owner": state.db.get_user(&key.user_id).map(|u| u.username),
        "group_id": scope.group_id,
        "group_name": scope.group_id.as_deref().map(|g| tree.display_path(g)),
        "client_ref": scope.client_ref,
        "permissions": scope.permissions,
        "remote": state.db.api_key_is_remote(&key.id),
    })
}

async fn list_keys(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Json<Value> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let keys: Vec<Value> = state
        .db
        .list_scoped_api_keys()
        .iter()
        .filter(|k| scope_of(k).is_some_and(|s| can_manage_key(&tree, &viewer, &s, &k.user_id)))
        .map(|k| key_json(&state, &tree, k))
        .collect();
    Json(json!(keys))
}

#[derive(Deserialize)]
struct NewKey {
    name: String,
    #[serde(default)]
    group_id: Option<String>,
    #[serde(default)]
    client_ref: Option<String>,
    permissions: Vec<String>,
}

/// `POST /api/integrations/keys`: a scoped key, shown once. Admins may
/// leave out the group (every group); managers name one they manage.
async fn create_key(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(caller)): Extension<KeyScope>,
    Json(body): Json<NewKey>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if caller.is_some() {
        return Err(api_err(StatusCode::FORBIDDEN, "integration keys can't make keys"));
    }
    auth::require_full(&user)?;
    if auth::auth_disabled() {
        return Err(api_err(StatusCode::CONFLICT, "authentication is disabled (FARMSLICER_NO_AUTH): API keys aren't used"));
    }
    let (tree, viewer) = groups_api::context(&state, &user);
    let name = body.name.trim().chars().take(100).collect::<String>();
    if name.is_empty() {
        return Err(api_err(StatusCode::BAD_REQUEST, "name is required"));
    }
    let group = body.group_id.filter(|g| !g.is_empty());
    match &group {
        None if !viewer.admin => return Err(api_err(StatusCode::BAD_REQUEST, "name the group the key is for")),
        Some(g) if tree.get(g).is_none() => return Err(api_err(StatusCode::BAD_REQUEST, "no such group")),
        Some(g) if !viewer.can_manage(&tree, g) => {
            return Err(api_err(StatusCode::FORBIDDEN, "only admins and the group's managers make its keys"));
        }
        _ => {}
    }
    if body.permissions.is_empty() || body.permissions.iter().any(|p| !PERMISSIONS.contains(&p.as_str())) {
        return Err(api_err(StatusCode::BAD_REQUEST, format!("permissions: some of {}", PERMISSIONS.join(", "))));
    }
    let scope = Scope {
        group_id: group,
        client_ref: body.client_ref.map(|c| c.trim().chars().take(200).collect::<String>()).filter(|c| !c.is_empty()),
        permissions: body.permissions,
    };
    let key = format!("{}{}", auth::API_KEY_PREFIX, auth::random_token());
    let prefix = format!("{}…", &key[..12]);
    let record = state.db.create_scoped_api_key(
        &user.id,
        &name,
        &prefix,
        &auth::sha256_hex(&key),
        Some(&serde_json::to_string(&scope).unwrap()),
    );
    println!("Integration key {} ({name}): made by {}", record.id, user.username);
    Ok((StatusCode::CREATED, Json(json!({"key": key, "api_key": key_json(&state, &tree, &record)}))))
}

#[derive(Deserialize)]
struct RemoteBody {
    allowed: bool,
}

/// `POST /api/integrations/keys/{id}/remote` (admins): let the key in from
/// outside the network (still only to its scoped routes), or stop.
async fn set_remote(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(caller)): Extension<KeyScope>,
    Path(id): Path<String>,
    Json(body): Json<RemoteBody>,
) -> Result<Json<Value>, ApiError> {
    if caller.is_some() {
        return Err(api_err(StatusCode::FORBIDDEN, "integration keys can't change keys"));
    }
    auth::require_admin(&user)?;
    let key = state.db.get_api_key(&id).filter(|k| k.scope.is_some()).ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such key"))?;
    state.db.set_api_key_remote(&id, body.allowed);
    println!("Integration key {} ({}): {} by {}", key.id, key.name, if body.allowed { "allowed from outside" } else { "local network only" }, user.username);
    let (tree, _) = groups_api::context(&state, &user);
    Ok(Json(key_json(&state, &tree, &state.db.get_api_key(&id).expect("key exists"))))
}

async fn delete_key(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let key = state.db.get_api_key(&id).ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such key"))?;
    let scope = scope_of(&key).ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such key"))?;
    if !can_manage_key(&tree, &viewer, &scope, &key.user_id) {
        return Err(api_err(StatusCode::NOT_FOUND, "no such key"));
    }
    state.db.delete_api_key_by_id(&id);
    Ok(StatusCode::NO_CONTENT)
}

// -- Usage ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct UsageQuery {
    group: Option<String>,
    client_ref: Option<String>,
    project: Option<String>,
    /// Prints that ended on or after (`YYYY-MM-DD` or date and time, UTC).
    from: Option<String>,
    /// ... and before.
    to: Option<String>,
}

/// One project's (or the total's) usage.
#[derive(Debug, Default, Serialize, Clone, PartialEq)]
pub struct Usage {
    pub prints: f64,
    pub printer_hours: f64,
    pub grams: BTreeMap<String, f64>,
    pub good: i64,
    pub failed: i64,
    pub estimated_cost: f64,
}

impl Usage {
    fn add(&mut self, other: &Usage, share: f64) {
        self.prints += other.prints * share;
        self.printer_hours += other.printer_hours * share;
        for (m, g) in &other.grams {
            *self.grams.entry(m.clone()).or_default() += g * share;
        }
        self.estimated_cost += other.estimated_cost * share;
    }

    fn rounded(mut self) -> Self {
        let r = |v: f64, d: f64| (v * d).round() / d;
        self.prints = r(self.prints, 100.0);
        self.printer_hours = r(self.printer_hours, 100.0);
        self.estimated_cost = r(self.estimated_cost, 100.0);
        for g in self.grams.values_mut() {
            *g = r(*g, 10.0);
        }
        self
    }
}

/// What one ended print used: how far it got times its plate's estimate.
fn print_usage(state: &AppState, prices: &crate::cost::Prices, print: &PrintRecord) -> Usage {
    let fraction = match print.status.as_str() {
        "finished" => 1.0,
        _ => (print.progress as f64 / 100.0).clamp(0.0, 1.0),
    };
    let mut u = Usage { prints: 1.0, ..Default::default() };
    if let (Some(start), Some(end)) = (print.started_at.as_deref(), print.finished_at.as_deref()) {
        let t = |s: &str| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok();
        if let (Some(a), Some(b)) = (t(start), t(end)) {
            u.printer_hours = ((b - a).num_seconds().max(0) as f64) / 3600.0;
        }
    }
    let plate = print
        .job_id
        .as_deref()
        .and_then(|j| state.db.get_job(j))
        .and_then(|job| crate::printing::package_of(&job))
        .and_then(|pkg| pkg.plate(print.plate as u32).cloned());
    if let Some(plate) = plate {
        for f in &plate.filaments {
            let grams = crate::gcode::effective_grams(&plate, f.id) * fraction;
            let material = if f.material.is_empty() { "unknown".to_string() } else { f.material.clone() };
            *u.grams.entry(material).or_default() += grams;
            u.estimated_cost += grams * prices.per_kg(&f.material) / 1000.0;
        }
    }
    u
}

/// `GET /api/usage/prints?group=&client_ref=&project=&from=&to=`: what the
/// prints that ended in the period used, per project (shared by copies when
/// a plate carried several projects' parts) and in total. Admins see
/// everything; managers name a group they manage; an integration key sees
/// its scope.
async fn usage(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(KeyScope(scope)): Extension<KeyScope>,
    Query(q): Query<UsageQuery>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let mut group = q.group.filter(|g| !g.is_empty());
    let mut client = q.client_ref.filter(|c| !c.is_empty());
    if let Some(s) = &scope {
        if group.is_some() && group != s.group_id && s.group_id.is_some() {
            return Err(api_err(StatusCode::FORBIDDEN, "this key reports on its own group only"));
        }
        if s.group_id.is_some() {
            group = s.group_id.clone();
        }
        if let Some(c) = &s.client_ref {
            if client.as_ref().is_some_and(|x| x != c) {
                return Err(api_err(StatusCode::FORBIDDEN, "this key reports on its own client only"));
            }
            client = Some(c.clone());
        }
    } else if !viewer.admin && !group.as_deref().is_some_and(|g| viewer.can_manage(&tree, g)) {
        return Err(api_err(StatusCode::FORBIDDEN, "admins see all usage; managers name a group they manage (group=)"));
    }
    let bound = |v: Option<String>, field: &str| -> Result<Option<String>, ApiError> {
        v.filter(|s| !s.trim().is_empty())
            .map(|s| crate::projects::parse_due(&s).map_err(|_| api_err(StatusCode::BAD_REQUEST, format!("{field}: a date (YYYY-MM-DD) or date and time"))))
            .transpose()
    };
    let from = bound(q.from, "from")?;
    let to = bound(q.to, "to")?;

    let prices = crate::cost::Prices::load(&state.db);
    let mut total = Usage::default();
    let mut per_project: BTreeMap<String, Usage> = BTreeMap::new();
    let mut unassigned = Usage::default();
    let mut projects: BTreeMap<String, Option<Project>> = BTreeMap::new();
    for print in state.db.prints_ended_between(from.as_deref(), to.as_deref()) {
        let lines = crate::outcomes::print_lines(&state, &print);
        let recorded = state.db.print_outcome_lines(&print.id);
        let planned: i64 = lines.iter().map(|l| l.planned).sum::<i64>().max(1);
        // Copies per project on this plate, and their outcomes.
        let mut shares: BTreeMap<String, (i64, i64, i64)> = BTreeMap::new();
        let mut loose = 0i64;
        for l in &lines {
            let project = l
                .item_id
                .as_deref()
                .and_then(|i| state.db.get_item(i))
                .map(|i| i.project_id)
                .filter(|p| {
                    projects
                        .entry(p.clone())
                        .or_insert_with(|| state.db.get_project(p))
                        .as_ref()
                        .is_some_and(|proj| {
                            group.as_ref().is_none_or(|g| proj.group_id.as_ref() == Some(g))
                                && client.as_ref().is_none_or(|c| proj.client_ref.as_ref() == Some(c))
                                && q.project.as_ref().is_none_or(|x| x == &proj.id)
                        })
                });
            let outcome = recorded.iter().find(|r| r.line.line == l.line);
            let (good, failed) = outcome.map_or((0, 0), |o| (o.good, o.failed));
            match project {
                Some(p) => {
                    let e = shares.entry(p).or_default();
                    e.0 += l.planned;
                    e.1 += good;
                    e.2 += failed;
                }
                None => loose += l.planned,
            }
        }
        // With a filter, prints with nothing for it don't count at all.
        let filtered = group.is_some() || client.is_some() || q.project.is_some();
        if filtered && shares.is_empty() {
            continue;
        }
        let used = print_usage(&state, &prices, &print);
        for (p, (copies, good, failed)) in &shares {
            let share = *copies as f64 / planned as f64;
            let u = per_project.entry(p.clone()).or_default();
            u.add(&used, share);
            u.good += good;
            u.failed += failed;
            total.add(&used, share);
            total.good += good;
            total.failed += failed;
        }
        if !filtered && loose > 0 {
            let share = loose as f64 / planned as f64;
            unassigned.add(&used, share);
            total.add(&used, share);
            for l in lines.iter().filter(|l| l.item_id.is_none()) {
                if let Some(o) = recorded.iter().find(|r| r.line.line == l.line) {
                    unassigned.good += o.good;
                    unassigned.failed += o.failed;
                    total.good += o.good;
                    total.failed += o.failed;
                }
            }
        }
    }
    let list: Vec<Value> = per_project
        .into_iter()
        .map(|(id, u)| {
            let p = projects.get(&id).cloned().flatten();
            json!({
                "project_id": id,
                "name": p.as_ref().map(|p| p.name.clone()),
                "client_ref": p.as_ref().and_then(|p| p.client_ref.clone()),
                "external_ref": p.as_ref().and_then(|p| p.external_ref.clone()),
                "group_id": p.as_ref().and_then(|p| p.group_id.clone()),
                "usage": u.rounded(),
            })
        })
        .collect();
    Ok(Json(json!({
        "from": from,
        "to": to,
        "currency": prices.currency,
        "total": total.rounded(),
        "projects": list,
        "unassigned": unassigned.rounded(),
    })))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/integrations/keys", get(list_keys).post(create_key))
        .route("/api/integrations/keys/{id}", axum::routing::delete(delete_key))
        .route("/api/integrations/keys/{id}/remote", axum::routing::post(set_remote))
        .route("/api/usage/prints", get(usage))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(perms: &[&str]) -> Scope {
        Scope { group_id: Some("g".into()), client_ref: None, permissions: perms.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn keys_reach_only_their_routes() {
        let read = scope(&["projects:read"]);
        assert!(allows(&read, &Method::GET, "/api/projects").is_ok());
        assert!(allows(&read, &Method::GET, "/api/projects/abc").is_ok());
        assert!(allows(&read, &Method::GET, "/api/me").is_ok());
        assert!(allows(&read, &Method::POST, "/api/projects").unwrap_err().contains("projects:write"));
        assert!(allows(&read, &Method::GET, "/api/usage/prints").unwrap_err().contains("usage:read"));
        assert!(allows(&read, &Method::GET, "/api/printers").is_err());
        assert!(allows(&read, &Method::GET, "/api/jobs").is_err(), "no job listing");
        assert!(allows(&read, &Method::GET, "/api/jobs/x/parts").is_ok());
        assert!(allows(&read, &Method::GET, "/api/jobs/x/gcode").is_err());
        let write = scope(&["projects:write"]);
        assert!(allows(&write, &Method::GET, "/api/projects").is_ok(), "write implies read");
        assert!(allows(&write, &Method::POST, "/api/jobs").is_ok());
        assert!(allows(&write, &Method::POST, "/api/uploads").is_ok());
        assert!(allows(&write, &Method::DELETE, "/api/jobs/x").is_err());
        assert!(allows(&write, &Method::POST, "/api/queue").is_err());
        assert!(allows(&write, &Method::POST, "/api/integrations/keys").is_err());
    }

    #[test]
    fn scopes_cover_their_projects() {
        let p = |g: Option<&str>, c: Option<&str>| Project {
            id: String::new(),
            name: String::new(),
            group_id: g.map(String::from),
            group_name: None,
            user_id: None,
            username: None,
            client_ref: c.map(String::from),
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
        let mut s = scope(&["projects:read"]);
        assert!(s.covers(&p(Some("g"), None)));
        assert!(!s.covers(&p(Some("h"), None)));
        assert!(!s.covers(&p(None, None)));
        s.client_ref = Some("acme".into());
        assert!(s.covers(&p(Some("g"), Some("acme"))));
        assert!(!s.covers(&p(Some("g"), Some("other"))));
        assert!(!s.covers(&p(Some("g"), None)));
        s.group_id = None;
        assert!(s.covers(&p(Some("h"), Some("acme"))));
    }
}
