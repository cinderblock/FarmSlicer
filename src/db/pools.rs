//! Printer pools and their operators (src/pools.rs has the rules).

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::Db;

pub(super) fn migrate(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS pools (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            settings TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS pool_printers (
            pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
            printer_id TEXT NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
            PRIMARY KEY (pool_id, printer_id)
        );
        CREATE TABLE IF NOT EXISTS pool_operators (
            pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            PRIMARY KEY (pool_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS pool_operators_user ON pool_operators(user_id);
        CREATE INDEX IF NOT EXISTS pool_printers_printer ON pool_printers(printer_id);",
    )
    .expect("failed to create pool tables");
}

#[derive(Debug, Serialize, Clone)]
pub struct Pool {
    pub id: String,
    pub name: String,
    /// JSON (`pools::PoolSettings`).
    pub settings: String,
    pub created_at: String,
    pub printer_ids: Vec<String>,
    /// (user id, username)
    pub operators: Vec<(String, String)>,
}

impl Db {
    fn pool_members(conn: &Connection, id: &str) -> (Vec<String>, Vec<(String, String)>) {
        let mut stmt = conn.prepare("SELECT printer_id FROM pool_printers WHERE pool_id = ?1 ORDER BY printer_id").unwrap();
        let printers = stmt.query_map(params![id], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect();
        let mut stmt = conn
            .prepare(
                "SELECT o.user_id, u.username FROM pool_operators o JOIN users u ON u.id = o.user_id
                 WHERE o.pool_id = ?1 ORDER BY u.username",
            )
            .unwrap();
        let operators = stmt.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().filter_map(|r| r.ok()).collect();
        (printers, operators)
    }

    pub fn list_pools(&self) -> Vec<Pool> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, name, settings, created_at FROM pools ORDER BY name").unwrap();
        let rows: Vec<(String, String, String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        rows.into_iter()
            .map(|(id, name, settings, created_at)| {
                let (printer_ids, operators) = Self::pool_members(&conn, &id);
                Pool { id, name, settings, created_at, printer_ids, operators }
            })
            .collect()
    }

    pub fn get_pool(&self, id: &str) -> Option<Pool> {
        let conn = self.conn.lock().unwrap();
        let (name, settings, created_at): (String, String, String) = conn
            .query_row("SELECT name, settings, created_at FROM pools WHERE id = ?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()
            .unwrap()?;
        let (printer_ids, operators) = Self::pool_members(&conn, id);
        Some(Pool { id: id.to_string(), name, settings, created_at, printer_ids, operators })
    }

    /// Create or replace a pool: its name, settings, printers and operators.
    pub fn save_pool(&self, id: &str, name: &str, settings: &str, printers: &[String], operators: &[String]) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO pools (id, name, settings) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, settings = excluded.settings",
            params![id, name, settings],
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
                "another pool has that name".to_string()
            }
            e => e.to_string(),
        })?;
        tx.execute("DELETE FROM pool_printers WHERE pool_id = ?1", params![id]).unwrap();
        tx.execute("DELETE FROM pool_operators WHERE pool_id = ?1", params![id]).unwrap();
        for p in printers {
            tx.execute("INSERT OR IGNORE INTO pool_printers (pool_id, printer_id) VALUES (?1, ?2)", params![id, p])
                .map_err(|e| format!("printer {p}: {e}"))?;
        }
        for u in operators {
            tx.execute("INSERT OR IGNORE INTO pool_operators (pool_id, user_id) VALUES (?1, ?2)", params![id, u])
                .map_err(|e| format!("user {u}: {e}"))?;
        }
        tx.commit().unwrap();
        Ok(())
    }

    pub fn delete_pool(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE queue_entries SET pool_id = NULL WHERE pool_id = ?1", params![id]).unwrap();
        conn.execute("DELETE FROM pools WHERE id = ?1", params![id]).unwrap() > 0
    }

    /// The printers `user_id` operates (through any of their pools).
    pub fn operated_printers(&self, user_id: &str) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT pp.printer_id FROM pool_printers pp
                 JOIN pool_operators o ON o.pool_id = pp.pool_id WHERE o.user_id = ?1",
            )
            .unwrap();
        stmt.query_map(params![user_id], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn pool_has_printer(&self, pool_id: &str, printer_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM pool_printers WHERE pool_id = ?1 AND printer_id = ?2",
            params![pool_id, printer_id],
            |_| Ok(()),
        )
        .optional()
        .unwrap()
        .is_some()
    }

    pub fn operates_pool(&self, user_id: &str, pool_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM pool_operators WHERE pool_id = ?1 AND user_id = ?2",
            params![pool_id, user_id],
            |_| Ok(()),
        )
        .optional()
        .unwrap()
        .is_some()
    }
}
