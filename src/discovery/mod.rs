//! Printers seen on the LAN, of every make FarmSlicer speaks to, for the
//! Printers page's "Detected on Network" cards:
//! - Bambu Lab: SSDP announcements on port 2021 (`ssdp.rs`);
//! - Klipper (Moonraker), OctoPrint, PrusaLink: mDNS / DNS-SD services
//!   (`mdns.rs`); Moonraker only advertises with `[zeroconf]` set up;
//! - Elegoo Centauri Carbon: SDCP's `M99999` UDP broadcast (`sdcp.rs`).
//!
//! Multicast and broadcast don't cross routers or Docker bridge networks:
//! FarmSlicer in Docker needs host networking to see printers. Printers on
//! other subnets are added by address.

mod mdns;
mod sdcp;
mod ssdp;

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Printers by `protocol:id`.
pub type DiscoveryMap = Mutex<HashMap<String, DiscoveredPrinter>>;

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredPrinter {
    /// The protocol to talk to it with (`printers.protocol`).
    pub protocol: &'static str,
    /// What tells it apart: Bambu serial, SDCP mainboard id, mDNS instance.
    pub id: String,
    /// For the printer's serial number field (Bambu serial, SDCP mainboard
    /// id); empty when the protocol has none.
    pub serial: String,
    pub name: String,
    pub model_code: String,
    pub model_name: String,
    /// A machine profile or base model to preselect, if known.
    pub machine_profile: String,
    pub ip: String,
    /// For the printer's address field (may carry a port).
    pub address: String,
    pub signal: String,
    #[serde(skip)]
    pub last_seen: Instant,
    /// Forgotten after this long without a sighting.
    #[serde(skip)]
    pub ttl: Duration,
}

impl DiscoveredPrinter {
    /// A sighting now, to fill in with struct update syntax.
    pub fn seen(ttl: Duration) -> Self {
        Self {
            protocol: "",
            id: String::new(),
            serial: String::new(),
            name: String::new(),
            model_code: String::new(),
            model_name: String::new(),
            machine_profile: String::new(),
            ip: String::new(),
            address: String::new(),
            signal: String::new(),
            last_seen: Instant::now(),
            ttl,
        }
    }

    fn key(&self) -> String {
        format!("{}:{}", self.protocol, self.id)
    }
}

/// Record a sighting, logging new printers and moved ones.
pub fn found(map: &DiscoveryMap, printer: DiscoveredPrinter) {
    let key = printer.key();
    let mut map = map.lock().unwrap();
    match map.get(&key) {
        None => println!(
            "Discovery: found {} \"{}\" ({} {}) at {}",
            if printer.model_name.is_empty() { printer.protocol } else { &printer.model_name },
            printer.name,
            printer.protocol,
            printer.id,
            printer.address
        ),
        Some(prev) if prev.address != printer.address => println!(
            "Discovery: {} \"{}\" ({}) moved from {} to {}",
            printer.model_name, printer.name, printer.id, prev.address, printer.address
        ),
        Some(_) => {}
    }
    map.insert(key, printer);
}

/// Listen on every source; forget printers that went quiet.
pub async fn run(discovered: Arc<DiscoveryMap>) {
    tokio::spawn(ssdp::run(discovered.clone()));
    tokio::spawn(sdcp::run(discovered.clone()));
    tokio::spawn(mdns::run(discovered.clone()));
    let mut sweep = tokio::time::interval(Duration::from_secs(15));
    loop {
        sweep.tick().await;
        let now = Instant::now();
        discovered.lock().unwrap().retain(|_, p| {
            let fresh = now.duration_since(p.last_seen) < p.ttl;
            if !fresh {
                println!(
                    "Discovery: lost {} \"{}\" ({}) at {}: silent for {}s",
                    if p.model_name.is_empty() { p.protocol } else { &p.model_name },
                    p.name,
                    p.id,
                    p.address,
                    p.ttl.as_secs()
                );
            }
            fresh
        });
    }
}
