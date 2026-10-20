//! How prints turned out (src/outcomes.rs has the rules): a row per line of
//! a print in `print_outcomes`, the print's summary on `prints`.

use rusqlite::{Connection, params};

use super::Db;
use crate::outcomes::{Line, LineOutcome};

pub(super) fn migrate(conn: &Connection) {
    for col in ["outcome", "outcome_by", "outcome_at", "outcome_note"] {
        if conn.prepare(&format!("SELECT {col} FROM prints LIMIT 0")).is_err() {
            conn.execute_batch(&format!("ALTER TABLE prints ADD COLUMN {col} TEXT;")).ok();
        }
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS print_outcomes (
            print_id TEXT NOT NULL REFERENCES prints(id) ON DELETE CASCADE,
            line INTEGER NOT NULL,
            item_id TEXT, -- project_items(id); no FK: an item's removal keeps history
            model_idx INTEGER,
            name TEXT NOT NULL,
            planned INTEGER NOT NULL,
            good INTEGER NOT NULL,
            failed INTEGER NOT NULL,
            reason TEXT,
            PRIMARY KEY (print_id, line)
        );
        CREATE INDEX IF NOT EXISTS print_outcomes_item ON print_outcomes(item_id);
        CREATE INDEX IF NOT EXISTS prints_outcome ON prints(status, outcome);",
    )
    .expect("failed to create print_outcomes");
}

impl Db {
    /// Replace the record of how `print_id` came out.
    pub fn set_print_outcome(&self, print_id: &str, outcome: &str, by: &str, note: Option<&str>, lines: &[LineOutcome]) {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute("DELETE FROM print_outcomes WHERE print_id = ?1", params![print_id]).unwrap();
        for l in lines {
            tx.execute(
                "INSERT INTO print_outcomes (print_id, line, item_id, model_idx, name, planned, good, failed, reason)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    print_id,
                    l.line.line,
                    l.line.item_id,
                    l.line.model_idx,
                    l.line.name,
                    l.line.planned,
                    l.good,
                    l.failed,
                    l.reason
                ],
            )
            .unwrap();
        }
        tx.execute(
            "UPDATE prints SET outcome = ?2, outcome_by = ?3, outcome_note = ?4, outcome_at = datetime('now'),
                    updated_at = datetime('now')
             WHERE id = ?1",
            params![print_id, outcome, by, note],
        )
        .unwrap();
        tx.commit().unwrap();
    }

    /// The recorded lines of a print, in order (empty = nothing recorded).
    pub fn print_outcome_lines(&self, print_id: &str) -> Vec<LineOutcome> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT line, item_id, model_idx, name, planned, good, failed, reason
                 FROM print_outcomes WHERE print_id = ?1 ORDER BY line",
            )
            .unwrap();
        stmt.query_map(params![print_id], |r| {
            Ok(LineOutcome {
                line: Line {
                    line: r.get(0)?,
                    item_id: r.get(1)?,
                    model_idx: r.get(2)?,
                    name: r.get(3)?,
                    planned: r.get(4)?,
                },
                good: r.get(5)?,
                failed: r.get(6)?,
                reason: r.get(7)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }
}
