//! The live view of a server slice (plans/live-slice-preview.md): libslic3r
//! hands over each object step's geometry as it's done
//! (cxx/live_geometry.cpp, through `slicer::slice_geometry`), the frames
//! are kept here in memory while the job slices and a little after, and
//! `GET /api/jobs/{id}/live` streams them to whoever can see the job: every
//! frame so far, then each new one, until the slice ends.
//!
//! On the wire each frame is preceded by its length (u32, little-endian).
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

struct Stream {
    frames: Vec<Bytes>,
    bytes: usize,
    /// When the slice ended (no more frames).
    ended: Option<Instant>,
    /// Frames so far and whether the slice ended, for the readers.
    tx: watch::Sender<(usize, bool)>,
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
        let (tx, _) = watch::channel((0, false));
        streams.insert(job_id.to_string(), Stream { frames: Vec::new(), bytes: 0, ended: None, tx });
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
        s.tx.send_replace((s.frames.len(), false));
    });
}

/// The slice of `job_id` ended (done, failed or cancelled).
pub fn finish(job_id: &str) {
    with(|streams| {
        if let Some(s) = streams.get_mut(job_id) {
            s.ended = Some(Instant::now());
            s.tx.send_replace((s.frames.len(), true));
        }
    });
}

/// Frames from `from` on, and whether the slice ended; None = no stream.
fn frames_since(job_id: &str, from: usize) -> Option<(Vec<Bytes>, bool)> {
    with(|streams| {
        let s = streams.get(job_id)?;
        Some((s.frames.get(from..).unwrap_or_default().to_vec(), s.ended.is_some()))
    })
}

fn subscribe(job_id: &str) -> Option<watch::Receiver<(usize, bool)>> {
    with(|streams| streams.get(job_id).map(|s| s.tx.subscribe()))
}

/// A frame as it goes out: its length, then the frame.
fn framed(frame: &Bytes) -> Bytes {
    let mut out = Vec::with_capacity(4 + frame.len());
    out.extend_from_slice(&(frame.len() as u32).to_le_bytes());
    out.extend_from_slice(frame);
    Bytes::from(out)
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
    // (job, receiver, frames sent, ended)
    let stream = futures_util::stream::unfold((id, rx, 0usize, false), |(id, mut rx, sent, ended)| async move {
        if ended {
            return None;
        }
        loop {
            let (frames, done) = frames_since(&id, sent)?;
            if !frames.is_empty() || done {
                let mut chunk = Vec::new();
                for f in &frames {
                    chunk.extend_from_slice(&framed(f));
                }
                let next = (id, rx, sent + frames.len(), done);
                return Some((Ok::<_, std::convert::Infallible>(Bytes::from(chunk)), next));
            }
            // Nothing new: wait for the next frame or the end. A stream
            // replaced or dropped meanwhile ends this one.
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
        assert!(frames_since(job, 0).is_none());
        start(job);
        frame(job, b"one");
        frame(job, b"two");
        let (frames, ended) = frames_since(job, 0).unwrap();
        assert_eq!(frames, vec![Bytes::from_static(b"one"), Bytes::from_static(b"two")]);
        assert!(!ended);
        assert_eq!(frames_since(job, 1).unwrap().0, vec![Bytes::from_static(b"two")]);
        finish(job);
        frame(job, b"late"); // after the end: dropped
        let (frames, ended) = frames_since(job, 0).unwrap();
        assert_eq!(frames.len(), 2);
        assert!(ended);
        assert!(frames_since(job, 5).unwrap().0.is_empty());
    }

    #[test]
    fn a_new_slice_starts_afresh() {
        let job = "live-test-again";
        start(job);
        frame(job, b"old");
        finish(job);
        start(job);
        assert_eq!(frames_since(job, 0).unwrap(), (Vec::new(), false));
    }

    #[test]
    fn framing_prefixes_the_length() {
        assert_eq!(&framed(&Bytes::from_static(b"abc"))[..], &[3, 0, 0, 0, b'a', b'b', b'c']);
    }

    #[tokio::test]
    async fn readers_wake_on_new_frames() {
        let job = "live-test-wake";
        start(job);
        let mut rx = subscribe(job).unwrap();
        frame(job, b"x");
        rx.changed().await.unwrap();
        assert_eq!(*rx.borrow(), (1, false));
        finish(job);
        rx.changed().await.unwrap();
        assert_eq!(*rx.borrow(), (1, true));
    }
}
