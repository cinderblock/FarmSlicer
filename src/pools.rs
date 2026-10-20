//! Printer pools and their operators (step 5 of
//! plans/plates-and-print-queue.md fills this in).

use crate::groups::Viewer;
use crate::server::AppState;

/// Is `printer_id` in pool `pool_id`?
pub fn has_printer(_state: &AppState, _pool_id: &str, _printer_id: &str) -> bool {
    false
}

pub fn exists(_state: &AppState, _pool_id: &str) -> bool {
    false
}

/// May `viewer` work a printer `entry` could go to?
pub fn operates_entry(_state: &AppState, _viewer: &Viewer, _entry: &crate::db::QueueEntry) -> bool {
    false
}

/// May `viewer` work `printer_id` as one of its pools' operators?
pub fn operates(_state: &AppState, _viewer: &Viewer, _printer_id: Option<&str>) -> bool {
    false
}
