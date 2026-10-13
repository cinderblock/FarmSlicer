//! Printer cameras, on demand.
//!
//! Three kinds of source (see [`CameraKind`]): Bambu's two (`bambu.rs`) and
//! MJPEG over HTTP (`mjpeg.rs`, Klipper/OctoPrint webcams, Elegoo). H.264
//! goes to browsers as access units they decode with WebCodecs (no
//! transcoding here); everything else as JPEG frames.
//!
//! A feed starts when the first viewer subscribes and stops a little after
//! the last one leaves, so each printer's camera has one upstream
//! connection however many people watch. Late viewers get the stream setup
//! and the frames since the last key frame (or the last JPEG), so they see
//! a picture at once.

mod bambu;
mod mjpeg;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use tokio::sync::broadcast;

pub use bambu::bambu_kind;

/// Keep a feed this long after its last viewer left (page reloads).
const LINGER: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A JPEG frame larger than this means we lost sync with the stream.
const MAX_JPEG: usize = 8 << 20;

#[derive(Debug)]
pub enum Frame {
    /// H.264 stream setup: WebCodecs `codec` string, the avcC record as the
    /// decoder `description`, and the picture size.
    H264Init { codec: String, description: Bytes, width: u32, height: u32 },
    /// One access unit, AVC (length-prefixed) format. Timestamp in µs.
    H264 { key: bool, timestamp_us: i64, data: Bytes },
    Jpeg(Bytes),
    /// The feed stopped; why.
    Error(String),
}

/// Where a printer's pictures come from.
#[derive(Clone, Debug)]
pub enum CameraKind {
    /// X1/H2-class Bambu printers: H.264 over RTSPS on 322.
    BambuRtsp { address: String, access_code: String },
    /// A1/P1 Bambu printers: JPEG frames over TLS on 6000.
    BambuJpeg { address: String, access_code: String },
    /// An MJPEG stream over HTTP (mjpg-streamer, ustreamer, crowsnest), or a
    /// snapshot URL polled when there is no stream.
    Mjpeg { stream: Option<url::Url>, snapshot: Option<url::Url> },
}

impl CameraKind {
    /// For logs, without credentials.
    fn describe(&self) -> String {
        match self {
            CameraKind::BambuRtsp { address, .. } => format!("RTSPS at {address}"),
            CameraKind::BambuJpeg { address, .. } => format!("JPEG at {address}"),
            CameraKind::Mjpeg { stream: Some(u), .. } => format!("MJPEG at {u}"),
            CameraKind::Mjpeg { snapshot: Some(u), .. } => format!("snapshots at {u}"),
            CameraKind::Mjpeg { .. } => "nothing".to_string(),
        }
    }

    /// What the browser gets: "h264" or "jpeg".
    pub fn browser_kind(&self) -> &'static str {
        match self {
            CameraKind::BambuRtsp { .. } => "h264",
            CameraKind::BambuJpeg { .. } | CameraKind::Mjpeg { .. } => "jpeg",
        }
    }
}

#[derive(Clone)]
pub struct CameraSource {
    pub printer_id: String,
    pub name: String,
    pub kind: CameraKind,
}

struct Feed {
    tx: broadcast::Sender<Arc<Frame>>,
    /// What a new viewer needs before live frames: the H.264 setup and the
    /// current group of pictures.
    backlog: Arc<Mutex<Vec<Arc<Frame>>>>,
}

#[derive(Clone, Default)]
pub struct CameraHub {
    feeds: Arc<Mutex<HashMap<String, Feed>>>,
}

pub struct Subscription {
    pub backlog: Vec<Arc<Frame>>,
    pub frames: broadcast::Receiver<Arc<Frame>>,
}

impl CameraHub {
    /// Watch a printer's camera, starting its feed if needed.
    pub fn watch(&self, source: CameraSource) -> Subscription {
        let mut feeds = self.feeds.lock().unwrap();
        if let Some(feed) = feeds.get(&source.printer_id) {
            return Subscription {
                backlog: feed.backlog.lock().unwrap().clone(),
                frames: feed.tx.subscribe(),
            };
        }
        let (tx, rx) = broadcast::channel(256);
        let backlog = Arc::new(Mutex::new(Vec::new()));
        feeds.insert(source.printer_id.clone(), Feed { tx: tx.clone(), backlog: backlog.clone() });
        let hub = self.clone();
        tokio::spawn(async move {
            let id = source.printer_id.clone();
            println!("Camera {}: starting ({})", source.name, source.kind.describe());
            let result = run_feed(&source, &tx, &backlog).await;
            let why = match result {
                Ok(()) => "no viewers left".to_string(),
                Err(e) => {
                    eprintln!("Camera {}: {e}", source.name);
                    let _ = tx.send(Arc::new(Frame::Error(e.clone())));
                    e
                }
            };
            println!("Camera {}: stopped ({why})", source.name);
            hub.feeds.lock().unwrap().remove(&id);
        });
        Subscription { backlog: Vec::new(), frames: rx }
    }
}

/// Publish a frame and keep the backlog new viewers start from.
pub(crate) fn publish(tx: &broadcast::Sender<Arc<Frame>>, backlog: &Mutex<Vec<Arc<Frame>>>, frame: Frame) {
    let frame = Arc::new(frame);
    {
        let mut b = backlog.lock().unwrap();
        match &*frame {
            Frame::H264Init { .. } => {
                b.clear();
                b.push(frame.clone());
            }
            Frame::H264 { key: true, .. } => {
                b.retain(|f| matches!(**f, Frame::H264Init { .. }));
                b.push(frame.clone());
            }
            Frame::H264 { .. } => {
                // Bound memory if key frames are rare.
                if b.len() < 600 {
                    b.push(frame.clone());
                }
            }
            Frame::Jpeg(_) => {
                b.clear();
                b.push(frame.clone());
            }
            Frame::Error(_) => {}
        }
    }
    let _ = tx.send(frame);
}

/// Does anyone still watch? (Lingers before saying no.)
pub(crate) struct Idle {
    since: Option<tokio::time::Instant>,
}

impl Default for Idle {
    fn default() -> Self {
        Self { since: None }
    }
}

impl Idle {
    pub(crate) fn should_stop(&mut self, tx: &broadcast::Sender<Arc<Frame>>) -> bool {
        if tx.receiver_count() > 0 {
            self.since = None;
            return false;
        }
        let since = *self.since.get_or_insert_with(tokio::time::Instant::now);
        since.elapsed() > LINGER
    }
}

async fn run_feed(
    source: &CameraSource,
    tx: &broadcast::Sender<Arc<Frame>>,
    backlog: &Mutex<Vec<Arc<Frame>>>,
) -> Result<(), String> {
    match &source.kind {
        CameraKind::BambuJpeg { address, access_code } => bambu::run_jpeg(address, access_code, tx, backlog).await,
        CameraKind::BambuRtsp { address, access_code } => bambu::run_rtsp(address, access_code, tx, backlog).await,
        CameraKind::Mjpeg { stream, snapshot } => mjpeg::run(stream.as_ref(), snapshot.as_ref(), tx, backlog).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backlog_restarts_at_key_frames() {
        let (tx, _rx) = broadcast::channel(16);
        let backlog = Mutex::new(Vec::new());
        let h = |key| Frame::H264 { key, timestamp_us: 0, data: Bytes::new() };
        publish(&tx, &backlog, Frame::H264Init { codec: "avc1".into(), description: Bytes::new(), width: 1, height: 1 });
        publish(&tx, &backlog, h(true));
        publish(&tx, &backlog, h(false));
        publish(&tx, &backlog, h(true));
        publish(&tx, &backlog, h(false));
        let b = backlog.lock().unwrap();
        assert_eq!(b.len(), 3, "setup + the latest key frame + one delta");
        assert!(matches!(*b[0], Frame::H264Init { .. }));
        assert!(matches!(*b[1], Frame::H264 { key: true, .. }));
    }
}
