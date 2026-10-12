//! Upload files to a Bambu printer's storage over implicit FTPS (port 990).
//!
//! The printer runs vsftpd with `require_ssl_reuse`: a passive data
//! connection is refused (`522 SSL connection failed: session reuse
//! required`) unless its TLS handshake resumes the control connection's
//! session. Both connections therefore use one rustls config with a private
//! session cache ([`tls::ftps_config`]) and the same server name.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::ClientConfig;
use tokio_rustls::rustls::pki_types::ServerName;

use super::tls;

pub const FTPS_PORT: u16 = 990;
const STEP_TIMEOUT: Duration = Duration::from_secs(20);
const CHUNK: usize = 64 * 1024;

#[derive(Debug)]
pub struct FtpsError(pub String);

impl std::fmt::Display for FtpsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

type Result<T> = std::result::Result<T, FtpsError>;

fn err(msg: impl Into<String>) -> FtpsError {
    FtpsError(msg.into())
}

async fn step<T, E: std::fmt::Display>(
    what: &str,
    fut: impl Future<Output = std::result::Result<T, E>>,
) -> Result<T> {
    match timeout(STEP_TIMEOUT, fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(err(format!("{what}: {e}"))),
        Err(_) => Err(err(format!("{what}: timed out after {}s", STEP_TIMEOUT.as_secs()))),
    }
}

struct Control<S> {
    stream: BufReader<S>,
}

impl<S: AsyncRead + AsyncWrite + Unpin> Control<S> {
    /// Read one (possibly multi-line) reply: `(code, text)`.
    async fn reply(&mut self) -> Result<(u16, String)> {
        let mut text = String::new();
        let mut line = String::new();
        line.clear();
        let n = step("reading the server's reply", self.stream.read_line(&mut line)).await?;
        if n == 0 {
            return Err(err("the server closed the connection"));
        }
        let code: u16 = line
            .get(..3)
            .and_then(|c| c.parse().ok())
            .ok_or_else(|| err(format!("unexpected reply {line:?}")))?;
        text.push_str(line.trim_end());
        // "123-..." starts a multi-line reply that ends at "123 ...".
        if line.as_bytes().get(3) == Some(&b'-') {
            let end = format!("{code} ");
            loop {
                line.clear();
                let n = step("reading the server's reply", self.stream.read_line(&mut line)).await?;
                if n == 0 {
                    return Err(err("the server closed the connection"));
                }
                text.push('\n');
                text.push_str(line.trim_end());
                if line.starts_with(&end) {
                    break;
                }
            }
        }
        Ok((code, text))
    }

    async fn send(&mut self, command: &str) -> Result<()> {
        let stream = self.stream.get_mut();
        step("sending a command", stream.write_all(format!("{command}\r\n").as_bytes())).await?;
        step("sending a command", stream.flush()).await
    }

    /// Send a command and require a reply code in `ok`.
    async fn expect(&mut self, command: &str, shown: &str, ok: &[u16]) -> Result<String> {
        self.send(command).await?;
        let (code, text) = self.reply().await?;
        if ok.contains(&code) {
            Ok(text)
        } else {
            Err(err(format!("{shown} was refused: {text}")))
        }
    }
}

/// `227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)` → the port.
fn passive_port(text: &str) -> Option<u16> {
    let inner = text.split('(').nth(1)?.split(')').next()?;
    let nums: Vec<u16> = inner.split(',').map(|n| n.trim().parse().ok()).collect::<Option<_>>()?;
    if nums.len() != 6 {
        return None;
    }
    Some(nums[4] * 256 + nums[5])
}

fn server_name(host: &str) -> Result<ServerName<'static>> {
    ServerName::try_from(host.to_string()).map_err(|e| err(format!("bad printer address {host:?}: {e}")))
}

async fn tls_connect(
    config: &Arc<ClientConfig>,
    name: &ServerName<'static>,
    addr: SocketAddr,
    what: &str,
) -> Result<TlsStream<TcpStream>> {
    let tcp = step(&format!("connecting to {addr} ({what})"), TcpStream::connect(addr)).await?;
    tcp.set_nodelay(true).ok();
    step(
        &format!("TLS handshake with {addr} ({what})"),
        TlsConnector::from(config.clone()).connect(name.clone(), tcp),
    )
    .await
}

/// A logged-in FTPS session with a printer.
pub struct Session {
    host: String,
    addr: SocketAddr,
    config: Arc<ClientConfig>,
    name: ServerName<'static>,
    control: Control<TlsStream<TcpStream>>,
}

impl Session {
    pub async fn open(host: &str, port: u16, access_code: &str) -> Result<Session> {
        let config = tls::ftps_config();
        let name = server_name(host)?;
        let addr: SocketAddr = step(&format!("resolving {host}"), tokio::net::lookup_host((host, port)))
            .await?
            .next()
            .ok_or_else(|| err(format!("{host} has no address")))?;
        let stream = tls_connect(&config, &name, addr, "control").await?;
        let mut control = Control { stream: BufReader::new(stream) };
        let (code, text) = control.reply().await?;
        if code != 220 {
            return Err(err(format!("unexpected greeting: {text}")));
        }
        control.expect("USER bblp", "USER", &[331, 230]).await?;
        control
            .expect(&format!("PASS {access_code}"), "the access code", &[230, 202])
            .await
            .map_err(|e| err(format!("{e} (is the access code current?)")))?;
        control.expect("PBSZ 0", "PBSZ", &[200]).await?;
        control.expect("PROT P", "PROT P", &[200]).await?;
        control.expect("TYPE I", "TYPE I", &[200]).await?;
        Ok(Session { host: host.to_string(), addr, config, name, control })
    }

    /// PASV, connect, send `command`; the data connection once the server
    /// accepted it, or the refusal `(code, text)`.
    async fn data(&mut self, command: &str) -> Result<std::result::Result<TlsStream<TcpStream>, (u16, String)>> {
        let pasv = self.control.expect("PASV", "PASV", &[227]).await?;
        let data_port = passive_port(&pasv).ok_or_else(|| err(format!("can't read the PASV reply: {pasv}")))?;
        // Connect to the control connection's address: the one in the reply
        // can be wrong behind NAT.
        let data_addr = SocketAddr::new(self.addr.ip(), data_port);
        let data_tcp = step(&format!("connecting to {data_addr} (data)"), TcpStream::connect(data_addr)).await?;
        self.control.send(command).await?;
        let (code, text) = self.control.reply().await?;
        if code != 150 && code != 125 {
            return Ok(Err((code, text)));
        }
        let stream = step(
            &format!("TLS handshake with {data_addr} (data)"),
            TlsConnector::from(self.config.clone()).connect(self.name.clone(), data_tcp),
        )
        .await?;
        if stream.get_ref().1.handshake_kind() != Some(tokio_rustls::rustls::HandshakeKind::Resumed) {
            eprintln!(
                "FTPS {}: the data connection did not resume the TLS session; the printer may refuse it",
                self.host
            );
        }
        Ok(Ok(stream))
    }

    /// Store `data` as `remote_path`; `progress(sent, total)` as bytes go out.
    pub async fn store(&mut self, remote_path: &str, data: &[u8], mut progress: impl FnMut(u64, u64)) -> Result<()> {
        check_path(remote_path)?;
        let mut data_stream = self
            .data(&format!("STOR {remote_path}"))
            .await?
            .map_err(|(_, text)| err(format!("STOR {remote_path} was refused: {text}")))?;
        let total = data.len() as u64;
        let mut sent = 0u64;
        for chunk in data.chunks(CHUNK) {
            step("sending the file", data_stream.write_all(chunk)).await?;
            sent += chunk.len() as u64;
            progress(sent, total);
        }
        step("finishing the upload", data_stream.flush()).await?;
        // close_notify + FIN: the server's end-of-file.
        step("finishing the upload", data_stream.shutdown()).await?;
        // Then read until the server closes too. It may have sent TLS 1.3
        // session tickets we never read, and closing a socket with unread
        // input resets the connection, which can cut off the end of the file.
        let mut rest = Vec::new();
        let _ = timeout(STEP_TIMEOUT, data_stream.read_to_end(&mut rest)).await;
        drop(data_stream);
        let (code, text) = self.control.reply().await?;
        if code != 226 && code != 250 {
            return Err(err(format!("the upload of {remote_path} failed: {text}")));
        }
        Ok(())
    }

    /// Fetch `remote_path`, at most `max_bytes` of it. `Ok(None)` when the
    /// file doesn't exist (or is bigger than that).
    pub async fn retrieve(&mut self, remote_path: &str, max_bytes: usize) -> Result<Option<Vec<u8>>> {
        check_path(remote_path)?;
        let mut data_stream = match self.data(&format!("RETR {remote_path}")).await? {
            Ok(s) => s,
            Err((550, _)) => return Ok(None),
            Err((_, text)) => return Err(err(format!("RETR {remote_path} was refused: {text}"))),
        };
        let mut out = Vec::new();
        let mut chunk = vec![0u8; CHUNK];
        let mut too_big = false;
        loop {
            let n = step("receiving the file", data_stream.read(&mut chunk)).await?;
            if n == 0 {
                break;
            }
            if out.len() + n > max_bytes {
                too_big = true;
                break;
            }
            out.extend_from_slice(&chunk[..n]);
        }
        drop(data_stream);
        // 226 after a complete transfer; 426/451 when we hung up early.
        let (code, text) = self.control.reply().await?;
        if too_big {
            return Ok(None);
        }
        if code != 226 && code != 250 {
            return Err(err(format!("the download of {remote_path} failed: {text}")));
        }
        Ok(Some(out))
    }

    /// Log out (best effort).
    pub async fn quit(mut self) {
        if self.control.send("QUIT").await.is_ok() {
            let _ = self.control.reply().await;
        }
        let _ = timeout(STEP_TIMEOUT, self.control.stream.get_mut().shutdown()).await;
    }
}

fn check_path(path: &str) -> Result<()> {
    if path.contains(['\r', '\n']) {
        return Err(err("file names can't contain line breaks"));
    }
    Ok(())
}

/// Upload `data` as `remote_path` (e.g. `/Bracket-1a2b3c4d.gcode.3mf`).
/// `progress(sent, total)` is called as bytes go out.
pub async fn upload(
    host: &str,
    port: u16,
    access_code: &str,
    remote_path: &str,
    data: &[u8],
    progress: impl FnMut(u64, u64),
) -> Result<()> {
    check_path(remote_path)?;
    let mut session = Session::open(host, port, access_code).await?;
    session.store(remote_path, data, progress).await?;
    session.quit().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::net::TcpListener;
    use tokio_rustls::TlsAcceptor;
    use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    use tokio_rustls::rustls::{self, HandshakeKind, ServerConfig};

    #[test]
    fn parses_pasv() {
        assert_eq!(passive_port("227 Entering Passive Mode (10,0,0,5,195,80)."), Some(50000));
        assert_eq!(passive_port("227 nonsense"), None);
    }

    /// What the fake server saw.
    #[derive(Default, Debug)]
    struct Seen {
        stored: Option<(String, Vec<u8>)>,
        data_resumed: Option<bool>,
    }

    fn server_config() -> Arc<ServerConfig> {
        let key = rcgen::generate_simple_self_signed(vec!["printer.test".into()]).unwrap();
        let cert = CertificateDer::from(key.cert.der().to_vec());
        let pkey = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.signing_key.serialize_der()));
        let config = ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![cert], pkey)
            .unwrap();
        Arc::new(config)
    }

    /// A minimal vsftpd stand-in: implicit TLS, one upload, and like
    /// `require_ssl_reuse=YES` it refuses a data connection that didn't
    /// resume the control session.
    async fn fake_server(code: &'static str) -> (u16, Arc<Mutex<Seen>>) {
        let acceptor = TlsAcceptor::from(server_config());
        let control = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = control.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Seen::default()));
        let out = seen.clone();
        tokio::spawn(async move {
            let (tcp, _) = control.accept().await.unwrap();
            let tls = acceptor.accept(tcp).await.unwrap();
            let mut s = BufReader::new(tls);
            s.get_mut().write_all(b"220-Welcome\r\n220 ready\r\n").await.unwrap();
            // Like vsftpd: a fresh passive port per PASV.
            let mut data_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            loop {
                let mut line = String::new();
                if s.read_line(&mut line).await.unwrap() == 0 {
                    return;
                }
                let line = line.trim_end();
                let reply = match line.split_once(' ').map_or((line, ""), |(a, b)| (a, b)) {
                    ("USER", _) => "331 Please specify the password.".to_string(),
                    ("PASS", p) if p == code => "230 Login successful.".to_string(),
                    ("PASS", _) => "530 Login incorrect.".to_string(),
                    ("PBSZ", _) | ("PROT", _) | ("TYPE", _) => "200 OK.".to_string(),
                    ("PASV", _) => {
                        data_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                        let data_port = data_listener.local_addr().unwrap().port();
                        format!("227 Entering Passive Mode (10,9,8,7,{},{}).", data_port / 256, data_port % 256)
                    }
                    ("STOR", path) => {
                        let path = path.to_string();
                        let (tcp, _) = data_listener.accept().await.unwrap();
                        s.get_mut().write_all(b"150 Ok to send data.\r\n").await.unwrap();
                        let mut data = acceptor.accept(tcp).await.unwrap();
                        let resumed = data.get_ref().1.handshake_kind() == Some(HandshakeKind::Resumed);
                        seen.lock().unwrap().data_resumed = Some(resumed);
                        if !resumed {
                            s.get_mut()
                                .write_all(b"522 SSL connection failed: session reuse required\r\n")
                                .await
                                .unwrap();
                            continue;
                        }
                        let mut buf = Vec::new();
                        data.read_to_end(&mut buf).await.unwrap();
                        seen.lock().unwrap().stored = Some((path, buf));
                        "226 Transfer complete.".to_string()
                    }
                    ("RETR", path) => {
                        let stored = seen.lock().unwrap().stored.clone();
                        match stored.filter(|(p, _)| p == path) {
                            None => "550 Failed to open file.".to_string(),
                            Some((_, bytes)) => {
                                let (tcp, _) = data_listener.accept().await.unwrap();
                                s.get_mut().write_all(b"150 Opening BINARY mode data connection.\r\n").await.unwrap();
                                let mut data = acceptor.accept(tcp).await.unwrap();
                                data.write_all(&bytes).await.unwrap();
                                data.shutdown().await.unwrap();
                                "226 Transfer complete.".to_string()
                            }
                        }
                    }
                    ("QUIT", _) => {
                        let _ = s.get_mut().write_all(b"221 Goodbye.\r\n").await;
                        return;
                    }
                    _ => "500 Unknown command.".to_string(),
                };
                s.get_mut().write_all(format!("{reply}\r\n").as_bytes()).await.unwrap();
            }
        });
        (port, out)
    }

    #[tokio::test]
    async fn uploads_with_a_resumed_data_session() {
        let (port, seen) = fake_server("12345678").await;
        let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let mut last = (0, 0);
        upload("127.0.0.1", port, "12345678", "/Part-1.gcode.3mf", &data, |s, t| last = (s, t))
            .await
            .unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.data_resumed, Some(true));
        let (path, stored) = seen.stored.as_ref().unwrap();
        assert_eq!(path, "/Part-1.gcode.3mf");
        assert_eq!(stored, &data);
        assert_eq!(last, (data.len() as u64, data.len() as u64));
    }

    /// Against a real server (a printer, or vsftpd configured like one):
    /// `FARMSLICER_FTPS_TEST=host:port:access_code cargo test -- --ignored live_upload`
    #[tokio::test]
    #[ignore]
    async fn live_upload() {
        let target = std::env::var("FARMSLICER_FTPS_TEST").expect("FARMSLICER_FTPS_TEST=host:port:code");
        let mut parts = target.splitn(3, ':');
        let (host, port, code) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap());
        let data = vec![b'x'; 5 << 20];
        upload(host, port.parse().unwrap(), code, "/farmslicer-live-test.bin", &data, |_, _| {})
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn one_session_stores_and_retrieves() {
        let (port, _) = fake_server("12345678").await;
        let mut session = Session::open("127.0.0.1", port, "12345678").await.unwrap();
        session.store("/a.gcode.3mf", b"hello", |_, _| {}).await.unwrap();
        assert_eq!(session.retrieve("/missing.3mf", 1 << 20).await.unwrap(), None);
        assert_eq!(session.retrieve("/a.gcode.3mf", 1 << 20).await.unwrap().as_deref(), Some(&b"hello"[..]));
        assert_eq!(session.retrieve("/a.gcode.3mf", 3).await.unwrap(), None, "over the size cap");
        session.quit().await;
    }

    #[tokio::test]
    async fn wrong_access_code_is_reported() {
        let (port, _) = fake_server("12345678").await;
        let e = upload("127.0.0.1", port, "nope", "/x.gcode.3mf", b"x", |_, _| {})
            .await
            .unwrap_err();
        assert!(e.0.contains("access code"), "{e}");
    }
}
