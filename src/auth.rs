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
//! - Kinds: `full` accounts sign in with passkeys; `guest` accounts (created
//!   through a group's join flow when the group allows it, src/join_api.rs)
//!   have no credential: a long-lived session plus one-time sign-in codes
//!   (stored like recovery codes). Guests can't create API keys, change
//!   printers or profiles, or create groups; adding a passkey (or recovering
//!   with the code) makes them full accounts.
//! - WebAuthn relying party: `FARMSLICER_ORIGINS` (comma-separated, first one
//!   is canonical; its host is the RP ID, which must never change once users
//!   have enrolled). Default for development: `http://localhost:9337` and the
//!   Vite dev server on `http://localhost:5173`.
//! - `FARMSLICER_NO_AUTH=1` disables all of it for local development.
//! - Remote access: with `FARMSLICER_LAN_HEADER` set, a request is from the
//!   local network only if the reverse proxy set that header to `1`;
//!   anything else is from the internet. From the internet only accounts
//!   approved for it (`users.remote_access`, full accounts) get in, only
//!   with a session made by a passkey ceremony, and only passkey sign-in and
//!   those accounts' invite links are open: no setup, recovery codes, join
//!   flow, guest codes or API keys (`remote_gate`, `authenticate`).

use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
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
/// Ceremonies can be started without signing in (from the internet too), so
/// the store is bounded: past this, the oldest flows make way.
const MAX_FLOWS: usize = 10_000;

/// How a session was made (`sessions.method`). Only `VIA_PASSKEY` sessions
/// count from the internet.
pub const VIA_PASSKEY: &str = "passkey";
pub const VIA_RECOVERY: &str = "recovery";
pub const VIA_CODE: &str = "code";

pub const NOT_APPROVED_REMOTE: &str =
    "this account isn't approved for access from outside the local network; ask an admin";

/// The authenticated user, attached to the request by `require_auth`.
#[derive(Clone, Debug)]
pub struct CurrentUser(pub User);

/// What the request's integration key may reach (src/integration.rs); None
/// for sessions and unscoped keys. Every authenticated request carries one.
#[derive(Clone, Debug)]
pub struct KeyScope(pub Option<crate::integration::Scope>);

pub fn auth_disabled() -> bool {
    std::env::var_os("FARMSLICER_NO_AUTH").is_some()
}

/// First-run setup is offered when there are no accounts, and also when the
/// accounts that exist can never sign in (no passkey, no live invite, no
/// unused recovery code): an installation nobody can enter is not set up.
/// Setup then replaces those unreachable accounts.
pub fn setup_required(db: &crate::db::Db) -> bool {
    !auth_disabled() && (db.user_count() == 0 || db.no_way_in())
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
    /// A new account created through a group's join flow.
    Join {
        user_id: String,
        username: String,
        request: Box<crate::join_api::JoinRequest>,
    },
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
        while flows.len() >= MAX_FLOWS {
            let Some(oldest) = flows.iter().min_by_key(|(_, (t, _))| *t).map(|(k, _)| k.clone()) else {
                break;
            };
            flows.remove(&oldest);
        }
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

// ---- where a request comes from --------------------------------------------------

/// `FARMSLICER_LAN_HEADER`: the header the reverse proxy sets to `1` on
/// requests from the local network (and strips from everyone else's).
/// Unset: there is no internet path and every request is local.
fn lan_header() -> Option<&'static HeaderName> {
    static NAME: OnceLock<Option<HeaderName>> = OnceLock::new();
    NAME.get_or_init(|| {
        let raw = std::env::var("FARMSLICER_LAN_HEADER").ok()?;
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        match HeaderName::from_bytes(raw.as_bytes()) {
            Ok(name) => Some(name),
            Err(_) => panic!("FARMSLICER_LAN_HEADER: {raw:?} is not a valid header name"),
        }
    })
    .as_ref()
}

/// Startup check (panics on an invalid name) and a line for the log.
pub fn describe_network() -> String {
    match lan_header() {
        Some(name) => format!(
            "remote access: requests without `{name}: 1` count as from the internet (approved accounts, passkeys only)"
        ),
        None => "remote access: off (FARMSLICER_LAN_HEADER unset; every request counts as local)".to_string(),
    }
}

/// From the internet rather than the local network. Fails closed: once the
/// header is configured, only an exact `1` makes a request local.
pub fn is_remote(headers: &HeaderMap) -> bool {
    match lan_header() {
        None => false,
        Some(name) => headers.get(name).map(|v| v.as_bytes()) != Some(b"1".as_slice()),
    }
}

/// Where a request came from, for the log (the proxy's X-Forwarded-For).
pub fn client_addr(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown address")
        .to_string()
}

/// Public routes that answer requests from the internet; the rest of the
/// public API (setup, recovery, join flow, guest codes) is local-only.
fn open_to_remote(path: &str) -> bool {
    matches!(
        path,
        "/api/health" | "/api/auth/status" | "/api/auth/login/start" | "/api/auth/login/finish" | "/api/auth/logout"
    ) || path.starts_with("/api/auth/invite/")
}

/// Middleware for the public (unauthenticated) routes.
pub async fn remote_gate(req: Request, next: Next) -> Response {
    if is_remote(req.headers()) && !open_to_remote(req.uri().path()) {
        return remote_refusal("only available on the local network");
    }
    next.run(req).await
}

pub fn remote_refusal(msg: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        axum::Json(serde_json::json!({"error": msg, "remote_denied": true})),
    )
        .into_response()
}

/// May this account use a session made by `method` from the internet?
pub fn remote_allowed(user: &User, method: Option<&str>) -> Result<(), &'static str> {
    if !user.remote_access || user.kind != "full" {
        Err(NOT_APPROVED_REMOTE)
    } else if method != Some(VIA_PASSKEY) {
        Err("sign in with your passkey to use FarmSlicer from outside the local network")
    } else {
        Ok(())
    }
}

// ---- sessions -----------------------------------------------------------------

/// Session cookies are `Secure` when the canonical origin is https.
fn cookie_attrs() -> &'static str {
    static ATTRS: OnceLock<&'static str> = OnceLock::new();
    ATTRS.get_or_init(|| {
        let https = configured_origins().first().is_some_and(|o| o.scheme() == "https");
        if https {
            "Path=/; HttpOnly; Secure; SameSite=Strict"
        } else {
            "Path=/; HttpOnly; SameSite=Strict"
        }
    })
}

pub fn session_cookie(token: &str, days: i64) -> String {
    format!("{SESSION_COOKIE}={token}; {}; Max-Age={}", cookie_attrs(), days * 86400)
}

pub fn clear_session_cookie() -> String {
    format!("{SESSION_COOKIE}=; {}; Max-Age=0", cookie_attrs())
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

/// Why a request has no user.
pub enum Refusal {
    /// No valid session or API key.
    Unauthenticated,
    /// Valid credentials, but not usable from the internet.
    Remote(&'static str),
}

/// Who is making this request: session cookie first, then API key. From the
/// internet, only a passkey session of an approved account counts.
pub fn authenticate(state: &AppState, req: &Request) -> Result<User, Refusal> {
    let remote = is_remote(req.headers());
    if auth_disabled() {
        return if remote {
            Err(Refusal::Remote("authentication is disabled, so only the local network gets in"))
        } else {
            Ok(dev_user())
        };
    }
    if let Some(token) = session_token_from_request(req) {
        if let Some((user, method)) = state.db.session_user(&sha256_hex(&token)) {
            if remote {
                remote_allowed(&user, method.as_deref()).map_err(Refusal::Remote)?;
            }
            return Ok(user);
        }
    }
    if let Some(key) = bearer_from_request(req) {
        // From the internet only integration keys an admin let out, and
        // only to their scoped routes (integration::allows).
        if remote && !state.db.api_key_remote(&sha256_hex(&key)) {
            return Err(Refusal::Remote("API keys only work on the local network (an admin can let an integration key in from outside)"));
        }
        if let Some(user) = state.db.api_key_user(&sha256_hex(&key)) {
            return Ok(user);
        }
    }
    Err(Refusal::Unauthenticated)
}

pub fn resolve_user(state: &AppState, req: &Request) -> Option<User> {
    authenticate(state, req).ok()
}

fn dev_user() -> User {
    User {
        id: "dev".to_string(),
        username: "dev".to_string(),
        role: "owner".to_string(),
        created_at: String::new(),
        last_login: None,
        kind: "full".to_string(),
        quotas: None,
        remote_access: false,
    }
}

/// Middleware for everything under /api except the public auth routes.
pub async fn require_auth(
    State(state): State<Arc<AppState>>,
    mut req: Request,
    next: Next,
) -> Response {
    match authenticate(&state, &req) {
        Ok(user) => {
            let scope = request_scope(&state, &req);
            if let Some(s) = &scope {
                let path = req.uri().path().to_string();
                if let Err(e) = crate::integration::allows(s, req.method(), &path)
                    .and_then(|()| crate::integration::check_data(&state, s, &path))
                {
                    let code = if e.ends_with("not found") { StatusCode::NOT_FOUND } else { StatusCode::FORBIDDEN };
                    return (code, axum::Json(serde_json::json!({"error": e}))).into_response();
                }
            }
            req.extensions_mut().insert(KeyScope(scope));
            req.extensions_mut().insert(CurrentUser(user));
            next.run(req).await
        }
        Err(Refusal::Remote(msg)) => remote_refusal(msg),
        Err(Refusal::Unauthenticated) => {
            let body = if setup_required(&state.db) {
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

/// The scope of the integration key that authenticated `req`, if one did
/// (a session cookie wins over a key, as in [`authenticate`]). A scope that
/// can't be read allows nothing.
fn request_scope(state: &AppState, req: &Request) -> Option<crate::integration::Scope> {
    if auth_disabled() {
        return None;
    }
    if session_token_from_request(req).is_some_and(|t| state.db.session_user(&sha256_hex(&t)).is_some()) {
        return None;
    }
    let text = state.db.api_key_scope(&sha256_hex(&bearer_from_request(req)?))?;
    Some(serde_json::from_str(&text).unwrap_or(crate::integration::Scope {
        group_id: Some(String::new()),
        client_ref: None,
        permissions: Vec::new(),
    }))
}

/// Guests (credential-less accounts) are refused.
pub fn require_full(user: &User) -> Result<(), (StatusCode, axum::Json<serde_json::Value>)> {
    if user.kind == "guest" {
        Err((
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({"error": "guest accounts can't do that; add a passkey on your Account page"})),
        ))
    } else {
        Ok(())
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
