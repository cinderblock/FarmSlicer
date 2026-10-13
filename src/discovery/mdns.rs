//! Printers advertised over mDNS / DNS-SD: Klipper's Moonraker
//! (`_moonraker._tcp`, only when its `[zeroconf]` component is set up),
//! OctoPrint (`_octoprint._tcp`, TXT `path`, `uuid`, `model`, `vendor`) and
//! Prusa's PrusaLink (`_prusalink._tcp`, no TXT, named after the printer's
//! hostname). The browse restarts now and then so quiet services are asked
//! again.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};

use super::{DiscoveredPrinter, DiscoveryMap, found};

const SERVICES: &[(&str, &str)] = &[
    ("_moonraker._tcp.local.", "moonraker"),
    ("_octoprint._tcp.local.", "octoprint"),
    ("_prusalink._tcp.local.", "prusalink"),
];
/// mDNS answers are cached for long; forget a service after this.
const TTL: Duration = Duration::from_secs(15 * 60);
const REBROWSE: Duration = Duration::from_secs(5 * 60);

/// The instance part of `Name._service._tcp.local.`.
fn instance(fullname: &str, service: &str) -> String {
    fullname.strip_suffix(service).unwrap_or(fullname).trim_end_matches('.').to_string()
}

/// A Prusa printer's model from its default hostname.
fn prusa_model(hostname: &str) -> &'static str {
    let h = hostname.trim_end_matches(".local.").trim_end_matches('.').to_ascii_lowercase();
    match h.as_str() {
        "prusa-mk4" => "Prusa MK4",
        "prusa-mk3-5" => "Prusa MK3.5",
        "prusa-xl" => "Prusa XL",
        "prusa-mini" => "Prusa MINI",
        "prusa-core-one" => "Prusa CORE One",
        "prusa-core-one-l" => "Prusa CORE One L",
        _ => "",
    }
}

/// A reachable IPv4 address of the service (printers announce every
/// interface they have).
fn best_ip(info: &ServiceInfo) -> Option<IpAddr> {
    let mut v4: Vec<IpAddr> = info
        .get_addresses()
        .iter()
        .copied()
        .filter(|a| match a {
            IpAddr::V4(v) => !v.is_loopback() && !v.is_link_local(),
            IpAddr::V6(_) => false,
        })
        .collect();
    v4.sort();
    v4.into_iter().next()
}

pub fn describe(info: &ServiceInfo, service: &str, protocol: &'static str) -> Option<DiscoveredPrinter> {
    let name = instance(info.get_fullname(), service);
    // Prusa-Link on a Raspberry Pi advertises OctoPrint's service too.
    if protocol == "octoprint" && name.starts_with("PrusaLink") {
        return None;
    }
    let ip = best_ip(info)?.to_string();
    let port = info.get_port();
    let txt = |k: &str| info.get_property_val_str(k).map(str::trim).filter(|v| !v.is_empty()).map(String::from);
    let path = txt("path").filter(|p| p != "/");
    let address = match (protocol, path) {
        (_, Some(path)) => format!("http://{ip}:{port}/{}", path.trim_start_matches('/')),
        ("prusalink", None) if port == 80 => ip.clone(),
        ("moonraker", None) if port == 7125 => ip.clone(),
        _ => format!("{ip}:{port}"),
    };
    let (model_name, machine_profile) = match protocol {
        "prusalink" => {
            let model = prusa_model(info.get_hostname());
            (if model.is_empty() { "Prusa (PrusaLink)".to_string() } else { model.to_string() }, model.to_string())
        }
        "octoprint" => {
            let model = [txt("vendor"), txt("model")].into_iter().flatten().collect::<Vec<_>>().join(" ");
            (if model.is_empty() { "OctoPrint".to_string() } else { model }, String::new())
        }
        _ => ("Klipper (Moonraker)".to_string(), String::new()),
    };
    Some(DiscoveredPrinter {
        protocol,
        id: txt("uuid").unwrap_or_else(|| info.get_fullname().to_string()),
        name,
        model_name,
        machine_profile,
        address,
        ip,
        ..DiscoveredPrinter::seen(TTL)
    })
}

pub async fn run(discovered: Arc<DiscoveryMap>) {
    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Discovery: can't start mDNS: {e}");
            return;
        }
    };
    println!("Discovery: browsing mDNS for Klipper, OctoPrint and PrusaLink printers");
    loop {
        let mut browsers = Vec::new();
        for (service, protocol) in SERVICES {
            match daemon.browse(service) {
                Ok(rx) => browsers.push((*service, *protocol, rx)),
                Err(e) => eprintln!("Discovery: can't browse {service}: {e}"),
            }
        }
        let until = tokio::time::Instant::now() + REBROWSE;
        let mut tasks = Vec::new();
        for (service, protocol, rx) in browsers {
            let discovered = discovered.clone();
            tasks.push(tokio::spawn(async move {
                while let Ok(event) = rx.recv_async().await {
                    if let ServiceEvent::ServiceResolved(info) = event {
                        if let Some(p) = describe(&info, service, protocol) {
                            found(&discovered, p);
                        }
                    }
                }
            }));
        }
        tokio::time::sleep_until(until).await;
        for (service, _) in SERVICES {
            let _ = daemon.stop_browse(service);
        }
        for t in tasks {
            t.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_models() {
        assert_eq!(instance("OctoPrint instance on octopi._octoprint._tcp.local.", "_octoprint._tcp.local."), "OctoPrint instance on octopi");
        assert_eq!(prusa_model("prusa-core-one.local."), "Prusa CORE One");
        assert_eq!(prusa_model("bay3-mk4.local."), "");
    }

    #[test]
    fn services_become_printers() {
        let props = [("path", "/octoprint"), ("uuid", "eea05568"), ("model", "MK3S")];
        let info = ServiceInfo::new("_octoprint._tcp.local.", "Bench", "octopi.local.", "192.168.1.60", 80, &props[..]).unwrap();
        let p = describe(&info, "_octoprint._tcp.local.", "octoprint").unwrap();
        assert_eq!((p.id.as_str(), p.address.as_str(), p.model_name.as_str()), ("eea05568", "http://192.168.1.60:80/octoprint", "MK3S"));

        let none: [(&str, &str); 0] = [];
        let info = ServiceInfo::new("_prusalink._tcp.local.", "prusa-mk4", "prusa-mk4.local.", "192.168.1.70", 80, &none[..]).unwrap();
        let p = describe(&info, "_prusalink._tcp.local.", "prusalink").unwrap();
        assert_eq!((p.address.as_str(), p.machine_profile.as_str()), ("192.168.1.70", "Prusa MK4"));

        let info = ServiceInfo::new("_moonraker._tcp.local.", "voron @ voron", "voron.local.", "192.168.1.80", 7125, &none[..]).unwrap();
        let p = describe(&info, "_moonraker._tcp.local.", "moonraker").unwrap();
        assert_eq!((p.protocol, p.address.as_str()), ("moonraker", "192.168.1.80"));
    }
}
