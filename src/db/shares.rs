//! Shares: a job, project, folder or group library shared with a person,
//! a group, or anyone holding a link (src/shares.rs has the rules).

use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;

use super::Db;

pub(super) fn migrate(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS shares (
            id TEXT PRIMARY KEY,
            target_kind TEXT NOT NULL,      -- job | project | folder | library
            target_id TEXT NOT NULL,        -- library: the group's id
            principal_kind TEXT NOT NULL,   -- user | group | link
            principal_id TEXT NOT NULL,     -- link: its code (shown again, like join links)
            level TEXT NOT NULL,            -- view | use | edit
            created_by TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT
        );
        CREATE INDEX IF NOT EXISTS shares_target ON shares(target_kind, target_id);
        CREATE INDEX IF NOT EXISTS shares_principal ON shares(principal_kind, principal_id);",
    )
    .expect("failed to create shares table");
}

#[derive(Debug, Clone, Serialize)]
pub struct Share {
    pub id: String,
    pub target_kind: String,
    pub target_id: String,
    pub principal_kind: String,
    pub principal_id: String,
    pub level: String,
    pub created_by: Option<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
}

const COLS: &str = "id, target_kind, target_id, principal_kind, principal_id, level, created_by, created_at, expires_at";
/// Only shares that haven't expired.
const LIVE: &str = "(expires_at IS NULL OR expires_at > datetime('now'))";

fn share_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Share> {
    Ok(Share {
        id: r.get(0)?,
        target_kind: r.get(1)?,
        target_id: r.get(2)?,
        principal_kind: r.get(3)?,
        principal_id: r.get(4)?,
        level: r.get(5)?,
        created_by: r.get(6)?,
        created_at: r.get(7)?,
        expires_at: r.get(8)?,
    })
}

impl Db {
    /// Live shares with this user or any of these groups.
    pub fn shares_for(&self, user_id: &str, group_ids: &[String]) -> Vec<Share> {
        let conn = self.conn.lock().unwrap();
        let mut args = vec![user_id.to_string()];
        let mut sql = format!("SELECT {COLS} FROM shares WHERE {LIVE} AND ((principal_kind = 'user' AND principal_id = ?1)");
        if !group_ids.is_empty() {
            let list: Vec<String> = group_ids
                .iter()
                .map(|g| {
                    args.push(g.clone());
                    format!("?{}", args.len())
                })
                .collect();
            sql.push_str(&format!(" OR (principal_kind = 'group' AND principal_id IN ({}))", list.join(", ")));
        }
        sql.push(')');
        let mut stmt = conn.prepare(&sql).unwrap();
        stmt.query_map(params_from_iter(args.iter()), share_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// Every share of a target (expired ones too, so they can be removed).
    pub fn shares_on(&self, target_kind: &str, target_id: &str) -> Vec<Share> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("SELECT {COLS} FROM shares WHERE target_kind = ?1 AND target_id = ?2 ORDER BY created_at"))
            .unwrap();
        stmt.query_map(params![target_kind, target_id], share_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn get_share(&self, id: &str) -> Option<Share> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {COLS} FROM shares WHERE id = ?1"), params![id], share_from_row)
            .optional()
            .unwrap()
    }

    /// A live public link by its code.
    pub fn share_by_code(&self, code: &str) -> Option<Share> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {COLS} FROM shares WHERE principal_kind = 'link' AND principal_id = ?1 AND {LIVE}"),
            params![code],
            share_from_row,
        )
        .optional()
        .unwrap()
    }

    /// Create a share, or change the level and expiry of the same
    /// target × principal.
    pub fn save_share(&self, s: &Share, expires_days: Option<i64>) -> String {
        let conn = self.conn.lock().unwrap();
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM shares WHERE target_kind = ?1 AND target_id = ?2 AND principal_kind = ?3 AND principal_id = ?4",
                params![s.target_kind, s.target_id, s.principal_kind, s.principal_id],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        let expires = "CASE WHEN ?2 IS NULL THEN NULL ELSE datetime('now', '+' || ?2 || ' days') END";
        match existing {
            Some(id) => {
                conn.execute(
                    &format!("UPDATE shares SET level = ?3, expires_at = {expires} WHERE id = ?1"),
                    params![id, expires_days, s.level],
                )
                .unwrap();
                id
            }
            None => {
                conn.execute(
                    &format!(
                        "INSERT INTO shares (id, target_kind, target_id, principal_kind, principal_id, level, created_by, expires_at)
                         VALUES (?1, ?3, ?4, ?5, ?6, ?7, ?8, {expires})"
                    ),
                    params![s.id, expires_days, s.target_kind, s.target_id, s.principal_kind, s.principal_id, s.level, s.created_by],
                )
                .unwrap();
                s.id.clone()
            }
        }
    }

    pub fn delete_share(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM shares WHERE id = ?1", params![id]).unwrap_or(0) > 0
    }

    /// A target or a principal is going away.
    pub fn delete_shares_of(&self, target_kind: &str, target_id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM shares WHERE target_kind = ?1 AND target_id = ?2", params![target_kind, target_id]).ok();
    }

    pub fn delete_shares_with(&self, principal_kind: &str, principal_id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM shares WHERE principal_kind = ?1 AND principal_id = ?2",
            params![principal_kind, principal_id],
        )
        .ok();
    }
}
