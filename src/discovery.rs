use serde::Serialize;
use std::collections::HashMap;
use socket2::{Domain, Protocol, Socket, Type};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::UdpSocket;
use tokio::time;

const MULTICAST_ADDR: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
const BAMBU_PORT: u16 = 2021;
const BAMBU_NT: &str = "urn:bambulab-com:device:3dprinter:1";
const STALE_TIMEOUT: Duration = Duration::from_secs(60);
const PROBE_INTERVAL: Duration = Duration::from_secs(15);

const M_SEARCH: &[u8] = b"\
M-SEARCH * HTTP/1.1\r\n\
HOST: 239.255.255.250:2021\r\n\
MAN: \"ssdp:discover\"\r\n\
MX: 3\r\n\
ST: urn:bambulab-com:device:3dprinter:1\r\n\
\r\n";

pub type DiscoveryMap = Mutex<HashMap<String, DiscoveredPrinter>>;

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredPrinter {
    pub serial: String,
    pub name: String,
    pub model_code: String,
    pub model_name: String,
    pub machine_profile: String,
    pub ip: String,
    pub signal: String,
    #[serde(skip)]
    pub last_seen: Instant,
}

pub async fn run(discovered: Arc<DiscoveryMap>) {
    let socket = match create_multicast_socket() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Discovery: failed to create multicast socket: {e}");
            return;
        }
    };

    println!("Discovery: listening for Bambu printers on 239.255.255.250:{BAMBU_PORT}");

    let mut buf = [0u8; 4096];
    let mut probe_interval = time::interval(PROBE_INTERVAL);
    probe_interval.tick().await; // first tick is immediate

    loop {
        tokio::select! {
            result = socket.recv_from(&mut buf) => {
                match result {
                    Ok((len, src)) => {
                        handle_packet(&buf[..len], src, &discovered);
                    }
                    Err(e) => {
                        eprintln!("Discovery: recv error: {e}");
                        time::sleep(Duration::from_secs(1)).await;
                    }
                }
            }
            _ = probe_interval.tick() => {
                // Send M-SEARCH probe
                let dest: SocketAddr = (MULTICAST_ADDR, BAMBU_PORT).into();
                if let Err(e) = socket.send_to(M_SEARCH, dest).await {
                    eprintln!("Discovery: M-SEARCH send error: {e}");
                }

                // Evict stale entries
                let mut map = discovered.lock().unwrap();
                let now = Instant::now();
                map.retain(|_, p| {
                    let fresh = now.duration_since(p.last_seen) < STALE_TIMEOUT;
                    if !fresh {
                        println!(
                            "Discovery: lost {} \"{}\" (serial {}) at {}: silent for {}s",
                            p.model_name,
                            p.name,
                            p.serial,
                            p.ip,
                            STALE_TIMEOUT.as_secs()
                        );
                    }
                    fresh
                });
            }
        }
    }
}

/// Bind the SSDP port shared: Bambu Studio, Home Assistant's Bambu
/// integration or another print-farm tool on the same host listen on it too,
/// and printers broadcast their announcements, so every listener gets a copy.
fn create_multicast_socket() -> std::io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    socket.set_reuse_port(true)?;
    socket.set_broadcast(true)?;
    socket.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, BAMBU_PORT).into())?;
    socket.join_multicast_v4(&MULTICAST_ADDR, &Ipv4Addr::UNSPECIFIED)?;
    socket.set_nonblocking(true)?;
    UdpSocket::from_std(socket.into())
}

fn handle_packet(data: &[u8], src: SocketAddr, discovered: &DiscoveryMap) {
    let text = match std::str::from_utf8(data) {
        Ok(s) => s,
        Err(_) => return,
    };

    let headers = parse_headers(text);

    // Only process Bambu printer messages
    let nt = headers.get("nt").or_else(|| headers.get("st"));
    match nt {
        Some(v) if v.contains("bambulab") => {}
        _ => return,
    }

    let serial = match headers.get("usn") {
        Some(s) if !s.is_empty() => s.clone(),
        _ => return,
    };

    let ip = headers
        .get("location")
        .cloned()
        .unwrap_or_else(|| src.ip().to_string());

    // Filter virtual network IPs
    if is_virtual_ip(&ip) {
        return;
    }

    let model_code = headers.get("devmodel.bambu.com").cloned().unwrap_or_default();

    let printer = DiscoveredPrinter {
        serial: serial.clone(),
        name: headers.get("devname.bambu.com").cloned().unwrap_or_default(),
        model_name: model_name(&model_code).to_string(),
        machine_profile: machine_profile(&model_code).to_string(),
        model_code,
        ip,
        signal: headers.get("devsignal.bambu.com").cloned().unwrap_or_default(),
        last_seen: Instant::now(),
    };

    let mut map = discovered.lock().unwrap();
    match map.get(&serial) {
        None => println!(
            "Discovery: found {} \"{}\" (serial {}, model code {}) at {}",
            printer.model_name, printer.name, printer.serial, printer.model_code, printer.ip
        ),
        Some(prev) if prev.ip != printer.ip => println!(
            "Discovery: {} \"{}\" (serial {}) moved from {} to {}",
            printer.model_name, printer.name, printer.serial, prev.ip, printer.ip
        ),
        Some(_) => {}
    }
    map.insert(serial, printer);
}

fn parse_headers(text: &str) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    for line in text.split("\r\n") {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_lowercase(), value.trim().to_string());
        }
    }
    headers
}

/// Loopback and link-local addresses can't be a printer we can reach.
/// (172.16.0.0/12 is deliberately not filtered: it is an ordinary private LAN
/// range, not only Docker's.)
fn is_virtual_ip(ip: &str) -> bool {
    match ip.parse::<Ipv4Addr>() {
        Ok(addr) => addr.is_loopback() || addr.is_link_local(),
        Err(_) => false,
    }
}

fn model_name(code: &str) -> &str {
    match code {
        "3DPrinter-X1-Carbon" | "3DPrinter-X1" | "BL-P001" | "BL-P002" => "Bambu Lab X1C",
        "3DPrinter-X1E" | "C13" => "Bambu Lab X1E",
        "C11" => "Bambu Lab P1P",
        "C12" => "Bambu Lab P1S",
        "N1" => "Bambu Lab A1 Mini",
        "N2S" => "Bambu Lab A1",
        "H2D" | "O1D" => "Bambu Lab H2D",
        "H2C" => "Bambu Lab H2C",
        "H2S" => "Bambu Lab H2S",
        "P2S" => "Bambu Lab P2S",
        _ => "Bambu Lab (Unknown)",
    }
}

fn machine_profile(code: &str) -> &str {
    match code {
        "3DPrinter-X1-Carbon" | "3DPrinter-X1" | "BL-P001" | "BL-P002" => {
            "Bambu Lab X1 Carbon 0.4 nozzle"
        }
        "3DPrinter-X1E" | "C13" => "Bambu Lab X1E 0.4 nozzle",
        "C11" => "Bambu Lab P1P 0.4 nozzle",
        "C12" => "Bambu Lab P1S 0.4 nozzle",
        "N1" => "Bambu Lab A1 mini 0.4 nozzle",
        "N2S" => "Bambu Lab A1 0.4 nozzle",
        "H2D" | "O1D" => "Bambu Lab H2D 0.4 nozzle",
        // H2C has no OrcaSlicer profile yet — leave blank for user to select
        "H2S" => "Bambu Lab H2S 0.4 nozzle",
        "P2S" => "Bambu Lab P2S 0.4 nozzle",
        _ => "",
    }
}
