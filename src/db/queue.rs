//! The print queue (supply): plates waiting for a printer, one entry per
//! time a plate is to be printed (src/queue.rs has the rules).

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::Db;

pub(super) fn migrate(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS queue_entries (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            plate INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued', -- queued | sent | printed | failed | cancelled
            priority INTEGER NOT NULL DEFAULT 0,
            printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL, -- pinned to one printer
            pool_id TEXT, -- only printers of this pool (src/pools.rs)
            print_id TEXT REFERENCES prints(id) ON DELETE SET NULL,
            note TEXT,
            created_by TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            sent_at TEXT
        );
        CREATE INDEX IF NOT EXISTS queue_status ON queue_entries(status, priority);
        CREATE INDEX IF NOT EXISTS queue_job ON queue_entries(job_id, plate);
        CREATE INDEX IF NOT EXISTS queue_print ON queue_entries(print_id);",
    )
    .expect("failed to create queue_entries");
}

#[derive(Debug, Serialize, Clone)]
pub struct QueueEntry {
    pub id: String,
    pub job_id: String,
    pub plate: i64,
    pub status: String,
    pub priority: i64,
    pub printer_id: Option<String>,
    pub pool_id: Option<String>,
    pub print_id: Option<String>,
    pub note: Option<String>,
    pub created_by: Option<String>,
    pub created_by_name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub sent_at: Option<String>,
    /// From the job: its name, creator and group.
    pub job_name: String,
    pub job_user_id: Option<String>,
    pub job_group_id: Option<String>,
    /// From the projects the plate carries items for: the highest
    /// priority, the earliest due date, and whether one of them is on hold
    /// (or cancelled), which holds the entry.
    pub project_priority: Option<i64>,
    pub due_at: Option<String>,
    pub held: bool,
}

const ENTRY_SELECT: &str = "SELECT q.id, q.job_id, q.plate, q.status, q.priority, q.printer_id, q.pool_id,
        q.print_id, q.note, q.created_by, u.username, q.created_at, q.updated_at, q.sent_at,
        j.model_name, j.user_id, j.group_id,
        (SELECT MAX(p.priority) FROM job_items ji JOIN project_items i ON i.id = ji.item_id
            JOIN projects p ON p.id = i.project_id WHERE ji.job_id = q.job_id AND ji.plate = q.plate) AS project_priority,
        (SELECT MIN(p.due_at) FROM job_items ji JOIN project_items i ON i.id = ji.item_id
            JOIN projects p ON p.id = i.project_id WHERE ji.job_id = q.job_id AND ji.plate = q.plate) AS due,
        EXISTS (SELECT 1 FROM job_items ji JOIN project_items i ON i.id = ji.item_id
            JOIN projects p ON p.id = i.project_id
            WHERE ji.job_id = q.job_id AND ji.plate = q.plate AND p.status IN ('on_hold', 'cancelled')) AS held
     FROM queue_entries q JOIN jobs j ON j.id = q.job_id LEFT JOIN users u ON u.id = q.created_by";

/// The queue's order: held entries last, then the entry's priority, its
/// projects' priority and due date, and age.
const ENTRY_ORDER: &str =
    "ORDER BY held, q.priority DESC, COALESCE(project_priority, 0) DESC, due IS NULL, due, q.created_at, q.rowid";

fn entry_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<QueueEntry> {
    Ok(QueueEntry {
        id: r.get(0)?,
        job_id: r.get(1)?,
        plate: r.get(2)?,
        status: r.get(3)?,
        priority: r.get(4)?,
        printer_id: r.get(5)?,
        pool_id: r.get(6)?,
        print_id: r.get(7)?,
        note: r.get(8)?,
        created_by: r.get(9)?,
        created_by_name: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
        sent_at: r.get(13)?,
        job_name: r.get(14)?,
        job_user_id: r.get(15)?,
        job_group_id: r.get(16)?,
        project_priority: r.get(17)?,
        due_at: r.get(18)?,
        held: r.get(19)?,
    })
}

impl Db {
    #[allow(clippy::too_many_arguments)]
    pub fn add_queue_entry(
        &self,
        job_id: &str,
        plate: i64,
        priority: i64,
        printer_id: Option<&str>,
        pool_id: Option<&str>,
        note: Option<&str>,
        created_by: Option<&str>,
    ) -> QueueEntry {
        let id = uuid::Uuid::new_v4().to_string();
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO queue_entries (id, job_id, plate, priority, printer_id, pool_id, note, created_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![id, job_id, plate, priority, printer_id, pool_id, note, created_by],
            )
            .unwrap();
        }
        self.get_queue_entry(&id).expect("entry just inserted")
    }

    pub fn get_queue_entry(&self, id: &str) -> Option<QueueEntry> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("{ENTRY_SELECT} WHERE q.id = ?1"), params![id], entry_from_row)
            .optional()
            .unwrap()
    }

    /// Entries with one of `statuses`, in queue order.
    pub fn list_queue(&self, statuses: &[&str], limit: i64) -> Vec<QueueEntry> {
        let list = statuses.iter().map(|s| format!("'{}'", s.replace('\'', ""))).collect::<Vec<_>>().join(", ");
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("{ENTRY_SELECT} WHERE q.status IN ({list}) {ENTRY_ORDER} LIMIT ?1"))
            .unwrap();
        stmt.query_map(params![limit], entry_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// A job plate's queued entries, oldest first.
    pub fn queued_for_plate(&self, job_id: &str, plate: i64) -> Vec<QueueEntry> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "{ENTRY_SELECT} WHERE q.job_id = ?1 AND q.plate = ?2 AND q.status = 'queued' ORDER BY q.created_at, q.rowid"
            ))
            .unwrap();
        stmt.query_map(params![job_id, plate], entry_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn update_queue_entry(&self, id: &str, priority: i64, printer_id: Option<&str>, pool_id: Option<&str>, note: Option<&str>) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE queue_entries SET priority = ?2, printer_id = ?3, pool_id = ?4, note = ?5, updated_at = datetime('now')
             WHERE id = ?1 AND status = 'queued'",
            params![id, priority, printer_id, pool_id, note],
        )
        .unwrap()
            > 0
    }

    /// Take a queued entry for sending (false: someone else took it, or it
    /// is no longer queued).
    pub fn claim_queue_entry(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE queue_entries SET status = 'sent', sent_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?1 AND status = 'queued'",
            params![id],
        )
        .unwrap()
            > 0
    }

    /// Give a claimed entry back (its send didn't happen).
    pub fn release_queue_entry(&self, id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE queue_entries SET status = 'queued', print_id = NULL, sent_at = NULL, updated_at = datetime('now')
             WHERE id = ?1 AND status = 'sent'",
            params![id],
        )
        .unwrap();
    }

    pub fn set_queue_entry_print(&self, id: &str, print_id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE queue_entries SET print_id = ?2, updated_at = datetime('now') WHERE id = ?1",
            params![id, print_id],
        )
        .unwrap();
    }

    pub fn queue_entry_of_print(&self, print_id: &str) -> Option<QueueEntry> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("{ENTRY_SELECT} WHERE q.print_id = ?1"), params![print_id], entry_from_row)
            .optional()
            .unwrap()
    }

    /// End a sent entry: `printed`, `failed` or `cancelled`.
    pub fn end_queue_entry(&self, id: &str, status: &str, note: Option<&str>) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE queue_entries SET status = ?2, note = COALESCE(?3, note), updated_at = datetime('now')
             WHERE id = ?1 AND status IN ('sent', 'queued')",
            params![id, status, note],
        )
        .unwrap()
            > 0
    }

    /// Entries per status, for the queue's header.
    pub fn queue_counts(&self) -> Vec<(String, i64)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT status, COUNT(*) FROM queue_entries GROUP BY status").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().filter_map(|r| r.ok()).collect()
    }
}
