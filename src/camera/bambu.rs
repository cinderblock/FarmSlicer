//! Bambu Lab cameras:
//! - X1, H2, P2S, X2D: H.264 over RTSPS on port 322
//!   (`rtsps://bblp:<code>@<ip>:322/streaming/live/1`). We speak RTSP with
//!   `retina` through a local TLS proxy, so the access code never appears on
//!   a command line.
//! - A1, P1: JPEG frames over TLS on port 6000 after an 80-byte login
//!   (u32 LE 0x40, u32 LE 0x3000, two zero u32s, "bblp" and the access code
//!   each NUL-padded to 32 bytes); each frame is a 16-byte header whose first
//!   u32 LE is the JPEG's length, then the JPEG.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::pki_types::ServerName;

use super::{CONNECT_TIMEOUT, CameraKind, Frame, Idle, MAX_JPEG, publish};
use crate::printer::tls;

pub const RTSP_PORT: u16 = 322;
pub const JPEG_PORT: u16 = 6000;

/// Bambu model ids whose camera is the port-6000 JPEG stream.
const JPEG_MODELS: &[&str] = &["C11", "C12", "N1", "N2S"];

/// The camera of a Bambu printer of `model_id` (`None`: unknown, assume
/// the RTSP kind most models have).
pub fn bambu_kind(model_id: Option<&str>, address: &str, access_code: &str) -> CameraKind {
    let (address, access_code) = (address.to_string(), access_code.to_string());
    match model_id {
        Some(id) if JPEG_MODELS.contains(&id) => CameraKind::BambuJpeg { address, access_code },
        _ => CameraKind::BambuRtsp { address, access_code },
    }
}

async fn tls_connect(address: &str, port: u16) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    let name = ServerName::try_from(address.to_string()).map_err(|e| format!("bad address {address:?}: {e}"))?;
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((address, port)))
        .await
        .map_err(|_| format!("connecting to {address}:{port} timed out"))?
        .map_err(|e| format!("connecting to {address}:{port}: {e}"))?;
    tcp.set_nodelay(true).ok();
    tokio::time::timeout(CONNECT_TIMEOUT, TlsConnector::from(tls::mqtt_config()).connect(name, tcp))
        .await
        .map_err(|_| format!("TLS with {address}:{port} timed out"))?
        .map_err(|e| format!("TLS with {address}:{port}: {e}"))
}

// -- A1/P1: JPEG over TLS on 6000 ------------------------------------------------

fn jpeg_login(access_code: &str) -> [u8; 80] {
    let mut p = [0u8; 80];
    p[0..4].copy_from_slice(&0x40u32.to_le_bytes());
    p[4..8].copy_from_slice(&0x3000u32.to_le_bytes());
    let user = b"bblp";
    p[16..16 + user.len()].copy_from_slice(user);
    let code = access_code.as_bytes();
    let n = code.len().min(32);
    p[48..48 + n].copy_from_slice(&code[..n]);
    p
}

pub async fn run_jpeg(
    address: &str,
    access_code: &str,
    tx: &broadcast::Sender<Arc<Frame>>,
    backlog: &Mutex<Vec<Arc<Frame>>>,
) -> Result<(), String> {
    let mut stream = tls_connect(address, JPEG_PORT).await?;
    stream
        .write_all(&jpeg_login(access_code))
        .await
        .map_err(|e| format!("camera login: {e}"))?;
    let mut idle = Idle::default();
    let mut header = [0u8; 16];
    loop {
        if idle.should_stop(tx) {
            return Ok(());
        }
        // The printer sends ~1-2 frames a second; a long silence is a dead link.
        match tokio::time::timeout(Duration::from_secs(15), stream.read_exact(&mut header)).await {
            Err(_) => return Err("the camera stopped sending (is the access code right?)".into()),
            Ok(Err(e)) => return Err(format!("camera stream: {e} (is the access code right?)")),
            Ok(Ok(_)) => {}
        }
        let len = u32::from_le_bytes(header[0..4].try_into().unwrap()) as usize;
        if len == 0 || len > MAX_JPEG {
            return Err(format!("camera stream out of sync (frame of {len} bytes)"));
        }
        let mut jpeg = vec![0u8; len];
        stream.read_exact(&mut jpeg).await.map_err(|e| format!("camera stream: {e}"))?;
        if !(jpeg.starts_with(&[0xFF, 0xD8]) && jpeg.ends_with(&[0xFF, 0xD9])) {
            return Err("camera sent something that isn't a JPEG".into());
        }
        publish(tx, backlog, Frame::Jpeg(Bytes::from(jpeg)));
    }
}

// -- X1/H2: H.264 over RTSPS on 322 ------------------------------------------------

/// Rewrite the URL in an RTSP request line: `from` prefix → `to`.
fn rewrite_request_line(head: &[u8], from: &str, to: &str) -> Vec<u8> {
    let line_end = head.iter().position(|&b| b == b'\n').map_or(head.len(), |i| i + 1);
    let (line, rest) = head.split_at(line_end);
    let line = String::from_utf8_lossy(line).replacen(from, to, 1);
    let mut out = line.into_bytes();
    out.extend_from_slice(rest);
    out
}

/// Client → printer: forward interleaved binary frames (`$`, channel, u16
/// length) untouched, and RTSP requests with their request-line URL turned
/// from our local address into the printer's `rtsps://` one. LIVE555 on the
/// printers redirects any other URL; digest auth still works because it
/// hashes the `uri=` in the Authorization header, which stays as it was.
async fn forward_requests<R, W>(mut from: R, mut to: W, local: String, remote: String) -> std::io::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    loop {
        // Forward everything complete in the buffer.
        loop {
            if buf.first() == Some(&b'$') {
                if buf.len() < 4 {
                    break;
                }
                let len = 4 + u16::from_be_bytes([buf[2], buf[3]]) as usize;
                if buf.len() < len {
                    break;
                }
                to.write_all(&buf[..len]).await?;
                buf.drain(..len);
            } else if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head_len = end + 4;
                let head = String::from_utf8_lossy(&buf[..head_len]).to_ascii_lowercase();
                let body_len = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if buf.len() < head_len + body_len {
                    break;
                }
                to.write_all(&rewrite_request_line(&buf[..head_len], &local, &remote)).await?;
                to.write_all(&buf[head_len..head_len + body_len]).await?;
                buf.drain(..head_len + body_len);
            } else {
                break;
            }
        }
        to.flush().await?;
        let n = from.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > 1 << 20 {
            return Err(std::io::Error::other("RTSP request too large"));
        }
    }
}

/// Accept one local connection and splice it to the printer over TLS,
/// rewriting request URLs (see `forward_requests`). Returns the local port.
async fn tls_proxy(address: String) -> Result<(u16, tokio::task::JoinHandle<()>), String> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("camera proxy: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let task = tokio::spawn(async move {
        let Ok((local, _)) = listener.accept().await else { return };
        drop(listener);
        let remote = match tls_connect(&address, RTSP_PORT).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("Camera proxy: {e}");
                return;
            }
        };
        let (local_read, mut local_write) = tokio::io::split(local);
        let (mut remote_read, remote_write) = tokio::io::split(remote);
        let up = forward_requests(
            local_read,
            remote_write,
            format!("rtsp://127.0.0.1:{port}"),
            format!("rtsps://{address}:{RTSP_PORT}"),
        );
        let down = tokio::io::copy(&mut remote_read, &mut local_write);
        tokio::select! {
            _ = up => {}
            _ = down => {}
        }
    });
    Ok((port, task))
}

pub async fn run_rtsp(
    address: &str,
    access_code: &str,
    tx: &broadcast::Sender<Arc<Frame>>,
    backlog: &Mutex<Vec<Arc<Frame>>>,
) -> Result<(), String> {
    use retina::client::{Credentials, PlayOptions, SessionOptions, SetupOptions, TcpTransportOptions, Transport};
    use retina::codec::{CodecItem, ParametersRef};

    let (port, proxy) = tls_proxy(address.to_string()).await?;
    struct AbortOnDrop(tokio::task::JoinHandle<()>);
    impl Drop for AbortOnDrop {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _proxy = AbortOnDrop(proxy);

    let url = url::Url::parse(&format!("rtsp://127.0.0.1:{port}/streaming/live/1")).expect("valid URL");
    let options = SessionOptions::default()
        .creds(Some(Credentials { username: "bblp".into(), password: access_code.to_string() }))
        .user_agent("FarmSlicer".into());
    let mut session = tokio::time::timeout(CONNECT_TIMEOUT, retina::client::Session::describe(url, options))
        .await
        .map_err(|_| "the camera didn't answer (is LAN liveview on?)".to_string())?
        .map_err(|e| format!("camera: {e} (is the access code right, and LAN liveview on?)"))?;
    let video = session
        .streams()
        .iter()
        .position(|s| s.media() == "video" && s.encoding_name() == "h264")
        .ok_or("the camera offers no H.264 video")?;
    session
        .setup(video, SetupOptions::default().transport(Transport::Tcp(TcpTransportOptions::default())))
        .await
        .map_err(|e| format!("camera setup: {e}"))?;
    let session = session
        .play(PlayOptions::default())
        .await
        .map_err(|e| format!("camera play: {e}"))?
        .demuxed()
        .map_err(|e| format!("camera: {e}"))?;
    tokio::pin!(session);

    let init_from = |params: Option<ParametersRef<'_>>| match params {
        Some(ParametersRef::Video(v)) => Some(Frame::H264Init {
            codec: v.rfc6381_codec().to_string(),
            description: Bytes::copy_from_slice(v.extra_data()),
            width: v.pixel_dimensions().0,
            height: v.pixel_dimensions().1,
        }),
        _ => None,
    };
    if let Some(init) = init_from(session.streams()[video].parameters()) {
        publish(tx, backlog, init);
    }

    let mut idle = Idle::default();
    let mut check = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            item = session.next() => match item {
                None => return Err("the camera ended the stream".into()),
                Some(Err(e)) => return Err(format!("camera stream: {e}")),
                Some(Ok(CodecItem::VideoFrame(frame))) => {
                    if frame.has_new_parameters() {
                        if let Some(init) = init_from(session.streams()[video].parameters()) {
                            publish(tx, backlog, init);
                        }
                    }
                    let ts = frame.timestamp();
                    let timestamp_us = (ts.elapsed() as i128 * 1_000_000 / ts.clock_rate().get() as i128) as i64;
                    publish(tx, backlog, Frame::H264 {
                        key: frame.is_random_access_point(),
                        timestamp_us,
                        data: Bytes::from(frame.into_data()),
                    });
                }
                Some(Ok(_)) => {}
            },
            _ = check.tick() => {
                if idle.should_stop(tx) {
                    return Ok(());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_packet_layout() {
        let p = jpeg_login("12345678");
        assert_eq!(&p[0..8], &[0x40, 0, 0, 0, 0, 0x30, 0, 0]);
        assert_eq!(&p[16..20], b"bblp");
        assert_eq!(&p[48..56], b"12345678");
        assert!(p[56..].iter().all(|&b| b == 0));
    }

    #[tokio::test]
    async fn proxy_rewrites_request_lines_only() {
        let requests = b"DESCRIBE rtsp://127.0.0.1:5000/streaming/live/1 RTSP/1.0\r\nCSeq: 1\r\nAuthorization: Digest uri=\"rtsp://127.0.0.1:5000/streaming/live/1\"\r\n\r\n\
$\x01\x00\x03abcSET_PARAMETER rtsp://127.0.0.1:5000/x RTSP/1.0\r\nContent-Length: 4\r\n\r\nbody";
        let mut out = Vec::new();
        // Feed it in awkward pieces.
        let (mut w, r) = tokio::io::duplex(7);
        let feeder = tokio::spawn(async move {
            for piece in requests.chunks(5) {
                w.write_all(piece).await.unwrap();
            }
        });
        forward_requests(r, &mut out, "rtsp://127.0.0.1:5000".into(), "rtsps://10.0.0.5:322".into())
            .await
            .unwrap();
        feeder.await.unwrap();
        let out = String::from_utf8_lossy(&out);
        assert!(out.starts_with("DESCRIBE rtsps://10.0.0.5:322/streaming/live/1 RTSP/1.0\r\n"), "{out}");
        assert!(out.contains("uri=\"rtsp://127.0.0.1:5000/streaming/live/1\""), "digest uri kept: {out}");
        assert!(out.contains("$\u{1}\u{0}\u{3}abcSET_PARAMETER rtsps://10.0.0.5:322/x RTSP/1.0"), "{out}");
        assert!(out.ends_with("\r\n\r\nbody"), "{out}");
    }

    #[test]
    fn camera_kind_by_model() {
        let jpeg = |id| matches!(bambu_kind(id, "a", "c"), CameraKind::BambuJpeg { .. });
        assert!(jpeg(Some("C12")));
        assert!(jpeg(Some("N1")));
        assert!(!jpeg(Some("BL-P001")));
        assert!(!jpeg(Some("O1D")));
        assert!(!jpeg(None));
    }
}
