//! Process-wide slicing progress and cancellation registry.
//!
//! libslic3r calls back into Rust from inside the (blocking) slice call with no
//! user data pointer, so the bridge identifies jobs by id and looks them up
//! here. A sink installed at startup persists progress (to SQLite) so the
//! Jobs page can poll it.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

type Sink = Box<dyn Fn(&str, i32, &str) + Send + Sync>;

static SINK: OnceLock<Sink> = OnceLock::new();
static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Install the function that receives `(job_id, percent, message)` updates.
/// Only the first call has an effect.
pub fn install_sink(sink: Sink) {
    let _ = SINK.set(sink);
}

pub fn report(job_id: &str, percent: i32, message: &str) {
    if let Some(sink) = SINK.get() {
        sink(job_id, percent.clamp(0, 100), message);
    }
}

/// Ask the slicer to abandon `job_id` at its next cancellation checkpoint.
pub fn request_cancel(job_id: &str) {
    let mut guard = CANCELLED.lock().unwrap();
    guard.get_or_insert_with(HashSet::new).insert(job_id.to_string());
}

pub fn is_cancelled(job_id: &str) -> bool {
    let guard = CANCELLED.lock().unwrap();
    guard.as_ref().is_some_and(|set| set.contains(job_id))
}

/// Forget any cancellation request for `job_id` (call when the job finishes).
pub fn clear(job_id: &str) {
    let mut guard = CANCELLED.lock().unwrap();
    if let Some(set) = guard.as_mut() {
        set.remove(job_id);
    }
}
