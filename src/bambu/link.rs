//! The Bambu driver's link to one printer: an MQTT connection, the merged
//! state it reports, and request/response for commands.
//!
//! Printers speak MQTT 3.1.1 over TLS on port 8883 as user `bblp` with the
//! printer's LAN access code. They publish to `device/<serial>/report` and
//! take requests on `device/<serial>/request`; responses to a request come
//! back on the report topic carrying the request's `sequence_id`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use rumqttc::{
    AsyncClient, Event, EventLoop, MqttOptions, Packet, QoS, TlsConfiguration, Transport,
};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use super::{hms, status};
use crate::printer::tls;
use crate::db;
use crate::printer::hub::StatusSink;
use crate::printer::{Command, CommandError, Speed};

const MQTT_PORT: u16 = 8883;
/// Reports from X1-class printers run to tens of kB; rumqttc's default
/// incoming limit is 10 kB.
const MAX_PACKET: usize = 1 << 20;
/// Ask for a full report this often, to recover from a missed delta. P1/A1
/// firmware is said to struggle with frequent `pushall`s, so keep it rare.
const RESYNC_INTERVAL: Duration = Duration::from_secs(30 * 60);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// How long commands wait for the printer's answer.
const COMMAND_WAIT: Duration = Duration::from_secs(5);

/// Request sequence ids, shared by every link. Start somewhere unlikely to
/// collide with another client's (responses go to every subscriber of the
/// report topic).
static SEQUENCE: LazyLock<AtomicU64> = LazyLock::new(|| {
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() % 1_000_000 * 1000)
        .unwrap_or(0);
    AtomicU64::new(seed)
});

/// Connection settings for one printer. Only `address`, `serial` and
/// `access_code` decide whether a running link must be restarted.
#[derive(Debug, Clone)]
pub struct Config {
    pub name: String,
    address: String,
    serial: String,
    access_code: String,
}

impl Config {
    pub fn from_printer(p: &db::Printer) -> Option<Self> {
        let address = p.address.trim();
        let serial = p.serial_number.trim();
        let access_code = p.access_code.trim();
        if address.is_empty() || serial.is_empty() || access_code.is_empty() {
            return None;
        }
        Some(Self {
            name: p.name.clone(),
            address: address.to_string(),
            serial: serial.to_string(),
            access_code: access_code.to_string(),
        })
    }

    pub fn same_endpoint(&self, other: &Self) -> bool {
        self.address == other.address
            && self.serial == other.serial
            && self.access_code == other.access_code
    }

    fn report_topic(&self) -> String {
        format!("device/{}/report", self.serial)
    }

    fn request_topic(&self) -> String {
        format!("device/{}/request", self.serial)
    }
}

#[derive(Default)]
struct State {
    online: bool,
    error: Option<String>,
    updated_at: Option<String>,
    /// The merged `print` object.
    report: Value,
}

struct Shared {
    config: Config,
    sink: StatusSink,
    state: Mutex<State>,
    /// sequence_id → whoever is waiting for the response.
    waiters: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

/// Commands for one printer. Cheap to clone.
#[derive(Clone)]
pub struct Handle {
    shared: Arc<Shared>,
    client: AsyncClient,
}

/// Connect to the printer; the task keeps the connection up and publishes
/// its status to `sink`.
pub fn start(config: Config, sink: StatusSink) -> (Handle, JoinHandle<()>) {
    println!(
        "Printer {}: connecting to {}:{MQTT_PORT} (serial {})",
        config.name, config.address, config.serial
    );
    let client_id = format!(
        "farmslicer-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let mut options = MqttOptions::new(client_id, config.address.clone(), MQTT_PORT);
    options
        .set_credentials("bblp", config.access_code.clone())
        .set_keep_alive(Duration::from_secs(30))
        .set_max_packet_size(MAX_PACKET, MAX_PACKET)
        .set_transport(Transport::tls_with_config(TlsConfiguration::Rustls(
            tls::mqtt_config(),
        )));
    let (client, event_loop) = AsyncClient::new(options, 64);
    let shared = Arc::new(Shared {
        config,
        sink,
        state: Mutex::new(State::default()),
        waiters: Mutex::new(HashMap::new()),
    });
    let task = tokio::spawn(run(shared.clone(), client.clone(), event_loop));
    (Handle { shared, client }, task)
}

impl Handle {
    /// Publish a request such as `{"print": {"command": "pause"}}` (a
    /// `sequence_id` is added) and wait up to `wait` for the printer's
    /// response. `Ok(None)` means it didn't answer in time.
    pub async fn request(&self, mut request: Value, wait: Duration) -> Result<Option<Value>, CommandError> {
        {
            let state = self.shared.state.lock().unwrap();
            if !state.online {
                let why = state.error.clone().unwrap_or_else(|| "not connected yet".to_string());
                return Err(CommandError::Offline(why));
            }
        }

        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed).to_string();
        if let Some(body) = request.as_object_mut().and_then(|o| o.values_mut().next()) {
            if let Some(body) = body.as_object_mut() {
                body.insert("sequence_id".into(), Value::String(sequence.clone()));
            }
        }
        let (tx, rx) = oneshot::channel();
        self.shared.waiters.lock().unwrap().insert(sequence.clone(), tx);

        let payload = serde_json::to_vec(&request).expect("JSON values serialize");
        let topic = self.shared.config.request_topic();
        if let Err(e) = self.client.publish(topic, QoS::AtLeastOnce, false, payload).await {
            self.shared.waiters.lock().unwrap().remove(&sequence);
            return Err(CommandError::Offline(e.to_string()));
        }
        let response = tokio::time::timeout(wait, rx).await.ok().and_then(Result::ok);
        self.shared.waiters.lock().unwrap().remove(&sequence);
        Ok(response)
    }

    pub async fn command(&self, command: &Command) -> Result<Option<Value>, CommandError> {
        let request = match command {
            Command::Pause => json!({"print": {"command": "pause"}}),
            Command::Resume => json!({"print": {"command": "resume"}}),
            Command::Stop => json!({"print": {"command": "stop"}}),
            // The firmware wants the level as a string.
            Command::Speed(Speed::Level(l @ 1..=4)) => {
                json!({"print": {"command": "print_speed", "param": l.to_string()}})
            }
            Command::Speed(_) => {
                return Err(CommandError::Unsupported("set that speed (levels 1 to 4 only)".into()));
            }
            Command::Heat { nozzle, bed } => {
                json!({"print": {"command": "gcode_line", "param": format!("M104 S{nozzle}\nM140 S{bed}\n")}})
            }
        };
        let Some(response) = self.request(request, COMMAND_WAIT).await? else {
            return Ok(None);
        };
        let body = response.as_object().and_then(|o| o.values().next()).cloned().unwrap_or(Value::Null);
        if body["result"].as_str().unwrap_or("").eq_ignore_ascii_case("FAIL") {
            let reason = body["reason"].as_str().unwrap_or("no reason given");
            return Err(CommandError::Refused(reason.to_string()));
        }
        Ok(Some(body))
    }

    /// The merged raw report.
    pub fn raw(&self) -> Option<Value> {
        let state = self.shared.state.lock().unwrap();
        (!state.report.is_null()).then(|| state.report.clone())
    }

    pub fn shutdown(&self) {
        let _ = self.client.try_disconnect();
    }
}

/// The connection error, with a hint for the usual causes.
fn explain(e: &rumqttc::ConnectionError) -> String {
    use rumqttc::{ConnectReturnCode, ConnectionError};
    let raw = e.to_string();
    match e {
        ConnectionError::ConnectionRefused(
            ConnectReturnCode::NotAuthorized | ConnectReturnCode::BadUserNamePassword,
        ) => format!("{raw}: access code rejected (it changes when LAN mode is toggled; check the printer's screen)"),
        ConnectionError::Io(io) if io.kind() == std::io::ErrorKind::ConnectionRefused => {
            format!("{raw}: nothing listening on {MQTT_PORT}; is LAN mode (and Developer Mode) on?")
        }
        _ => raw,
    }
}

fn pushall() -> Vec<u8> {
    serde_json::to_vec(&json!({"pushing": {"sequence_id": "0", "command": "pushall"}}))
        .expect("JSON values serialize")
}

impl Shared {
    fn update(&self, change: impl FnOnce(&mut State)) {
        let mut summary = {
            let mut state = self.state.lock().unwrap();
            change(&mut state);
            status::summarize(state.online, state.error.clone(), state.updated_at.clone(), &state.report)
        };
        hms::describe(&mut summary, &self.config.serial);
        self.sink.publish(summary);
    }

    fn handle_message(&self, payload: &[u8]) {
        let Ok(message) = serde_json::from_slice::<Value>(payload) else {
            return;
        };

        // A response to one of our requests?
        if let Some(object) = message.as_object() {
            for body in object.values() {
                if let Some(seq) = body.get("sequence_id").and_then(Value::as_str) {
                    let is_push = body.get("command").and_then(Value::as_str) == Some("push_status");
                    if !is_push {
                        if let Some(tx) = self.waiters.lock().unwrap().remove(seq) {
                            let _ = tx.send(message.clone());
                        }
                    }
                }
            }
        }

        if let Some(print) = status::status_push(&message) {
            let delta = Value::Object(print.clone());
            self.update(|s| {
                if s.report.is_null() {
                    s.report = json!({});
                }
                status::merge(&mut s.report, &delta);
                s.updated_at = Some(chrono::Utc::now().to_rfc3339());
            });
        }
    }
}

async fn run(shared: Arc<Shared>, client: AsyncClient, mut event_loop: EventLoop) {
    let config = &shared.config;
    let mut backoff = Duration::from_secs(2);
    let mut failures: u32 = 0;
    let mut resync = tokio::time::interval(RESYNC_INTERVAL);
    resync.tick().await;

    loop {
        tokio::select! {
            event = event_loop.poll() => match event {
                Ok(Event::Incoming(Packet::ConnAck(_))) => {
                    println!(
                        "Printer {}: connected{}",
                        config.name,
                        if failures > 0 { format!(" after {failures} failed attempts") } else { String::new() }
                    );
                    failures = 0;
                    backoff = Duration::from_secs(2);
                    shared.update(|s| {
                        s.online = true;
                        s.error = None;
                    });
                    // try_*: the event loop we'd be waiting on is this task.
                    if let Err(e) = client.try_subscribe(config.report_topic(), QoS::AtMostOnce) {
                        eprintln!("Printer {}: subscribe failed: {e}", config.name);
                    }
                    if let Err(e) = client.try_publish(config.request_topic(), QoS::AtLeastOnce, false, pushall()) {
                        eprintln!("Printer {}: pushall failed: {e}", config.name);
                    }
                }
                Ok(Event::Incoming(Packet::Publish(publish))) => {
                    shared.handle_message(&publish.payload);
                }
                Ok(_) => {}
                Err(e) => {
                    failures += 1;
                    let why = explain(&e);
                    eprintln!(
                        "Printer {}: connection to {}:{MQTT_PORT} failed (attempt {failures}): {why}; retrying in {}s",
                        config.name, config.address, backoff.as_secs()
                    );
                    shared.update(|s| {
                        s.online = false;
                        s.error = Some(why);
                    });
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            },
            _ = resync.tick() => {
                let _ = client.try_publish(config.request_topic(), QoS::AtLeastOnce, false, pushall());
            }
        }
    }
}
