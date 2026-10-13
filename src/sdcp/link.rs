//! The SDCP driver's link to one Elegoo Centauri Carbon: a WebSocket on port
//! 3030 (`/websocket`, no auth), JSON envelopes, request/response by
//! `RequestID`, status pushes on `sdcp/status/<mainboard>`.
//!
//! The printer runs everything (screen, network, motion) in one process, and
//! a command it doesn't expect can crash it mid-print: only the commands and
//! payload shapes Elegoo's own clients send go out (see
//! `plans/printer-drivers/sdcp.md` §5). Status pushes may stop while the
//! printer is idle, so the link asks (Cmd 0) whenever it hasn't heard for a
//! while. The printer takes five WebSocket clients: one link per printer.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

use super::status;
use crate::db;
use crate::printer::hub::StatusSink;
use crate::printer::{Command, CommandError, Speed};

pub const WS_PORT: u16 = 3030;
pub const HTTP_PORT: u16 = 80;
pub const VIDEO_PORT: u16 = 3031;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const HEARTBEAT: Duration = Duration::from_secs(15);
/// Ask for the status when nothing came for this long.
const QUIET_ACTIVE: Duration = Duration::from_secs(5);
const QUIET_IDLE: Duration = Duration::from_secs(20);
/// No answer to anything (not even `pong`) for this long: dead.
const SILENCE: Duration = Duration::from_secs(45);
pub const COMMAND_WAIT: Duration = Duration::from_secs(10);

pub mod cmd {
    pub const STATUS: i64 = 0;
    pub const ATTRIBUTES: i64 = 1;
    pub const START: i64 = 128;
    pub const PAUSE: i64 = 129;
    pub const STOP: i64 = 130;
    pub const RESUME: i64 = 131;
    pub const CAMERA: i64 = 386;
    pub const SETTINGS: i64 = 403;
}

/// Where the printer listens: its host, and the three ports (fixed on real
/// printers; `host?ws=..&http=..&video=..` overrides them, for port
/// forwarding and tests).
#[derive(Debug, Clone, PartialEq)]
pub struct Endpoint {
    pub host: String,
    pub ws_port: u16,
    pub http_port: u16,
    pub video_port: u16,
}

impl Endpoint {
    pub fn parse(address: &str) -> Option<Self> {
        let address = address.trim();
        let address = address.strip_prefix("http://").unwrap_or(address).trim_end_matches('/');
        let (host, query) = address.split_once('?').unwrap_or((address, ""));
        let (host, http_port) = match host.rsplit_once(':') {
            Some((h, p)) if !h.ends_with(':') && p.bytes().all(|b| b.is_ascii_digit()) => (h, p.parse().ok()?),
            _ => (host, HTTP_PORT),
        };
        if host.is_empty() {
            return None;
        }
        let mut e = Self { host: host.to_string(), ws_port: WS_PORT, http_port, video_port: VIDEO_PORT };
        for pair in query.split('&').filter(|p| !p.is_empty()) {
            let (k, v) = pair.split_once('=')?;
            let port: u16 = v.parse().ok()?;
            match k {
                "ws" => e.ws_port = port,
                "http" => e.http_port = port,
                "video" => e.video_port = port,
                _ => return None,
            }
        }
        Some(e)
    }

    pub fn http(&self, path: &str) -> String {
        format!("http://{}:{}/{}", self.host, self.http_port, path.trim_start_matches('/'))
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub name: String,
    pub endpoint: Endpoint,
    /// The mainboard id, if the admin gave it; learnt from the printer
    /// otherwise.
    pub mainboard_id: Option<String>,
}

impl Config {
    pub fn from_printer(p: &db::Printer) -> Option<Self> {
        Some(Self {
            name: p.name.clone(),
            endpoint: Endpoint::parse(&p.address)?,
            mainboard_id: Some(p.serial_number.trim().to_string()).filter(|s| !s.is_empty()),
        })
    }

    pub fn same_endpoint(&self, other: &Self) -> bool {
        self.endpoint == other.endpoint && self.mainboard_id == other.mainboard_id
    }
}

#[derive(Default)]
pub(super) struct State {
    connected: bool,
    error: Option<String>,
    updated_at: Option<String>,
    pub status: Map<String, Value>,
    /// Counts status frames, so a caller can wait for a fresh one.
    status_seq: u64,
    attributes: Map<String, Value>,
    mainboard_id: Option<String>,
}

struct Request {
    cmd: i64,
    data: Value,
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
            status::summarize(s.connected, s.error.clone(), s.updated_at.clone(), &s.status)
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
    println!(
        "Printer {}: connecting to SDCP at {}:{}",
        config.name, config.endpoint.host, config.endpoint.ws_port
    );
    let shared = Arc::new(Shared { config, sink, state: Mutex::new(State::default()) });
    let (tx, rx) = mpsc::channel(16);
    let task = tokio::spawn(run(shared.clone(), rx));
    (Handle { shared, requests: tx }, task)
}

impl Handle {
    pub fn config(&self) -> &Config {
        &self.shared.config
    }

    /// Send one SDCP command and wait for its `Ack`. `Ok(None)`: no answer
    /// in time.
    pub async fn call(&self, cmd: i64, data: Value, wait: Duration) -> Result<Option<Value>, CommandError> {
        {
            let s = self.shared.state.lock().unwrap();
            if !s.connected {
                return Err(CommandError::Offline(s.error.clone().unwrap_or_else(|| "not connected yet".into())));
            }
        }
        let (reply, rx) = oneshot::channel();
        self.requests
            .send(Request { cmd, data, reply })
            .await
            .map_err(|_| CommandError::Offline("the link stopped".into()))?;
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(result)) => result.map(Some),
            Ok(Err(_)) => Err(CommandError::Offline("the connection dropped".into())),
            Err(_) => Ok(None),
        }
    }

    /// The status as last merged.
    pub(super) fn status(&self) -> Map<String, Value> {
        self.shared.state.lock().unwrap().status.clone()
    }

    /// Ask for the status and wait for it: the printer acknowledges the
    /// request first and sends the status after.
    pub async fn refresh(&self) -> Map<String, Value> {
        let seen = self.shared.state.lock().unwrap().status_seq;
        if self.call(cmd::STATUS, json!({}), Duration::from_secs(5)).await.is_ok() {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
            while self.shared.state.lock().unwrap().status_seq == seen && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        self.status()
    }

    /// Can a print start now?
    pub fn check_idle(&self) -> Result<(), String> {
        let s = self.shared.state.lock().unwrap();
        if !s.connected {
            return Err(format!("the printer is offline: {}", s.error.clone().unwrap_or_default()));
        }
        if s.status.is_empty() {
            return Err("the printer hasn't reported its state yet".into());
        }
        match status::machine_state(&s.status) {
            0 if !status::has_code(&s.status, 1) => Ok(()),
            1 => Err("the printer is printing".into()),
            2 | 8 => Err("the printer is busy with a file".into()),
            _ => Err("the printer is busy".into()),
        }
    }

    pub async fn command(&self, command: &Command) -> Result<Option<Value>, CommandError> {
        let print = self.status().get("PrintInfo").and_then(|p| p["Status"].as_i64()).unwrap_or(0);
        let task = status::has_code(&self.status(), 1);
        let refuse = |what: &str| Err(CommandError::Refused(format!("can't {what} now")));
        let (cmd, data) = match command {
            Command::Pause if task && matches!(print, 13 | 12) => (cmd::PAUSE, json!({})),
            Command::Resume if task && print == 6 => (cmd::RESUME, json!({})),
            Command::Stop if task => (cmd::STOP, json!({})),
            Command::Pause => return refuse("pause"),
            Command::Resume => return refuse("resume"),
            Command::Stop => return refuse("stop"),
            Command::Speed(Speed::Level(l @ 1..=4)) => {
                (cmd::SETTINGS, json!({"PrintSpeedPct": status::SPEED_PRESETS[*l as usize - 1]}))
            }
            Command::Speed(_) => {
                return Err(CommandError::Unsupported("set that speed (silent, standard, sport or ludicrous)".into()));
            }
            Command::Heat { nozzle, bed } => (
                cmd::SETTINGS,
                json!({"TempTargetNozzle": nozzle.clamp(&0, &300), "TempTargetHotbed": bed.clamp(&0, &110)}),
            ),
        };
        let reply = self.call(cmd, data, COMMAND_WAIT).await?;
        if let Some(r) = &reply {
            check_ack(cmd, r)?;
        }
        Ok(reply)
    }

    /// The printer's state as held, for debugging.
    pub fn raw(&self) -> Option<Value> {
        let s = self.shared.state.lock().unwrap();
        (!s.status.is_empty()).then(|| json!({"status": s.status, "attributes": s.attributes, "mainboard_id": s.mainboard_id}))
    }
}

/// An `Ack` other than 0 as a refusal, in words where they're known.
pub fn check_ack(cmd: i64, data: &Value) -> Result<(), CommandError> {
    let ack = data["Ack"].as_i64().unwrap_or(0);
    if ack == 0 {
        return Ok(());
    }
    let why = match (cmd, ack) {
        (cmd::START, 1) => "the printer is busy",
        (cmd::START, 2) => "the file isn't on the printer",
        (cmd::START, 3) => "the file's MD5 didn't match",
        (cmd::START, 4) => "the printer couldn't read the file",
        (cmd::START, 5) => "wrong resolution",
        (cmd::START, 6) => "unknown file format",
        (cmd::START, 7) => "the file was sliced for another printer model",
        (cmd::CAMERA, 1) => "too many people are watching the camera",
        (cmd::CAMERA, 2) => "the printer has no camera",
        _ => "",
    };
    Err(CommandError::Refused(if why.is_empty() { format!("SDCP command {cmd} answered Ack {ack}") } else { why.to_string() }))
}

async fn run(shared: Arc<Shared>, mut requests: mpsc::Receiver<Request>) {
    let name = shared.config.name.clone();
    let e = &shared.config.endpoint;
    let url = format!("ws://{}:{}/websocket", e.host, e.ws_port);
    let mut backoff = Duration::from_secs(2);
    let mut failures: u32 = 0;
    loop {
        let attempt = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(url.as_str())).await;
        let why = match attempt {
            Ok(Ok((ws, _))) => {
                println!(
                    "Printer {name}: connected{}",
                    if failures > 0 { format!(" after {failures} failed attempts") } else { String::new() }
                );
                failures = 0;
                backoff = Duration::from_secs(2);
                shared.update(|s| {
                    s.connected = true;
                    s.error = None;
                });
                session(&shared, ws, &mut requests).await
            }
            Ok(Err(tokio_tungstenite::tungstenite::Error::Http(r))) if r.status() == 500 => {
                "the printer turned the connection down (it takes five clients: the Elegoo app, slicers, \
                 Home Assistant and the like count too)"
                    .to_string()
            }
            Ok(Err(e)) => e.to_string(),
            Err(_) => "timed out".to_string(),
        };
        failures += 1;
        eprintln!("Printer {name}: SDCP at {url} unreachable (attempt {failures}): {why}; retrying in {}s", backoff.as_secs());
        shared.update(|s| {
            s.connected = false;
            s.error = Some(why);
        });
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

fn envelope(cmd: i64, data: Value, request_id: &str, mainboard: &str) -> String {
    json!({
        "Id": "",
        "Data": {
            "Cmd": cmd,
            "Data": data,
            "RequestID": request_id,
            "MainboardID": mainboard,
            "TimeStamp": chrono::Utc::now().timestamp_millis(),
            // As Elegoo's own clients send it.
            "From": 1,
        },
        "Topic": format!("sdcp/request/{mainboard}"),
    })
    .to_string()
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn session(shared: &Arc<Shared>, ws: Ws, requests: &mut mpsc::Receiver<Request>) -> String {
    let (mut write, mut read) = ws.split();
    let mut pending: HashMap<String, (i64, Option<oneshot::Sender<Result<Value, CommandError>>>)> = HashMap::new();
    let mainboard = || {
        let s = shared.state.lock().unwrap();
        s.mainboard_id.clone().or_else(|| shared.config.mainboard_id.clone()).unwrap_or_default()
    };
    let new_id = || uuid::Uuid::new_v4().simple().to_string();

    // On connect: who it is, and how it is.
    for c in [cmd::ATTRIBUTES, cmd::STATUS] {
        let id = new_id();
        if let Err(e) = write.send(Message::Text(envelope(c, json!({}), &id, &mainboard()).into())).await {
            return e.to_string();
        }
        pending.insert(id, (c, None));
    }
    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await;
    let mut check = tokio::time::interval(Duration::from_secs(1));
    let mut last_heard = tokio::time::Instant::now();
    let mut last_status = tokio::time::Instant::now();
    let mut asked_status = tokio::time::Instant::now();

    let result = loop {
        tokio::select! {
            incoming = read.next() => {
                let text = match incoming {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(_))) | None => break "the printer closed the connection".to_string(),
                    Some(Ok(_)) => { last_heard = tokio::time::Instant::now(); continue; }
                    Some(Err(e)) => break e.to_string(),
                };
                last_heard = tokio::time::Instant::now();
                if text.trim() == "pong" {
                    continue;
                }
                // Some firmware puts the frame's length in front of it.
                let body = text.trim_start_matches(|c: char| c.is_ascii_digit());
                let Ok(message) = serde_json::from_str::<Value>(body) else { continue };
                let topic = message["Topic"].as_str().unwrap_or("");
                if let Some(id) = message["MainboardID"].as_str().or_else(|| message["Data"]["MainboardID"].as_str()) {
                    if !id.is_empty() {
                        let mut s = shared.state.lock().unwrap();
                        if s.mainboard_id.as_deref() != Some(id) {
                            s.mainboard_id = Some(id.to_string());
                        }
                    }
                }
                if topic.starts_with("sdcp/response/") || message["Data"]["RequestID"].is_string() && message.get("Status").is_none() {
                    let id = message["Data"]["RequestID"].as_str().unwrap_or("");
                    if let Some((c, reply)) = pending.remove(id) {
                        let data = message["Data"]["Data"].clone();
                        if let Some(reply) = reply {
                            let _ = reply.send(Ok(data));
                        } else if c == cmd::ATTRIBUTES {
                            if let Some(a) = data.get("Attributes").and_then(Value::as_object) {
                                shared.update(|s| s.attributes = a.clone());
                            }
                        }
                    }
                } else if let Some(st) = message.get("Status").or_else(|| message["Data"]["Data"].get("Status")).and_then(Value::as_object) {
                    last_status = tokio::time::Instant::now();
                    shared.update(|s| {
                        status::merge(&mut s.status, st);
                        s.status_seq += 1;
                        s.updated_at = Some(chrono::Utc::now().to_rfc3339());
                    });
                } else if let Some(a) = message.get("Attributes").and_then(Value::as_object) {
                    shared.update(|s| s.attributes = a.clone());
                } else if topic.starts_with("sdcp/error/") {
                    eprintln!("Printer {}: SDCP error {}", shared.config.name, message["Data"]["Data"]);
                }
            }
            request = requests.recv() => match request {
                Some(r) => {
                    let id = new_id();
                    if let Err(e) = write.send(Message::Text(envelope(r.cmd, r.data, &id, &mainboard()).into())).await {
                        let _ = r.reply.send(Err(CommandError::Offline(e.to_string())));
                        break e.to_string();
                    }
                    pending.insert(id, (r.cmd, Some(r.reply)));
                }
                None => break "the link stopped".to_string(),
            },
            _ = heartbeat.tick() => {
                if last_heard.elapsed() > SILENCE {
                    break "the printer stopped answering".to_string();
                }
                if write.send(Message::Text("ping".into())).await.is_err() {
                    break "the connection dropped".to_string();
                }
            }
            _ = check.tick() => {
                // Pushes may stop while idle: ask (often while the printer
                // is anything but plainly idle).
                let active = {
                    let s = shared.state.lock().unwrap();
                    status::has_code(&s.status, 1) || status::machine_state(&s.status) != 0
                };
                let quiet = if active { QUIET_ACTIVE } else { QUIET_IDLE };
                if last_status.elapsed() > quiet && asked_status.elapsed() > quiet {
                    asked_status = tokio::time::Instant::now();
                    let id = new_id();
                    if write.send(Message::Text(envelope(cmd::STATUS, json!({}), &id, &mainboard()).into())).await.is_err() {
                        break "the connection dropped".to_string();
                    }
                    pending.insert(id, (cmd::STATUS, None));
                }
                // Forget requests nobody waits for any more.
                pending.retain(|_, (_, reply)| reply.as_ref().is_none_or(|r| !r.is_closed()));
            }
        }
    };
    for (_, (_, reply)) in pending {
        if let Some(reply) = reply {
            let _ = reply.send(Err(CommandError::Offline(result.clone())));
        }
    }
    let _ = write.send(Message::Close(None)).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints() {
        let e = Endpoint::parse("192.168.1.50").unwrap();
        assert_eq!((e.ws_port, e.http_port, e.video_port), (3030, 80, 3031));
        let e = Endpoint::parse(" 127.0.0.1:18080?ws=13030&video=13031 ").unwrap();
        assert_eq!((e.host.as_str(), e.ws_port, e.http_port, e.video_port), ("127.0.0.1", 13030, 18080, 13031));
        assert_eq!(e.http("uploadFile/upload"), "http://127.0.0.1:18080/uploadFile/upload");
        assert!(Endpoint::parse("").is_none());
        assert!(Endpoint::parse("h?bogus=1").is_none());
    }

    #[test]
    fn acks_in_words() {
        assert!(check_ack(cmd::START, &json!({"Ack": 0})).is_ok());
        let e = check_ack(cmd::START, &json!({"Ack": 7})).unwrap_err().to_string();
        assert!(e.contains("another printer model"), "{e}");
    }
}
