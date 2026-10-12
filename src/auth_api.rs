//! HTTP handlers for accounts: passkey setup / login / invites / recovery,
//! the signed-in user's own passkeys, API keys and recovery code, and the
//! admin user list. Policy lives in src/auth.rs.

use axum::{
    extract::{Path, Request, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use webauthn_rs::prelude::*;

use crate::auth::{self, CurrentUser, Flow, RegisterPurpose};
use crate::db::{PasskeyRecord, User};
use crate::server::AppState;

type ApiError = (StatusCode, Json<Value>);

fn err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

fn user_json(user: &User) -> Value {
    json!({
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "kind": user.kind,
        "created_at": user.created_at,
        "last_login": user.last_login,
    })
}

fn passkey_json(k: &PasskeyRecord) -> Value {
    json!({
        "id": k.id,
        "name": k.name,
        "created_at": k.created_at,
        "last_used": k.last_used,
    })
}

fn load_passkeys(state: &AppState, user_id: &str) -> Vec<(PasskeyRecord, Passkey)> {
    state
        .db
        .list_passkeys(user_id)
        .into_iter()
        .filter_map(|rec| {
            serde_json::from_str::<Passkey>(&rec.passkey_json)
                .ok()
                .map(|pk| (rec, pk))
        })
        .collect()
}

pub(crate) fn start_session(state: &AppState, user: &User, extra: Value, days: i64) -> Response {
    let token = auth::random_token();
    state
        .db
        .create_session(&auth::sha256_hex(&token), &user.id, days);
    let mut body = json!({"ok": true, "user": user_json(user)});
    if let (Some(obj), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in extra {
            obj.insert(k.clone(), v.clone());
        }
    }
    (
        StatusCode::OK,
        [(header::SET_COOKIE, auth::session_cookie(&token, days))],
        Json(body),
    )
        .into_response()
}

/// Issue a fresh recovery code (a guest's sign-in code) for the user and
/// return it (plaintext, once).
pub(crate) fn issue_recovery_code(state: &AppState, user_id: &str) -> String {
    let code = auth::recovery_code();
    state
        .db
        .set_recovery_code(user_id, &auth::sha256_hex(&auth::normalize_recovery_code(&code)));
    code
}

pub(crate) fn begin_registration(
    state: &AppState,
    user_id: &str,
    username: &str,
    purpose: RegisterPurpose,
) -> Result<Json<Value>, ApiError> {
    let existing: Vec<CredentialID> = load_passkeys(state, user_id)
        .into_iter()
        .map(|(_, pk)| pk.cred_id().clone())
        .collect();
    let exclude = if existing.is_empty() { None } else { Some(existing) };
    let (options, reg_state) = state
        .rp
        .webauthn
        .start_passkey_registration(auth::user_uuid(user_id), username, username, exclude)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("webauthn: {e}")))?;
    let flow_id = state.rp.store_flow(Flow::Register {
        state: reg_state,
        purpose,
    });
    Ok(Json(json!({"flow_id": flow_id, "options": options})))
}

#[derive(Deserialize)]
pub(crate) struct FinishRegistration {
    pub flow_id: String,
    pub credential: RegisterPublicKeyCredential,
    #[serde(default)]
    pub key_name: Option<String>,
}

pub(crate) fn take_registration(state: &AppState, flow_id: &str) -> Result<(PasskeyRegistration, RegisterPurpose), ApiError> {
    match state.rp.take_flow(flow_id) {
        Some(Flow::Register { state, purpose }) => Ok((state, purpose)),
        _ => Err(err(StatusCode::BAD_REQUEST, "registration expired or unknown; start again")),
    }
}

pub(crate) fn finish_registration(
    state: &AppState,
    reg_state: &PasskeyRegistration,
    credential: &RegisterPublicKeyCredential,
) -> Result<(String, String), ApiError> {
    let passkey = state
        .rp
        .webauthn
        .finish_passkey_registration(credential, reg_state)
        .map_err(|e| err(StatusCode::BAD_REQUEST, format!("passkey registration failed: {e}")))?;
    let id = auth::cred_id_hex(passkey.cred_id().as_ref());
    let json = serde_json::to_string(&passkey)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok((id, json))
}

pub(crate) fn key_name(body: &Option<String>) -> String {
    body.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Passkey")
        .to_string()
}

// ---- public: status ------------------------------------------------------------

async fn auth_status(State(state): State<Arc<AppState>>, req: Request) -> Json<Value> {
    let setup_required = auth::setup_required(&state.db);
    let user = auth::resolve_user(&state, &req);
    let tree = crate::groups::Tree::load(&state.db);
    let join_groups: Vec<Value> = tree
        .listed()
        .iter()
        .map(|g| json!({"id": g.id, "name": g.name, "description": g.description}))
        .collect();
    Json(json!({
        "setup_required": setup_required,
        "auth_disabled": auth::auth_disabled(),
        "authenticated": user.is_some(),
        "user": user.as_ref().map(user_json),
        "rp_id": state.rp.rp_id,
        "join_groups": join_groups,
    }))
}

// ---- public: first-run setup ----------------------------------------------------

#[derive(Deserialize)]
struct SetupStart {
    username: String,
}

async fn setup_start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SetupStart>,
) -> Result<Json<Value>, ApiError> {
    if !auth::setup_required(&state.db) {
        return Err(err(StatusCode::CONFLICT, "setup already completed"));
    }
    if !auth::valid_username(&body.username) {
        return Err(err(StatusCode::BAD_REQUEST, "username: 2-32 characters, letters, digits, . _ -"));
    }
    let user_id = Uuid::new_v4().to_string();
    let username = body.username.trim().to_string();
    begin_registration(
        &state,
        &user_id,
        &username,
        RegisterPurpose::Setup { user_id: user_id.clone(), username: username.clone() },
    )
}

async fn setup_finish(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FinishRegistration>,
) -> Result<Response, ApiError> {
    let (reg_state, purpose) = take_registration(&state, &body.flow_id)?;
    let RegisterPurpose::Setup { user_id, username } = purpose else {
        return Err(err(StatusCode::BAD_REQUEST, "not a setup registration"));
    };
    if !auth::setup_required(&state.db) {
        return Err(err(StatusCode::CONFLICT, "setup already completed"));
    }
    let (cred_id, passkey_json) = finish_registration(&state, &reg_state, &body.credential)?;
    // Re-bootstrap: accounts nobody can sign in to (no passkey) make way.
    let removed = state.db.delete_users_without_passkeys();
    if removed > 0 {
        println!("first-run setup: removed {removed} account(s) that had no passkey");
    }
    let user = state
        .db
        .create_user(&user_id, &username, "owner", "full")
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    state
        .db
        .add_passkey(&cred_id, &user.id, &key_name(&body.key_name), &passkey_json)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let recovery_code = issue_recovery_code(&state, &user.id);
    println!("first-run setup: owner account '{}' created with a passkey", user.username);
    Ok(start_session(&state, &user, json!({"recovery_code": recovery_code}), auth::SESSION_DAYS))
}

// ---- public: login -------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct LoginStart {
    #[serde(default)]
    username: Option<String>,
}

async fn login_start(
    State(state): State<Arc<AppState>>,
    body: Option<Json<LoginStart>>,
) -> Result<Json<Value>, ApiError> {
    let username = body.and_then(|Json(b)| b.username).filter(|u| !u.trim().is_empty());
    if let Some(username) = username {
        let Some(user) = state.db.get_user_by_username(&username) else {
            return Err(err(StatusCode::NOT_FOUND, "no such user"));
        };
        let keys: Vec<Passkey> = load_passkeys(&state, &user.id).into_iter().map(|(_, k)| k).collect();
        if keys.is_empty() {
            if user.kind == "guest" {
                return Err(err(StatusCode::NOT_FOUND, "that is a guest account; sign in with its sign-in code"));
            }
            return Err(err(StatusCode::NOT_FOUND, "that account has no passkey yet; use its invite link"));
        }
        let (options, auth_state) = state
            .rp
            .webauthn
            .start_passkey_authentication(&keys)
            .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("webauthn: {e}")))?;
        let flow_id = state.rp.store_flow(Flow::Login { state: auth_state, user_id: user.id });
        return Ok(Json(json!({"flow_id": flow_id, "options": options})));
    }
    let (options, auth_state) = state
        .rp
        .webauthn
        .start_discoverable_authentication()
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("webauthn: {e}")))?;
    let flow_id = state.rp.store_flow(Flow::Discoverable { state: auth_state });
    Ok(Json(json!({"flow_id": flow_id, "options": options})))
}

#[derive(Deserialize)]
struct LoginFinish {
    flow_id: String,
    credential: PublicKeyCredential,
}

async fn login_finish(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LoginFinish>,
) -> Result<Response, ApiError> {
    let bad = || err(StatusCode::UNAUTHORIZED, "passkey sign-in failed");
    let (user_id, result) = match state.rp.take_flow(&body.flow_id) {
        Some(Flow::Login { state: auth_state, user_id }) => {
            let result = state
                .rp
                .webauthn
                .finish_passkey_authentication(&body.credential, &auth_state)
                .map_err(|_| bad())?;
            (user_id, result)
        }
        Some(Flow::Discoverable { state: auth_state }) => {
            let (uuid, _cred_id) = state
                .rp
                .webauthn
                .identify_discoverable_authentication(&body.credential)
                .map_err(|_| bad())?;
            let user_id = uuid.to_string();
            let keys: Vec<DiscoverableKey> = load_passkeys(&state, &user_id)
                .into_iter()
                .map(|(_, k)| DiscoverableKey::from(k))
                .collect();
            if keys.is_empty() {
                return Err(bad());
            }
            let result = state
                .rp
                .webauthn
                .finish_discoverable_authentication(&body.credential, auth_state, &keys)
                .map_err(|_| bad())?;
            (user_id, result)
        }
        _ => return Err(err(StatusCode::BAD_REQUEST, "sign-in expired or unknown; start again")),
    };

    let Some(user) = state.db.get_user(&user_id) else {
        return Err(bad());
    };
    // Persist the updated sign counter / backup state.
    let used_id = auth::cred_id_hex(result.cred_id().as_ref());
    for (rec, mut pk) in load_passkeys(&state, &user.id) {
        if rec.id == used_id {
            pk.update_credential(&result);
            if let Ok(json) = serde_json::to_string(&pk) {
                state.db.touch_passkey(&rec.id, &json);
            }
        }
    }
    Ok(start_session(&state, &user, json!({}), auth::SESSION_DAYS))
}

async fn logout(State(state): State<Arc<AppState>>, req: Request) -> impl IntoResponse {
    if let Some(token) = auth::session_token_from_request(&req) {
        state.db.delete_session(&auth::sha256_hex(&token));
    }
    (
        StatusCode::OK,
        [(header::SET_COOKIE, auth::clear_session_cookie())],
        Json(json!({"ok": true})),
    )
}

// ---- public: invites (enrol a passkey for an account an admin created) ---------------

async fn invite_info(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let Some((invite, user)) = state.db.get_invite(&auth::sha256_hex(&token)) else {
        return Err(err(StatusCode::NOT_FOUND, "this invite link is invalid, used or expired"));
    };
    Ok(Json(json!({
        "username": user.username,
        "role": user.role,
        "expires_at": invite.expires_at,
        "has_passkeys": state.db.passkey_count(&user.id) > 0,
    })))
}

async fn invite_start(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let token_hash = auth::sha256_hex(&token);
    let Some((_, user)) = state.db.get_invite(&token_hash) else {
        return Err(err(StatusCode::NOT_FOUND, "this invite link is invalid, used or expired"));
    };
    begin_registration(
        &state,
        &user.id,
        &user.username,
        RegisterPurpose::Invite { user_id: user.id.clone(), token_hash },
    )
}

async fn invite_finish(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    Json(body): Json<FinishRegistration>,
) -> Result<Response, ApiError> {
    let (reg_state, purpose) = take_registration(&state, &body.flow_id)?;
    let RegisterPurpose::Invite { user_id, token_hash } = purpose else {
        return Err(err(StatusCode::BAD_REQUEST, "not an invite registration"));
    };
    if token_hash != auth::sha256_hex(&token) || state.db.get_invite(&token_hash).is_none() {
        return Err(err(StatusCode::NOT_FOUND, "this invite link is invalid, used or expired"));
    }
    let (cred_id, passkey_json) = finish_registration(&state, &reg_state, &body.credential)?;
    state
        .db
        .add_passkey(&cred_id, &user_id, &key_name(&body.key_name), &passkey_json)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    state.db.use_invite(&token_hash);
    let user = state.db.get_user(&user_id).ok_or_else(|| err(StatusCode::NOT_FOUND, "user vanished"))?;
    let recovery_code = issue_recovery_code(&state, &user.id);
    println!("invite accepted: '{}' enrolled a passkey", user.username);
    Ok(start_session(&state, &user, json!({"recovery_code": recovery_code}), auth::SESSION_DAYS))
}

// ---- public: recovery (lost every passkey) -------------------------------------------

#[derive(Deserialize)]
struct RecoverStart {
    username: String,
    code: String,
}

async fn recover_start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RecoverStart>,
) -> Result<Json<Value>, ApiError> {
    let bad = || err(StatusCode::UNAUTHORIZED, "unknown user or wrong recovery code");
    let user = state.db.get_user_by_username(&body.username).ok_or_else(bad)?;
    let code_hash = auth::sha256_hex(&auth::normalize_recovery_code(&body.code));
    if !state.db.recovery_code_valid(&user.id, &code_hash) {
        return Err(bad());
    }
    begin_registration(
        &state,
        &user.id,
        &user.username,
        RegisterPurpose::Recovery { user_id: user.id.clone(), code_hash },
    )
}

async fn recover_finish(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FinishRegistration>,
) -> Result<Response, ApiError> {
    let (reg_state, purpose) = take_registration(&state, &body.flow_id)?;
    let RegisterPurpose::Recovery { user_id, code_hash } = purpose else {
        return Err(err(StatusCode::BAD_REQUEST, "not a recovery registration"));
    };
    if !state.db.recovery_code_valid(&user_id, &code_hash) {
        return Err(err(StatusCode::UNAUTHORIZED, "recovery code no longer valid"));
    }
    let (cred_id, passkey_json) = finish_registration(&state, &reg_state, &body.credential)?;
    state
        .db
        .add_passkey(&cred_id, &user_id, &key_name(&body.key_name), &passkey_json)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    state.db.use_recovery_code(&code_hash);
    // A guest who enrols a passkey becomes a full account.
    state.db.set_user_kind(&user_id, "full");
    let user = state.db.get_user(&user_id).ok_or_else(|| err(StatusCode::NOT_FOUND, "user vanished"))?;
    let recovery_code = issue_recovery_code(&state, &user.id);
    println!("recovery: '{}' re-enrolled a passkey", user.username);
    Ok(start_session(&state, &user, json!({"recovery_code": recovery_code}), auth::SESSION_DAYS))
}

// ---- signed-in user: own account ------------------------------------------------------

/// The caller, their memberships, and the groups they can charge jobs to.
async fn me(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Json<Value> {
    let (tree, viewer) = crate::groups_api::context(&state, &user);
    let mut v = user_json(&user);
    let groups: Vec<Value> = viewer
        .memberships
        .iter()
        .filter(|m| tree.get(&m.group_id).is_some())
        .map(|m| {
            json!({
                "group_id": m.group_id,
                "path": tree.display_path(&m.group_id),
                "role": m.role,
                "status": m.status,
                "keep_models": tree.effective(&m.group_id).keep_models,
            })
        })
        .collect();
    let obj = v.as_object_mut().unwrap();
    obj.insert("groups".into(), json!(groups));
    obj.insert(
        "chargeable".into(),
        json!(viewer
            .chargeable(&tree)
            .into_iter()
            .map(|(id, path)| json!({"id": id, "path": path}))
            .collect::<Vec<_>>()),
    );
    Json(v)
}

async fn list_my_passkeys(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Json<Value> {
    let keys: Vec<Value> = state.db.list_passkeys(&user.id).iter().map(passkey_json).collect();
    Json(json!(keys))
}

async fn add_passkey_start(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Result<Json<Value>, ApiError> {
    begin_registration(
        &state,
        &user.id,
        &user.username,
        RegisterPurpose::AddKey { user_id: user.id.clone() },
    )
}

async fn add_passkey_finish(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<FinishRegistration>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (reg_state, purpose) = take_registration(&state, &body.flow_id)?;
    let RegisterPurpose::AddKey { user_id } = purpose else {
        return Err(err(StatusCode::BAD_REQUEST, "not an add-passkey registration"));
    };
    if user_id != user.id {
        return Err(err(StatusCode::FORBIDDEN, "registration belongs to another account"));
    }
    let (cred_id, pk_json) = finish_registration(&state, &reg_state, &body.credential)?;
    state
        .db
        .add_passkey(&cred_id, &user.id, &key_name(&body.key_name), &pk_json)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    if user.kind == "guest" {
        state.db.set_user_kind(&user.id, "full");
        println!("'{}' added a passkey: guest account upgraded to full", user.username);
    }
    let rec = state.db.get_passkey(&cred_id).ok_or_else(|| err(StatusCode::INTERNAL_SERVER_ERROR, "passkey not stored"))?;
    Ok((StatusCode::CREATED, Json(passkey_json(&rec))))
}

#[derive(Deserialize)]
struct RenameKey {
    name: String,
}

async fn rename_passkey(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<RenameKey>,
) -> StatusCode {
    if body.name.trim().is_empty() {
        return StatusCode::BAD_REQUEST;
    }
    if state.db.rename_passkey(&id, &user.id, &body.name) {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn delete_passkey(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if state.db.passkey_count(&user.id) <= 1 {
        return Err(err(StatusCode::BAD_REQUEST, "you cannot remove your only passkey; add another first"));
    }
    if state.db.delete_passkey(&id, &user.id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(err(StatusCode::NOT_FOUND, "passkey not found"))
    }
}

/// Replace the recovery code; the new one is returned once.
async fn regenerate_recovery_code(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Json<Value> {
    let code = issue_recovery_code(&state, &user.id);
    Json(json!({"recovery_code": code}))
}

async fn list_my_api_keys(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Json<Value> {
    Json(json!(state.db.list_api_keys(&user.id)))
}

#[derive(Deserialize)]
struct CreateApiKey {
    name: String,
}

/// Returns the key itself exactly once.
async fn create_my_api_key(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<CreateApiKey>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    auth::require_full(&user)?;
    if body.name.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "name is required"));
    }
    let key = format!("{}{}", auth::API_KEY_PREFIX, auth::random_token());
    let prefix = format!("{}…", &key[..12]);
    let record = state
        .db
        .create_api_key(&user.id, &body.name, &prefix, &auth::sha256_hex(&key));
    Ok((StatusCode::CREATED, Json(json!({"key": key, "api_key": record}))))
}

async fn delete_my_api_key(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> StatusCode {
    if state.db.delete_api_key(&id, &user.id) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

// ---- admin: users ---------------------------------------------------------------------

fn admin_user_json(state: &AppState, tree: &crate::groups::Tree, user: &User) -> Value {
    let mut v = user_json(user);
    if let Some(obj) = v.as_object_mut() {
        obj.insert("passkeys".into(), json!(state.db.passkey_count(&user.id)));
        obj.insert("invite_expires_at".into(), json!(state.db.pending_invite_expiry(&user.id)));
        obj.insert(
            "quotas".into(),
            json!(user.quotas.as_deref().map(crate::quota::parse_rules)),
        );
        let groups: Vec<Value> = state
            .db
            .memberships_of_user(&user.id)
            .iter()
            .filter(|m| tree.get(&m.group_id).is_some())
            .map(|m| json!({"group_id": m.group_id, "path": tree.display_path(&m.group_id), "role": m.role, "status": m.status}))
            .collect();
        obj.insert("groups".into(), json!(groups));
    }
    v
}

async fn list_users(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&user)?;
    let tree = crate::groups::Tree::load(&state.db);
    let users: Vec<Value> = state
        .db
        .list_users()
        .iter()
        .map(|u| admin_user_json(&state, &tree, u))
        .collect();
    Ok(Json(json!(users)))
}

#[derive(Deserialize)]
struct CreateUser {
    username: String,
    #[serde(default)]
    role: Option<String>,
}

fn issue_invite(state: &AppState, user_id: &str, created_by: &str) -> (String, String) {
    let token = auth::random_token();
    state
        .db
        .create_invite(&auth::sha256_hex(&token), user_id, Some(created_by), auth::INVITE_HOURS);
    let expires = state.db.pending_invite_expiry(user_id).unwrap_or_default();
    (state.rp.invite_url(&token), expires)
}

/// Creates the account and returns its invite link; the invitee enrols a
/// passkey through it.
async fn create_user(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(actor)): Extension<CurrentUser>,
    Json(body): Json<CreateUser>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    auth::require_admin(&actor)?;
    let role = body.role.as_deref().unwrap_or("user");
    if !matches!(role, "admin" | "user") {
        return Err(err(StatusCode::BAD_REQUEST, "role must be 'admin' or 'user'"));
    }
    if !auth::valid_username(&body.username) {
        return Err(err(StatusCode::BAD_REQUEST, "username: 2-32 characters, letters, digits, . _ -"));
    }
    let user = state
        .db
        .create_user(&Uuid::new_v4().to_string(), &body.username, role, "full")
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    let (invite_url, expires_at) = issue_invite(&state, &user.id, &actor.id);
    let tree = crate::groups::Tree::load(&state.db);
    Ok((
        StatusCode::CREATED,
        Json(json!({"user": admin_user_json(&state, &tree, &user), "invite_url": invite_url, "expires_at": expires_at})),
    ))
}

/// (Re)issue an enrolment link, e.g. when a user lost every passkey and their
/// recovery code. Admins cannot do this for the owner.
async fn reissue_invite(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(actor)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&actor)?;
    let Some(target) = state.db.get_user(&id) else {
        return Err(err(StatusCode::NOT_FOUND, "user not found"));
    };
    if target.role == "owner" && actor.id != target.id {
        return Err(err(StatusCode::FORBIDDEN, "only the owner can re-enrol the owner"));
    }
    let (invite_url, expires_at) = issue_invite(&state, &target.id, &actor.id);
    Ok(Json(json!({"invite_url": invite_url, "expires_at": expires_at})))
}

#[derive(Deserialize)]
struct UpdateUser {
    #[serde(default)]
    role: Option<String>,
    /// Present → per-user quota rules (`null` = back to the site default).
    #[serde(default, deserialize_with = "deserialize_some")]
    quotas: Option<Option<Vec<crate::quota::Rule>>>,
}

/// Distinguish an absent field (None) from an explicit null (Some(None)).
fn deserialize_some<'de, T, D>(d: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    T::deserialize(d).map(Some)
}

async fn update_user(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(actor)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<UpdateUser>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&actor)?;
    let Some(target) = state.db.get_user(&id) else {
        return Err(err(StatusCode::NOT_FOUND, "user not found"));
    };
    if let Some(role) = &body.role {
        if target.role == "owner" {
            return Err(err(StatusCode::BAD_REQUEST, "the owner's role is fixed"));
        }
        if !matches!(role.as_str(), "admin" | "user") {
            return Err(err(StatusCode::BAD_REQUEST, "role must be 'admin' or 'user'"));
        }
        state.db.update_user_role(&id, role);
    }
    if let Some(quotas) = &body.quotas {
        if target.role == "owner" && actor.id != target.id {
            return Err(err(StatusCode::FORBIDDEN, "only the owner can change the owner's quotas"));
        }
        if let Some(rules) = quotas {
            crate::quota::validate_rules(rules).map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
        }
        let json = quotas.as_ref().map(|r| serde_json::to_string(r).unwrap());
        state.db.set_user_quotas(&id, json.as_deref());
    }
    let tree = crate::groups::Tree::load(&state.db);
    Ok(Json(admin_user_json(&state, &tree, &state.db.get_user(&id).unwrap_or(target))))
}

async fn delete_user(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(actor)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    auth::require_admin(&actor)?;
    let Some(target) = state.db.get_user(&id) else {
        return Err(err(StatusCode::NOT_FOUND, "user not found"));
    };
    if target.role == "owner" {
        return Err(err(StatusCode::FORBIDDEN, "the owner cannot be deleted"));
    }
    if target.id == actor.id {
        return Err(err(StatusCode::BAD_REQUEST, "you cannot delete yourself"));
    }
    state.db.delete_user(&id);
    Ok(StatusCode::NO_CONTENT)
}

// ---- routers ---------------------------------------------------------------------------

/// No authentication required.
pub fn public_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/setup/start", post(setup_start))
        .route("/api/auth/setup/finish", post(setup_finish))
        .route("/api/auth/login/start", post(login_start))
        .route("/api/auth/login/finish", post(login_finish))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/invite/{token}", get(invite_info))
        .route("/api/auth/invite/{token}/start", post(invite_start))
        .route("/api/auth/invite/{token}/finish", post(invite_finish))
        .route("/api/auth/recover/start", post(recover_start))
        .route("/api/auth/recover/finish", post(recover_finish))
}

/// Behind `auth::require_auth`.
pub fn protected_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/me", get(me))
        .route("/api/me/passkeys", get(list_my_passkeys))
        .route("/api/me/passkeys/start", post(add_passkey_start))
        .route("/api/me/passkeys/finish", post(add_passkey_finish))
        .route("/api/me/passkeys/{id}", axum::routing::put(rename_passkey).delete(delete_passkey))
        .route("/api/me/recovery-code", post(regenerate_recovery_code))
        .route("/api/me/api-keys", get(list_my_api_keys).post(create_my_api_key))
        .route("/api/me/api-keys/{id}", delete(delete_my_api_key))
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{id}", axum::routing::put(update_user).delete(delete_user))
        .route("/api/users/{id}/invite", post(reissue_invite))
}
