//! The OctoPrint driver's link to one printer: OctoPrint's push socket
//! (`/sockjs/websocket`, raw JSON frames), REST for the state on connect and
//! for commands.
//!
//! On connect: `POST /api/login {"passive": true}` with the API key gives a
//! session; the socket gets `subscribe`, `auth` (`name:session`) and
//! `throttle`; then `current` messages (state flags, job, progress,
//! temperatures) and `event`s arrive. Events aren't replayed after a
//! reconnect, so `GET /api/printer` and `/api/job` seed the state first.
//!
//! OctoPrint keeps a finished or cancelled file selected and only says
//! "Operational", so how the last print ended comes from the events
//! (`PrintDone`, `PrintCancelled`, `PrintFailed{reason}`), or, after a
//! reconnect, from what the job's progress looks like.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use super::status::{self, Outcome, Snapshot};
use crate::db;
use crate::printer::hub::StatusSink;
use crate::printer::{Command, CommandError, Speed, http};

/// OctoPi serves OctoPrint on port 80 (haproxy); OctoPrint itself on 5000.
pub const DEFAULT_PORT: u16 = 80;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// OctoPrint sends `current` about every 2 s with `throttle` 4; silence
/// this long means the socket is dead.
const SILENCE: Duration = Duration::from_secs(30);
const PING_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct Config {
    pub name: String,
    pub base: url::Url,
    pub api_key: String,
}

impl Config {
    pub fn from_printer(p: &db::Printer) -> Option<Self> {
        let api_key = p.access_code.trim();
        if api_key.is_empty() {
            return None;
        }
        Some(Self {
            name: p.name.clone(),
            base: http::base_url(&p.address, DEFAULT_PORT)?,
            api_key: api_key.to_string(),
        })
    }

    pub fn same_endpoint(&self, other: &Self) -> bool {
        self.base == other.base && self.api_key == other.api_key
    }

    pub fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        http::client().request(method, http::join(&self.base, path)).header("X-Api-Key", &self.api_key)
    }

    fn ws_url(&self) -> url::Url {
        let mut url = http::join(&self.base, "sockjs/websocket");
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme).expect("ws and wss are valid schemes");
        url
    }
}

/// What a REST call to OctoPrint said: the JSON body (204 → null), or why not.
pub async fn call(request: reqwest::RequestBuilder) -> Result<Value, CommandError> {
    let response = request.send().await.map_err(|e| CommandError::Offline(http::explain(&e)))?;
    let code = response.status();
    let text = response.text().await.unwrap_or_default();
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if code.is_success() {
        return Ok(body);
    }
    let message = body["error"].as_str().map(String::from).unwrap_or_else(|| text.trim().to_string());
    Err(match code.as_u16() {
        401 | 403 => CommandError::Refused(format!("OctoPrint refused the API key ({code})")),
        _ => CommandError::Refused(if message.is_empty() { format!("HTTP {code}") } else { message }),
    })
}

#[derive(Default)]
pub(super) struct State {
    pub connected: bool,
    pub error: Option<String>,
    pub updated_at: Option<String>,
    /// The last `current` (or the REST equivalent): state, job, progress.
    pub current: Value,
    /// Last known temperatures (`current.temps` can be empty).
    pub temps: Value,
    /// How the last print of `current.job.file.path` ended, from events.
    pub outcome: Option<(String, Outcome)>,
    /// The speed factor we set during this print (OctoPrint can't report it).
    pub speed_percent: Option<i64>,
}

impl State {
    fn flags(&self) -> &Value {
        &self.current["state"]["flags"]
    }

    /// Printing, paused or on its way in or out of either.
    pub fn busy(&self) -> bool {
        let f = self.flags();
        ["printing", "paused", "pausing", "resuming", "cancelling", "finishing", "starting"]
            .iter()
            .any(|k| f[k].as_bool() == Some(true))
    }
}

struct Shared {
    config: Config,
    sink: StatusSink,
    state: Mutex<State>,
}

impl Shared {
    fn update(&self, change: impl FnOnce(&mut State)) {
        let summary = {
            let mut s = self.state.lock().unwrap();
            change(&mut s);
            status::summarize(&Snapshot { state: &s })
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
    println!("Printer {}: connecting to OctoPrint at {}", config.name, config.base);
    let shared = Arc::new(Shared { config, sink, state: Mutex::new(State::default()) });
    let task = tokio::spawn(run(shared.clone()));
    (Handle { shared }, task)
}

impl Handle {
    pub fn config(&self) -> &Config {
        &self.shared.config
    }

    /// Can a print start now?
    pub fn check_idle(&self) -> Result<(), String> {
        let s = self.shared.state.lock().unwrap();
        if !s.connected {
            return Err(format!("the printer is offline: {}", s.error.clone().unwrap_or_default()));
        }
        if s.busy() {
            return Err(format!("the printer is busy ({})", s.current["state"]["text"].as_str().unwrap_or("printing")));
        }
        if s.flags()["operational"].as_bool() != Some(true) {
            return Err("OctoPrint isn't connected to the printer".to_string());
        }
        Ok(())
    }

    fn require(&self, what: &str, ok: impl Fn(&Value) -> bool) -> Result<(), CommandError> {
        let s = self.shared.state.lock().unwrap();
        if !s.connected {
            return Err(CommandError::Offline(s.error.clone().unwrap_or_else(|| "not connected yet".into())));
        }
        if ok(s.flags()) {
            Ok(())
        } else {
            let text = s.current["state"]["text"].as_str().unwrap_or("idle").to_ascii_lowercase();
            Err(CommandError::Refused(format!("can't {what}: the printer is {text}")))
        }
    }

    pub async fn command(&self, command: &Command) -> Result<Option<Value>, CommandError> {
        let c = &self.shared.config;
        let is = |f: &Value, k: &str| f[k].as_bool() == Some(true);
        let post = |path: &str, body: Value| c.request(reqwest::Method::POST, path).json(&body);
        let request = match command {
            Command::Pause => {
                self.require("pause", |f| is(f, "printing"))?;
                post("api/job", json!({"command": "pause", "action": "pause"}))
            }
            Command::Resume => {
                self.require("resume", |f| is(f, "paused"))?;
                post("api/job", json!({"command": "pause", "action": "resume"}))
            }
            Command::Stop => {
                self.require("stop", |f| is(f, "printing") || is(f, "paused") || is(f, "pausing"))?;
                post("api/job", json!({"command": "cancel"}))
            }
            Command::Speed(speed) => {
                // An integer is a percent; a float would be taken as a fraction.
                let percent: u16 = match speed {
                    Speed::Percent(p) => (*p).clamp(10, 300),
                    Speed::Level(1) => 50,
                    Speed::Level(2) => 100,
                    Speed::Level(3) => 124,
                    Speed::Level(4) => 166,
                    Speed::Level(_) => return Err(CommandError::Unsupported("set that speed".into())),
                };
                call(post("api/printer/printhead", json!({"command": "feedrate", "factor": percent}))).await?;
                self.shared.update(|s| s.speed_percent = Some(percent as i64));
                return Ok(Some(json!("ok")));
            }
            Command::Heat { nozzle, bed } => {
                call(post("api/printer/tool", json!({"command": "target", "targets": {"tool0": nozzle}}))).await?;
                let has_bed = self.shared.state.lock().unwrap().temps.get("bed").is_some();
                if has_bed {
                    call(post("api/printer/bed", json!({"command": "target", "target": bed}))).await?;
                }
                return Ok(Some(json!("ok")));
            }
        };
        call(request).await.map(|_| Some(json!("ok")))
    }

    /// OctoPrint's state as we hold it, for debugging.
    pub fn raw(&self) -> Option<Value> {
        let s = self.shared.state.lock().unwrap();
        (!s.current.is_null()).then(|| {
            json!({"current": s.current, "temps": s.temps,
                   "outcome": s.outcome.as_ref().map(|(p, o)| json!({"path": p, "outcome": format!("{o:?}")}))})
        })
    }
}

async fn run(shared: Arc<Shared>) {
    let name = shared.config.name.clone();
    let mut backoff = Duration::from_secs(2);
    let mut failures: u32 = 0;
    loop {
        let why = match connect(&shared).await {
            Ok(ws) => {
                println!(
                    "Printer {name}: connected{}",
                    if failures > 0 { format!(" after {failures} failed attempts") } else { String::new() }
                );
                failures = 0;
                backoff = Duration::from_secs(2);
                session(&shared, ws).await
            }
            Err(e) => e,
        };
        failures += 1;
        eprintln!(
            "Printer {name}: OctoPrint at {} unreachable (attempt {failures}): {why}; retrying in {}s",
            shared.config.base,
            backoff.as_secs()
        );
        shared.update(|s| {
            s.connected = false;
            s.error = Some(why);
        });
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
type Ws = tokio_tungstenite::WebSocketStream<Box<dyn Stream>>;

/// Log in, read the state over REST, open and authenticate the socket.
async fn connect(shared: &Shared) -> Result<Ws, String> {
    let c = &shared.config;
    let login = call(c.request(reqwest::Method::POST, "api/login").json(&json!({"passive": true})))
        .await
        .map_err(|e| match e {
            CommandError::Refused(m) if m.contains("API key") || m.contains("403") => {
                "OctoPrint refused the API key: check it in OctoPrint (User Settings → Application Keys)".to_string()
            }
            CommandError::Refused(m) => format!("{m} (is this OctoPrint? the address may need :5000)"),
            other => other.to_string(),
        })?;
    let auth = format!(
        "{}:{}",
        login["name"].as_str().unwrap_or_default(),
        login["session"].as_str().ok_or("OctoPrint gave no session")?
    );

    // The state now: the socket only says what changes from here on.
    let printer = c.request(reqwest::Method::GET, "api/printer").send().await.map_err(|e| http::explain(&e))?;
    let printer_state: Value = if printer.status() == 409 {
        json!({"state": {"text": "Offline", "flags": {"closedOrError": true}}})
    } else {
        printer.json().await.unwrap_or(Value::Null)
    };
    let job = call(c.request(reqwest::Method::GET, "api/job")).await.unwrap_or(Value::Null);
    shared.update(|s| {
        s.connected = true;
        s.error = None;
        s.current = json!({"state": printer_state["state"], "job": job["job"], "progress": job["progress"]});
        if let Some(t) = printer_state.get("temperature") {
            s.temps = t.clone();
        }
        // After a reconnect the events of the last print are gone: judge by
        // what's left (a finished file stays at 100 %, a cancelled one at
        // no progress).
        let path = job["job"]["file"]["path"].as_str().unwrap_or("").to_string();
        if !path.is_empty() && !s.busy() && s.outcome.as_ref().is_none_or(|(p, _)| *p != path) {
            let completion = job["progress"]["completion"].as_f64();
            s.outcome = match completion {
                Some(c) if c >= 99.9 => Some((path, Outcome::Done)),
                None => Some((path, Outcome::Unknown)),
                Some(_) => None,
            };
        }
        s.updated_at = Some(chrono::Utc::now().to_rfc3339());
    });

    let url = c.ws_url();
    let request = url.as_str().into_client_request().map_err(|e| e.to_string())?;
    let host = url.host_str().unwrap_or_default().to_string();
    let port = url.port_or_known_default().unwrap_or(DEFAULT_PORT);
    let open = async {
        let tcp = tokio::net::TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|e| format!("can't connect to {host}:{port}: {e}"))?;
        let stream: Box<dyn Stream> = if url.scheme() == "wss" {
            let name = tokio_rustls::rustls::pki_types::ServerName::try_from(host.clone()).map_err(|e| e.to_string())?;
            Box::new(
                tokio_rustls::TlsConnector::from(Arc::new(crate::printer::tls::https_config()))
                    .connect(name, tcp)
                    .await
                    .map_err(|e| format!("TLS: {e}"))?,
            )
        } else {
            Box::new(tcp)
        };
        // No Origin header: OctoPrint checks it only when present.
        tokio_tungstenite::client_async(request, stream).await.map(|(ws, _)| ws).map_err(|e| e.to_string())
    };
    let mut ws = tokio::time::timeout(CONNECT_TIMEOUT, open).await.map_err(|_| "timed out".to_string())??;
    for message in [
        json!({"subscribe": {"state": {"logs": false, "messages": false}, "events": true, "plugins": false}}),
        json!({ "auth": auth }),
        json!({"throttle": 4}),
    ] {
        ws.send(Message::Text(message.to_string().into())).await.map_err(|e| e.to_string())?;
    }
    Ok(ws)
}

/// Run one socket until it ends; returns why.
async fn session(shared: &Shared, ws: Ws) -> String {
    let (mut write, mut read) = ws.split();
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await;
    let mut last_heard = tokio::time::Instant::now();
    loop {
        tokio::select! {
            incoming = read.next() => {
                let text = match incoming {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(_))) | None => return "OctoPrint closed the connection".into(),
                    Some(Ok(_)) => { last_heard = tokio::time::Instant::now(); continue; }
                    Some(Err(e)) => return e.to_string(),
                };
                last_heard = tokio::time::Instant::now();
                let Ok(message) = serde_json::from_str::<Value>(&text) else { continue };
                if message.get("reauthRequired").is_some() {
                    return "OctoPrint asked to log in again".into();
                }
                handle_message(shared, &message);
            }
            _ = ping.tick() => {
                if last_heard.elapsed() > SILENCE {
                    return "OctoPrint stopped sending".into();
                }
                if write.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return "the connection dropped".into();
                }
            }
        }
    }
}

fn handle_message(shared: &Shared, message: &Value) {
    if let Some(current) = message.get("current").or_else(|| message.get("history")) {
        shared.update(|s| {
            for key in ["state", "job", "progress"] {
                if let Some(v) = current.get(key) {
                    s.current[key] = v.clone();
                }
            }
            if let Some(last) = current["temps"].as_array().and_then(|t| t.last()) {
                s.temps = last.clone();
            }
            s.updated_at = Some(chrono::Utc::now().to_rfc3339());
        });
    }
    if let Some(event) = message.get("event") {
        let kind = event["type"].as_str().unwrap_or("");
        let payload = &event["payload"];
        let path = payload["path"].as_str().unwrap_or("").to_string();
        let outcome = match kind {
            "PrintStarted" => {
                shared.update(|s| {
                    s.outcome = None;
                    s.speed_percent = None;
                });
                return;
            }
            "PrintDone" => Outcome::Done,
            "PrintCancelled" => Outcome::Cancelled,
            // A cancel ends with PrintFailed{reason: "cancelled"} too.
            "PrintFailed" if payload["reason"] == "cancelled" => Outcome::Cancelled,
            "PrintFailed" => Outcome::Failed(payload["error"].as_str().unwrap_or("").trim().to_string()),
            "Error" => {
                let error = payload["error"].as_str().unwrap_or("").trim().to_string();
                if !error.is_empty() {
                    eprintln!("Printer {}: OctoPrint error: {error}", shared.config.name);
                }
                return;
            }
            _ => return,
        };
        println!("Printer {}: {kind} {path}", shared.config.name);
        shared.update(|s| {
            // A cancel's PrintFailed mustn't overwrite the PrintCancelled.
            if !matches!(&s.outcome, Some((p, Outcome::Cancelled)) if *p == path) {
                s.outcome = Some((path, outcome));
            }
        });
    }
}
