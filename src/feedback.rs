//! Feedback: what users tell us (manual reports from the Feedback button)
//! and what goes wrong without them saying (automatic error reports from
//! the browser, and slice failures here). Storage is `db::feedback`, the
//! HTTP side `feedback_api`.
//!
//! Automatic reports are deduplicated by a fingerprint of where they were
//! caught, the message and the first stack frame, each normalised so that
//! the same fault in another job, build or line of the bundle lands on the
//! same report (`fingerprint`). Everything a client sends is capped in size
//! and rate (`Limit`), and the number of distinct automatic reports is
//! capped too, so a runaway loop can't fill the database.

use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use crate::db::{Db, ErrorOccurrence, Recorded};

/// Report categories, chosen by the reporter (automatic ones: `app`, or
/// `slicer` for slice failures).
pub const KINDS: &[&str] = &["printer", "slicer", "app", "bug", "idea", "other"];
/// Triage states.
pub const STATUSES: &[&str] = &["new", "acknowledged", "resolved", "wont_fix"];
/// Where the browser caught an error (`web/src/errorReporting.ts`).
pub const CLIENT_SOURCES: &[&str] = &["window", "promise", "console", "react", "api", "resource"];

/// Manual report text, in characters (longer is refused: someone typed it).
pub const MAX_MESSAGE: usize = 5000;
pub const MAX_NOTE: usize = 5000;
/// Automatic report fields, in characters (longer is truncated).
pub const MAX_ERROR_MESSAGE: usize = 1000;
pub const MAX_STACK: usize = 8000;
pub const MAX_URL: usize = 1000;
pub const MAX_VERSION: usize = 64;
pub const MAX_USER_AGENT: usize = 400;
/// Context JSON, in bytes; larger is replaced by a note saying so.
pub const MAX_CONTEXT: usize = 32 * 1024;
pub const MAX_ERROR_CONTEXT: usize = 8 * 1024;
/// Automatic reports per request.
pub const MAX_BATCH: usize = 20;
/// Occurrences one batched report can stand for.
pub const MAX_REPEAT: i64 = 1000;
/// Distinct automatic reports kept; new fingerprints past this are dropped.
pub const MAX_ERROR_REPORTS: i64 = 2000;
/// Request bodies on the feedback routes.
pub const MAX_BODY: usize = 256 * 1024;

/// What the server reports itself as in occurrence rows.
pub const SERVER_VERSION: &str = concat!("server-", env!("CARGO_PKG_VERSION"));

/// `s` cut to at most `max` characters, marked with an ellipsis when cut.
pub fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        None => s.to_string(),
        Some(_) => {
            let keep: String = s.chars().take(max.saturating_sub(1)).collect();
            format!("{keep}…")
        }
    }
}

/// Context JSON to store: as sent when it fits in `max` bytes, otherwise a
/// note that it was dropped (the report itself is kept).
pub fn limit_context(context: Option<&Value>, max: usize) -> Option<String> {
    let value = context.filter(|v| !v.is_null())?;
    let text = value.to_string();
    if text.len() <= max {
        Some(text)
    } else {
        Some(json!({"dropped": format!("the context was {} bytes; at most {max} are kept", text.len())}).to_string())
    }
}

// ---- fingerprints ---------------------------------------------------------------------

static UUID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b").unwrap());
static HEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:0x)?[0-9a-f]{8,}\b").unwrap());
static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b\d+(?:\.\d+)*\b").unwrap());
static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?:https?|blob:https?)://[^\s'"()<>]+"#).unwrap());
/// Scheme and host of a URL.
static ORIGIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:blob:)?https?://[^/]+").unwrap());
/// `:line` or `:line:column` at the end of a location.
static LINE_COL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?::\d+){1,2}$").unwrap());
/// Vite's content hash in asset names: `index-B1a2C3d4.js` → `index.js`.
static ASSET_HASH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"-[A-Za-z0-9_-]{8}\.(m?js|css|wasm)\b").unwrap());
/// A V8 frame: `at fn (location)` or `at location`.
static V8_FRAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*at\s+(?:(.*?)\s+\((.*)\)|(.*))\s*$").unwrap());
/// A Firefox/Safari frame: `fn@location`.
static GECKO_FRAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*([^@\s]*)@(.+?)\s*$").unwrap());

/// A script location without what changes between builds and deploys:
/// origin, query, line and column, asset hash.
fn normalize_location(loc: &str) -> String {
    let loc = ORIGIN.replace(loc.trim(), "");
    let loc = LINE_COL.replace(&loc, "");
    let loc = match loc.find(['?', '#']) {
        Some(i) => &loc[..i],
        None => &loc,
    };
    ASSET_HASH.replace_all(loc, ".$1").into_owned()
}

/// Message text without what differs between occurrences of the same
/// fault: ids, hashes, numbers, asset URLs, spacing.
pub fn normalize_message(message: &str) -> String {
    let s = URL.replace_all(message, |c: &regex::Captures<'_>| normalize_location(&c[0]));
    let s = UUID.replace_all(&s, "<uuid>");
    let s = HEX.replace_all(&s, "<hex>");
    let s = NUMBER.replace_all(&s, "<n>");
    let s = SPACE.replace_all(s.trim(), " ");
    s.chars().take(500).collect()
}

/// The first stack frame, normalised: `function location`. Lines that
/// aren't frames (V8's `TypeError: message` header) are skipped.
pub fn first_frame(stack: &str) -> Option<String> {
    stack.lines().find_map(|line| {
        if let Some(c) = V8_FRAME.captures(line) {
            let (func, loc) = match (c.get(1), c.get(2), c.get(3)) {
                (Some(f), Some(l), _) => (f.as_str(), l.as_str()),
                (_, _, Some(l)) => ("", l.as_str()),
                _ => return None,
            };
            return Some(frame(func, loc));
        }
        let c = GECKO_FRAME.captures(line)?;
        let loc = c.get(2)?.as_str();
        // `@` turns up in messages too; a frame has a location with a line.
        LINE_COL.is_match(loc).then(|| frame(c.get(1).map_or("", |f| f.as_str()), loc))
    })
}

fn frame(func: &str, loc: &str) -> String {
    let loc = normalize_location(loc);
    let loc = UUID.replace_all(&loc, "<uuid>");
    format!("{} {}", func.trim(), loc).trim().to_string()
}

/// Which automatic report an occurrence belongs to.
pub fn fingerprint(source: &str, message: &str, stack: Option<&str>) -> String {
    let frame = stack.and_then(first_frame).unwrap_or_default();
    let digest = Sha256::digest(format!("{source}\n{}\n{frame}", normalize_message(message)).as_bytes());
    hex::encode(&digest[..16])
}

// ---- rate limits -------------------------------------------------------------------------

/// Per-account allowances, as token buckets: a burst of `capacity`, then
/// one more every `refill_secs`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Limit {
    /// Manual reports.
    Manual,
    /// Automatic reports (each one in a batch counts).
    Errors,
}

impl Limit {
    fn capacity(self) -> f64 {
        match self {
            Limit::Manual => 10.0,
            Limit::Errors => 60.0,
        }
    }
    pub fn refill_secs(self) -> f64 {
        match self {
            Limit::Manual => 60.0,
            Limit::Errors => 10.0,
        }
    }
}

struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn new(limit: Limit, now: Instant) -> Self {
        Bucket { tokens: limit.capacity(), at: now }
    }

    /// Up to `wanted` tokens, as many as there are.
    fn take(&mut self, limit: Limit, wanted: usize, now: Instant) -> usize {
        let refilled = now.duration_since(self.at).as_secs_f64() / limit.refill_secs();
        self.tokens = (self.tokens + refilled).min(limit.capacity());
        self.at = now;
        let granted = (self.tokens.floor() as usize).min(wanted);
        self.tokens -= granted as f64;
        granted
    }

    fn full(&self, limit: Limit, now: Instant) -> bool {
        self.tokens + now.duration_since(self.at).as_secs_f64() / limit.refill_secs() >= limit.capacity()
    }
}

static BUCKETS: LazyLock<Mutex<HashMap<(String, Limit), Bucket>>> = LazyLock::new(Default::default);

/// Take up to `wanted` of `user`'s allowance; returns how many were granted.
pub fn take(user: &str, limit: Limit, wanted: usize) -> usize {
    let now = Instant::now();
    let mut buckets = BUCKETS.lock().unwrap();
    if buckets.len() > 10_000 {
        // Full buckets are the same as none.
        buckets.retain(|(_, l), b| !b.full(*l, now));
    }
    buckets
        .entry((user.to_string(), limit))
        .or_insert_with(|| Bucket::new(limit, now))
        .take(limit, wanted, now)
}

// ---- recording -----------------------------------------------------------------------------

/// Count an automatic report; logs the first occurrence of each and
/// regressions (counting is silent).
pub fn record(db: &Db, e: &ErrorOccurrence<'_>, who: &str) -> Recorded {
    let recorded = db.record_error(e, MAX_ERROR_REPORTS);
    match &recorded {
        Recorded::New(_) => println!("Error report ({}, {}) from {who}: {}", e.kind, e.source, truncate(e.message, 300)),
        Recorded::Regressed(_) => println!(
            "Error report ({}, {}) from {who} happened again after being resolved: {}",
            e.kind,
            e.source,
            truncate(e.message, 300)
        ),
        Recorded::Dropped => {
            static WARNED: std::sync::Once = std::sync::Once::new();
            WARNED.call_once(|| {
                eprintln!("Error reports: {MAX_ERROR_REPORTS} distinct reports stored; new ones are dropped until some are deleted")
            });
        }
        Recorded::Counted(_) => {}
    }
    recorded
}

/// A slice failed (`engine`: "server" for libslic3r here, "browser" for a
/// failure the browser engine posted): an automatic `slicer` report.
pub fn slice_failed(db: &Db, job_id: &str, error: &str, engine: &str) {
    let job = db.get_job(job_id);
    let message = truncate(&format!("{engine} slice failed: {}", error.trim()), MAX_ERROR_MESSAGE);
    let printer_model = job
        .as_ref()
        .and_then(|j| j.config_json.as_deref())
        .and_then(|c| serde_json::from_str::<Value>(c).ok())
        .and_then(|c| c.get("printer_model").and_then(Value::as_str).map(str::to_string));
    let context = json!({
        "engine": engine,
        "model_name": job.as_ref().map(|j| j.model_name.as_str()),
        "printer_model": printer_model,
    })
    .to_string();
    let user_id = job.as_ref().and_then(|j| j.user_id.clone());
    let who = user_id.as_deref().and_then(|u| db.get_user(u)).map_or_else(|| "the server".to_string(), |u| u.username);
    record(
        db,
        &ErrorOccurrence {
            kind: "slicer",
            source: "server",
            fingerprint: &fingerprint("server", &message, None),
            message: &message,
            stack: None,
            user_id: user_id.as_deref(),
            printer_id: job.as_ref().and_then(|j| j.printer_id.as_deref()),
            job_id: job.as_ref().map(|j| j.id.as_str()),
            page_url: None,
            user_agent: None,
            version: Some(SERVER_VERSION),
            context: Some(&context),
            count: 1,
        },
        &who,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn messages_lose_ids_numbers_and_hashes() {
        assert_eq!(
            normalize_message("job 3f2c8a10-1b2c-4d5e-8f90-123456789abc failed after 12.5 s"),
            "job <uuid> failed after <n> s"
        );
        assert_eq!(normalize_message("bad digest deadbeef0123 here"), "bad digest <hex> here");
        assert_eq!(normalize_message("  two\n\tlines  "), "two lines");
        // Identifiers with digits in them stay: they name things.
        assert_eq!(normalize_message("H2D T1000 es2020"), "H2D T1000 es2020");
        assert_eq!(
            normalize_message("Cannot read properties of undefined (reading '0')"),
            "Cannot read properties of undefined (reading '<n>')"
        );
        assert_eq!(
            normalize_message("Failed to fetch dynamically imported module: https://farm.example.com/assets/Slice-B1a2C3d4.js"),
            "Failed to fetch dynamically imported module: /assets/Slice.js"
        );
    }

    #[test]
    fn v8_frames_lose_origin_position_and_hash() {
        let stack = "TypeError: x is undefined\n    at renderPart (https://farm.example.com/assets/index-B1a2C3d4.js:12:3456)\n    at other (x.js:1:2)";
        assert_eq!(first_frame(stack).as_deref(), Some("renderPart /assets/index.js"));
        let anonymous = "Error: boom\n    at http://localhost:5173/src/pages/Slice.tsx?t=1700000000000:88:15";
        assert_eq!(first_frame(anonymous).as_deref(), Some("/src/pages/Slice.tsx"));
    }

    #[test]
    fn gecko_frames_too() {
        let stack = "renderPart@https://farm.example.com/assets/index-Xy_z-123.js:12:3456\n@x.js:1:1";
        assert_eq!(first_frame(stack).as_deref(), Some("renderPart /assets/index.js"));
        assert_eq!(first_frame("no frames here"), None);
        assert_eq!(first_frame("mail me@example.com"), None, "an @ in text isn't a frame");
    }

    #[test]
    fn worker_blob_urls_lose_their_ids() {
        let stack = "Error\n    at onmessage (blob:https://farm.example.com/3f2c8a10-1b2c-4d5e-8f90-123456789abc:3:7)";
        assert_eq!(first_frame(stack).as_deref(), Some("onmessage /<uuid>"));
    }

    #[test]
    fn same_fault_same_fingerprint() {
        let a = fingerprint(
            "window",
            "job 3f2c8a10-1b2c-4d5e-8f90-123456789abc: 3 parts",
            Some("Error\n    at f (https://a.example/assets/index-AAAAAAAA.js:1:100)"),
        );
        let b = fingerprint(
            "window",
            "job 0a0a0a0a-1b2c-4d5e-8f90-000000000000: 7 parts",
            Some("Error\n    at f (http://localhost:9337/assets/index-BBBBBBBB.js:2:200)"),
        );
        assert_eq!(a, b, "another job, build and deploy: the same report");
        let other_source = fingerprint("console", "job 0a0a0a0a-1b2c-4d5e-8f90-000000000000: 7 parts", None);
        assert_ne!(a, other_source);
        let other_frame = fingerprint("window", "job x: 3 parts", Some("Error\n    at g (index.js:1:1)"));
        assert_ne!(a, other_frame);
        assert_eq!(a.len(), 32);
    }

    #[test]
    fn truncation_is_by_character() {
        assert_eq!(truncate("héllo", 10), "héllo");
        assert_eq!(truncate("héllo", 3), "hé…");
        assert_eq!(truncate("héllo", 3).chars().count(), 3);
    }

    #[test]
    fn oversized_context_is_replaced_by_a_note() {
        let small = json!({"viewport": "800x600"});
        assert_eq!(limit_context(Some(&small), 100).as_deref(), Some(r#"{"viewport":"800x600"}"#));
        let big = json!({"log": "x".repeat(200)});
        let kept: Value = serde_json::from_str(&limit_context(Some(&big), 100).unwrap()).unwrap();
        assert!(kept["dropped"].as_str().unwrap().contains("at most 100"));
        assert_eq!(limit_context(Some(&Value::Null), 100), None);
    }

    #[test]
    fn buckets_burst_then_refill() {
        let t0 = Instant::now();
        let mut b = Bucket::new(Limit::Errors, t0);
        assert_eq!(b.take(Limit::Errors, 20, t0), 20);
        assert_eq!(b.take(Limit::Errors, 50, t0), 40, "what's left of the burst");
        assert_eq!(b.take(Limit::Errors, 1, t0), 0);
        let later = t0 + Duration::from_secs_f64(Limit::Errors.refill_secs() * 3.0);
        assert_eq!(b.take(Limit::Errors, 10, later), 3);
        let much_later = later + Duration::from_secs(3600 * 24);
        assert!(b.full(Limit::Errors, much_later));
        assert_eq!(b.take(Limit::Errors, 1000, much_later), 60, "never more than the burst");
    }
}
