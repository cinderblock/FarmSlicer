//! Webhooks: what happened, POSTed to software that wants to know (a shop's
//! order system, a fulfillment tool, a chat bot). Admins add them
//! (`/api/integrations/webhooks`): a URL, the events (or `*`), optionally
//! one group's events only, and a secret FarmSlicer makes.
//!
//! Each delivery is `{"id", "event", "created_at", "data"}` as JSON, with
//! headers `X-FarmSlicer-Event`, `X-FarmSlicer-Delivery`,
//! `X-FarmSlicer-Timestamp` (Unix seconds) and `X-FarmSlicer-Signature:
//! sha256=<hex>`, the HMAC-SHA256 of `"<timestamp>.<body>"` with the secret
//! (check it, and refuse old timestamps, to know a delivery is genuine and
//! fresh). Anything but a 2xx is retried after 1 min, 5 min, 30 min, 2 h and
//! 12 h, then given up; every delivery is logged and can be retried by hand.
//! HTTPS certificates are checked against the public roots (unlike the
//! printers' self-signed ones); redirects aren't followed.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Notify;

use crate::auth::{self, CurrentUser};
use crate::server::AppState;

pub const EVENTS: &[&str] = &[
    "print.started",
    "print.finished",
    "print.failed",
    "print.approval_requested",
    "print.outcome",
    "item.completed",
    "project.printed",
    "project.status",
    "ping",
];

/// Seconds to wait after the nth failed attempt; one more failure after the
/// last and the delivery is given up.
const RETRY_AFTER: &[i64] = &[60, 300, 1800, 7200, 43200];

const TIMEOUT: Duration = Duration::from_secs(15);

/// HMAC-SHA256 (RFC 2104).
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let pad = |byte: u8| k.iter().map(|b| b ^ byte).collect::<Vec<u8>>();
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(message).finalize();
    Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize().into()
}

/// The signature header's value for a body sent at `timestamp`.
pub fn signature(secret: &str, timestamp: i64, body: &str) -> String {
    format!("sha256={}", hex::encode(hmac_sha256(secret.as_bytes(), format!("{timestamp}.{body}").as_bytes())))
}

fn wake() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

/// Queue `event` for every webhook that wants it (`group`: whose event it
/// is, for webhooks limited to one group).
pub fn enqueue(state: &AppState, event: &str, group: Option<&str>, data: &Value) {
    let hooks: Vec<_> = state
        .db
        .list_webhooks()
        .into_iter()
        .filter(|h| h.enabled)
        .filter(|h| h.group_id.is_none() || h.group_id.as_deref() == group)
        .filter(|h| {
            let events: Vec<String> = serde_json::from_str(&h.events).unwrap_or_default();
            events.iter().any(|e| e == "*" || e == event)
        })
        .collect();
    for h in hooks {
        enqueue_for(state, &h.id, event, data);
    }
}

fn enqueue_for(state: &AppState, webhook_id: &str, event: &str, data: &Value) {
    let id = uuid::Uuid::new_v4().to_string();
    let payload = json!({
        "id": id,
        "event": event,
        "created_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "data": data,
    });
    state.db.add_delivery(&id, webhook_id, event, &payload.to_string());
    wake().notify_one();
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| internet_client(concat!("FarmSlicer-Webhooks/", env!("CARGO_PKG_VERSION"))))
}

/// A client for the internet (webhooks, push services): Mozilla's roots, no
/// redirects, short timeouts.
pub(crate) fn internet_client(user_agent: &'static str) -> reqwest::Client {
    use tokio_rustls::rustls;
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("the ring provider supports TLS 1.2 and 1.3")
        .with_root_certificates(roots)
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(TIMEOUT)
        .user_agent(user_agent)
        .build()
        .expect("the internet client builds")
}

async fn deliver(state: &AppState, d: &crate::db::Delivery) {
    let Some(hook) = state.db.get_webhook(&d.webhook_id) else { return };
    let timestamp = chrono::Utc::now().timestamp();
    let result = client()
        .post(&hook.url)
        .header("content-type", "application/json")
        .header("x-farmslicer-event", &d.event)
        .header("x-farmslicer-delivery", &d.id)
        .header("x-farmslicer-timestamp", timestamp.to_string())
        .header("x-farmslicer-signature", signature(&hook.secret, timestamp, &d.payload))
        .body(d.payload.clone())
        .send()
        .await;
    let (ok, status, error) = match result {
        Ok(r) if r.status().is_success() => (true, Some(r.status().as_u16() as i64), None),
        Ok(r) => (false, Some(r.status().as_u16() as i64), Some(format!("HTTP {}", r.status()))),
        Err(e) => (false, None, Some(format!("{e}"))),
    };
    if ok {
        state.db.delivery_attempted(&d.id, "delivered", status, None, 0);
        return;
    }
    let attempt = d.attempts as usize; // attempts before this one
    match RETRY_AFTER.get(attempt) {
        Some(wait) => state.db.delivery_attempted(&d.id, "pending", status, error.as_deref(), *wait),
        None => {
            eprintln!("Webhook {}: giving up on delivery {} ({})", hook.id, d.id, error.as_deref().unwrap_or(""));
            state.db.delivery_attempted(&d.id, "failed", status, error.as_deref(), 0);
        }
    }
}

/// Deliver whatever is due, whenever something is queued and every 30 s.
pub async fn run(state: Arc<AppState>) {
    loop {
        for d in state.db.due_deliveries(50) {
            deliver(&state, &d).await;
        }
        tokio::select! {
            _ = wake().notified() => {}
            _ = tokio::time::sleep(Duration::from_secs(30)) => {}
        }
    }
}

// -- API -----------------------------------------------------------------------------

type ApiError = (StatusCode, Json<Value>);

fn api_err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

fn hook_json(state: &AppState, h: &crate::db::Webhook) -> Value {
    let (pending, failed) = state.db.delivery_counts(&h.id);
    let mut v = json!(h);
    v["events"] = serde_json::from_str(&h.events).unwrap_or(json!([]));
    v["pending"] = json!(pending);
    v["failed"] = json!(failed);
    v
}

fn check_url(url: &str) -> Result<String, ApiError> {
    let u = url.trim();
    let parsed = url::Url::parse(u).map_err(|_| api_err(StatusCode::BAD_REQUEST, "url: not a URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() || u.len() > 2000 {
        return Err(api_err(StatusCode::BAD_REQUEST, "url: an http:// or https:// address"));
    }
    Ok(u.to_string())
}

fn check_events(events: &[String]) -> Result<String, ApiError> {
    if events.is_empty() || events.iter().any(|e| e != "*" && !EVENTS.contains(&e.as_str())) {
        return Err(api_err(StatusCode::BAD_REQUEST, format!("events: \"*\" or some of {}", EVENTS.join(", "))));
    }
    Ok(serde_json::to_string(events).unwrap())
}

fn new_secret() -> String {
    format!("whsec_{}", auth::random_token())
}

async fn list_hooks(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&user)?;
    let hooks: Vec<Value> = state.db.list_webhooks().iter().map(|h| hook_json(&state, h)).collect();
    Ok(Json(json!({ "webhooks": hooks, "events": EVENTS })))
}

#[derive(Deserialize)]
struct HookBody {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    events: Option<Vec<String>>,
    #[serde(default)]
    group_id: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    /// PATCH: make a new secret (returned once).
    #[serde(default)]
    rotate_secret: bool,
}

/// `POST /api/integrations/webhooks` (admins): returns the secret once.
async fn create_hook(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<HookBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    auth::require_admin(&user)?;
    let url = check_url(body.url.as_deref().unwrap_or(""))?;
    let events = check_events(&body.events.unwrap_or_else(|| vec!["*".into()]))?;
    let group = body.group_id.filter(|g| !g.is_empty());
    if group.as_deref().is_some_and(|g| state.db.get_group(g).is_none()) {
        return Err(api_err(StatusCode::BAD_REQUEST, "no such group"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let secret = new_secret();
    let description = body.description.unwrap_or_default().trim().chars().take(500).collect::<String>();
    state
        .db
        .save_webhook(&id, &url, &secret, &events, group.as_deref(), &description, body.enabled.unwrap_or(true), Some(&user.id));
    println!("Webhook {id}: {} adds {url}", user.username);
    let mut v = hook_json(&state, &state.db.get_webhook(&id).expect("webhook just saved"));
    v["secret"] = json!(secret);
    Ok((StatusCode::CREATED, Json(v)))
}

async fn update_hook(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<HookBody>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&user)?;
    let h = state.db.get_webhook(&id).ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such webhook"))?;
    let url = match &body.url {
        Some(u) => check_url(u)?,
        None => h.url.clone(),
    };
    let events = match &body.events {
        Some(e) => check_events(e)?,
        None => h.events.clone(),
    };
    let group = match &body.group_id {
        Some(g) if g.is_empty() => None,
        Some(g) if state.db.get_group(g).is_none() => return Err(api_err(StatusCode::BAD_REQUEST, "no such group")),
        Some(g) => Some(g.clone()),
        None => h.group_id.clone(),
    };
    let secret = if body.rotate_secret { new_secret() } else { h.secret.clone() };
    let description = body.description.map(|d| d.trim().chars().take(500).collect::<String>()).unwrap_or(h.description.clone());
    state.db.save_webhook(&id, &url, &secret, &events, group.as_deref(), &description, body.enabled.unwrap_or(h.enabled), h.created_by.as_deref());
    let mut v = hook_json(&state, &state.db.get_webhook(&id).expect("webhook exists"));
    if body.rotate_secret {
        v["secret"] = json!(secret);
    }
    Ok(Json(v))
}

async fn delete_hook(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    auth::require_admin(&user)?;
    if !state.db.delete_webhook(&id) {
        return Err(api_err(StatusCode::NOT_FOUND, "no such webhook"));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct LimitQuery {
    limit: Option<i64>,
}

/// `GET /api/integrations/webhooks/{id}/deliveries`: newest first.
async fn list_deliveries(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Query(q): Query<LimitQuery>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&user)?;
    state.db.get_webhook(&id).ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such webhook"))?;
    Ok(Json(json!(state.db.webhook_deliveries(&id, q.limit.unwrap_or(50).clamp(1, 500)))))
}

/// `POST /api/integrations/webhooks/{id}/test`: a `ping` to see it works.
async fn test_hook(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    auth::require_admin(&user)?;
    state.db.get_webhook(&id).ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such webhook"))?;
    enqueue_for(&state, &id, "ping", &json!({"message": format!("{} is testing this webhook", user.username)}));
    Ok((StatusCode::ACCEPTED, Json(json!({"ok": true}))))
}

async fn retry_delivery(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&user)?;
    if !state.db.retry_delivery(&id) {
        return Err(api_err(StatusCode::NOT_FOUND, "no such delivery"));
    }
    wake().notify_one();
    Ok(Json(json!(state.db.get_delivery(&id))))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/integrations/webhooks", get(list_hooks).post(create_hook))
        .route("/api/integrations/webhooks/{id}", axum::routing::patch(update_hook).delete(delete_hook))
        .route("/api/integrations/webhooks/{id}/deliveries", get(list_deliveries))
        .route("/api/integrations/webhooks/{id}/test", post(test_hook))
        .route("/api/integrations/deliveries/{id}/retry", post(retry_delivery))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc_4231() {
        // Test case 2.
        assert_eq!(
            hex::encode(hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // Test case 6: a key longer than a block.
        assert_eq!(
            hex::encode(hmac_sha256(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First")),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn signatures_cover_the_timestamp() {
        let a = signature("whsec_x", 1700000000, "{}");
        assert!(a.starts_with("sha256=") && a.len() == 7 + 64);
        assert_ne!(a, signature("whsec_x", 1700000001, "{}"));
        assert_ne!(a, signature("whsec_y", 1700000000, "{}"));
    }
}
