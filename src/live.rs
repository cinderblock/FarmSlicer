//! The live view of a server slice (plans/live-slice-preview.md): libslic3r
//! hands over each object step's geometry as it's done
//! (cxx/live_geometry.cpp, through `slicer::slice_geometry`), the frames
//! are kept here in memory while the job slices and a little after, and
//! `GET /api/jobs/{id}/live` streams them to whoever can see the job: every
//! frame so far, then each new one, until the slice ends. The slicer's
//! progress goes along as it comes (the latest, at most every `PACE`), so
//! the page needn't poll the job for it.
//!
//! On the wire each frame is preceded by its length (u32, little-endian).
//! Geometry frames start "FSL1" (plans/live-slice-preview.md), progress
//! frames "FSP1" (`progress_frame`).
//! Browser slices make their frames in the page and never come here.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde_json::Value;
use tokio::sync::watch;

use crate::auth::CurrentUser;
use crate::prints_api::visible_job;
use crate::server::AppState;

/// How long a finished slice's frames stay, for a page that opens late.
const KEEP: Duration = Duration::from_secs(60);
/// Bytes kept per slice; frames beyond it are dropped (the C++ side's point
/// budget keeps a slice far below it).
const MAX_BYTES: usize = 96 * 1024 * 1024;
/// A reader gets at most one chunk this often: progress comes once per layer
/// while the G-code is written (hundreds a second), the page needs ~20.
const PACE: Duration = Duration::from_millis(50);

/// A progress frame's magic ("FSP1"); geometry frames start with "FSL1".
const PROGRESS_MAGIC: &[u8; 4] = b"FSP1";

struct Stream {
    frames: Vec<Bytes>,
    bytes: usize,
    /// The latest progress (number, percent, message); number 0 = none yet.
    progress: (u64, i32, String),
    /// When the slice ended (no more frames).
    ended: Option<Instant>,
    /// Bumped on every change (frame, progress, end), for the readers.
    tx: watch::Sender<u64>,
}

impl Stream {
    fn changed(&self) {
        self.tx.send_modify(|v| *v += 1);
    }
}

static STREAMS: Mutex<Option<HashMap<String, Stream>>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut HashMap<String, Stream>) -> R) -> R {
    let mut guard = STREAMS.lock().unwrap();
    f(guard.get_or_insert_with(HashMap::new))
}

/// A slice of `job_id` begins: frames from now on are kept.
pub fn start(job_id: &str) {
    with(|streams| {
        let now = Instant::now();
        streams.retain(|_, s| s.ended.is_none_or(|t| now.duration_since(t) < KEEP));
        let (tx, _) = watch::channel(0);
        let stream = Stream { frames: Vec::new(), bytes: 0, progress: (0, 0, String::new()), ended: None, tx };
        streams.insert(job_id.to_string(), stream);
    });
}

/// One frame from the slicer (any thread).
#[cfg_attr(farmslicer_no_cxx, allow(dead_code))]
pub fn frame(job_id: &str, frame: &[u8]) {
    with(|streams| {
        let Some(s) = streams.get_mut(job_id) else { return };
        if s.ended.is_some() || s.bytes + frame.len() > MAX_BYTES {
            return;
        }
        s.bytes += frame.len();
        s.frames.push(Bytes::copy_from_slice(frame));
        s.changed();
    });
}

/// The slicer's progress (any thread): readers get the latest as it comes,
/// instead of waiting for the page's next poll of the job.
#[cfg_attr(farmslicer_no_cxx, allow(dead_code))]
pub fn progress(job_id: &str, percent: i32, message: &str) {
    with(|streams| {
        let Some(s) = streams.get_mut(job_id) else { return };
        if s.ended.is_some() {
            return;
        }
        let n = s.progress.0 + 1;
        s.progress = (n, percent.clamp(0, 100), message.to_string());
        s.changed();
    });
}

/// The slice of `job_id` ended (done, failed or cancelled).
pub fn finish(job_id: &str) {
    with(|streams| {
        if let Some(s) = streams.get_mut(job_id) {
            s.ended = Some(Instant::now());
            s.changed();
        }
    });
}

/// What a reader hasn't had yet.
#[derive(Debug, PartialEq)]
struct News {
    frames: Vec<Bytes>,
    /// The latest progress, when newer than the reader's: (number, percent, message).
    progress: Option<(u64, i32, String)>,
    ended: bool,
}

/// Frames from `from` on, the progress if newer than `seen`, and whether
/// the slice ended; None = no stream.
fn news(job_id: &str, from: usize, seen: u64) -> Option<News> {
    with(|streams| {
        let s = streams.get(job_id)?;
        Some(News {
            frames: s.frames.get(from..).unwrap_or_default().to_vec(),
            progress: (s.progress.0 > seen).then(|| s.progress.clone()),
            ended: s.ended.is_some(),
        })
    })
}

fn subscribe(job_id: &str) -> Option<watch::Receiver<u64>> {
    with(|streams| streams.get(job_id).map(|s| s.tx.subscribe()))
}

/// A frame as it goes out: its length, then the frame.
fn framed(frame: &[u8]) -> Bytes {
    let mut out = Vec::with_capacity(4 + frame.len());
    out.extend_from_slice(&(frame.len() as u32).to_le_bytes());
    out.extend_from_slice(frame);
    Bytes::from(out)
}

/// A progress frame: "FSP1", the percent (u8), the message (u16 length + UTF-8).
fn progress_frame(percent: i32, message: &str) -> Vec<u8> {
    let mut cut = message.len().min(u16::MAX as usize);
    while !message.is_char_boundary(cut) {
        cut -= 1;
    }
    let text = &message.as_bytes()[..cut];
    let mut out = Vec::with_capacity(7 + text.len());
    out.extend_from_slice(PROGRESS_MAGIC);
    out.push(percent.clamp(0, 100) as u8);
    out.extend_from_slice(&(text.len() as u16).to_le_bytes());
    out.extend_from_slice(text);
    out
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/api/jobs/{id}/live", get(job_live))
}

/// `GET /api/jobs/{id}/live`: the slice's frames as it's made. 204 when
/// there is nothing to stream (a browser slice, one that ended a while ago,
/// one still queued: the page asks again once it slices).
async fn job_live(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    visible_job(&state, &user, &id)?;
    let Some(rx) = subscribe(&id) else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    // (job, receiver, frames sent, progress sent, ended)
    let state = (id, rx, 0usize, 0u64, false);
    let stream = futures_util::stream::unfold(state, |(id, mut rx, sent, seen, ended)| async move {
        if ended {
            return None;
        }
        loop {
            let news = news(&id, sent, seen)?;
            if !news.frames.is_empty() || news.progress.is_some() || news.ended {
                let mut chunk = Vec::new();
                for f in &news.frames {
                    chunk.extend_from_slice(&framed(f));
                }
                let mut seen = seen;
                if let Some((n, percent, message)) = &news.progress {
                    chunk.extend_from_slice(&framed(&progress_frame(*percent, message)));
                    seen = *n;
                }
                if !news.ended {
                    // Whatever comes meanwhile goes out in the next chunk.
                    tokio::time::sleep(PACE).await;
                }
                let next = (id, rx, sent + news.frames.len(), seen, news.ended);
                return Some((Ok::<_, std::convert::Infallible>(Bytes::from(chunk)), next));
            }
            // Nothing new: wait for the next change. A stream replaced or
            // dropped meanwhile ends this one.
            if rx.changed().await.is_err() {
                return None;
            }
        }
    });
    let mut response = Body::from_stream(stream).into_response();
    let h = response.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    // Proxies pass each frame on as it comes (nginx-style buffering off).
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_kept_in_order_until_the_end() {
        let job = "live-test-order";
        frame(job, b"before"); // no stream yet: dropped
        assert!(news(job, 0, 0).is_none());
        start(job);
        frame(job, b"one");
        frame(job, b"two");
        let n = news(job, 0, 0).unwrap();
        assert_eq!(n.frames, vec![Bytes::from_static(b"one"), Bytes::from_static(b"two")]);
        assert!(!n.ended);
        assert_eq!(news(job, 1, 0).unwrap().frames, vec![Bytes::from_static(b"two")]);
        finish(job);
        frame(job, b"late"); // after the end: dropped
        let n = news(job, 0, 0).unwrap();
        assert_eq!(n.frames.len(), 2);
        assert!(n.ended);
        assert!(news(job, 5, 0).unwrap().frames.is_empty());
    }

    #[test]
    fn readers_get_the_latest_progress_once() {
        let job = "live-test-progress";
        start(job);
        assert_eq!(news(job, 0, 0).unwrap().progress, None);
        progress(job, 10, "Generating walls");
        progress(job, 80, "Generating G-code: layer 3");
        let n = news(job, 0, 0).unwrap();
        assert_eq!(n.progress, Some((2, 80, "Generating G-code: layer 3".to_string())));
        assert_eq!(news(job, 0, 2).unwrap().progress, None);
        progress(job, 150, "clamped");
        assert_eq!(news(job, 0, 2).unwrap().progress, Some((3, 100, "clamped".to_string())));
        finish(job);
        progress(job, 100, "after the end");
        assert_eq!(news(job, 0, 3).unwrap().progress, None);
    }

    #[test]
    fn a_new_slice_starts_afresh() {
        let job = "live-test-again";
        start(job);
        frame(job, b"old");
        progress(job, 50, "half");
        finish(job);
        start(job);
        assert_eq!(news(job, 0, 0).unwrap(), News { frames: Vec::new(), progress: None, ended: false });
    }

    #[test]
    fn framing() {
        assert_eq!(&framed(b"abc")[..], &[3, 0, 0, 0, b'a', b'b', b'c']);
        assert_eq!(progress_frame(42, "hi"), vec![b'F', b'S', b'P', b'1', 42, 2, 0, b'h', b'i']);
    }

    #[tokio::test]
    async fn readers_wake_on_every_change() {
        let job = "live-test-wake";
        start(job);
        let mut rx = subscribe(job).unwrap();
        frame(job, b"x");
        rx.changed().await.unwrap();
        progress(job, 5, "p");
        rx.changed().await.unwrap();
        finish(job);
        rx.changed().await.unwrap();
        assert!(news(job, 1, 1).unwrap().ended);
    }
}
