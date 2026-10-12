//! Accounts, sessions and API keys.
//!
//! - Passwords: argon2id (random salt, default params), stored as PHC strings.
//! - Sessions: random 256-bit token in the `fs_session` cookie; the database
//!   keeps only its SHA-256 so a leaked database does not leak logins.
//! - API keys: `fsk_` + 256 random bits, shown once at creation; the database
//!   keeps the SHA-256 and a short prefix for display. Sent as
//!   `Authorization: Bearer fsk_...`.
//! - Roles: `owner` (the first account, created on first run), `admin`
//!   (manage users, printers, everything), `user` (slice, view, manage own
//!   keys). Admins cannot modify the owner.
//!
//! `FARMSLICER_NO_AUTH=1` disables all of it for local development: every
//! request runs as a synthetic owner.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng};
use argon2::Argon2;
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::db::User;
use crate::server::AppState;

pub const SESSION_COOKIE: &str = "fs_session";
pub const SESSION_DAYS: i64 = 30;
pub const API_KEY_PREFIX: &str = "fsk_";

/// The authenticated user, attached to the request by `require_auth`.
#[derive(Clone, Debug)]
pub struct CurrentUser(pub User);

pub fn auth_disabled() -> bool {
    std::env::var_os("FARMSLICER_NO_AUTH").is_some()
}

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

pub fn verify_password(hash: &str, password: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// 256 random bits as lowercase hex.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn sha256_hex(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}

pub fn is_admin(user: &User) -> bool {
    matches!(user.role.as_str(), "owner" | "admin")
}

pub fn valid_username(name: &str) -> bool {
    let n = name.trim();
    (2..=32).contains(&n.len())
        && n
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn valid_password(password: &str) -> Result<(), &'static str> {
    if password.len() < 8 {
        return Err("password must be at least 8 characters");
    }
    if password.len() > 256 {
        return Err("password is too long");
    }
    Ok(())
}

pub fn session_cookie(token: &str) -> String {
    format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}",
        SESSION_DAYS * 86400
    )
}

pub fn clear_session_cookie() -> String {
    format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
}

pub fn session_token_from_request(req: &Request) -> Option<String> {
    let cookie_header = req.headers().get(header::COOKIE)?.to_str().ok()?;
    cookie_header.split(';').find_map(|part| {
        part.trim()
            .strip_prefix(&format!("{SESSION_COOKIE}="))
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    })
}

fn bearer_from_request(req: &Request) -> Option<String> {
    let value = req.headers().get(header::AUTHORIZATION)?.to_str().ok()?;
    value
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|v| v.starts_with(API_KEY_PREFIX))
        .map(str::to_string)
}

/// Who is making this request, if anyone: session cookie first, then API key.
pub fn resolve_user(state: &AppState, req: &Request) -> Option<User> {
    if auth_disabled() {
        return Some(dev_user());
    }
    if let Some(token) = session_token_from_request(req) {
        if let Some(user) = state.db.session_user(&sha256_hex(&token)) {
            return Some(user);
        }
    }
    if let Some(key) = bearer_from_request(req) {
        if let Some(user) = state.db.api_key_user(&sha256_hex(&key)) {
            return Some(user);
        }
    }
    None
}

fn dev_user() -> User {
    User {
        id: "dev".to_string(),
        username: "dev".to_string(),
        role: "owner".to_string(),
        created_at: String::new(),
        last_login: None,
    }
}

/// Middleware for everything under /api except the public auth routes.
pub async fn require_auth(
    State(state): State<Arc<AppState>>,
    mut req: Request,
    next: Next,
) -> Response {
    match resolve_user(&state, &req) {
        Some(user) => {
            req.extensions_mut().insert(CurrentUser(user));
            next.run(req).await
        }
        None => {
            let body = if state.db.user_count() == 0 {
                r#"{"error":"setup required","setup_required":true}"#
            } else {
                r#"{"error":"authentication required"}"#
            };
            (
                StatusCode::UNAUTHORIZED,
                [(header::CONTENT_TYPE, "application/json")],
                body,
            )
                .into_response()
        }
    }
}

pub fn require_admin(user: &User) -> Result<(), (StatusCode, axum::Json<serde_json::Value>)> {
    if is_admin(user) {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({"error": "admin role required"})),
        ))
    }
}
