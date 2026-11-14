//! Signed-in devices: when each session was last used and from what
//! (src/sessions_api.rs).

use rusqlite::{Connection, params};
use serde::Serialize;

use super::Db;

pub(super) fn migrate(conn: &Connection) {
    for col in ["last_seen", "user_agent"] {
        if conn.prepare(&format!("SELECT {col} FROM sessions LIMIT 0")).is_err() {
            conn.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {col} TEXT;")).ok();
        }
    }
}

/// A session as people see it. `id` is the start of the token's hash:
/// enough to name it, useless for signing in.
#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub method: Option<String>,
    pub created_at: String,
    pub expires_at: String,
    pub last_seen: Option<String>,
    pub user_agent: Option<String>,
    #[serde(skip)]
    pub token_hash: String,
}

/// How much of the hash names a session.
const ID_LEN: usize = 16;

impl Db {
    /// Note a session's use (at most once a minute) and its browser.
    pub fn touch_session(&self, token_hash: &str, user_agent: Option<&str>) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET last_seen = datetime('now'), user_agent = COALESCE(?2, user_agent)
             WHERE token_hash = ?1 AND (last_seen IS NULL OR last_seen < datetime('now', '-60 seconds'))",
            params![token_hash, user_agent.map(|u| u.chars().take(300).collect::<String>())],
        )
        .ok();
    }

    /// A user's live sessions, most recently used first.
    pub fn list_sessions(&self, user_id: &str) -> Vec<SessionInfo> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT token_hash, method, created_at, expires_at, last_seen, user_agent FROM sessions
                 WHERE user_id = ?1 AND expires_at > datetime('now')
                 ORDER BY COALESCE(last_seen, created_at) DESC",
            )
            .unwrap();
        stmt.query_map(params![user_id], |r| {
            let hash: String = r.get(0)?;
            Ok(SessionInfo {
                id: hash.chars().take(ID_LEN).collect(),
                method: r.get(1)?,
                created_at: r.get(2)?,
                expires_at: r.get(3)?,
                last_seen: r.get(4)?,
                user_agent: r.get(5)?,
                token_hash: hash,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    /// End one of a user's sessions by its id.
    pub fn end_session(&self, user_id: &str, id: &str) -> bool {
        if id.len() != ID_LEN || !id.chars().all(|c| c.is_ascii_hexdigit()) {
            return false;
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM sessions WHERE user_id = ?1 AND substr(token_hash, 1, 16) = ?2",
            params![user_id, id],
        )
        .unwrap_or(0)
            > 0
    }

    /// End every session of a user but `keep` (a token hash); how many ended.
    pub fn end_sessions(&self, user_id: &str, keep: Option<&str>) -> usize {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM sessions WHERE user_id = ?1 AND token_hash IS NOT ?2",
            params![user_id, keep],
        )
        .unwrap_or(0)
    }

    pub fn delete_passkey_of(&self, user_id: &str, id: &str) -> bool {
        self.delete_passkey(id, user_id)
    }
}
