//! One live link per configured printer, whatever its protocol, and the
//! latest status of each.
//!
//! A link is a driver task (it keeps the connection up and publishes
//! statuses) plus a handle for sending it commands. The hub starts, restarts
//! and stops links as the printers table changes ([`PrinterHub::sync`]) and
//! fans statuses out to whoever subscribes (the tracker, the UI's events).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use super::{Command, PrinterStatus, Protocol, protocol_of};
use crate::{bambu, db, moonraker, octoprint, prusalink};

#[derive(Debug)]
pub enum CommandError {
    /// No link for this printer: a protocol FarmSlicer doesn't speak, or
    /// connection settings missing.
    NotConfigured,
    Offline(String),
    /// The printer (or its protocol) can't do that.
    Unsupported(String),
    /// The printer answered no.
    Refused(String),
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured => write!(f, "the printer's connection settings are incomplete"),
            Self::Offline(why) => write!(f, "the printer is not connected: {why}"),
            Self::Unsupported(what) => write!(f, "the printer can't {what}"),
            Self::Refused(why) => write!(f, "the printer refused: {why}"),
        }
    }
}

/// The latest status of every link, and the broadcast of each new one.
struct Board {
    /// printer id → (generation of the link that may publish, last status).
    states: Mutex<HashMap<String, (u64, Option<PrinterStatus>)>>,
    events: broadcast::Sender<PrinterStatus>,
}

/// Where a driver publishes its printer's status. Statuses from a link the
/// hub has since replaced or removed are dropped.
#[derive(Clone)]
pub struct StatusSink {
    board: Arc<Board>,
    printer_id: String,
    generation: u64,
}

impl StatusSink {
    pub fn publish(&self, mut status: PrinterStatus) {
        status.printer_id = self.printer_id.clone();
        {
            let mut states = self.board.states.lock().unwrap();
            match states.get_mut(&self.printer_id) {
                Some((generation, slot)) if *generation == self.generation => *slot = Some(status.clone()),
                _ => return,
            }
        }
        // Nobody listening is fine.
        let _ = self.board.events.send(status);
    }
}

/// A driver's command handle. Cheap to clone.
#[derive(Clone)]
pub enum DriverHandle {
    Bambu(bambu::link::Handle),
    Moonraker(moonraker::link::Handle),
    OctoPrint(octoprint::link::Handle),
    PrusaLink(prusalink::link::Handle),
}

impl DriverHandle {
    /// Carry out `command`. `Ok(Some(reply))`: the printer confirmed;
    /// `Ok(None)`: sent, but the printer didn't confirm in time.
    pub async fn command(&self, command: &Command) -> Result<Option<Value>, CommandError> {
        match self {
            DriverHandle::Bambu(h) => h.command(command).await,
            DriverHandle::Moonraker(h) => h.command(command).await,
            DriverHandle::OctoPrint(h) => h.command(command).await,
            DriverHandle::PrusaLink(h) => h.command(command).await,
        }
    }

    /// The printer's raw state as the driver keeps it, for debugging.
    fn raw(&self) -> Option<Value> {
        match self {
            DriverHandle::Bambu(h) => h.raw(),
            DriverHandle::Moonraker(h) => h.raw(),
            DriverHandle::OctoPrint(h) => h.raw(),
            DriverHandle::PrusaLink(h) => h.raw(),
        }
    }

    fn shutdown(&self) {
        match self {
            DriverHandle::Bambu(h) => h.shutdown(),
            // Aborting the link's task closes its socket.
            DriverHandle::Moonraker(_) | DriverHandle::OctoPrint(_) | DriverHandle::PrusaLink(_) => {}
        }
    }
}

/// Connection settings of one printer, per protocol.
#[derive(Clone)]
enum LinkConfig {
    Bambu(bambu::link::Config),
    Moonraker(moonraker::link::Config),
    OctoPrint(octoprint::link::Config),
    PrusaLink(prusalink::link::Config),
}

impl LinkConfig {
    fn from_printer(p: &db::Printer) -> Option<Self> {
        match protocol_of(p)? {
            Protocol::Bambu => bambu::link::Config::from_printer(p).map(Self::Bambu),
            Protocol::Moonraker => moonraker::link::Config::from_printer(p).map(Self::Moonraker),
            Protocol::OctoPrint => octoprint::link::Config::from_printer(p).map(Self::OctoPrint),
            Protocol::PrusaLink => prusalink::link::Config::from_printer(p).map(Self::PrusaLink),
        }
    }

    /// Would a link for `self` talk to the same printer the same way as one
    /// for `other`? (Otherwise the link restarts.)
    fn same_endpoint(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Bambu(a), Self::Bambu(b)) => a.same_endpoint(b),
            (Self::Moonraker(a), Self::Moonraker(b)) => a.same_endpoint(b),
            (Self::OctoPrint(a), Self::OctoPrint(b)) => a.same_endpoint(b),
            (Self::PrusaLink(a), Self::PrusaLink(b)) => a.same_endpoint(b),
            _ => false,
        }
    }

    fn name(&self) -> &str {
        match self {
            Self::Bambu(c) => &c.name,
            Self::Moonraker(c) => &c.name,
            Self::OctoPrint(c) => &c.name,
            Self::PrusaLink(c) => &c.name,
        }
    }

    fn start(&self, sink: StatusSink) -> (DriverHandle, JoinHandle<()>) {
        match self {
            Self::Bambu(c) => {
                let (handle, task) = bambu::link::start(c.clone(), sink);
                (DriverHandle::Bambu(handle), task)
            }
            Self::Moonraker(c) => {
                let (handle, task) = moonraker::link::start(c.clone(), sink);
                (DriverHandle::Moonraker(handle), task)
            }
            Self::OctoPrint(c) => {
                let (handle, task) = octoprint::link::start(c.clone(), sink);
                (DriverHandle::OctoPrint(handle), task)
            }
            Self::PrusaLink(c) => {
                let (handle, task) = prusalink::link::start(c.clone(), sink);
                (DriverHandle::PrusaLink(handle), task)
            }
        }
    }
}

struct Link {
    config: LinkConfig,
    handle: DriverHandle,
    task: JoinHandle<()>,
}

impl Drop for Link {
    fn drop(&mut self) {
        self.handle.shutdown();
        self.task.abort();
    }
}

struct Inner {
    links: Mutex<HashMap<String, Link>>,
    board: Arc<Board>,
    generation: AtomicU64,
}

/// Handle to every printer link. Cheap to clone.
#[derive(Clone)]
pub struct PrinterHub {
    inner: Arc<Inner>,
}

impl Default for PrinterHub {
    fn default() -> Self {
        Self::new()
    }
}

impl PrinterHub {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(Inner {
                links: Mutex::new(HashMap::new()),
                board: Arc::new(Board { states: Mutex::new(HashMap::new()), events }),
                generation: AtomicU64::new(0),
            }),
        }
    }

    /// Bring the links in line with the printers table: connect new
    /// printers, reconnect changed ones, drop removed ones. Call after every
    /// change to printers.
    pub fn sync(&self, printers: &[db::Printer]) {
        let wanted: HashMap<String, LinkConfig> = printers
            .iter()
            .filter_map(|p| Some((p.id.clone(), LinkConfig::from_printer(p)?)))
            .collect();

        let mut links = self.inner.links.lock().unwrap();
        let mut states = self.inner.board.states.lock().unwrap();
        links.retain(|id, link| {
            let keep = wanted.get(id).is_some_and(|c| c.same_endpoint(&link.config));
            if !keep {
                println!("Printer {}: disconnecting (settings changed or removed)", link.config.name());
                states.remove(id);
            }
            keep
        });
        for (id, config) in wanted {
            if let Some(link) = links.get_mut(&id) {
                link.config = config;
                continue;
            }
            // A new or restarted link starts from a blank status.
            let generation = self.inner.generation.fetch_add(1, Ordering::Relaxed);
            states.insert(id.clone(), (generation, None));
            let sink = StatusSink { board: self.inner.board.clone(), printer_id: id.clone(), generation };
            let (handle, task) = config.start(sink);
            links.insert(id, Link { config, handle, task });
        }
    }

    fn summary(printer_id: &str, slot: Option<&(u64, Option<PrinterStatus>)>) -> PrinterStatus {
        slot.and_then(|(_, s)| s.clone())
            .unwrap_or_else(|| PrinterStatus::offline(printer_id, Some("not connected yet".to_string())))
    }

    /// The status of every linked printer.
    pub fn statuses(&self) -> Vec<PrinterStatus> {
        let links = self.inner.links.lock().unwrap();
        let states = self.inner.board.states.lock().unwrap();
        links.keys().map(|id| Self::summary(id, states.get(id))).collect()
    }

    /// `None`: the printer has no link (protocol not spoken here, or
    /// connection settings missing).
    pub fn status(&self, printer_id: &str) -> Option<PrinterStatus> {
        if !self.inner.links.lock().unwrap().contains_key(printer_id) {
            return None;
        }
        Some(Self::summary(printer_id, self.inner.board.states.lock().unwrap().get(printer_id)))
    }

    /// The driver's raw view of the printer, for debugging.
    pub fn report(&self, printer_id: &str) -> Option<Value> {
        self.handle(printer_id)?.raw()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PrinterStatus> {
        self.inner.board.events.subscribe()
    }

    pub fn handle(&self, printer_id: &str) -> Option<DriverHandle> {
        self.inner.links.lock().unwrap().get(printer_id).map(|l| l.handle.clone())
    }

    pub async fn command(&self, printer_id: &str, command: &Command) -> Result<Option<Value>, CommandError> {
        let handle = self.handle(printer_id).ok_or(CommandError::NotConfigured)?;
        handle.command(command).await
    }
}
