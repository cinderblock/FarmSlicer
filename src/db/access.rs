//! Printer access rules, certifications and what an access rule asked of
//! a held print (src/access.rs has the rules).

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::Db;

pub(super) fn migrate(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS printer_access (
            id TEXT PRIMARY KEY,
            target_kind TEXT NOT NULL,          -- printer | pool | model | site
            target_id TEXT NOT NULL DEFAULT '', -- printer id, pool id, model name; '' for site
            position INTEGER NOT NULL,          -- order within the target: first match wins
            principal_kind TEXT NOT NULL,       -- everyone | user | group | role | certified
            principal_id TEXT NOT NULL DEFAULT '',
            effect TEXT NOT NULL,               -- allow | approve | deny
            approvers TEXT NOT NULL DEFAULT '[]', -- JSON [Principal] for approve
            note TEXT NOT NULL DEFAULT '',
            created_by TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS printer_access_target ON printer_access(target_kind, target_id, position);
        CREATE TABLE IF NOT EXISTS certifications (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            description TEXT NOT NULL DEFAULT '',
            valid_days INTEGER,                 -- NULL: doesn't expire
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS user_certifications (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            cert_id TEXT NOT NULL REFERENCES certifications(id) ON DELETE CASCADE,
            granted_by TEXT,
            granted_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT,
            note TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (user_id, cert_id)
        );
        CREATE INDEX IF NOT EXISTS user_certifications_cert ON user_certifications(cert_id);
        -- A print an access rule held: who may approve it, and whether
        -- print rules or the upload policy held it too.
        CREATE TABLE IF NOT EXISTS print_access_holds (
            print_id TEXT PRIMARY KEY REFERENCES prints(id) ON DELETE CASCADE,
            rule_id TEXT,
            access INTEGER NOT NULL DEFAULT 0,
            approvers TEXT NOT NULL DEFAULT '[]',
            rules_hold INTEGER NOT NULL DEFAULT 0
        );",
    )
    .expect("failed to create printer access tables");
}

/// Who a rule (or an approver entry) is about.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Principal {
    /// everyone | user | group | role | certified
    pub kind: String,
    #[serde(default)]
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccessRule {
    pub id: String,
    pub target_kind: String,
    pub target_id: String,
    pub position: i64,
    pub principal: Principal,
    pub effect: String,
    pub approvers: Vec<Principal>,
    pub note: String,
    pub created_by: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Certification {
    pub id: String,
    pub name: String,
    pub description: String,
    pub valid_days: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CertHolder {
    pub user_id: String,
    pub username: String,
    pub cert_id: String,
    pub granted_by: Option<String>,
    pub granted_at: String,
    pub expires_at: Option<String>,
    pub note: String,
    /// Not expired.
    pub valid: bool,
}

/// What an access rule asked of a held print.
#[derive(Debug, Clone, Default)]
pub struct PrintHold {
    pub rule_id: Option<String>,
    /// An access rule held it (approvers below).
    pub access: bool,
    pub approvers: Vec<Principal>,
    /// Print rules or the upload policy held it too.
    pub rules_hold: bool,
}

const RULE_COLS: &str =
    "id, target_kind, target_id, position, principal_kind, principal_id, effect, approvers, note, created_by, created_at";

fn rule_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AccessRule> {
    let approvers: String = r.get(7)?;
    Ok(AccessRule {
        id: r.get(0)?,
        target_kind: r.get(1)?,
        target_id: r.get(2)?,
        position: r.get(3)?,
        principal: Principal { kind: r.get(4)?, id: r.get(5)? },
        effect: r.get(6)?,
        approvers: serde_json::from_str(&approvers).unwrap_or_default(),
        note: r.get(8)?,
        created_by: r.get(9)?,
        created_at: r.get(10)?,
    })
}

const HOLDER_SELECT: &str = "SELECT uc.user_id, u.username, uc.cert_id, gb.username, uc.granted_at, uc.expires_at, uc.note,
        (uc.expires_at IS NULL OR uc.expires_at > datetime('now'))
     FROM user_certifications uc JOIN users u ON u.id = uc.user_id LEFT JOIN users gb ON gb.id = uc.granted_by";

fn holder_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CertHolder> {
    Ok(CertHolder {
        user_id: r.get(0)?,
        username: r.get(1)?,
        cert_id: r.get(2)?,
        granted_by: r.get(3)?,
        granted_at: r.get(4)?,
        expires_at: r.get(5)?,
        note: r.get(6)?,
        valid: r.get(7)?,
    })
}

impl Db {
    pub fn list_access_rules(&self) -> Vec<AccessRule> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("SELECT {RULE_COLS} FROM printer_access ORDER BY target_kind, target_id, position"))
            .unwrap();
        stmt.query_map([], rule_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn get_access_rule(&self, id: &str) -> Option<AccessRule> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {RULE_COLS} FROM printer_access WHERE id = ?1"), params![id], rule_from_row)
            .optional()
            .unwrap()
    }

    /// Insert (at the end of its target's list) or replace a rule.
    pub fn save_access_rule(&self, r: &AccessRule) {
        let conn = self.conn.lock().unwrap();
        let approvers = serde_json::to_string(&r.approvers).unwrap();
        conn.execute(
            "INSERT INTO printer_access (id, target_kind, target_id, position, principal_kind, principal_id, effect, approvers, note, created_by)
             VALUES (?1, ?2, ?3,
                     COALESCE((SELECT MAX(position) + 1 FROM printer_access WHERE target_kind = ?2 AND target_id = ?3), 0),
                     ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (id) DO UPDATE SET principal_kind = excluded.principal_kind, principal_id = excluded.principal_id,
                 effect = excluded.effect, approvers = excluded.approvers, note = excluded.note",
            params![r.id, r.target_kind, r.target_id, r.principal.kind, r.principal.id, r.effect, approvers, r.note, r.created_by],
        )
        .unwrap();
    }

    pub fn delete_access_rule(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM printer_access WHERE id = ?1", params![id]).unwrap_or(0) > 0
    }

    /// Rules on a printer or pool that is being removed.
    pub fn delete_access_rules_for(&self, target_kind: &str, target_id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM printer_access WHERE target_kind = ?1 AND target_id = ?2",
            params![target_kind, target_id],
        )
        .ok();
    }

    /// Put a target's rules in this order (ids not of the target are ignored).
    pub fn order_access_rules(&self, target_kind: &str, target_id: &str, ids: &[String]) {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE printer_access SET position = ?4 WHERE id = ?1 AND target_kind = ?2 AND target_id = ?3",
                params![id, target_kind, target_id, i as i64],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }

    pub fn list_certifications(&self) -> Vec<Certification> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, description, valid_days, created_at FROM certifications ORDER BY name COLLATE NOCASE")
            .unwrap();
        stmt.query_map([], |r| {
            Ok(Certification { id: r.get(0)?, name: r.get(1)?, description: r.get(2)?, valid_days: r.get(3)?, created_at: r.get(4)? })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn get_certification(&self, id: &str) -> Option<Certification> {
        self.list_certifications().into_iter().find(|c| c.id == id)
    }

    pub fn save_certification(&self, c: &Certification) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO certifications (id, name, description, valid_days) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, valid_days = excluded.valid_days",
            params![c.id, c.name.trim(), c.description.trim(), c.valid_days],
        )
        .map(|_| ())
        .map_err(|e| if e.to_string().contains("UNIQUE") { format!("there is already a certification named '{}'", c.name.trim()) } else { e.to_string() })
    }

    pub fn delete_certification(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM certifications WHERE id = ?1", params![id]).unwrap_or(0) > 0
    }

    /// Access rules naming the certification.
    pub fn certification_rule_count(&self, id: &str) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM printer_access WHERE principal_kind = 'certified' AND principal_id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Every grant (valid or expired), by certification then username.
    pub fn list_cert_holders(&self) -> Vec<CertHolder> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("{HOLDER_SELECT} ORDER BY uc.cert_id, u.username COLLATE NOCASE")).unwrap();
        stmt.query_map([], holder_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn certs_of_user(&self, user_id: &str) -> Vec<CertHolder> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("{HOLDER_SELECT} WHERE uc.user_id = ?1")).unwrap();
        stmt.query_map(params![user_id], holder_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// Grant (or renew) a certification; `valid_days` None = no expiry.
    pub fn grant_certification(&self, user_id: &str, cert_id: &str, by: &str, valid_days: Option<i64>, note: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO user_certifications (user_id, cert_id, granted_by, expires_at, note)
             VALUES (?1, ?2, ?3, CASE WHEN ?4 IS NULL THEN NULL ELSE datetime('now', '+' || ?4 || ' days') END, ?5)
             ON CONFLICT (user_id, cert_id) DO UPDATE SET granted_by = excluded.granted_by,
                 granted_at = datetime('now'), expires_at = excluded.expires_at, note = excluded.note",
            params![user_id, cert_id, by, valid_days, note.trim()],
        )
        .unwrap();
    }

    pub fn revoke_certification(&self, user_id: &str, cert_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM user_certifications WHERE user_id = ?1 AND cert_id = ?2", params![user_id, cert_id])
            .unwrap_or(0)
            > 0
    }

    pub fn set_print_hold(&self, print_id: &str, h: &PrintHold) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO print_access_holds (print_id, rule_id, access, approvers, rules_hold) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![print_id, h.rule_id, h.access, serde_json::to_string(&h.approvers).unwrap(), h.rules_hold],
        )
        .unwrap();
    }

    /// None for prints held before access rules existed (print rules or
    /// the upload policy held those).
    pub fn print_hold(&self, print_id: &str) -> Option<PrintHold> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT rule_id, access, approvers, rules_hold FROM print_access_holds WHERE print_id = ?1",
            params![print_id],
            |r| {
                let approvers: String = r.get(2)?;
                Ok(PrintHold {
                    rule_id: r.get(0)?,
                    access: r.get(1)?,
                    approvers: serde_json::from_str(&approvers).unwrap_or_default(),
                    rules_hold: r.get(3)?,
                })
            },
        )
        .optional()
        .unwrap()
    }
}
