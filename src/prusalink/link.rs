//! The PrusaLink driver's link to one printer. PrusaLink pushes nothing, so
//! this polls `/api/v1/status` (every 2 s while a job is on, 5 s otherwise)
//! and `/api/v1/job` when the job changes, one request at a time: the
//! printer serves three connections, shared with its own web page and
//! Prusa Connect.
//!
//! Auth: `X-Api-Key` with the PrusaLink password (Buddy firmware compares
//! it with the same secret its Digest login uses; the Raspberry Pi
//! Prusa-Link takes its own API key there).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::task::JoinHandle;

use super::status::{self, LastJob, Snapshot};
use crate::db;
use crate::printer::hub::StatusSink;
use crate::printer::{Command, CommandError, http};

pub const DEFAULT_PORT: u16 = 80;
const ACTIVE_POLL: Duration = Duration::from_secs(2);
const IDLE_POLL: Duration = Duration::from_secs(5);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Polls are small; a printer that takes longer is busy or gone.
const POLL_TIMEOUT: Duration = Duration::from_secs(8);
/// After a start, poll fast this long: the job shows only while it runs.
const WATCH_AFTER_START: Duration = Duration::from_secs(120);

#[derive(Debug, Clone)]
pub struct Config {
    pub name: String,
    pub base: url::Url,
    pub password: String,
}

impl Config {
    pub fn from_printer(p: &db::Printer) -> Option<Self> {
        let password = p.access_code.trim();
        if password.is_empty() {
            return None;
        }
        Some(Self { name: p.name.clone(), base: http::base_url(&p.address, DEFAULT_PORT)?, password: password.to_string() })
    }

    pub fn same_endpoint(&self, other: &Self) -> bool {
        self.base == other.base && self.password == other.password
    }

    pub fn request(&self, method: reqwest::Method, url: url::Url) -> reqwest::RequestBuilder {
        http::client().request(method, url).header("X-Api-Key", &self.password)
    }

    pub fn url(&self, path: &str) -> url::Url {
        http::join(&self.base, path)
    }

    /// `api/v1/files/usb/<path>`, each segment encoded.
    pub fn file_url(&self, path: &str) -> url::Url {
        let mut url = self.url("api/v1/files/usb/");
        url.path_segments_mut().expect("http URLs have paths").pop_if_empty().extend(path.split('/'));
        url
    }
}

/// A PrusaLink request's outcome: the JSON body (null for 204 and the like).
pub async fn call(request: reqwest::RequestBuilder) -> Result<Value, CommandError> {
    let response = request.send().await.map_err(|e| CommandError::Offline(http::explain(&e)))?;
    let code = response.status();
    let text = response.text().await.unwrap_or_default();
    if code.is_success() {
        return Ok(serde_json::from_str(&text).unwrap_or(Value::Null));
    }
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let message = body["message"]
        .as_str()
        .or_else(|| body["title"].as_str())
        .map(String::from)
        .unwrap_or_else(|| text.trim().chars().take(200).collect());
    Err(match code.as_u16() {
        401 | 403 => CommandError::Refused(
            "PrusaLink refused the password (the printer shows it under Settings → Network → PrusaLink)".into(),
        ),
        _ => CommandError::Refused(if message.is_empty() { format!("HTTP {code}") } else { format!("{message} ({code})") }),
    })
}

#[derive(Default)]
struct State {
    connected: bool,
    error: Option<String>,
    updated_at: Option<String>,
    status: Value,
    job: Option<LastJob>,
    version: Value,
}

impl State {
    fn printer_state(&self) -> &str {
        self.status["printer"]["state"].as_str().unwrap_or("")
    }
}

struct Shared {
    config: Config,
    sink: StatusSink,
    state: Mutex<State>,
    /// Poll now (a print was just started).
    wake: tokio::sync::Notify,
    /// Poll fast until then.
    watch_until: Mutex<Option<tokio::time::Instant>>,
}

impl Shared {
    fn update(&self, change: impl FnOnce(&mut State)) {
        let summary = {
            let mut s = self.state.lock().unwrap();
            change(&mut s);
            status::summarize(&Snapshot {
                connected: s.connected,
                error: s.error.clone(),
                updated_at: s.updated_at.clone(),
                status: &s.status,
                job: s.job.as_ref(),
            })
        };
        self.sink.publish(summary);
    }
}

/// Commands for one printer. Cheap to clone.
#[derive(Clone)]
pub struct Handle {
    shared: Arc<Shared>,
}

pub fn start(config: Config, sink: StatusSink) -> (Handle, JoinHandle<()>) {
    println!("Printer {}: polling PrusaLink at {}", config.name, config.base);
    let shared = Arc::new(Shared {
        config,
        sink,
        state: Mutex::new(State::default()),
        wake: tokio::sync::Notify::new(),
        watch_until: Mutex::new(None),
    });
    let task = tokio::spawn(run(shared.clone()));
    (Handle { shared }, task)
}

impl Handle {
    pub fn config(&self) -> &Config {
        &self.shared.config
    }

    /// A print was just started: look now, and often for a while.
    pub fn watch(&self) {
        *self.shared.watch_until.lock().unwrap() = Some(tokio::time::Instant::now() + WATCH_AFTER_START);
        self.shared.wake.notify_one();
    }

    /// Can a print start now? (PrusaLink starts from idle and from the
    /// finish screen.)
    pub fn check_idle(&self) -> Result<(), String> {
        let s = self.shared.state.lock().unwrap();
        if !s.connected {
            return Err(format!("the printer is offline: {}", s.error.clone().unwrap_or_default()));
        }
        if s.status.get("transfer").is_some_and(|t| !t.is_null()) {
            return Err("the printer is receiving another file".into());
        }
        match s.printer_state() {
            "IDLE" | "READY" | "FINISHED" | "STOPPED" => Ok(()),
            "ATTENTION" => Err("the printer is waiting for someone at its screen".into()),
            other => Err(format!("the printer is {}", other.to_ascii_lowercase())),
        }
    }

    pub async fn command(&self, command: &Command) -> Result<Option<Value>, CommandError> {
        let (state, job_id) = {
            let s = self.shared.state.lock().unwrap();
            if !s.connected {
                return Err(CommandError::Offline(s.error.clone().unwrap_or_else(|| "not connected yet".into())));
            }
            (s.printer_state().to_string(), s.status["job"]["id"].as_i64())
        };
        let refuse = |what: &str| Err(CommandError::Refused(format!("can't {what}: the printer is {}", state.to_ascii_lowercase())));
        let c = &self.shared.config;
        let (method, path) = match command {
            Command::Pause if state == "PRINTING" => (reqwest::Method::PUT, "pause"),
            Command::Resume if state == "PAUSED" => (reqwest::Method::PUT, "resume"),
            Command::Stop if matches!(state.as_str(), "PRINTING" | "PAUSED" | "ATTENTION") => (reqwest::Method::DELETE, ""),
            Command::Pause => return refuse("pause"),
            Command::Resume => return refuse("resume"),
            Command::Stop => return refuse("stop"),
            Command::Speed(_) => return Err(CommandError::Unsupported("change speed over PrusaLink".into())),
            Command::Heat { .. } => return Err(CommandError::Unsupported("set temperatures over PrusaLink".into())),
        };
        let id = job_id.ok_or_else(|| CommandError::Refused("the printer reports no job".into()))?;
        let url = c.url(&if path.is_empty() { format!("api/v1/job/{id}") } else { format!("api/v1/job/{id}/{path}") });
        call(c.request(method, url)).await?;
        Ok(Some(json!("ok")))
    }

    /// The printer's state as polled, for debugging.
    pub fn raw(&self) -> Option<Value> {
        let s = self.shared.state.lock().unwrap();
        (!s.status.is_null()).then(|| {
            json!({"status": s.status, "version": s.version,
                   "job": s.job.as_ref().map(|j| json!({"id": j.id, "file": j.file}))})
        })
    }
}

async fn run(shared: Arc<Shared>) {
    let name = shared.config.name.clone();
    let mut backoff = Duration::from_secs(2);
    let mut failures: u32 = 0;
    loop {
        let wait = match poll(&shared, failures > 0 || !shared.state.lock().unwrap().connected).await {
            Ok(active) => {
                if failures > 0 {
                    println!("Printer {name}: PrusaLink answers again after {failures} failed attempts");
                }
                failures = 0;
                backoff = Duration::from_secs(2);
                let watching = shared.watch_until.lock().unwrap().is_some_and(|t| tokio::time::Instant::now() < t);
                if active || watching { ACTIVE_POLL } else { IDLE_POLL }
            }
            Err(why) => {
                failures += 1;
                // Log the first failure and then now and then, not every poll.
                if failures == 1 || failures % 20 == 0 {
                    eprintln!("Printer {name}: PrusaLink at {} unreachable (attempt {failures}): {why}", shared.config.base);
                }
                shared.update(|s| {
                    s.connected = false;
                    s.error = Some(why);
                });
                let wait = backoff;
                backoff = (backoff * 2).min(MAX_BACKOFF);
                wait
            }
        };
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = shared.wake.notified() => {}
        }
    }
}

/// One round: the status, and the job's file when it changed. Returns
/// whether a job is on (poll faster).
async fn poll(shared: &Shared, fresh: bool) -> Result<bool, String> {
    let c = &shared.config;
    if fresh {
        let version = call(c.request(reqwest::Method::GET, c.url("api/version")).timeout(POLL_TIMEOUT))
            .await
            .map_err(|e| e.to_string())?;
        println!(
            "Printer {}: PrusaLink {} (firmware {}, printer {})",
            c.name,
            version["server"].as_str().unwrap_or("?"),
            version["firmware"].as_str().unwrap_or("?"),
            version["printer"].as_str().unwrap_or("?")
        );
        shared.state.lock().unwrap().version = version;
    }
    let status = call(c.request(reqwest::Method::GET, c.url("api/v1/status")).timeout(POLL_TIMEOUT))
        .await
        .map_err(|e| e.to_string())?;
    let state = status["printer"]["state"].as_str().unwrap_or("").to_string();
    let job_id = status["job"]["id"].as_i64();

    // The job's file: when the job is new, and while the printer asks about
    // a file on its screen (the job id only moves on once it really starts).
    let known = shared.state.lock().unwrap().job.clone();
    let mut job = known.clone();
    if let Some(id) = job_id {
        if known.as_ref().is_none_or(|j| j.id != id) || state == "ATTENTION" {
            let body = call(c.request(reqwest::Method::GET, c.url("api/v1/job")).timeout(POLL_TIMEOUT))
                .await
                .map_err(|e| e.to_string())?;
            let file = body["file"]["display_name"]
                .as_str()
                .or_else(|| body["file"]["name"].as_str())
                .unwrap_or("")
                .to_string();
            if !file.is_empty() {
                job = Some(LastJob { id, file });
            }
        }
    } else if state == "IDLE" {
        // The finish screen was closed: the last job is history.
        job = None;
    }
    let active = job_id.is_some() || status.get("transfer").is_some_and(|t| !t.is_null());
    shared.update(|s| {
        s.connected = true;
        s.error = None;
        s.status = status;
        s.job = job;
        s.updated_at = Some(chrono::Utc::now().to_rfc3339());
    });
    Ok(active)
}
