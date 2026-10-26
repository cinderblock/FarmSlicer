//! Push subscriptions and notification preferences (src/notifications.rs
//! has the rules).

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::Db;

/// Devices kept per account (the newest): a browser that re-subscribes
/// gets a new endpoint, and the old one may never answer 410.
const SUBSCRIPTIONS_KEPT: i64 = 20;

pub(super) fn migrate(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS push_subscriptions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL, -- base64url, the browser's P-256 public key
            auth TEXT NOT NULL,   -- base64url, its 16-byte auth secret
            label TEXT NOT NULL DEFAULT '', -- the device, from its user agent
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_success_at TEXT,
            last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);",
    )
    .expect("failed to create push subscription table");
    // JSON (src/notifications.rs `Prefs`); NULL = the defaults.
    conn.execute_batch("ALTER TABLE users ADD COLUMN notify_prefs TEXT;").ok();
}

#[derive(Debug, Serialize, Clone)]
pub struct PushSubscription {
    pub id: String,
    pub user_id: String,
    pub endpoint: String,
    #[serde(skip)]
    pub p256dh: String,
    #[serde(skip)]
    pub auth: String,
    pub label: String,
    pub created_at: String,
    pub last_success_at: Option<String>,
    pub last_error: Option<String>,
}

const SELECT: &str =
    "SELECT id, user_id, endpoint, p256dh, auth, label, created_at, last_success_at, last_error FROM push_subscriptions";

fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<PushSubscription> {
    Ok(PushSubscription {
        id: r.get(0)?,
        user_id: r.get(1)?,
        endpoint: r.get(2)?,
        p256dh: r.get(3)?,
        auth: r.get(4)?,
        label: r.get(5)?,
        created_at: r.get(6)?,
        last_success_at: r.get(7)?,
        last_error: r.get(8)?,
    })
}

impl Db {
    /// Save a browser's subscription for `user_id`. The same endpoint again
    /// (a device subscribing anew, or another account signing in on it)
    /// moves to this account with the new keys. Returns its id; an error
    /// when there is no such account (`FARMSLICER_NO_AUTH`'s dev user).
    pub fn save_push_subscription(&self, user_id: &str, endpoint: &str, p256dh: &str, auth: &str, label: &str) -> Result<String, String> {
        let conn = self.conn.lock().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, label) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
                auth = excluded.auth, label = excluded.label, last_error = NULL",
            params![id, user_id, endpoint, p256dh, auth, label],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM push_subscriptions WHERE user_id = ?1 AND id NOT IN
                (SELECT id FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2)",
            params![user_id, SUBSCRIPTIONS_KEPT],
        )
        .ok();
        conn.query_row("SELECT id FROM push_subscriptions WHERE endpoint = ?1", params![endpoint], |r| r.get(0))
            .map_err(|e| e.to_string())
    }

    pub fn push_subscriptions_of(&self, user_id: &str) -> Vec<PushSubscription> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("{SELECT} WHERE user_id = ?1 ORDER BY created_at")).unwrap();
        stmt.query_map(params![user_id], from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// The accounts with at least one subscription: the only ones a push
    /// can reach.
    pub fn push_subscribers(&self) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT DISTINCT user_id FROM push_subscriptions").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// Delete a subscription; `user_id` = only if it is theirs.
    pub fn delete_push_subscription(&self, id: &str, user_id: Option<&str>) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM push_subscriptions WHERE id = ?1 AND (?2 IS NULL OR user_id = ?2)",
            params![id, user_id],
        )
        .unwrap_or(0)
            > 0
    }

    pub fn push_delivered(&self, id: &str, error: Option<&str>) {
        let conn = self.conn.lock().unwrap();
        match error {
            None => conn.execute(
                "UPDATE push_subscriptions SET last_success_at = datetime('now'), last_error = NULL WHERE id = ?1",
                params![id],
            ),
            Some(e) => conn.execute("UPDATE push_subscriptions SET last_error = ?2 WHERE id = ?1", params![id, e]),
        }
        .ok();
    }

    pub fn notify_prefs(&self, user_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT notify_prefs FROM users WHERE id = ?1", params![user_id], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
            .flatten()
    }

    pub fn set_notify_prefs(&self, user_id: &str, prefs: Option<&str>) {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE users SET notify_prefs = ?2 WHERE id = ?1", params![user_id, prefs]).ok();
    }

    /// A site setting, set to `value` first if it has none (keys made on
    /// first use: whoever gets there first wins, everyone reads the same).
    pub fn setting_or_insert(&self, key: &str, value: &str) -> String {
        let conn = self.conn.lock().unwrap();
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)", params![key, value]).ok();
        conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
            .expect("setting just inserted")
    }
}
