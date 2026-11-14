//! Custom roles (src/permissions.rs has the rules; built-in roles live
//! there, not here) and account suspension.

use rusqlite::{Connection, OptionalExtension, params};

use super::Db;
use crate::permissions::{Role, Scope};

pub(super) fn migrate(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS roles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            scope TEXT NOT NULL, -- site | group
            description TEXT NOT NULL DEFAULT '',
            caps TEXT NOT NULL DEFAULT '[]', -- JSON array of capability ids
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS roles_name ON roles(scope, name COLLATE NOCASE);",
    )
    .expect("failed to create roles table");
    for col in ["suspended_at", "suspended_by", "suspend_reason"] {
        if conn.prepare(&format!("SELECT {col} FROM users LIMIT 0")).is_err() {
            conn.execute_batch(&format!("ALTER TABLE users ADD COLUMN {col} TEXT;")).ok();
        }
    }
}

fn role_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Role> {
    let scope: String = r.get(2)?;
    let caps: String = r.get(4)?;
    Ok(Role {
        id: r.get(0)?,
        name: r.get(1)?,
        scope: Scope::parse(&scope).unwrap_or(Scope::Site),
        description: r.get(3)?,
        caps: serde_json::from_str(&caps).unwrap_or_default(),
        builtin: false,
        created_at: r.get(5)?,
    })
}

const ROLE_COLS: &str = "id, name, scope, description, caps, created_at";

impl Db {
    pub fn list_roles(&self) -> Vec<Role> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("SELECT {ROLE_COLS} FROM roles ORDER BY scope, name COLLATE NOCASE"))
            .unwrap();
        stmt.query_map([], role_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn get_role(&self, id: &str) -> Option<Role> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {ROLE_COLS} FROM roles WHERE id = ?1"), params![id], role_from_row)
            .optional()
            .unwrap()
    }

    /// Create or replace a custom role.
    pub fn save_role(&self, id: &str, name: &str, scope: Scope, description: &str, caps: &[&str]) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO roles (id, name, scope, description, caps) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, caps = excluded.caps",
            params![id, name.trim(), scope.as_str(), description.trim(), serde_json::to_string(caps).unwrap()],
        )
        .map(|_| ())
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                format!("there is already a {} role named '{}'", scope.as_str(), name.trim())
            } else {
                e.to_string()
            }
        })
    }

    pub fn delete_role(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM roles WHERE id = ?1", params![id]).unwrap_or(0) > 0
    }

    /// How many accounts (site role) or memberships (group role) hold it.
    pub fn role_holders(&self, id: &str) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT (SELECT COUNT(*) FROM users WHERE role = ?1) + (SELECT COUNT(*) FROM group_members WHERE role = ?1)",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Suspend (`Some(reason)`) or reinstate (`None`) an account. Suspending
    /// also ends its sessions.
    pub fn set_user_suspended(&self, id: &str, by: Option<&str>, reason: Option<&str>) -> bool {
        let conn = self.conn.lock().unwrap();
        let changed = match by {
            Some(by) => conn.execute(
                "UPDATE users SET suspended_at = datetime('now'), suspended_by = ?2, suspend_reason = ?3
                 WHERE id = ?1 AND suspended_at IS NULL",
                params![id, by, reason.unwrap_or("").trim()],
            ),
            None => conn.execute(
                "UPDATE users SET suspended_at = NULL, suspended_by = NULL, suspend_reason = NULL
                 WHERE id = ?1 AND suspended_at IS NOT NULL",
                params![id],
            ),
        }
        .unwrap_or(0)
            > 0;
        if changed && by.is_some() {
            conn.execute("DELETE FROM sessions WHERE user_id = ?1", params![id]).ok();
        }
        changed
    }

    /// (suspended_by, suspend_reason) of a suspended account.
    pub fn suspension(&self, id: &str) -> Option<(Option<String>, String)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT suspended_by, COALESCE(suspend_reason, '') FROM users WHERE id = ?1 AND suspended_at IS NOT NULL",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .unwrap()
    }
}
