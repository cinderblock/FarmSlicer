//! One MQTT connection per configured Bambu printer, the merged state each
//! one reports, and request/response for commands.
//!
//! Printers speak MQTT 3.1.1 over TLS on port 8883 as user `bblp` with the
//! printer's LAN access code. They publish to `device/<serial>/report` and
//! take requests on `device/<serial>/request`; responses to a request come
//! back on the report topic carrying the request's `sequence_id`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rumqttc::{
    AsyncClient, Event, EventLoop, MqttOptions, Packet, QoS, TlsConfiguration, Transport,
};
use serde_json::{Value, json};
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;

use super::status::{self, PrinterStatus};
use super::tls;
use crate::db;

const MQTT_PORT: u16 = 8883;
/// Reports from X1-class printers run to tens of kB; rumqttc's default
/// incoming limit is 10 kB.
const MAX_PACKET: usize = 1 << 20;
/// Ask for a full report this often, to recover from a missed delta. P1/A1
/// firmware is said to struggle with frequent `pushall`s, so keep it rare.
const RESYNC_INTERVAL: Duration = Duration::from_secs(30 * 60);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// Connection settings for one printer. Only `address`, `serial` and
/// `access_code` decide whether a running link must be restarted.
#[derive(Debug, Clone)]
struct LinkConfig {
    printer_id: String,
    name: String,
    address: String,
    serial: String,
    access_code: String,
}

impl LinkConfig {
    fn from_printer(p: &db::Printer) -> Option<Self> {
        if p.protocol != "bambu" {
            return None;
        }
        let address = p.address.trim();
        let serial = p.serial_number.trim();
        let access_code = p.access_code.trim();
        if address.is_empty() || serial.is_empty() || access_code.is_empty() {
            return None;
        }
        Some(Self {
            printer_id: p.id.clone(),
            name: p.name.clone(),
            address: address.to_string(),
            serial: serial.to_string(),
            access_code: access_code.to_string(),
        })
    }

    fn same_endpoint(&self, other: &Self) -> bool {
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

struct Link {
    config: LinkConfig,
    client: AsyncClient,
    task: JoinHandle<()>,
}

impl Drop for Link {
    fn drop(&mut self) {
        let _ = self.client.try_disconnect();
        self.task.abort();
    }
}

#[derive(Default)]
struct PrinterState {
    online: bool,
    error: Option<String>,
    updated_at: Option<String>,
    /// The merged `print` object.
    report: Value,
}

struct Inner {
    links: Mutex<HashMap<String, Link>>,
    states: Mutex<HashMap<String, PrinterState>>,
    /// sequence_id → whoever is waiting for the response.
    waiters: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    events: broadcast::Sender<PrinterStatus>,
    sequence: AtomicU64,
}

/// Handle to every printer connection. Cheap to clone.
#[derive(Clone)]
pub struct PrinterHub {
    inner: Arc<Inner>,
}

#[derive(Debug)]
pub enum CommandError {
    /// No link for this printer (not a Bambu printer, or address, serial or
    /// access code missing).
    NotConfigured,
    Offline(String),
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured => {
                write!(f, "the printer has no address, serial number or access code set")
            }
            Self::Offline(why) => write!(f, "the printer is not connected: {why}"),
        }
    }
}

impl Default for PrinterHub {
    fn default() -> Self {
        Self::new()
    }
}

impl PrinterHub {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(256);
        // Start sequence ids somewhere unlikely to collide with another
        // client's (responses go to every subscriber of the report topic).
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() % 1_000_000 * 1000)
            .unwrap_or(0);
        Self {
            inner: Arc::new(Inner {
                links: Mutex::new(HashMap::new()),
                states: Mutex::new(HashMap::new()),
                waiters: Mutex::new(HashMap::new()),
                events,
                sequence: AtomicU64::new(seed),
            }),
        }
    }

    /// Bring the connections in line with the printers table: connect new
    /// printers, reconnect changed ones, drop removed ones. Call after every
    /// change to printers.
    pub fn sync(&self, printers: &[db::Printer]) {
        let wanted: HashMap<String, LinkConfig> = printers
            .iter()
            .filter_map(LinkConfig::from_printer)
            .map(|c| (c.printer_id.clone(), c))
            .collect();

        let mut links = self.inner.links.lock().unwrap();
        links.retain(|id, link| {
            let keep = wanted.get(id).is_some_and(|c| c.same_endpoint(&link.config));
            if !keep {
                println!("Printer {}: disconnecting (settings changed or removed)", link.config.name);
            }
            keep
        });
        let mut fresh = Vec::new();
        for (id, config) in wanted {
            if let Some(link) = links.get_mut(&id) {
                link.config.name = config.name;
                continue;
            }
            fresh.push(id.clone());
            links.insert(id, self.connect(config));
        }

        // A new or restarted link starts from a blank report.
        let mut states = self.inner.states.lock().unwrap();
        states.retain(|id, _| links.contains_key(id) && !fresh.contains(id));
    }

    fn connect(&self, config: LinkConfig) -> Link {
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
        let task = tokio::spawn(run_link(
            self.inner.clone(),
            config.clone(),
            client.clone(),
            event_loop,
        ));
        Link { config, client, task }
    }

    pub fn statuses(&self) -> Vec<PrinterStatus> {
        let links = self.inner.links.lock().unwrap();
        let states = self.inner.states.lock().unwrap();
        links.keys().map(|id| summarize(id, states.get(id))).collect()
    }

    pub fn status(&self, printer_id: &str) -> Option<PrinterStatus> {
        if !self.inner.links.lock().unwrap().contains_key(printer_id) {
            return None;
        }
        Some(summarize(printer_id, self.inner.states.lock().unwrap().get(printer_id)))
    }

    /// The merged raw report, for debugging.
    pub fn report(&self, printer_id: &str) -> Option<Value> {
        self.inner
            .states
            .lock()
            .unwrap()
            .get(printer_id)
            .map(|s| s.report.clone())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PrinterStatus> {
        self.inner.events.subscribe()
    }

    /// Publish a request such as `{"print": {"command": "pause"}}` (a
    /// `sequence_id` is added) and wait up to `wait` for the printer's
    /// response. `Ok(None)` means it didn't answer in time.
    pub async fn command(
        &self,
        printer_id: &str,
        mut request: Value,
        wait: Duration,
    ) -> Result<Option<Value>, CommandError> {
        let (client, topic) = {
            let links = self.inner.links.lock().unwrap();
            let link = links.get(printer_id).ok_or(CommandError::NotConfigured)?;
            (link.client.clone(), link.config.request_topic())
        };
        {
            let states = self.inner.states.lock().unwrap();
            let state = states.get(printer_id);
            if !state.is_some_and(|s| s.online) {
                let why = state
                    .and_then(|s| s.error.clone())
                    .unwrap_or_else(|| "not connected yet".to_string());
                return Err(CommandError::Offline(why));
            }
        }

        let sequence = self.inner.sequence.fetch_add(1, Ordering::Relaxed).to_string();
        if let Some(body) = request.as_object_mut().and_then(|o| o.values_mut().next()) {
            if let Some(body) = body.as_object_mut() {
                body.insert("sequence_id".into(), Value::String(sequence.clone()));
            }
        }
        let (tx, rx) = oneshot::channel();
        self.inner.waiters.lock().unwrap().insert(sequence.clone(), tx);

        let payload = serde_json::to_vec(&request).expect("JSON values serialize");
        if let Err(e) = client.publish(topic, QoS::AtLeastOnce, false, payload).await {
            self.inner.waiters.lock().unwrap().remove(&sequence);
            return Err(CommandError::Offline(e.to_string()));
        }
        let response = tokio::time::timeout(wait, rx).await.ok().and_then(Result::ok);
        self.inner.waiters.lock().unwrap().remove(&sequence);
        Ok(response)
    }
}

fn summarize(printer_id: &str, state: Option<&PrinterState>) -> PrinterStatus {
    match state {
        Some(s) => PrinterStatus::summarize(
            printer_id,
            s.online,
            s.error.clone(),
            s.updated_at.clone(),
            &s.report,
        ),
        None => PrinterStatus::offline(printer_id, Some("not connected yet".to_string())),
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

impl Inner {
    fn update(&self, printer_id: &str, change: impl FnOnce(&mut PrinterState)) {
        let summary = {
            let mut states = self.states.lock().unwrap();
            let state = states.entry(printer_id.to_string()).or_default();
            change(state);
            summarize(printer_id, Some(state))
        };
        // Nobody listening is fine.
        let _ = self.events.send(summary);
    }

    fn handle_message(&self, printer_id: &str, payload: &[u8]) {
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
            self.update(printer_id, |s| {
                if s.report.is_null() {
                    s.report = json!({});
                }
                status::merge(&mut s.report, &delta);
                s.updated_at = Some(chrono::Utc::now().to_rfc3339());
            });
        }
    }
}

async fn run_link(inner: Arc<Inner>, config: LinkConfig, client: AsyncClient, mut event_loop: EventLoop) {
    let id = config.printer_id.clone();
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
                    inner.update(&id, |s| {
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
                    inner.handle_message(&id, &publish.payload);
                }
                Ok(_) => {}
                Err(e) => {
                    failures += 1;
                    let why = explain(&e);
                    eprintln!(
                        "Printer {}: connection to {}:{MQTT_PORT} failed (attempt {failures}): {why}; retrying in {}s",
                        config.name, config.address, backoff.as_secs()
                    );
                    inner.update(&id, |s| {
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
