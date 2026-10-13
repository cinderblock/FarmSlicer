//! MJPEG over HTTP, the webcam format of Klipper hosts (mjpg-streamer,
//! ustreamer, crowsnest), OctoPrint and Elegoo printers: a
//! `multipart/x-mixed-replace` response whose parts are JPEGs. Or, for
//! cameras with only a snapshot URL, that URL polled about once a second.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use tokio::sync::broadcast;

use super::{CONNECT_TIMEOUT, Frame, Idle, MAX_JPEG, publish};

/// A stream that sends nothing for this long has stalled.
const STALL: Duration = Duration::from_secs(15);
const SNAPSHOT_INTERVAL: Duration = Duration::from_millis(1000);

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    // No overall timeout: a stream runs as long as someone watches.
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .use_preconfigured_tls(crate::printer::tls::https_config())
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .expect("the HTTP client builds")
    })
}

pub async fn run(
    stream: Option<&url::Url>,
    snapshot: Option<&url::Url>,
    tx: &broadcast::Sender<Arc<Frame>>,
    backlog: &Mutex<Vec<Arc<Frame>>>,
) -> Result<(), String> {
    match (stream, snapshot) {
        (Some(url), _) => run_stream(url, tx, backlog).await,
        (None, Some(url)) => run_snapshots(url, tx, backlog).await,
        (None, None) => Err("the printer has no camera set up".into()),
    }
}

/// Pulls JPEGs out of a multipart byte stream. Uses each part's
/// `Content-Length` when given; otherwise finds the JPEG's own start (FFD8)
/// and end (FFD9) markers.
#[derive(Default)]
struct Splitter {
    buf: BytesMut,
}

impl Splitter {
    fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    fn next_jpeg(&mut self) -> Result<Option<Bytes>, String> {
        let Some(soi) = find(&self.buf, &[0xFF, 0xD8, 0xFF]) else {
            // Part headers so far (they hold the length); junk beyond
            // reason is dropped, but for a possible partial marker.
            if self.buf.len() > 64 << 10 {
                let drop = self.buf.len() - 2;
                let _ = self.buf.split_to(drop);
            }
            return Ok(None);
        };
        // The part's headers sit just before the JPEG.
        let headers = String::from_utf8_lossy(&self.buf[..soi]).to_ascii_lowercase();
        let length = headers
            .lines()
            .rev()
            .find_map(|l| l.strip_prefix("content-length:"))
            .and_then(|v| v.trim().parse::<usize>().ok());
        let end = match length {
            Some(n) if n > MAX_JPEG => return Err(format!("camera frame of {n} bytes is too big")),
            Some(n) if self.buf.len() >= soi + n => Some(soi + n),
            Some(_) => None,
            None => find(&self.buf[soi + 2..], &[0xFF, 0xD9]).map(|i| soi + 2 + i + 2),
        };
        let Some(end) = end else {
            if self.buf.len() - soi > MAX_JPEG {
                return Err("camera stream out of sync (no frame end)".into());
            }
            return Ok(None);
        };
        let _ = self.buf.split_to(soi);
        Ok(Some(self.buf.split_to(end - soi).freeze()))
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn run_stream(url: &url::Url, tx: &broadcast::Sender<Arc<Frame>>, backlog: &Mutex<Vec<Arc<Frame>>>) -> Result<(), String> {
    let response = client()
        .get(url.clone())
        .send()
        .await
        .map_err(|e| format!("camera at {url}: {}", crate::printer::http::explain(&e)))?;
    if !response.status().is_success() {
        return Err(format!("camera at {url}: HTTP {}", response.status()));
    }
    let mut body = response.bytes_stream();
    let mut splitter = Splitter::default();
    let mut idle = Idle::default();
    loop {
        if idle.should_stop(tx) {
            return Ok(());
        }
        let chunk = match tokio::time::timeout(STALL, body.next()).await {
            Err(_) => return Err("the camera stopped sending".into()),
            Ok(None) => return Err("the camera ended the stream".into()),
            Ok(Some(Err(e))) => return Err(format!("camera stream: {e}")),
            Ok(Some(Ok(c))) => c,
        };
        splitter.push(&chunk);
        while let Some(jpeg) = splitter.next_jpeg()? {
            publish(tx, backlog, Frame::Jpeg(jpeg));
        }
    }
}

async fn run_snapshots(url: &url::Url, tx: &broadcast::Sender<Arc<Frame>>, backlog: &Mutex<Vec<Arc<Frame>>>) -> Result<(), String> {
    let mut idle = Idle::default();
    let mut tick = tokio::time::interval(SNAPSHOT_INTERVAL);
    let mut failures = 0;
    loop {
        tick.tick().await;
        if idle.should_stop(tx) {
            return Ok(());
        }
        let result = async {
            let r = client().get(url.clone()).timeout(STALL).send().await.map_err(|e| crate::printer::http::explain(&e))?;
            if !r.status().is_success() {
                return Err(format!("HTTP {}", r.status()));
            }
            r.bytes().await.map_err(|e| e.to_string())
        }
        .await;
        match result {
            Ok(jpeg) if jpeg.starts_with(&[0xFF, 0xD8]) => {
                failures = 0;
                publish(tx, backlog, Frame::Jpeg(jpeg));
            }
            Ok(_) => return Err(format!("the camera's snapshot at {url} isn't a JPEG")),
            Err(e) => {
                failures += 1;
                if failures >= 5 {
                    return Err(format!("camera snapshot at {url}: {e}"));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(tag: u8) -> Vec<u8> {
        vec![0xFF, 0xD8, 0xFF, 0xE0, tag, 0xFF, 0x00, tag, 0xFF, 0xD9]
    }

    #[test]
    fn splits_parts_with_and_without_lengths() {
        let mut s = Splitter::default();
        let mut stream = Vec::new();
        for tag in [1u8, 2] {
            let j = jpeg(tag);
            stream.extend_from_slice(format!("--boundarydonotcross\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n", j.len()).as_bytes());
            stream.extend_from_slice(&j);
            stream.extend_from_slice(b"\r\n");
        }
        // No length: ends at the JPEG's own end marker.
        stream.extend_from_slice(b"--b\r\nContent-Type: image/jpeg\r\n\r\n");
        stream.extend_from_slice(&jpeg(3));
        let mut out = Vec::new();
        for piece in stream.chunks(7) {
            s.push(piece);
            while let Some(j) = s.next_jpeg().unwrap() {
                out.push(j);
            }
        }
        assert_eq!(out, vec![Bytes::from(jpeg(1)), Bytes::from(jpeg(2)), Bytes::from(jpeg(3))]);
    }
}
