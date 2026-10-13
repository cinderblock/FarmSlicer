//! The Moonraker driver's link to one printer: a WebSocket speaking
//! JSON-RPC 2.0 (`/websocket`), the printer objects it reports, and
//! request/response for commands.
//!
//! On connect: `server.connection.identify`, `server.info`; once Klipper is
//! `ready`, `printer.objects.list` and `printer.objects.subscribe` (its reply
//! is the full state; `notify_status_update` deltas follow). Klipper
//! restarting (`notify_klippy_ready` / `_disconnected` / `_shutdown`) starts
//! that over. The file being printed is looked up once
//! (`server.files.metadata`) for its time estimate and layer count.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use super::status::{self, FileInfo, Snapshot};
use crate::db;
use crate::printer::hub::StatusSink;
use crate::printer::{Command, CommandError, Speed, http};

/// Moonraker's own port; behind nginx it is 80.
pub const DEFAULT_PORT: u16 = 7125;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Ask for Klipper's state this often while it isn't ready.
const KLIPPY_POLL: Duration = Duration::from_secs(2);
const PING_INTERVAL: Duration = Duration::from_secs(30);
/// No message at all for this long: the connection is dead.
const SILENCE: Duration = Duration::from_secs(75);
/// How long commands wait for an answer. `printer.gcode.script` answers
/// when the G-code is done, so only quick commands are sent.
pub const COMMAND_WAIT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct Config {
    pub name: String,
    pub base: url::Url,
    pub api_key: Option<String>,
}

impl Config {
    pub fn from_printer(p: &db::Printer) -> Option<Self> {
        Some(Self {
            name: p.name.clone(),
            base: http::base_url(&p.address, DEFAULT_PORT)?,
            api_key: Some(p.access_code.trim().to_string()).filter(|k| !k.is_empty()),
        })
    }

    pub fn same_endpoint(&self, other: &Self) -> bool {
        self.base == other.base && self.api_key == other.api_key
    }

    fn ws_url(&self) -> url::Url {
        let mut url = http::join(&self.base, "websocket");
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme).expect("ws and wss are valid schemes");
        url
    }

    /// An HTTP request to the printer, with the API key if there is one.
    pub fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let r = http::client().request(method, http::join(&self.base, path));
        match &self.api_key {
            Some(key) => r.header("X-Api-Key", key),
            None => r,
        }
    }
}

#[derive(Default)]
struct State {
    connected: bool,
    error: Option<String>,
    updated_at: Option<String>,
    klippy_state: String,
    klippy_message: String,
    objects: Map<String, Value>,
    file: Option<FileInfo>,
}

impl State {
    fn print_state(&self) -> &str {
        self.objects.get("print_stats").and_then(|p| p["state"].as_str()).unwrap_or("")
    }

    fn klippy(&self) -> &str {
        self.objects
            .get("webhooks")
            .and_then(|w| w["state"].as_str())
            .unwrap_or(&self.klippy_state)
    }
}

struct Request {
    method: String,
    params: Value,
    reply: oneshot::Sender<Result<Value, CommandError>>,
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
            status::summarize(&Snapshot {
                connected: s.connected,
                error: s.error.clone(),
                updated_at: s.updated_at.clone(),
                klippy_state: &s.klippy_state,
                klippy_message: &s.klippy_message,
                objects: &s.objects,
                file: s.file.as_ref(),
            })
        };
        self.sink.publish(summary);
    }
}

/// Commands for one printer. Cheap to clone.
#[derive(Clone)]
pub struct Handle {
    shared: Arc<Shared>,
    requests: mpsc::Sender<Request>,
}

pub fn start(config: Config, sink: StatusSink) -> (Handle, JoinHandle<()>) {
    println!("Printer {}: connecting to Moonraker at {}", config.name, config.base);
    let shared = Arc::new(Shared { config, sink, state: Mutex::new(State::default()) });
    let (tx, rx) = mpsc::channel(32);
    let task = tokio::spawn(run(shared.clone(), rx));
    (Handle { shared, requests: tx }, task)
}

impl Handle {
    pub fn config(&self) -> &Config {
        &self.shared.config
    }

    /// Call a JSON-RPC method. `Ok(None)`: no answer within `wait`.
    pub async fn call(&self, method: &str, params: Value, wait: Duration) -> Result<Option<Value>, CommandError> {
        {
            let s = self.shared.state.lock().unwrap();
            if !s.connected {
                return Err(CommandError::Offline(s.error.clone().unwrap_or_else(|| "not connected yet".into())));
            }
        }
        let (reply, rx) = oneshot::channel();
        let request = Request { method: method.to_string(), params, reply };
        self.requests
            .send(request)
            .await
            .map_err(|_| CommandError::Offline("the link stopped".into()))?;
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(result)) => result.map(Some),
            Ok(Err(_)) => Err(CommandError::Offline("the connection dropped".into())),
            Err(_) => Ok(None),
        }
    }

    /// Klipper's print state now (`standby`, `printing`, ...), and whether
    /// Klipper is ready.
    pub fn print_state(&self) -> (String, bool) {
        let s = self.shared.state.lock().unwrap();
        (s.print_state().to_string(), s.connected && s.klippy() == "ready")
    }

    /// Can a print start now? Klipper itself doesn't refuse a start while a
    /// print is paused: it replaces the paused job.
    pub fn check_idle(&self) -> Result<(), String> {
        let (state, ready) = self.print_state();
        if !ready {
            let s = self.shared.state.lock().unwrap();
            if !s.connected {
                return Err(format!("the printer is offline: {}", s.error.clone().unwrap_or_default()));
            }
            return Err(format!("Klipper isn't ready ({})", s.klippy()));
        }
        match state.as_str() {
            "printing" | "paused" => Err(format!("the printer is {state}")),
            _ => Ok(()),
        }
    }

    pub async fn command(&self, command: &Command) -> Result<Option<Value>, CommandError> {
        let (state, _) = self.print_state();
        let busy = matches!(state.as_str(), "printing" | "paused");
        let gcode = |script: String| ("printer.gcode.script", json!({ "script": script }));
        let (method, params) = match command {
            Command::Pause if state == "printing" => ("printer.print.pause", json!({})),
            Command::Resume if state == "paused" => ("printer.print.resume", json!({})),
            Command::Stop if busy => ("printer.print.cancel", json!({})),
            Command::Pause | Command::Resume | Command::Stop => {
                return Err(CommandError::Refused(format!("the printer is {}", if state.is_empty() { "idle" } else { &state })));
            }
            Command::Speed(Speed::Percent(p)) => gcode(format!("M220 S{p}")),
            // Bambu's levels, as speed factors.
            Command::Speed(Speed::Level(l)) => match l {
                1 => gcode("M220 S50".into()),
                2 => gcode("M220 S100".into()),
                3 => gcode("M220 S124".into()),
                4 => gcode("M220 S166".into()),
                _ => return Err(CommandError::Unsupported("set that speed".into())),
            },
            Command::Heat { nozzle, bed } => {
                let has_bed = self.shared.state.lock().unwrap().objects.contains_key("heater_bed");
                let mut script = format!("SET_HEATER_TEMPERATURE HEATER=extruder TARGET={nozzle}");
                if has_bed {
                    script.push_str(&format!("\nSET_HEATER_TEMPERATURE HEATER=heater_bed TARGET={bed}"));
                }
                gcode(script)
            }
        };
        self.call(method, params, COMMAND_WAIT).await
    }

    /// The merged printer objects, for debugging.
    pub fn raw(&self) -> Option<Value> {
        let s = self.shared.state.lock().unwrap();
        (!s.objects.is_empty()).then(|| {
            json!({"klippy_state": s.klippy(), "objects": s.objects, "file": s.file.as_ref().map(|f| &f.filename)})
        })
    }
}

/// What a pending request's answer is for.
enum Pending {
    Identify,
    ServerInfo,
    ObjectsList,
    Subscribe,
    Metadata(String),
    Caller(oneshot::Sender<Result<Value, CommandError>>),
}

async fn run(shared: Arc<Shared>, mut requests: mpsc::Receiver<Request>) {
    let name = shared.config.name.clone();
    let mut backoff = Duration::from_secs(2);
    let mut failures: u32 = 0;
    loop {
        let why = match connect(&shared.config).await {
            Ok(ws) => {
                if failures > 0 {
                    println!("Printer {name}: connected after {failures} failed attempts");
                } else {
                    println!("Printer {name}: connected");
                }
                failures = 0;
                backoff = Duration::from_secs(2);
                shared.update(|s| {
                    s.connected = true;
                    s.error = None;
                });
                session(&shared, ws, &mut requests).await
            }
            Err(e) => e,
        };
        failures += 1;
        eprintln!(
            "Printer {name}: Moonraker at {} unreachable (attempt {failures}): {why}; retrying in {}s",
            shared.config.base,
            backoff.as_secs()
        );
        shared.update(|s| {
            s.connected = false;
            s.error = Some(why);
            s.objects.clear();
            s.file = None;
        });
        // Callers get an answer while we wait.
        let sleep = tokio::time::sleep(backoff);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => break,
                request = requests.recv() => match request {
                    Some(r) => { let _ = r.reply.send(Err(CommandError::Offline("not connected".into()))); }
                    None => return,
                },
            }
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
type Ws = tokio_tungstenite::WebSocketStream<Box<dyn Stream>>;

async fn connect(config: &Config) -> Result<Ws, String> {
    let url = config.ws_url();
    let mut request = url.as_str().into_client_request().map_err(|e| e.to_string())?;
    if let Some(key) = &config.api_key {
        request
            .headers_mut()
            .insert("X-Api-Key", key.parse().map_err(|_| "the API key isn't a valid header value".to_string())?);
    }
    let host = url.host_str().unwrap_or_default().to_string();
    let port = url.port_or_known_default().unwrap_or(DEFAULT_PORT);
    let attempt = async {
        let tcp = tokio::net::TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|e| format!("can't connect to {host}:{port}: {e}"))?;
        let stream: Box<dyn Stream> = if url.scheme() == "wss" {
            let name = tokio_rustls::rustls::pki_types::ServerName::try_from(host.clone())
                .map_err(|e| e.to_string())?;
            let tls = tokio_rustls::TlsConnector::from(Arc::new(crate::printer::tls::https_config()))
                .connect(name, tcp)
                .await
                .map_err(|e| format!("TLS: {e}"))?;
            Box::new(tls)
        } else {
            Box::new(tcp)
        };
        tokio_tungstenite::client_async(request, stream).await.map(|(ws, _)| ws).map_err(|e| match e {
            tokio_tungstenite::tungstenite::Error::Http(r) if r.status() == 401 || r.status() == 403 => {
                "Moonraker refused the connection (401): set the printer's API key, or trust this server in moonraker.conf"
                    .to_string()
            }
            tokio_tungstenite::tungstenite::Error::Http(r) => {
                format!("HTTP {} at {url}: is this Moonraker? (the address may need :7125)", r.status())
            }
            other => other.to_string(),
        })
    };
    tokio::time::timeout(CONNECT_TIMEOUT, attempt).await.map_err(|_| "timed out".to_string())?
}

/// Run one connection until it ends; returns why.
async fn session(shared: &Arc<Shared>, ws: Ws, requests: &mut mpsc::Receiver<Request>) -> String {
    let (mut write, mut read) = ws.split();
    let mut next_id: u64 = 1;
    let mut pending: HashMap<u64, Pending> = HashMap::new();
    let mut outbox: Vec<(String, Value, Pending)> = vec![
        (
            "server.connection.identify".into(),
            json!({"client_name": "FarmSlicer", "version": env!("CARGO_PKG_VERSION"), "type": "other",
                   "url": "https://github.com/cinderblock/FarmSlicer",
                   "api_key": shared.config.api_key}),
            Pending::Identify,
        ),
        ("server.info".into(), json!({}), Pending::ServerInfo),
    ];
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await;
    let mut klippy_poll = tokio::time::interval(KLIPPY_POLL);
    let mut last_heard = tokio::time::Instant::now();

    let result = loop {
        for (method, params, why) in outbox.drain(..) {
            let id = next_id;
            next_id += 1;
            let message = json!({"jsonrpc": "2.0", "method": method, "params": params, "id": id});
            if let Err(e) = write.send(Message::Text(message.to_string().into())).await {
                if let Pending::Caller(tx) = why {
                    let _ = tx.send(Err(CommandError::Offline(e.to_string())));
                }
                return e.to_string();
            }
            pending.insert(id, why);
        }

        tokio::select! {
            incoming = read.next() => {
                let text = match incoming {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(frame))) => {
                        break frame.map(|f| format!("Moonraker closed the connection: {}", f.reason)).unwrap_or_else(|| "Moonraker closed the connection".into());
                    }
                    Some(Ok(_)) => { last_heard = tokio::time::Instant::now(); continue; }
                    Some(Err(e)) => break e.to_string(),
                    None => break "the connection closed".to_string(),
                };
                last_heard = tokio::time::Instant::now();
                let Ok(message) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(id) = message["id"].as_u64() {
                    if let Some(why) = pending.remove(&id) {
                        handle_response(shared, why, &message, &mut outbox);
                    }
                } else if let Some(method) = message["method"].as_str() {
                    handle_notification(shared, method, &message["params"], &mut outbox);
                }
            }
            request = requests.recv() => match request {
                Some(r) => outbox.push((r.method, r.params, Pending::Caller(r.reply))),
                None => break "the link stopped".to_string(),
            },
            _ = ping.tick() => {
                if last_heard.elapsed() > SILENCE {
                    break "Moonraker stopped answering".to_string();
                }
                if write.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break "the connection dropped".to_string();
                }
            }
            _ = klippy_poll.tick() => {
                let waiting = {
                    let s = shared.state.lock().unwrap();
                    s.klippy() != "ready" || !s.objects.contains_key("print_stats")
                };
                let asking = pending.values().any(|p| matches!(p, Pending::ServerInfo | Pending::ObjectsList | Pending::Subscribe));
                if waiting && !asking {
                    outbox.push(("server.info".into(), json!({}), Pending::ServerInfo));
                }
            }
        }
    };
    for (_, why) in pending {
        if let Pending::Caller(tx) = why {
            let _ = tx.send(Err(CommandError::Offline(result.clone())));
        }
    }
    let _ = write.send(Message::Close(None)).await;
    result
}

fn rpc_error(message: &Value) -> Option<String> {
    let e = message.get("error")?;
    Some(e["message"].as_str().unwrap_or("error").trim().to_string())
}

fn handle_response(shared: &Shared, why: Pending, message: &Value, outbox: &mut Vec<(String, Value, Pending)>) {
    let result = &message["result"];
    match why {
        Pending::Caller(tx) => {
            let _ = tx.send(match rpc_error(message) {
                Some(e) => Err(CommandError::Refused(e)),
                None => Ok(result.clone()),
            });
        }
        Pending::Identify => {
            if let Some(e) = rpc_error(message) {
                eprintln!("Printer {}: identify: {e}", shared.config.name);
            }
        }
        Pending::ServerInfo => {
            if let Some(e) = rpc_error(message) {
                eprintln!("Printer {}: server.info: {e}", shared.config.name);
                return;
            }
            let klippy = result["klippy_state"].as_str().unwrap_or("disconnected").to_string();
            let ready = klippy == "ready";
            shared.update(|s| {
                // Klipper gone or restarting: its last word no longer holds.
                // (After a shutdown `webhooks` keeps the reason.)
                if matches!(klippy.as_str(), "disconnected" | "startup") {
                    s.objects.remove("webhooks");
                }
                s.klippy_state = klippy;
            });
            if ready {
                outbox.push(("printer.objects.list".into(), json!({}), Pending::ObjectsList));
            }
        }
        Pending::ObjectsList => {
            let available: Vec<String> = result["objects"]
                .as_array()
                .map(|a| a.iter().filter_map(|o| o.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let objects = status::subscription(&available);
            outbox.push(("printer.objects.subscribe".into(), json!({ "objects": objects }), Pending::Subscribe));
        }
        Pending::Subscribe => {
            if let Some(e) = rpc_error(message) {
                eprintln!("Printer {}: subscribe: {e}", shared.config.name);
                return;
            }
            if let Some(status) = result["status"].as_object() {
                shared.update(|s| {
                    s.objects = status.clone();
                    s.updated_at = Some(chrono::Utc::now().to_rfc3339());
                });
                want_metadata(shared, outbox);
            }
        }
        Pending::Metadata(filename) => {
            let info = FileInfo::from_metadata(&filename, if rpc_error(message).is_some() { &Value::Null } else { result });
            shared.update(|s| s.file = Some(info));
        }
    }
}

/// Look up the file being printed, once per file.
fn want_metadata(shared: &Shared, outbox: &mut Vec<(String, Value, Pending)>) {
    let filename = {
        let s = shared.state.lock().unwrap();
        let name = s.objects.get("print_stats").and_then(|p| p["filename"].as_str()).unwrap_or("").to_string();
        if name.is_empty() || s.file.as_ref().is_some_and(|f| f.filename == name) {
            return;
        }
        name
    };
    // Placeholder until the answer, so it's asked once.
    shared.state.lock().unwrap().file = Some(FileInfo { filename: filename.clone(), ..Default::default() });
    outbox.push(("server.files.metadata".into(), json!({ "filename": filename }), Pending::Metadata(filename)));
}

fn handle_notification(shared: &Shared, method: &str, params: &Value, outbox: &mut Vec<(String, Value, Pending)>) {
    match method {
        "notify_status_update" => {
            if let Some(delta) = params[0].as_object() {
                shared.update(|s| {
                    status::merge(&mut s.objects, delta);
                    s.updated_at = Some(chrono::Utc::now().to_rfc3339());
                });
                want_metadata(shared, outbox);
            }
        }
        "notify_klippy_ready" => {
            println!("Printer {}: Klipper ready", shared.config.name);
            outbox.push(("server.info".into(), json!({}), Pending::ServerInfo));
        }
        "notify_klippy_shutdown" | "notify_klippy_disconnected" => {
            let state = if method == "notify_klippy_shutdown" { "shutdown" } else { "disconnected" };
            println!("Printer {}: Klipper {state}", shared.config.name);
            shared.update(|s| {
                s.klippy_state = state.to_string();
                if state == "disconnected" {
                    s.objects.remove("webhooks");
                }
            });
        }
        _ => {}
    }
}
