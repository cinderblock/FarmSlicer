//! Signed-in devices and credentials (`plans/organization-and-access.md`,
//! slice 6): everyone sees their own sessions and signs devices out (one,
//! or all but this one); holders of `users.manage` see a person's
//! sessions, passkeys and API keys and revoke them, within the usual rank
//! rule (only accounts with no permission they lack; the owner only by
//! the owner). Storage in src/db/sessions.rs.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{delete, get, post},
    Extension, Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::audit;
use crate::auth::{self, CurrentUser};
use crate::db::{SessionInfo, User};
use crate::permissions::{self, Cap};
use crate::server::AppState;

type ApiError = (StatusCode, Json<Value>);

fn err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

/// The hash of the session cookie this request came with.
fn current_hash(headers: &HeaderMap) -> Option<String> {
    let cookie = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    cookie.split(';').find_map(|part| {
        part.trim()
            .strip_prefix(&format!("{}=", auth::SESSION_COOKIE))
            .filter(|v| !v.is_empty())
            .map(auth::sha256_hex)
    })
}

/// "Firefox on Windows" from a User-Agent, else the raw string.
pub fn device_name(ua: &str) -> String {
    let browser = if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("OPR/") {
        "Opera"
    } else if ua.contains("Firefox/") {
        "Firefox"
    } else if ua.contains("Chrome/") {
        "Chrome"
    } else if ua.contains("Safari/") {
        "Safari"
    } else if ua.contains("node") || ua.contains("undici") {
        "a script"
    } else {
        return ua.chars().take(60).collect();
    };
    let os = if ua.contains("iPhone") || ua.contains("iPad") {
        Some("iOS")
    } else if ua.contains("Android") {
        Some("Android")
    } else if ua.contains("Windows") {
        Some("Windows")
    } else if ua.contains("Mac OS") {
        Some("macOS")
    } else if ua.contains("Linux") {
        Some("Linux")
    } else {
        None
    };
    match os {
        Some(os) => format!("{browser} on {os}"),
        None => browser.to_string(),
    }
}

fn session_json(s: &SessionInfo, current: Option<&str>) -> Value {
    let mut v = json!(s);
    v["device"] = json!(s.user_agent.as_deref().map(device_name));
    v["current"] = json!(current == Some(s.token_hash.as_str()));
    v
}

/// `GET /api/me/sessions`
async fn my_sessions(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    headers: HeaderMap,
) -> Json<Value> {
    let current = current_hash(&headers);
    Json(json!(state.db.list_sessions(&user.id).iter().map(|s| session_json(s, current.as_deref())).collect::<Vec<_>>()))
}

/// `DELETE /api/me/sessions/{id}`: sign a device out.
async fn end_my_session(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if state.db.end_session(&user.id, &id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(err(StatusCode::NOT_FOUND, "no such session"))
    }
}

/// `POST /api/me/sessions/sign-out-others`: every device but this one.
async fn end_my_others(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    headers: HeaderMap,
) -> Json<Value> {
    let ended = state.db.end_sessions(&user.id, current_hash(&headers).as_deref());
    Json(json!({"ended": ended}))
}

/// The account the actor may manage (404 when there's none, 403 by rank).
fn target(state: &AppState, actor: &User, id: &str) -> Result<User, ApiError> {
    auth::require(actor, Cap::UsersManage)?;
    let t = state.db.get_user(id).ok_or_else(|| err(StatusCode::NOT_FOUND, "user not found"))?;
    if !permissions::outranks(&state.db, &actor.role, actor.caps, &t.role) {
        return Err(err(StatusCode::FORBIDDEN, "that account has permissions you don't have"));
    }
    Ok(t)
}

/// `GET /api/users/{id}/access`: a person's sessions, passkeys and API keys.
async fn user_access(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(actor)): Extension<CurrentUser>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let t = target(&state, &actor, &id)?;
    let current = current_hash(&headers);
    Ok(Json(json!({
        "sessions": state.db.list_sessions(&t.id).iter().map(|s| session_json(s, current.as_deref())).collect::<Vec<_>>(),
        "passkeys": state.db.list_passkeys(&t.id).iter().map(|k| json!({"id": k.id, "name": k.name, "created_at": k.created_at, "last_used": k.last_used})).collect::<Vec<_>>(),
        "api_keys": state.db.list_api_keys(&t.id).iter().map(|k| json!({"id": k.id, "name": k.name, "prefix": k.prefix, "created_at": k.created_at, "last_used": k.last_used, "integration": k.scope.is_some()})).collect::<Vec<_>>(),
    })))
}

/// `DELETE /api/users/{id}/sessions`: sign them out everywhere.
async fn end_user_sessions(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(actor)): Extension<CurrentUser>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let t = target(&state, &actor, &id)?;
    // Your own: keep the session you're using.
    let keep = if t.id == actor.id { current_hash(&headers) } else { None };
    let ended = state.db.end_sessions(&t.id, keep.as_deref());
    audit::record(&state.db, &actor, "user.sessions.end", audit::user(&t), json!({"ended": ended}));
    Ok(Json(json!({"ended": ended})))
}

/// `DELETE /api/users/{id}/sessions/{sid}`: sign one device out.
async fn end_user_session(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(actor)): Extension<CurrentUser>,
    Path((id, sid)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let t = target(&state, &actor, &id)?;
    if !state.db.end_session(&t.id, &sid) {
        return Err(err(StatusCode::NOT_FOUND, "no such session"));
    }
    audit::record(&state.db, &actor, "user.sessions.end", audit::user(&t), json!({"ended": 1}));
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/users/{id}/passkeys/{pid}`: e.g. a lost phone.
async fn delete_user_passkey(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(actor)): Extension<CurrentUser>,
    Path((id, pid)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let t = target(&state, &actor, &id)?;
    if t.id == actor.id && state.db.passkey_count(&t.id) <= 1 {
        return Err(err(StatusCode::BAD_REQUEST, "you cannot remove your only passkey; add another first"));
    }
    let name = state.db.list_passkeys(&t.id).into_iter().find(|k| k.id == pid).map(|k| k.name);
    if !state.db.delete_passkey_of(&t.id, &pid) {
        return Err(err(StatusCode::NOT_FOUND, "no such passkey"));
    }
    audit::record(&state.db, &actor, "user.passkey.delete", audit::user(&t), json!({"passkey": name}));
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/users/{id}/api-keys/{kid}`
async fn delete_user_api_key(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(actor)): Extension<CurrentUser>,
    Path((id, kid)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let t = target(&state, &actor, &id)?;
    let name = state.db.list_api_keys(&t.id).into_iter().find(|k| k.id == kid).map(|k| k.name);
    if !state.db.delete_api_key(&kid, &t.id) {
        return Err(err(StatusCode::NOT_FOUND, "no such API key"));
    }
    audit::record(&state.db, &actor, "user.api_key.delete", audit::user(&t), json!({"key": name}));
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/me/sessions", get(my_sessions))
        .route("/api/me/sessions/sign-out-others", post(end_my_others))
        .route("/api/me/sessions/{id}", delete(end_my_session))
        .route("/api/users/{id}/access", get(user_access))
        .route("/api/users/{id}/sessions", delete(end_user_sessions))
        .route("/api/users/{id}/sessions/{sid}", delete(end_user_session))
        .route("/api/users/{id}/passkeys/{pid}", delete(delete_user_passkey))
        .route("/api/users/{id}/api-keys/{kid}", delete(delete_user_api_key))
}

#[cfg(test)]
mod tests {
    use super::device_name;

    #[test]
    fn devices() {
        assert_eq!(device_name("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0"), "Firefox on Windows");
        assert_eq!(
            device_name("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"),
            "Safari on iOS"
        );
        assert_eq!(
            device_name("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"),
            "Edge on Windows"
        );
        assert_eq!(device_name("curl/8.5"), "curl/8.5");
    }
}
