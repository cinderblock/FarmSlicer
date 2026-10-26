//! Notifications: Web Push to the devices people turned them on for, when a
//! print fails, finishes or waits for approval. The browser subscribes (its
//! service worker, `web/public/sw.js`) with this server's public key; a push
//! is encrypted for that browser alone (RFC 8291, `aes128gcm`) and signed
//! by this server (RFC 8292, VAPID), then POSTed to the browser's push
//! service, which wakes the device. Nothing to configure: the key pair is
//! made on first use and kept in the `settings` table (`vapid_key`).
//!
//! Who gets one: only accounts with a subscription, by how they relate to
//! the print (`Relation`) and what they asked for (`Prefs`, defaults in
//! [`default_prefs`]). Nobody hears about a print they just stopped
//! themselves. A push isn't retried: news of a failed print an hour late
//! is noise; the Prints page has it anyway.
//!
//! Push services are an allowlist ([`PUSH_SERVICES`], plus
//! `FARMSLICER_PUSH_SERVICES` origins for tests), so a subscription can't
//! make the server POST to anything else.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use openssl::bn::{BigNum, BigNumContext};
use openssl::derive::Deriver;
use openssl::ec::{EcGroup, EcKey, EcPoint, PointConversionForm};
use openssl::ecdsa::EcdsaSig;
use openssl::nid::Nid;
use openssl::pkey::{PKey, Private};
use openssl::symm::{Cipher, encrypt_aead};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::auth::CurrentUser;
use crate::db::{Db, PrintRecord, PushSubscription};
use crate::groups::{Tree, Viewer};
use crate::server::AppState;
use crate::webhooks::hmac_sha256;

/// What one can be told about, and how the Account page names it.
pub const EVENTS: &[(&str, &str)] = &[
    ("print.failed", "A print fails or is stopped"),
    ("print.finished", "A print finishes"),
    ("print.approval_requested", "A print is waiting for approval"),
];

/// How someone relates to a print.
pub const RELATIONS: &[(&str, &str)] = &[
    ("mine", "Prints I sent or sliced"),
    ("operated", "Printers I operate"),
    ("managed", "Groups I manage"),
    ("all", "Every print (admins)"),
];

/// Per event, the relations that notify (`EVENTS`, `RELATIONS` names).
pub type Prefs = BTreeMap<String, Vec<String>>;

pub fn default_prefs() -> Prefs {
    let of = |r: &[&str]| r.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    Prefs::from([
        ("print.failed".into(), of(&["mine", "operated"])),
        ("print.finished".into(), of(&[])),
        ("print.approval_requested".into(), of(&["managed", "all"])),
    ])
}

/// Someone's preferences: what they saved, the defaults for events they
/// never saved (an event added later starts at its default).
pub fn prefs_of(db: &Db, user_id: &str) -> Prefs {
    let mut prefs = default_prefs();
    if let Some(saved) = db.notify_prefs(user_id).and_then(|s| serde_json::from_str::<Prefs>(&s).ok()) {
        for (event, relations) in saved {
            if prefs.contains_key(&event) {
                prefs.insert(event, relations);
            }
        }
    }
    prefs
}

/// Does someone with `prefs`, related to a print as `relations`, want to
/// hear about `event`?
pub fn wants(prefs: &Prefs, event: &str, relations: &[&str]) -> bool {
    prefs.get(event).is_some_and(|wanted| wanted.iter().any(|w| relations.contains(&w.as_str())))
}

/// How `viewer` relates to `print` (`job_owner`: who made its job).
pub fn relations(db: &Db, tree: &Tree, viewer: &Viewer, print: &PrintRecord, job_owner: Option<&str>) -> Vec<&'static str> {
    let me = viewer.user.id.as_str();
    let mut r = Vec::new();
    if print.user_id.as_deref() == Some(me) || job_owner == Some(me) {
        r.push("mine");
    }
    if print.printer_id.as_ref().is_some_and(|p| db.operated_printers(me).contains(p)) {
        r.push("operated");
    }
    // As a manager, not as an admin (that's `all`).
    let member = Viewer { user: viewer.user.clone(), admin: false, memberships: viewer.memberships.clone() };
    if print.group_id.as_deref().is_some_and(|g| member.can_manage(tree, g)) {
        r.push("managed");
    }
    if viewer.admin {
        r.push("all");
    }
    r
}

// -- Who stopped what ----------------------------------------------------------------

/// Prints someone stopped from FarmSlicer lately, and who: they don't need
/// telling it stopped.
fn stopped() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static STOPPED: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    STOPPED.get_or_init(Default::default)
}

const STOPPED_FOR: Duration = Duration::from_secs(15 * 60);

/// `user_id` asked `print_id`'s printer to stop it.
pub fn stopped_by(print_id: &str, user_id: &str) {
    let mut s = stopped().lock().unwrap();
    s.retain(|_, (_, at)| at.elapsed() < STOPPED_FOR);
    s.insert(print_id.to_string(), (user_id.to_string(), Instant::now()));
}

fn who_stopped(print_id: &str) -> Option<String> {
    let s = stopped().lock().unwrap();
    s.get(print_id).filter(|(_, at)| at.elapsed() < STOPPED_FOR).map(|(u, _)| u.clone())
}

// -- What to say -----------------------------------------------------------------------

/// A notification as the service worker shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub title: String,
    pub body: String,
    /// The page a tap opens.
    pub url: String,
    /// Same tag = replaces the earlier notification (one per print).
    pub tag: String,
    /// Push service urgency (RFC 8030): `high` wakes a sleeping phone.
    pub urgency: &'static str,
}

impl Message {
    fn payload(&self) -> Vec<u8> {
        json!({"title": self.title, "body": self.body, "url": self.url, "tag": self.tag}).to_string().into_bytes()
    }
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max - 1).collect::<String>()) }
}

/// What to say about `print` for `event` (None: nothing to say).
pub fn message(event: &str, print: &PrintRecord) -> Option<Message> {
    let what = format!("{} on {}", clip(&print.name, 80), clip(&print.printer_name, 60));
    let tag = format!("print-{}", print.id);
    let url = "/prints".to_string();
    Some(match event {
        "print.failed" => {
            let title = if print.status == "cancelled" { "Print stopped" } else { "Print failed" };
            let body = match print.error.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
                Some(e) => format!("{what}\n{}", clip(e, 300)),
                None => what,
            };
            Message { title: title.into(), body, url, tag, urgency: "high" }
        }
        "print.finished" => Message { title: "Print finished".into(), body: what, url, tag, urgency: "normal" },
        "print.approval_requested" => {
            let who = print.username.as_deref().unwrap_or("Someone");
            let mut body = format!("{who} wants to print {what}");
            if let Some(r) = print.approval_reason.as_deref().filter(|r| !r.is_empty()) {
                body = format!("{body}\n{}", clip(r, 300));
            }
            Message { title: "Print waiting for approval".into(), body, url, tag, urgency: "normal" }
        }
        _ => return None,
    })
}

// -- Who to tell -----------------------------------------------------------------------

/// The accounts to tell about `event` for `print`: subscribers who want it,
/// for approval requests only those who may approve, never whoever just
/// stopped it.
fn recipients(state: &AppState, event: &str, print: &PrintRecord) -> Vec<String> {
    let subscribers = state.db.push_subscribers();
    if subscribers.is_empty() {
        return vec![];
    }
    let tree = Tree::load(&state.db);
    let job_owner = print.job_id.as_deref().and_then(|j| state.db.get_job(j)).and_then(|j| j.user_id);
    let stopper = (event == "print.failed" && print.status == "cancelled").then(|| who_stopped(&print.id)).flatten();
    subscribers
        .into_iter()
        .filter(|u| stopper.as_deref() != Some(u.as_str()))
        .filter(|u| {
            let Some(user) = state.db.get_user(u) else { return false };
            let viewer = Viewer::load(&state.db, &user);
            if event == "print.approval_requested" && !crate::prints_api::can_approve_print(&tree, &viewer, print) {
                return false;
            }
            wants(&prefs_of(&state.db, u), event, &relations(&state.db, &tree, &viewer, print, job_owner.as_deref()))
        })
        .collect()
}

/// Tell whoever wants to know that `print` had `event`.
pub fn print_event(state: &AppState, event: &str, print: &PrintRecord) {
    let Some(msg) = message(event, print) else { return };
    for user in recipients(state, event, print) {
        send_to_user(state, &user, &msg);
    }
}

/// Push `msg` to every device of `user_id`, in the background.
pub fn send_to_user(state: &AppState, user_id: &str, msg: &Message) {
    let subs = state.db.push_subscriptions_of(user_id);
    if subs.is_empty() {
        return;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    let db = state.db.clone();
    let contact = contact(state);
    let msg = msg.clone();
    runtime.spawn(async move {
        for sub in subs {
            deliver(&db, &contact, &sub, &msg).await;
        }
    });
}

/// The VAPID `sub` claim: how a push service reaches whoever runs this
/// server (its public origin).
fn contact(state: &AppState) -> String {
    state.rp.origin.as_str().trim_end_matches('/').to_string()
}

// -- Push services ---------------------------------------------------------------------

/// The push services browsers use (host, or a parent domain of it).
pub const PUSH_SERVICES: &[&str] = &[
    "fcm.googleapis.com",        // Chrome, Edge on Android, Opera, Samsung, Brave
    "android.googleapis.com",    // older Chrome
    "push.services.mozilla.com", // Firefox
    "push.apple.com",            // Safari, iOS home-screen apps
    "notify.windows.com",        // Edge on Windows
];

/// Is `endpoint` a push service's address? HTTPS to one of
/// [`PUSH_SERVICES`], or under an origin in `FARMSLICER_PUSH_SERVICES`
/// (comma-separated; for tests' fake push service, http allowed).
pub fn allowed_endpoint(endpoint: &str) -> bool {
    if endpoint.len() > 2000 {
        return false;
    }
    let extra = std::env::var("FARMSLICER_PUSH_SERVICES").unwrap_or_default();
    if extra.split(',').map(|o| o.trim().trim_end_matches('/')).any(|o| !o.is_empty() && endpoint.starts_with(&format!("{o}/"))) {
        return true;
    }
    let Ok(url) = url::Url::parse(endpoint) else { return false };
    let Some(host) = url.host_str() else { return false };
    url.scheme() == "https"
        && url.port().is_none()
        && PUSH_SERVICES.iter().any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| crate::webhooks::internet_client(concat!("FarmSlicer-Push/", env!("CARGO_PKG_VERSION"))))
}

/// How long a push service keeps a push for a device that's off (seconds).
const TTL: u32 = 24 * 3600;

async fn deliver(db: &Db, contact: &str, sub: &PushSubscription, msg: &Message) {
    let request = (|| -> Result<_, String> {
        let key = server_key(db)?;
        let body = encrypt(&decode(&sub.p256dh)?, &decode(&sub.auth)?, &msg.payload(), None)?;
        Ok((vapid_header(&key, &sub.endpoint, contact, now())?, body))
    })();
    let (authorization, body) = match request {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Push to {} ({}): {e}", sub.user_id, sub.label);
            db.push_delivered(&sub.id, Some(&e));
            return;
        }
    };
    let result = client()
        .post(&sub.endpoint)
        .header("authorization", authorization)
        .header("content-encoding", "aes128gcm")
        .header("content-type", "application/octet-stream")
        .header("ttl", TTL.to_string())
        .header("urgency", msg.urgency)
        .body(body)
        .send()
        .await;
    match result {
        Ok(r) if r.status().is_success() => db.push_delivered(&sub.id, None),
        // The browser unsubscribed, or the subscription expired.
        Ok(r) if matches!(r.status().as_u16(), 404 | 410) => {
            println!("Push: {} ({}) is gone; forgetting it", sub.id, sub.label);
            db.delete_push_subscription(&sub.id, None);
        }
        Ok(r) => {
            let status = r.status();
            let text = r.text().await.unwrap_or_default();
            let e = format!("HTTP {status}: {}", clip(text.trim(), 200));
            eprintln!("Push to {} ({}): {e}", sub.user_id, sub.label);
            db.push_delivered(&sub.id, Some(&e));
        }
        Err(e) => {
            eprintln!("Push to {} ({}): {e}", sub.user_id, sub.label);
            db.push_delivered(&sub.id, Some(&e.to_string()));
        }
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn decode(s: &str) -> Result<Vec<u8>, String> {
    B64.decode(s.trim().trim_end_matches('=').replace('+', "-").replace('/', "_")).map_err(|_| "not base64url".to_string())
}

// -- Keys and crypto -------------------------------------------------------------------

fn p256() -> EcGroup {
    EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).expect("OpenSSL has P-256")
}

/// This server's VAPID key, made on first use.
fn server_key(db: &Db) -> Result<EcKey<Private>, String> {
    let fresh = || -> Result<String, openssl::error::ErrorStack> {
        let pem = EcKey::generate(&p256())?.private_key_to_pem()?;
        Ok(String::from_utf8(pem).expect("PEM is ASCII"))
    };
    let pem = db.setting_or_insert("vapid_key", &fresh().map_err(|e| format!("making the push key: {e}"))?);
    EcKey::private_key_from_pem(pem.as_bytes()).map_err(|e| format!("the stored push key: {e}"))
}

/// A key's public point, uncompressed (65 bytes: 0x04, x, y).
fn public_bytes(key: &EcKey<Private>) -> Vec<u8> {
    let mut ctx = BigNumContext::new().expect("a BN context");
    key.public_key().to_bytes(&p256(), PointConversionForm::UNCOMPRESSED, &mut ctx).expect("a P-256 point encodes")
}

/// The public key browsers subscribe with (`applicationServerKey`), base64url.
pub fn public_key(db: &Db) -> Result<String, String> {
    Ok(B64.encode(public_bytes(&server_key(db)?)))
}

/// HKDF-SHA256 (RFC 5869) for one block of output: `len` <= 32.
fn hkdf(salt: &[u8], ikm: &[u8], info: &[u8], len: usize) -> Vec<u8> {
    let prk = hmac_sha256(salt, ikm);
    let mut t = info.to_vec();
    t.push(1);
    hmac_sha256(&prk, &t)[..len].to_vec()
}

/// Record size in the header; one record holds any payload we send.
const RECORD_SIZE: u32 = 4096;

/// Encrypt `plaintext` for the browser whose public key is `ua_public` and
/// auth secret `auth` (RFC 8291, one `aes128gcm` record). `sender` = the
/// ephemeral key and salt, given only by the test (RFC 8291's example).
fn encrypt(
    ua_public: &[u8],
    auth: &[u8],
    plaintext: &[u8],
    sender: Option<(EcKey<Private>, [u8; 16])>,
) -> Result<Vec<u8>, String> {
    let err = |e: openssl::error::ErrorStack| format!("encrypting: {e}");
    if ua_public.len() != 65 || ua_public[0] != 4 {
        return Err("the browser's key isn't an uncompressed P-256 point".into());
    }
    if auth.len() != 16 {
        return Err("the browser's auth secret isn't 16 bytes".into());
    }
    if plaintext.len() + 1 + 16 + 86 > RECORD_SIZE as usize {
        return Err("the message is too long".into());
    }
    let group = p256();
    let (ephemeral, salt) = match sender {
        Some(s) => s,
        None => {
            let mut salt = [0u8; 16];
            openssl::rand::rand_bytes(&mut salt).map_err(err)?;
            (EcKey::generate(&group).map_err(err)?, salt)
        }
    };
    let as_public = public_bytes(&ephemeral);
    let mut ctx = BigNumContext::new().map_err(err)?;
    let peer = EcPoint::from_bytes(&group, ua_public, &mut ctx).map_err(|_| "the browser's key isn't on P-256".to_string())?;
    let peer = PKey::from_ec_key(EcKey::from_public_key(&group, &peer).map_err(err)?).map_err(err)?;
    let ours = PKey::from_ec_key(ephemeral).map_err(err)?;
    let mut deriver = Deriver::new(&ours).map_err(err)?;
    deriver.set_peer(&peer).map_err(err)?;
    let ecdh_secret = deriver.derive_to_vec().map_err(err)?;

    let key_info = [b"WebPush: info\0".as_slice(), ua_public, &as_public].concat();
    let ikm = hkdf(auth, &ecdh_secret, &key_info, 32);
    let cek = hkdf(&salt, &ikm, b"Content-Encoding: aes128gcm\0", 16);
    let nonce = hkdf(&salt, &ikm, b"Content-Encoding: nonce\0", 12);

    let mut record = plaintext.to_vec();
    record.push(2); // the last (only) record's delimiter, no padding
    let mut tag = [0u8; 16];
    let ciphertext = encrypt_aead(Cipher::aes_128_gcm(), &cek, Some(&nonce), &[], &record, &mut tag).map_err(err)?;

    let mut out = Vec::with_capacity(86 + ciphertext.len() + 16);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    out.push(as_public.len() as u8);
    out.extend_from_slice(&as_public);
    out.extend_from_slice(&ciphertext);
    out.extend_from_slice(&tag);
    Ok(out)
}

/// The `Authorization` header for a push to `endpoint` (RFC 8292): an ES256
/// JWT for the endpoint's origin, valid 12 hours, and our public key.
fn vapid_header(key: &EcKey<Private>, endpoint: &str, contact: &str, now: i64) -> Result<String, String> {
    let url = url::Url::parse(endpoint).map_err(|_| "the endpoint isn't a URL".to_string())?;
    let audience = url.origin().ascii_serialization();
    let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = B64.encode(json!({"aud": audience, "exp": now + 12 * 3600, "sub": contact}).to_string());
    let signing_input = format!("{header}.{claims}");
    let digest = Sha256::digest(signing_input.as_bytes());
    let sig = EcdsaSig::sign(&digest, key).map_err(|e| format!("signing: {e}"))?;
    let pad = |n: &openssl::bn::BigNumRef| n.to_vec_padded(32).expect("a P-256 scalar fits 32 bytes");
    let signature = [pad(sig.r()), pad(sig.s())].concat();
    Ok(format!("vapid t={signing_input}.{}, k={}", B64.encode(signature), B64.encode(public_bytes(key))))
}

// -- API -------------------------------------------------------------------------------

type ApiError = (StatusCode, Json<Value>);

fn api_err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

/// The relations that can apply to `viewer` (the Account page offers only
/// those).
fn relations_for(state: &AppState, viewer: &Viewer) -> Vec<&'static str> {
    let mut r = vec!["mine"];
    if !state.db.operated_printers(&viewer.user.id).is_empty() {
        r.push("operated");
    }
    if viewer.memberships.iter().any(|m| m.status == "active" && m.role == "manager") {
        r.push("managed");
    }
    if viewer.admin {
        r.push("all");
    }
    r
}

fn settings_json(state: &AppState, user: &crate::db::User) -> Result<Value, ApiError> {
    let viewer = Viewer::load(&state.db, user);
    let key = public_key(&state.db).map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let relations = relations_for(state, &viewer);
    let events: Vec<Value> = EVENTS
        .iter()
        // Approval requests only reach those who may approve.
        .filter(|(e, _)| *e != "print.approval_requested" || relations.iter().any(|r| matches!(*r, "managed" | "all")))
        .map(|(e, label)| json!({"event": e, "label": label}))
        .collect();
    Ok(json!({
        "key": key,
        "events": events,
        "relations": RELATIONS.iter().filter(|(r, _)| relations.contains(r)).map(|(r, label)| json!({"relation": r, "label": label})).collect::<Vec<_>>(),
        "prefs": prefs_of(&state.db, &user.id),
        "subscriptions": state.db.push_subscriptions_of(&user.id),
    }))
}

/// `GET /api/me/notifications`: the server's key, what can be chosen, the
/// choices, this account's devices.
async fn get_settings(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(settings_json(&state, &user)?))
}

#[derive(Deserialize)]
struct PrefsBody {
    prefs: Prefs,
}

/// `PUT /api/me/notifications`: `{prefs: {event: [relation, ...]}}`.
async fn put_prefs(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<PrefsBody>,
) -> Result<Json<Value>, ApiError> {
    let mut prefs = Prefs::new();
    for (event, relations) in body.prefs {
        if !EVENTS.iter().any(|(e, _)| *e == event) {
            return Err(api_err(StatusCode::BAD_REQUEST, format!("unknown event {event:?}")));
        }
        if let Some(r) = relations.iter().find(|r| !RELATIONS.iter().any(|(x, _)| x == r)) {
            return Err(api_err(StatusCode::BAD_REQUEST, format!("unknown relation {r:?}")));
        }
        let mut relations = relations;
        relations.sort();
        relations.dedup();
        prefs.insert(event, relations);
    }
    state.db.set_notify_prefs(&user.id, Some(&serde_json::to_string(&prefs).unwrap()));
    Ok(Json(settings_json(&state, &user)?))
}

#[derive(Deserialize)]
struct Keys {
    p256dh: String,
    auth: String,
}

/// What `PushSubscription.toJSON()` gives, plus an optional device name.
#[derive(Deserialize)]
struct SubscribeBody {
    endpoint: String,
    keys: Keys,
    #[serde(default)]
    label: Option<String>,
}

/// A device's name from its user agent ("Chrome on Android").
pub fn device_label(user_agent: &str) -> String {
    let ua = user_agent;
    let browser = if ua.contains("Edg/") || ua.contains("EdgA/") || ua.contains("EdgiOS/") {
        "Edge"
    } else if ua.contains("OPR/") {
        "Opera"
    } else if ua.contains("SamsungBrowser/") {
        "Samsung Internet"
    } else if ua.contains("Firefox/") || ua.contains("FxiOS/") {
        "Firefox"
    } else if ua.contains("Chrome/") || ua.contains("CriOS/") {
        "Chrome"
    } else if ua.contains("Safari/") {
        "Safari"
    } else {
        "A browser"
    };
    let os = if ua.contains("iPhone") {
        "iPhone"
    } else if ua.contains("iPad") {
        "iPad"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Mac OS X") || ua.contains("Macintosh") {
        "Mac"
    } else if ua.contains("CrOS") {
        "ChromeOS"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        ""
    };
    if os.is_empty() { browser.to_string() } else { format!("{browser} on {os}") }
}

/// `POST /api/me/notifications/subscriptions`: this device, subscribed.
async fn subscribe(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    headers: HeaderMap,
    Json(body): Json<SubscribeBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if !allowed_endpoint(&body.endpoint) {
        return Err(api_err(StatusCode::BAD_REQUEST, "endpoint: not a known push service"));
    }
    let p256dh = decode(&body.keys.p256dh).map_err(|_| api_err(StatusCode::BAD_REQUEST, "keys.p256dh: not base64url"))?;
    let auth = decode(&body.keys.auth).map_err(|_| api_err(StatusCode::BAD_REQUEST, "keys.auth: not base64url"))?;
    if p256dh.len() != 65 || p256dh[0] != 4 || auth.len() != 16 {
        return Err(api_err(StatusCode::BAD_REQUEST, "keys: a P-256 public key (65 bytes) and a 16-byte auth secret"));
    }
    let label = match body.label.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        Some(l) => clip(l, 80),
        None => device_label(headers.get("user-agent").and_then(|v| v.to_str().ok()).unwrap_or("")),
    };
    let id = state
        .db
        .save_push_subscription(&user.id, &body.endpoint, &B64.encode(&p256dh), &B64.encode(&auth), &label)
        .map_err(|e| api_err(StatusCode::CONFLICT, format!("notifications need a real account ({e})")))?;
    println!("Push: {} turns notifications on for {label}", user.username);
    Ok((StatusCode::CREATED, Json(json!({"id": id, "settings": settings_json(&state, &user)?}))))
}

/// `DELETE /api/me/notifications/subscriptions/{id}`: one of my devices.
async fn unsubscribe(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if !state.db.delete_push_subscription(&id, Some(&user.id)) {
        return Err(api_err(StatusCode::NOT_FOUND, "no such device"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/me/notifications/test`: a notification to each of my devices.
async fn test(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let devices = state.db.push_subscriptions_of(&user.id).len();
    if devices == 0 {
        return Err(api_err(StatusCode::CONFLICT, "notifications aren't on for any device"));
    }
    let msg = Message {
        title: "FarmSlicer".into(),
        body: "Notifications work on this device.".into(),
        url: "/account".into(),
        tag: "test".into(),
        urgency: "normal",
    };
    send_to_user(&state, &user.id, &msg);
    Ok((StatusCode::ACCEPTED, Json(json!({"devices": devices}))))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/me/notifications", get(get_settings).put(put_prefs))
        .route("/api/me/notifications/subscriptions", post(subscribe))
        .route("/api/me/notifications/subscriptions/{id}", delete(unsubscribe))
        .route("/api/me/notifications/test", post(test))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(s: &str) -> Vec<u8> {
        decode(&s.replace(char::is_whitespace, "")).unwrap()
    }

    fn key_from_private(private: &[u8]) -> EcKey<Private> {
        let group = p256();
        let d = BigNum::from_slice(private).unwrap();
        let mut ctx = BigNumContext::new().unwrap();
        let mut point = EcPoint::new(&group).unwrap();
        point.mul_generator2(&group, &d, &mut ctx).unwrap();
        EcKey::from_private_components(&group, &d, &point).unwrap()
    }

    #[test]
    fn hkdf_matches_rfc_5869() {
        // Test case 1, the first 32 bytes of its 42.
        let ikm = [0x0b; 22];
        let salt: Vec<u8> = (0x00..=0x0c).collect();
        let info: Vec<u8> = (0xf0..=0xf9).collect();
        assert_eq!(hex::encode(hkdf(&salt, &ikm, &info, 32)), "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf");
    }

    #[test]
    fn encryption_matches_rfc_8291() {
        // RFC 8291 section 5 / appendix A.
        let sender = key_from_private(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"));
        assert_eq!(
            public_bytes(&sender),
            b64("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8")
        );
        let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let ua_public = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let auth = b64("BTBZMqHH6r4Tts7J_aSIgg");
        let body = encrypt(&ua_public, &auth, b"When I grow up, I want to be a watermelon", Some((sender, salt))).unwrap();
        assert_eq!(
            B64.encode(body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml\
             mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT\
             pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    #[test]
    fn encryption_refuses_bad_keys() {
        let ua = public_bytes(&EcKey::generate(&p256()).unwrap());
        assert!(encrypt(&ua, &[0; 16], b"hi", None).is_ok());
        assert!(encrypt(&ua[..64], &[0; 16], b"hi", None).is_err());
        assert!(encrypt(&ua, &[0; 15], b"hi", None).is_err());
        let mut off_curve = ua.clone();
        off_curve[40] ^= 1;
        assert!(encrypt(&off_curve, &[0; 16], b"hi", None).is_err());
        assert!(encrypt(&ua, &[0; 16], &[b'x'; 4000], None).is_err());
    }

    #[test]
    fn vapid_signs_for_the_endpoint_origin() {
        let key = EcKey::generate(&p256()).unwrap();
        let h = vapid_header(&key, "https://fcm.googleapis.com/fcm/send/abc", "https://farm.example.com", 1_700_000_000).unwrap();
        let (t, k) = h.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
        assert_eq!(b64(k), public_bytes(&key));
        let parts: Vec<&str> = t.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: Value = serde_json::from_slice(&b64(parts[1])).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["exp"], 1_700_000_000 + 12 * 3600);
        assert_eq!(claims["sub"], "https://farm.example.com");
        // The signature verifies: r || s, 32 bytes each.
        let sig = b64(parts[2]);
        assert_eq!(sig.len(), 64);
        let sig = EcdsaSig::from_private_components(BigNum::from_slice(&sig[..32]).unwrap(), BigNum::from_slice(&sig[32..]).unwrap()).unwrap();
        let public = EcKey::from_public_key(&p256(), key.public_key()).unwrap();
        let digest = Sha256::digest(format!("{}.{}", parts[0], parts[1]).as_bytes());
        assert!(sig.verify(&digest, &public).unwrap());
    }

    #[test]
    fn only_push_services_are_endpoints() {
        assert!(allowed_endpoint("https://fcm.googleapis.com/fcm/send/abc"));
        assert!(allowed_endpoint("https://updates.push.services.mozilla.com/wpush/v2/abc"));
        assert!(allowed_endpoint("https://web.push.apple.com/abc"));
        assert!(allowed_endpoint("https://wns2-by3p.notify.windows.com/w/?token=abc"));
        assert!(!allowed_endpoint("http://fcm.googleapis.com/fcm/send/abc"));
        assert!(!allowed_endpoint("https://fcm.googleapis.com:8443/fcm/send/abc"));
        assert!(!allowed_endpoint("https://evilpush.apple.com.example.net/abc"));
        assert!(!allowed_endpoint("https://notpush.apple.com/abc"));
        assert!(!allowed_endpoint("https://10.0.0.1/abc"));
        assert!(!allowed_endpoint("https://printer.local/abc"));
    }

    #[test]
    fn preferences_pick_relations() {
        let prefs = default_prefs();
        assert!(wants(&prefs, "print.failed", &["mine"]));
        assert!(wants(&prefs, "print.failed", &["operated", "all"]));
        assert!(!wants(&prefs, "print.failed", &["all"]));
        assert!(!wants(&prefs, "print.failed", &[]));
        assert!(!wants(&prefs, "print.finished", &["mine", "operated", "managed", "all"]));
        assert!(wants(&prefs, "print.approval_requested", &["managed"]));
        assert!(!wants(&prefs, "print.unknown", &["mine"]));
    }

    fn print(status: &str, error: Option<&str>) -> PrintRecord {
        serde_json::from_value(json!({
            "id": "p1", "job_id": null, "plate": 1, "printer_id": "pr", "printer_name": "X1C-3",
            "user_id": "u", "username": "sam", "group_id": null, "file_name": "f", "name": "Bracket",
            "ams_mapping": null, "options": null, "approval_reason": "over the group's limit", "decided_by": null,
            "safety_review": false, "status": status, "progress": 0, "error": error, "created_at": "",
            "started_at": null, "finished_at": null, "updated_at": "", "outcome": null, "outcome_by": null,
            "outcome_at": null, "outcome_note": null
        }))
        .unwrap()
    }

    #[test]
    fn messages_say_what_happened() {
        let m = message("print.failed", &print("failed", Some("Filament ran out"))).unwrap();
        assert_eq!(m.title, "Print failed");
        assert_eq!(m.body, "Bracket on X1C-3\nFilament ran out");
        assert_eq!((m.tag.as_str(), m.urgency), ("print-p1", "high"));
        assert_eq!(message("print.failed", &print("cancelled", None)).unwrap().title, "Print stopped");
        assert_eq!(message("print.failed", &print("cancelled", None)).unwrap().body, "Bracket on X1C-3");
        let a = message("print.approval_requested", &print("pending_approval", None)).unwrap();
        assert_eq!(a.body, "sam wants to print Bracket on X1C-3\nover the group's limit");
        assert!(message("print.started", &print("printing", None)).is_none());
    }

    #[test]
    fn device_labels() {
        let android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
        assert_eq!(device_label(android), "Chrome on Android");
        let iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
        assert_eq!(device_label(iphone), "Safari on iPhone");
        let edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
        assert_eq!(device_label(edge), "Edge on Windows");
        assert_eq!(device_label("Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0"), "Firefox on Linux");
        assert_eq!(device_label(""), "A browser");
    }

    #[test]
    fn stoppers_are_remembered() {
        stopped_by("print-x", "u1");
        assert_eq!(who_stopped("print-x").as_deref(), Some("u1"));
        assert_eq!(who_stopped("print-y"), None);
    }
}
