//! How printers take the queue (src/dispatch.rs has the rules).

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::Db;

pub(super) fn migrate(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS printer_dispatch (
            printer_id TEXT PRIMARY KEY REFERENCES printers(id) ON DELETE CASCADE,
            send_mode TEXT NOT NULL DEFAULT 'manual', -- manual | confirm | yolo
            set_by TEXT, -- the user the queue's sends go out as
            set_at TEXT,
            bed_clear_at TEXT -- someone said the bed is clear (cleared when a print goes out)
        );",
    )
    .expect("failed to create printer_dispatch");
}

#[derive(Debug, Serialize, Clone, Default, PartialEq)]
pub struct Dispatch {
    pub printer_id: String,
    pub send_mode: String,
    pub set_by: Option<String>,
    pub set_by_name: Option<String>,
    pub set_at: Option<String>,
    pub bed_clear_at: Option<String>,
}

const SELECT: &str = "SELECT d.printer_id, d.send_mode, d.set_by, u.username, d.set_at, d.bed_clear_at
     FROM printer_dispatch d LEFT JOIN users u ON u.id = d.set_by";

fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Dispatch> {
    Ok(Dispatch {
        printer_id: r.get(0)?,
        send_mode: r.get(1)?,
        set_by: r.get(2)?,
        set_by_name: r.get(3)?,
        set_at: r.get(4)?,
        bed_clear_at: r.get(5)?,
    })
}

impl Db {
    /// A printer's dispatch settings (manual when never set).
    pub fn dispatch(&self, printer_id: &str) -> Dispatch {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("{SELECT} WHERE d.printer_id = ?1"), params![printer_id], from_row)
            .optional()
            .unwrap()
            .unwrap_or_else(|| Dispatch { printer_id: printer_id.to_string(), send_mode: "manual".into(), ..Default::default() })
    }

    /// Printers that take the queue by themselves.
    pub fn automatic_printers(&self) -> Vec<Dispatch> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("{SELECT} WHERE d.send_mode != 'manual'")).unwrap();
        stmt.query_map([], from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn set_send_mode(&self, printer_id: &str, mode: &str, by: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO printer_dispatch (printer_id, send_mode, set_by, set_at) VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(printer_id) DO UPDATE SET send_mode = excluded.send_mode, set_by = excluded.set_by,
                set_at = excluded.set_at",
            params![printer_id, mode, by],
        )
        .unwrap();
    }

    /// Someone says the bed is clear (`clear`), or a print went out.
    pub fn set_bed_clear(&self, printer_id: &str, clear: bool) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO printer_dispatch (printer_id, bed_clear_at) VALUES (?1, CASE WHEN ?2 THEN datetime('now') END)
             ON CONFLICT(printer_id) DO UPDATE SET bed_clear_at = excluded.bed_clear_at",
            params![printer_id, clear],
        )
        .unwrap();
    }
}
