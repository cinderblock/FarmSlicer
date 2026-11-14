//! `/api/roles`: the built-in and custom roles and the capability lists
//! (src/permissions.rs has the rules). Everyone signed in reads them (the
//! group pages offer group roles); holders of `roles.manage` change them,
//! from capabilities they hold themselves.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, put},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::audit::{self, Target};
use crate::auth::{self, CurrentUser};
use crate::db::User;
use crate::permissions::{self, Cap, GroupCaps, Role, Scope, SiteCaps};
use crate::server::AppState;

type ApiError = (StatusCode, Json<Value>);

fn err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

fn role_json(state: &AppState, r: &Role) -> Value {
    let mut v = json!(r);
    v["holders"] = json!(if r.builtin { None } else { Some(state.db.role_holders(&r.id)) });
    v
}

async fn list(State(state): State<Arc<AppState>>) -> Json<Value> {
    let roles: Vec<Value> = permissions::all_roles(&state.db).iter().map(|r| role_json(&state, r)).collect();
    Json(json!({"roles": roles, "capabilities": permissions::catalogue()}))
}

#[derive(Deserialize)]
struct RoleBody {
    name: String,
    /// "site" | "group" (creation only; a role keeps its scope).
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    description: String,
    #[serde(default)]
    caps: Vec<String>,
}

/// Validated capability ids, none of which the actor lacks. Group
/// capabilities are bounded by "manage every group" (which holds them all).
fn checked_caps(actor: &User, scope: Scope, caps: &[String]) -> Result<Vec<&'static str>, ApiError> {
    let owner = actor.role == permissions::OWNER;
    match scope {
        Scope::Site => {
            let set = SiteCaps::parse(caps).map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
            if !owner && !set.is_subset_of(&actor.caps) {
                return Err(err(StatusCode::FORBIDDEN, "a role can't have permissions you don't have"));
            }
            Ok(set.ids())
        }
        Scope::Group => {
            let set = GroupCaps::parse(caps).map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
            if !owner && !auth::can(actor, Cap::GroupsManageAll) && !set.is_empty() {
                return Err(err(StatusCode::FORBIDDEN, "group roles are made by those who manage every group"));
            }
            Ok(set.ids())
        }
    }
}

fn valid_name(name: &str) -> Result<(), ApiError> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 40 {
        return Err(err(StatusCode::BAD_REQUEST, "name: 1-40 characters"));
    }
    if permissions::builtin_roles().iter().any(|r| r.name.eq_ignore_ascii_case(n) || r.id.eq_ignore_ascii_case(n)) {
        return Err(err(StatusCode::BAD_REQUEST, "that name belongs to a built-in role"));
    }
    Ok(())
}

fn target(r: &Role) -> Target<'_> {
    Target { kind: "role", id: &r.id, name: &r.name }
}

async fn create(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(actor)): Extension<CurrentUser>,
    Json(body): Json<RoleBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    auth::require(&actor, Cap::RolesManage)?;
    let scope = body
        .scope
        .as_deref()
        .and_then(Scope::parse)
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "scope: site or group"))?;
    valid_name(&body.name)?;
    if body.description.len() > 300 {
        return Err(err(StatusCode::BAD_REQUEST, "description: up to 300 characters"));
    }
    let caps = checked_caps(&actor, scope, &body.caps)?;
    let id = format!("r_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    state
        .db
        .save_role(&id, &body.name, scope, &body.description, &caps)
        .map_err(|e| err(StatusCode::CONFLICT, e))?;
    let role = state.db.get_role(&id).unwrap();
    audit::record(&state.db, &actor, "role.create", target(&role), json!({"scope": scope, "caps": caps}));
    Ok((StatusCode::CREATED, Json(role_json(&state, &role))))
}

async fn update(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(actor)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<RoleBody>,
) -> Result<Json<Value>, ApiError> {
    auth::require(&actor, Cap::RolesManage)?;
    if permissions::is_builtin(&id) {
        return Err(err(StatusCode::BAD_REQUEST, "built-in roles can't be changed"));
    }
    let Some(old) = state.db.get_role(&id) else {
        return Err(err(StatusCode::NOT_FOUND, "no such role"));
    };
    valid_name(&body.name)?;
    if body.description.len() > 300 {
        return Err(err(StatusCode::BAD_REQUEST, "description: up to 300 characters"));
    }
    // Removing a capability is as much a change as adding one: the actor
    // must hold the old set too.
    checked_caps(&actor, old.scope, &old.caps)?;
    let caps = checked_caps(&actor, old.scope, &body.caps)?;
    state
        .db
        .save_role(&id, &body.name, old.scope, &body.description, &caps)
        .map_err(|e| err(StatusCode::CONFLICT, e))?;
    let role = state.db.get_role(&id).unwrap();
    audit::record(
        &state.db,
        &actor,
        "role.update",
        target(&role),
        json!({"from": {"name": old.name, "caps": old.caps}, "to": {"name": role.name, "caps": role.caps}}),
    );
    Ok(Json(role_json(&state, &role)))
}

async fn remove(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(actor)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    auth::require(&actor, Cap::RolesManage)?;
    let Some(old) = state.db.get_role(&id) else {
        return Err(err(StatusCode::NOT_FOUND, "no such role"));
    };
    checked_caps(&actor, old.scope, &old.caps)?;
    let holders = state.db.role_holders(&id);
    if holders > 0 {
        return Err(err(
            StatusCode::CONFLICT,
            format!("{holders} {} this role; give them another one first", if holders == 1 { "account has" } else { "accounts have" }),
        ));
    }
    state.db.delete_role(&id);
    audit::record(&state.db, &actor, "role.delete", target(&old), json!({"caps": old.caps}));
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/roles", get(list).post(create))
        .route("/api/roles/{id}", put(update).delete(remove))
}
