//! Accounts, sessions, API keys and passkeys (WebAuthn). No passwords.
//!
//! - Sign-in is passkey-only. The first run registers the owner's passkey;
//!   further accounts are created by an admin as an invite link, and the
//!   invitee enrols their passkey through it. Each enrolment also hands out a
//!   one-time recovery code (stored hashed) for re-enrolling when every
//!   passkey is lost; admins can also re-issue an invite for an existing user.
//! - Sessions: random 256-bit token in the `fs_session` cookie; the database
//!   keeps only its SHA-256.
//! - API keys: `fsk_` + 256 random bits, shown once, stored as SHA-256, sent
//!   as `Authorization: Bearer fsk_...`.
//! - Roles: `owner` (first account), `admin`, `user`. Admins cannot modify
//!   the owner.
//! - WebAuthn relying party: `FARMSLICER_ORIGINS` (comma-separated, first one
//!   is canonical; its host is the RP ID, which must never change once users
//!   have enrolled). Default for development: `http://localhost:9337` and the
//!   Vite dev server on `http://localhost:5173`.
//! - `FARMSLICER_NO_AUTH=1` disables all of it for local development.

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use url::Url;
use webauthn_rs::prelude::*;

use crate::db::User;
use crate::server::AppState;

pub const SESSION_COOKIE: &str = "fs_session";
pub const SESSION_DAYS: i64 = 30;
pub const API_KEY_PREFIX: &str = "fsk_";
pub const INVITE_HOURS: i64 = 72;
const FLOW_TTL: Duration = Duration::from_secs(5 * 60);

/// The authenticated user, attached to the request by `require_auth`.
#[derive(Clone, Debug)]
pub struct CurrentUser(pub User);

pub fn auth_disabled() -> bool {
    std::env::var_os("FARMSLICER_NO_AUTH").is_some()
}

// ---- WebAuthn relying party -------------------------------------------------

pub struct Rp {
    pub webauthn: Webauthn,
    /// Canonical public origin, used to build invite links.
    pub origin: Url,
    pub rp_id: String,
    flows: Mutex<HashMap<String, (Instant, Flow)>>,
}

/// Server-side state between the start and finish of a ceremony.
pub enum Flow {
    Register {
        state: PasskeyRegistration,
        purpose: RegisterPurpose,
    },
    Login {
        state: PasskeyAuthentication,
        user_id: String,
    },
    Discoverable {
        state: DiscoverableAuthentication,
    },
}

#[derive(Clone, Debug)]
pub enum RegisterPurpose {
    /// First run: create the owner account with this username and id.
    Setup { user_id: String, username: String },
    /// Enrol through an invite (hash of the token).
    Invite { user_id: String, token_hash: String },
    /// Re-enrol with a recovery code (hash).
    Recovery { user_id: String, code_hash: String },
    /// A signed-in user adding another passkey.
    AddKey { user_id: String },
}

pub fn configured_origins() -> Vec<Url> {
    let raw = std::env::var("FARMSLICER_ORIGINS")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "http://localhost:9337,http://localhost:5173".to_string());
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|s| Url::parse(s).ok())
        .collect()
}

impl Rp {
    pub fn from_env() -> Result<Rp, String> {
        let origins = configured_origins();
        let origin = origins
            .first()
            .cloned()
            .ok_or("FARMSLICER_ORIGINS has no valid URL")?;
        let rp_id = origin
            .host_str()
            .ok_or("FARMSLICER_ORIGINS: first origin has no host")?
            .to_string();
        let mut builder = WebauthnBuilder::new(&rp_id, &origin)
            .map_err(|e| format!("webauthn config: {e}"))?
            .rp_name("FarmSlicer")
            // Extra origins (the Vite dev server) must share the RP ID's
            // host, which `localhost` does; any port is accepted.
            .allow_any_port(true);
        for extra in origins.iter().skip(1) {
            builder = builder.append_allowed_origin(extra);
        }
        let webauthn = builder.build().map_err(|e| format!("webauthn config: {e}"))?;
        Ok(Rp {
            webauthn,
            origin,
            rp_id,
            flows: Mutex::new(HashMap::new()),
        })
    }

    pub fn store_flow(&self, flow: Flow) -> String {
        let id = random_token();
        let mut flows = self.flows.lock().unwrap();
        flows.retain(|_, (t, _)| t.elapsed() < FLOW_TTL);
        flows.insert(id.clone(), (Instant::now(), flow));
        id
    }

    pub fn take_flow(&self, id: &str) -> Option<Flow> {
        let mut flows = self.flows.lock().unwrap();
        let (t, flow) = flows.remove(id)?;
        if t.elapsed() < FLOW_TTL { Some(flow) } else { None }
    }

    pub fn invite_url(&self, token: &str) -> String {
        format!("{}invite/{token}", self.origin)
    }
}

pub fn user_uuid(user_id: &str) -> Uuid {
    Uuid::parse_str(user_id).unwrap_or_else(|_| Uuid::new_v4())
}

pub fn cred_id_hex(id: &[u8]) -> String {
    hex::encode(id)
}

// ---- tokens -------------------------------------------------------------------

/// 256 random bits as lowercase hex.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Human-typable recovery code: 5 groups of 5 base32-ish characters.
pub fn recovery_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut bytes = [0u8; 25];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
        .chunks(5)
        .map(|chunk| {
            chunk
                .iter()
                .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("-")
}

/// Recovery codes are compared case-insensitively and ignoring separators.
pub fn normalize_recovery_code(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
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

// ---- sessions -----------------------------------------------------------------

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
