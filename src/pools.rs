//! Printer pools and their operators. A pool is a set of printers with the
//! people who run them: an operator may, for the printers of their pools,
//! see the queue in full, send entries, record outcomes, control prints
//! and pre-heat. Pools also pin queue entries ("only Bay 2's printers").
//! With no pools, admins work every printer (the implicit pool). Admins
//! manage pools (`/api/pools`).
//!
//! Pool settings: `mixing` (`none` | `group` | `any`; unset = the site's,
//! default `group`): which projects' parts may share a plate the
//! auto-plater makes for the pool.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::{self, CurrentUser};
use crate::db::QueueEntry;
use crate::groups::Viewer;
use crate::server::AppState;

pub const MIXING: &[&str] = &["none", "group", "any"];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PoolSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mixing: Option<String>,
}

impl PoolSettings {
    pub fn validate(&self) -> Result<(), String> {
        match self.mixing.as_deref() {
            Some(m) if !MIXING.contains(&m) => Err(format!("mixing: one of {}", MIXING.join(", "))),
            _ => Ok(()),
        }
    }
}

/// The site's mixing rule: `group` unless an admin chose otherwise.
pub fn site_mixing(state: &AppState) -> String {
    state.db.get_setting("mixing").filter(|m| MIXING.contains(&m.as_str())).unwrap_or_else(|| "group".into())
}

/// Is `printer_id` in pool `pool_id`?
pub fn has_printer(state: &AppState, pool_id: &str, printer_id: &str) -> bool {
    state.db.pool_has_printer(pool_id, printer_id)
}

pub fn exists(state: &AppState, pool_id: &str) -> bool {
    state.db.get_pool(pool_id).is_some()
}

/// May `viewer` work `printer_id` as one of its pools' operators? (Admins
/// work every printer; callers check that separately.)
pub fn operates(state: &AppState, viewer: &Viewer, printer_id: Option<&str>) -> bool {
    let Some(p) = printer_id else { return false };
    state.db.operated_printers(&viewer.user.id).iter().any(|x| x == p)
}

/// May `viewer` work a printer `entry` could go to?
pub fn operates_entry(state: &AppState, viewer: &Viewer, entry: &QueueEntry) -> bool {
    let printers = state.db.operated_printers(&viewer.user.id);
    if printers.is_empty() {
        return false;
    }
    if let Some(pin) = &entry.printer_id {
        return printers.contains(pin);
    }
    if let Some(pool) = &entry.pool_id {
        return state.db.operates_pool(&viewer.user.id, pool);
    }
    printers.iter().filter_map(|id| state.db.get_printer(id)).any(|p| crate::queue::fit(state, entry, &p).refused.is_none())
}

// -- API ---------------------------------------------------------------------------

type ApiError = (StatusCode, Json<Value>);

fn api_err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

fn pool_json(p: &crate::db::Pool) -> Value {
    json!({
        "id": p.id,
        "name": p.name,
        "settings": serde_json::from_str::<Value>(&p.settings).unwrap_or(json!({})),
        "printer_ids": p.printer_ids,
        "operators": p.operators.iter().map(|(id, name)| json!({"id": id, "username": name})).collect::<Vec<_>>(),
        "created_at": p.created_at,
    })
}

/// `GET /api/pools`: every pool (admins), or the pools one operates.
async fn list_pools(State(state): State<Arc<AppState>>, Extension(CurrentUser(user)): Extension<CurrentUser>) -> Json<Value> {
    let admin = auth::is_admin(&user);
    let pools: Vec<Value> = state
        .db
        .list_pools()
        .iter()
        .filter(|p| admin || p.operators.iter().any(|(id, _)| *id == user.id))
        .map(pool_json)
        .collect();
    Json(json!({ "pools": pools, "mixing": site_mixing(&state) }))
}

#[derive(Deserialize)]
struct PoolBody {
    name: Option<String>,
    #[serde(default)]
    printer_ids: Option<Vec<String>>,
    #[serde(default)]
    operator_ids: Option<Vec<String>>,
    #[serde(default)]
    settings: Option<PoolSettings>,
}

fn save(state: &AppState, id: &str, body: PoolBody, existing: Option<crate::db::Pool>) -> Result<Json<Value>, ApiError> {
    let name = match (&body.name, &existing) {
        (Some(n), _) => n.trim().chars().take(100).collect::<String>(),
        (None, Some(p)) => p.name.clone(),
        (None, None) => String::new(),
    };
    if name.is_empty() {
        return Err(api_err(StatusCode::BAD_REQUEST, "a pool needs a name"));
    }
    let printers = body.printer_ids.unwrap_or_else(|| existing.as_ref().map(|p| p.printer_ids.clone()).unwrap_or_default());
    let operators = body
        .operator_ids
        .unwrap_or_else(|| existing.as_ref().map(|p| p.operators.iter().map(|(id, _)| id.clone()).collect()).unwrap_or_default());
    for p in &printers {
        if state.db.get_printer(p).is_none() {
            return Err(api_err(StatusCode::BAD_REQUEST, format!("no printer {p}")));
        }
    }
    for u in &operators {
        match state.db.get_user(u) {
            Some(user) if user.kind == "full" => {}
            Some(_) => return Err(api_err(StatusCode::BAD_REQUEST, "guest accounts can't operate printers")),
            None => return Err(api_err(StatusCode::BAD_REQUEST, format!("no user {u}"))),
        }
    }
    let settings = match body.settings {
        Some(s) => s,
        None => existing.as_ref().and_then(|p| serde_json::from_str(&p.settings).ok()).unwrap_or_default(),
    };
    settings.validate().map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    state
        .db
        .save_pool(id, &name, &serde_json::to_string(&settings).unwrap(), &printers, &operators)
        .map_err(|e| api_err(StatusCode::CONFLICT, e))?;
    Ok(Json(pool_json(&state.db.get_pool(id).expect("pool just saved"))))
}

/// `POST /api/pools` (admins): `{name, printer_ids, operator_ids, settings}`.
async fn create_pool(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<PoolBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    auth::require_admin(&user)?;
    let id = uuid::Uuid::new_v4().to_string();
    let v = save(&state, &id, body, None)?;
    println!("Pool {id}: created by {}", user.username);
    crate::dispatch::poke(&state);
    Ok((StatusCode::CREATED, v))
}

/// `PATCH /api/pools/{id}` (admins): what's given replaces what was.
async fn update_pool(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<PoolBody>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&user)?;
    let existing = state.db.get_pool(&id).ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such pool"))?;
    let v = save(&state, &id, body, Some(existing))?;
    crate::dispatch::poke(&state);
    Ok(v)
}

/// `DELETE /api/pools/{id}` (admins): entries for the pool go to any printer.
async fn delete_pool(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    auth::require_admin(&user)?;
    if !state.db.delete_pool(&id) {
        return Err(api_err(StatusCode::NOT_FOUND, "no such pool"));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/pools", get(list_pools).post(create_pool))
        .route("/api/pools/{id}", axum::routing::patch(update_pool).delete(delete_pool))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixing_is_checked() {
        assert!(PoolSettings { mixing: Some("group".into()) }.validate().is_ok());
        assert!(PoolSettings { mixing: None }.validate().is_ok());
        assert!(PoolSettings { mixing: Some("sometimes".into()) }.validate().is_err());
    }
}
