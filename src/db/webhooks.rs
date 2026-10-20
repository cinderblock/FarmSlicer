//! Webhooks and their deliveries (src/webhooks.rs has the rules).

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::Db;

/// Deliveries kept per webhook (the newest).
const DELIVERIES_KEPT: i64 = 500;

pub(super) fn migrate(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS webhooks (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            secret TEXT NOT NULL,
            events TEXT NOT NULL DEFAULT '[\"*\"]', -- JSON list; \"*\" = every event
            group_id TEXT REFERENCES groups(id) ON DELETE CASCADE, -- only this group's events
            description TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_by TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
            id TEXT PRIMARY KEY,
            webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
            event TEXT NOT NULL,
            payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | failed
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_error TEXT,
            response_status INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            delivered_at TEXT
        );
        CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
        CREATE INDEX IF NOT EXISTS webhook_deliveries_hook ON webhook_deliveries(webhook_id, created_at);",
    )
    .expect("failed to create webhook tables");
}

#[derive(Debug, Serialize, Clone)]
pub struct Webhook {
    pub id: String,
    pub url: String,
    #[serde(skip)]
    pub secret: String,
    /// JSON list of event names.
    pub events: String,
    pub group_id: Option<String>,
    pub description: String,
    pub enabled: bool,
    pub created_by: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct Delivery {
    pub id: String,
    pub webhook_id: String,
    pub event: String,
    pub payload: String,
    pub status: String,
    pub attempts: i64,
    pub next_attempt_at: String,
    pub last_error: Option<String>,
    pub response_status: Option<i64>,
    pub created_at: String,
    pub delivered_at: Option<String>,
}

const HOOK_SELECT: &str =
    "SELECT id, url, secret, events, group_id, description, enabled, created_by, created_at FROM webhooks";

fn hook_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Webhook> {
    Ok(Webhook {
        id: r.get(0)?,
        url: r.get(1)?,
        secret: r.get(2)?,
        events: r.get(3)?,
        group_id: r.get(4)?,
        description: r.get(5)?,
        enabled: r.get(6)?,
        created_by: r.get(7)?,
        created_at: r.get(8)?,
    })
}

const DELIVERY_SELECT: &str = "SELECT id, webhook_id, event, payload, status, attempts, next_attempt_at, last_error,
        response_status, created_at, delivered_at FROM webhook_deliveries";

fn delivery_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Delivery> {
    Ok(Delivery {
        id: r.get(0)?,
        webhook_id: r.get(1)?,
        event: r.get(2)?,
        payload: r.get(3)?,
        status: r.get(4)?,
        attempts: r.get(5)?,
        next_attempt_at: r.get(6)?,
        last_error: r.get(7)?,
        response_status: r.get(8)?,
        created_at: r.get(9)?,
        delivered_at: r.get(10)?,
    })
}

impl Db {
    #[allow(clippy::too_many_arguments)]
    pub fn save_webhook(
        &self,
        id: &str,
        url: &str,
        secret: &str,
        events: &str,
        group_id: Option<&str>,
        description: &str,
        enabled: bool,
        created_by: Option<&str>,
    ) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO webhooks (id, url, secret, events, group_id, description, enabled, created_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET url = excluded.url, secret = excluded.secret, events = excluded.events,
                group_id = excluded.group_id, description = excluded.description, enabled = excluded.enabled",
            params![id, url, secret, events, group_id, description, enabled, created_by],
        )
        .unwrap();
    }

    pub fn list_webhooks(&self) -> Vec<Webhook> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("{HOOK_SELECT} ORDER BY created_at")).unwrap();
        stmt.query_map([], hook_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn get_webhook(&self, id: &str) -> Option<Webhook> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("{HOOK_SELECT} WHERE id = ?1"), params![id], hook_from_row).optional().unwrap()
    }

    pub fn delete_webhook(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM webhooks WHERE id = ?1", params![id]).unwrap() > 0
    }

    pub fn add_delivery(&self, id: &str, webhook_id: &str, event: &str, payload: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO webhook_deliveries (id, webhook_id, event, payload) VALUES (?1, ?2, ?3, ?4)",
            params![id, webhook_id, event, payload],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM webhook_deliveries WHERE webhook_id = ?1 AND status != 'pending' AND id NOT IN
                (SELECT id FROM webhook_deliveries WHERE webhook_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2)",
            params![webhook_id, DELIVERIES_KEPT],
        )
        .unwrap();
    }

    /// Pending deliveries whose time has come, oldest first.
    pub fn due_deliveries(&self, limit: i64) -> Vec<Delivery> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "{DELIVERY_SELECT} WHERE status = 'pending' AND next_attempt_at <= datetime('now')
                 ORDER BY next_attempt_at, rowid LIMIT ?1"
            ))
            .unwrap();
        stmt.query_map(params![limit], delivery_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// Record an attempt: delivered, failed for good, or pending again in
    /// `retry_in` seconds.
    pub fn delivery_attempted(&self, id: &str, status: &str, response: Option<i64>, error: Option<&str>, retry_in: i64) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE webhook_deliveries SET status = ?2, attempts = attempts + 1, response_status = ?3, last_error = ?4,
                next_attempt_at = datetime('now', ?5 || ' seconds'),
                delivered_at = CASE WHEN ?2 = 'delivered' THEN datetime('now') ELSE delivered_at END
             WHERE id = ?1",
            params![id, status, response, error, format!("+{retry_in}")],
        )
        .unwrap();
    }

    pub fn webhook_deliveries(&self, webhook_id: &str, limit: i64) -> Vec<Delivery> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("{DELIVERY_SELECT} WHERE webhook_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2"))
            .unwrap();
        stmt.query_map(params![webhook_id, limit], delivery_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn get_delivery(&self, id: &str) -> Option<Delivery> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("{DELIVERY_SELECT} WHERE id = ?1"), params![id], delivery_from_row)
            .optional()
            .unwrap()
    }

    /// Try a delivery again now (whatever became of it).
    pub fn retry_delivery(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = datetime('now') WHERE id = ?1",
            params![id],
        )
        .unwrap()
            > 0
    }

    /// Per webhook: deliveries pending and failed.
    pub fn delivery_counts(&self, webhook_id: &str) -> (i64, i64) {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COALESCE(SUM(status = 'pending'), 0), COALESCE(SUM(status = 'failed'), 0)
             FROM webhook_deliveries WHERE webhook_id = ?1",
            params![webhook_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0))
    }
}
