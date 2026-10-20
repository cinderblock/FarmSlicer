//! Printer pools and their operators (step 5 of
//! plans/plates-and-print-queue.md fills this in).

use crate::groups::Viewer;
use crate::server::AppState;

/// May `viewer` work `printer_id` as one of its pools' operators?
pub fn operates(_state: &AppState, _viewer: &Viewer, _printer_id: Option<&str>) -> bool {
    false
}
