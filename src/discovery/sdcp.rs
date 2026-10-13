//! Elegoo Centauri Carbon printers answer the 6 bytes `M99999` sent to UDP
//! port 3000 with a JSON description, unicast back to the sender. Resin
//! printers answer too (older ones speak another SDCP), so only V3 replies
//! from Centauri models count.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;

use super::{DiscoveredPrinter, DiscoveryMap, found};

const PORT: u16 = 3000;
const PROBE_INTERVAL: Duration = Duration::from_secs(15);
const TTL: Duration = Duration::from_secs(60);

fn socket() -> std::io::Result<UdpSocket> {
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_broadcast(true)?;
    s.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)).into())?;
    s.set_nonblocking(true)?;
    UdpSocket::from_std(s.into())
}

/// A discovery reply as a printer to add, if it's one SDCP serves.
pub fn parse(reply: &[u8], from: SocketAddr) -> Option<DiscoveredPrinter> {
    let v: Value = serde_json::from_slice(reply).ok()?;
    // Older tools nest the fields under Data.Attributes.
    let d = if v["Data"]["MainboardID"].is_string() { &v["Data"] } else { &v["Data"]["Attributes"] };
    let machine = d["MachineName"].as_str()?.trim();
    let protocol = d["ProtocolVersion"].as_str().unwrap_or("");
    if !protocol.starts_with("V3") || !matches!(machine.to_ascii_lowercase().as_str(), "centauri carbon" | "centauri") {
        return None;
    }
    let id = d["MainboardID"].as_str()?.trim().to_string();
    let ip = from.ip().to_string();
    Some(DiscoveredPrinter {
        protocol: "sdcp",
        serial: id.clone(),
        id,
        name: d["Name"].as_str().unwrap_or(machine).to_string(),
        model_code: d["FirmwareVersion"].as_str().unwrap_or("").to_string(),
        model_name: format!("Elegoo {machine}"),
        machine_profile: format!("Elegoo {machine}"),
        address: ip.clone(),
        ip,
        ..DiscoveredPrinter::seen(TTL)
    })
}

pub async fn run(discovered: Arc<DiscoveryMap>) {
    let socket = match socket() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Discovery: can't open a socket for SDCP: {e}");
            return;
        }
    };
    println!("Discovery: asking for Elegoo (SDCP) printers on UDP {PORT}");
    let broadcast: SocketAddr = (Ipv4Addr::BROADCAST, PORT).into();
    let mut probe = tokio::time::interval(PROBE_INTERVAL);
    let mut buf = [0u8; 4096];
    loop {
        tokio::select! {
            _ = probe.tick() => {
                // UDP gets lost on busy networks: say it twice.
                for _ in 0..2 {
                    if let Err(e) = socket.send_to(b"M99999", broadcast).await {
                        eprintln!("Discovery: SDCP probe failed: {e}");
                        break;
                    }
                }
            }
            r = socket.recv_from(&mut buf) => match r {
                Ok((n, from)) => {
                    if let Some(p) = parse(&buf[..n], from) {
                        found(&discovered, p);
                    }
                }
                Err(e) => {
                    eprintln!("Discovery: SDCP receive failed: {e}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centauri_replies_only() {
        let from: SocketAddr = "192.168.1.50:3000".parse().unwrap();
        let reply = br#"{"Id":"979d","Data":{"Name":"Bay 3","MachineName":"Centauri Carbon","BrandName":"ELEGOO",
            "MainboardIP":"192.168.1.50","MainboardID":"1c7319d3","ProtocolVersion":"V3.0.0","FirmwareVersion":"V1.1.46"}}"#;
        let p = parse(reply, from).unwrap();
        assert_eq!((p.protocol, p.id.as_str(), p.name.as_str(), p.address.as_str()), ("sdcp", "1c7319d3", "Bay 3", "192.168.1.50"));
        assert_eq!(p.machine_profile, "Elegoo Centauri Carbon");
        let resin = br#"{"Id":"x","Data":{"Name":"Saturn","MachineName":"Saturn 4 Ultra","MainboardID":"ab","ProtocolVersion":"V3.0.0"}}"#;
        assert!(parse(resin, from).is_none());
        let old = br#"{"Id":"x","Data":{"Attributes":{"MachineName":"Centauri Carbon","MainboardID":"ab","ProtocolVersion":"V1.0.0"}}}"#;
        assert!(parse(old, from).is_none());
    }
}
