//! Labels and what they're on (src/labels.rs has the rules).

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::Db;

pub(super) fn migrate(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS labels (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT 'gray',
            scope TEXT NOT NULL,              -- site | group | user
            owner_id TEXT NOT NULL DEFAULT '', -- '' (site), the group's id, the user's id
            created_by TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS labels_name ON labels(scope, owner_id, name COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS label_links (
            label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,               -- job | project | printer | group
            target_id TEXT NOT NULL,
            added_by TEXT,
            added_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (label_id, kind, target_id)
        );
        CREATE INDEX IF NOT EXISTS label_links_target ON label_links(kind, target_id);",
    )
    .expect("failed to create label tables");
}

#[derive(Debug, Clone, Serialize)]
pub struct Label {
    pub id: String,
    pub name: String,
    pub color: String,
    pub scope: String,
    pub owner_id: String,
    pub created_by: Option<String>,
    pub created_at: String,
}

fn label_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Label> {
    Ok(Label {
        id: r.get(0)?,
        name: r.get(1)?,
        color: r.get(2)?,
        scope: r.get(3)?,
        owner_id: r.get(4)?,
        created_by: r.get(5)?,
        created_at: r.get(6)?,
    })
}

const COLS: &str = "id, name, color, scope, owner_id, created_by, created_at";

impl Db {
    pub fn list_labels(&self) -> Vec<Label> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM labels ORDER BY name COLLATE NOCASE")).unwrap();
        stmt.query_map([], label_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn get_label(&self, id: &str) -> Option<Label> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {COLS} FROM labels WHERE id = ?1"), params![id], label_from_row)
            .optional()
            .unwrap()
    }

    pub fn save_label(&self, l: &Label) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO labels (id, name, color, scope, owner_id, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, color = excluded.color",
            params![l.id, l.name.trim(), l.color, l.scope, l.owner_id, l.created_by],
        )
        .map(|_| ())
        .map_err(|e| if e.to_string().contains("UNIQUE") { format!("there is already a label named '{}' there", l.name.trim()) } else { e.to_string() })
    }

    pub fn delete_label(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM label_links WHERE label_id = ?1", params![id]).ok();
        conn.execute("DELETE FROM labels WHERE id = ?1", params![id]).unwrap_or(0) > 0
    }

    /// Put a label on an item (`on`) or take it off. False: nothing changed.
    pub fn set_label_link(&self, label_id: &str, kind: &str, target_id: &str, on: bool, by: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        let n = if on {
            conn.execute(
                "INSERT OR IGNORE INTO label_links (label_id, kind, target_id, added_by) VALUES (?1, ?2, ?3, ?4)",
                params![label_id, kind, target_id, by],
            )
        } else {
            conn.execute(
                "DELETE FROM label_links WHERE label_id = ?1 AND kind = ?2 AND target_id = ?3",
                params![label_id, kind, target_id],
            )
        };
        n.unwrap_or(0) > 0
    }

    /// Every (label, kind, target).
    pub fn list_label_links(&self) -> Vec<(String, String, String)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT label_id, kind, target_id FROM label_links").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// Labels on an item that is going away.
    pub fn delete_label_links_for(&self, kind: &str, target_id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM label_links WHERE kind = ?1 AND target_id = ?2", params![kind, target_id]).ok();
    }

    /// A group (or account) is going away: its labels go too.
    pub fn delete_labels_of(&self, scope: &str, owner_id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM label_links WHERE label_id IN (SELECT id FROM labels WHERE scope = ?1 AND owner_id = ?2)",
            params![scope, owner_id],
        )
        .ok();
        conn.execute("DELETE FROM labels WHERE scope = ?1 AND owner_id = ?2", params![scope, owner_id]).ok();
    }
}
