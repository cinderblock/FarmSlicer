//! Sending the queue to printers by itself (step 7 of
//! plans/plates-and-print-queue.md fills this in).

use crate::db::Printer;
use crate::server::AppState;

/// How a printer takes the queue: `manual` (someone presses Send next).
pub fn send_mode(_printer: &Printer) -> &'static str {
    "manual"
}

/// Something changed that may let a printer take the next entry.
pub fn poke(_state: &AppState) {}
