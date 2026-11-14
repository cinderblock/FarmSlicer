//! The audit log: who changed accounts, roles, groups, settings and who
//! decided approvals (src/audit.rs writes it).

use rusqlite::{Connection, params_from_iter};
use serde::Serialize;

use super::Db;

pub(super) fn migrate(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at TEXT NOT NULL DEFAULT (datetime('now')),
            actor_id TEXT, -- no FK: the record outlives the account
            actor_name TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL,
            target_kind TEXT NOT NULL DEFAULT '',
            target_id TEXT NOT NULL DEFAULT '',
            target_name TEXT NOT NULL DEFAULT '',
            detail TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at);
        CREATE INDEX IF NOT EXISTS audit_target ON audit_log(target_kind, target_id);
        CREATE INDEX IF NOT EXISTS audit_actor ON audit_log(actor_id);",
    )
    .expect("failed to create audit table");
}

#[derive(Debug, Serialize, Clone)]
pub struct AuditEntry {
    pub id: i64,
    pub at: String,
    pub actor_id: Option<String>,
    pub actor_name: String,
    pub action: String,
    pub target_kind: String,
    pub target_id: String,
    pub target_name: String,
    pub detail: serde_json::Value,
}

#[derive(Debug, Default)]
pub struct AuditFilter {
    pub actor_id: Option<String>,
    pub action_prefix: Option<String>,
    pub target_kind: Option<String>,
    pub target_id: Option<String>,
    /// Entries with a smaller id (paging, newest first).
    pub before: Option<i64>,
    pub limit: i64,
}

pub struct NewAudit<'a> {
    pub actor_id: Option<&'a str>,
    pub actor_name: &'a str,
    pub action: &'a str,
    pub target_kind: &'a str,
    pub target_id: &'a str,
    pub target_name: &'a str,
    pub detail: &'a serde_json::Value,
}

impl Db {
    pub fn add_audit(&self, e: &NewAudit<'_>) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO audit_log (actor_id, actor_name, action, target_kind, target_id, target_name, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![e.actor_id, e.actor_name, e.action, e.target_kind, e.target_id, e.target_name, e.detail.to_string()],
        )
        .ok();
    }

    /// Newest first.
    pub fn list_audit(&self, f: &AuditFilter) -> Vec<AuditEntry> {
        let mut sql = String::from(
            "SELECT id, at, actor_id, actor_name, action, target_kind, target_id, target_name, detail FROM audit_log WHERE 1=1",
        );
        let mut args: Vec<String> = Vec::new();
        if let Some(a) = &f.actor_id {
            args.push(a.clone());
            sql.push_str(&format!(" AND actor_id = ?{}", args.len()));
        }
        if let Some(a) = &f.action_prefix {
            args.push(format!("{}%", a.replace('%', "")));
            sql.push_str(&format!(" AND action LIKE ?{}", args.len()));
        }
        if let Some(k) = &f.target_kind {
            args.push(k.clone());
            sql.push_str(&format!(" AND target_kind = ?{}", args.len()));
        }
        if let Some(t) = &f.target_id {
            args.push(t.clone());
            sql.push_str(&format!(" AND target_id = ?{}", args.len()));
        }
        if let Some(b) = f.before {
            args.push(b.to_string());
            sql.push_str(&format!(" AND id < CAST(?{} AS INTEGER)", args.len()));
        }
        sql.push_str(&format!(" ORDER BY id DESC LIMIT {}", f.limit.clamp(1, 1000)));
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql).unwrap();
        stmt.query_map(params_from_iter(args.iter()), |r| {
            let detail: String = r.get(8)?;
            Ok(AuditEntry {
                id: r.get(0)?,
                at: r.get(1)?,
                actor_id: r.get(2)?,
                actor_name: r.get(3)?,
                action: r.get(4)?,
                target_kind: r.get(5)?,
                target_id: r.get(6)?,
                target_name: r.get(7)?,
                detail: serde_json::from_str(&detail).unwrap_or(serde_json::Value::Null),
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }
}
