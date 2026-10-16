//! Feedback storage (src/feedback.rs has the policy): manual reports and
//! automatic error reports share the `feedback` table; an automatic report
//! is one row per fingerprint with a count, plus a row per (user, version)
//! that hit it in `feedback_occurrences`.

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::Db;

/// Occurrence rows kept per automatic report: the most recently seen.
const OCCURRENCES_KEPT: i64 = 25;

#[derive(Debug, Serialize, Clone)]
pub struct Feedback {
    pub id: String,
    pub automatic: bool,
    /// printer | slicer | app | bug | idea | other
    pub kind: String,
    /// `manual`, or where an error was caught (window, promise, console,
    /// react, api, resource, server).
    pub source: String,
    pub message: String,
    /// Automatic: the latest stack. Only in single-report responses.
    pub stack: Option<String>,
    pub fingerprint: Option<String>,
    /// Manual: the author. Automatic: who hit it first.
    pub user_id: Option<String>,
    pub username: Option<String>,
    pub printer_id: Option<String>,
    pub printer_name: Option<String>,
    pub job_id: Option<String>,
    pub job_name: Option<String>,
    pub page_url: Option<String>,
    pub user_agent: Option<String>,
    pub version: Option<String>,
    /// JSON the client attached (diagnostics). Only in single-report
    /// responses.
    pub context: Option<serde_json::Value>,
    pub count: i64,
    /// Automatic: first seen.
    pub created_at: String,
    pub last_seen: String,
    /// new | acknowledged | resolved | wont_fix
    pub status: String,
    /// The admins' note; the reporter sees it too.
    pub admin_note: String,
    pub updated_at: String,
    /// Automatic: how many accounts hit it (of the occurrence rows kept).
    pub affected_users: i64,
    /// Automatic: the app versions it was seen in (of the rows kept).
    pub versions: Vec<String>,
    /// Automatic, single-report responses: who hit it, in which version.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub occurrences: Vec<FeedbackOccurrence>,
}

#[derive(Debug, Serialize, Clone)]
pub struct FeedbackOccurrence {
    /// None: the server (no account).
    pub user_id: Option<String>,
    pub username: Option<String>,
    pub version: String,
    pub count: i64,
    pub first_seen: String,
    pub last_seen: String,
    pub page_url: Option<String>,
    pub user_agent: Option<String>,
    /// The raw message of the latest one.
    pub message: Option<String>,
}

/// A manual report.
pub struct NewFeedback<'a> {
    pub kind: &'a str,
    pub message: &'a str,
    pub user_id: Option<&'a str>,
    pub printer_id: Option<&'a str>,
    pub job_id: Option<&'a str>,
    pub page_url: Option<&'a str>,
    pub user_agent: Option<&'a str>,
    pub version: Option<&'a str>,
    pub context: Option<&'a str>,
}

/// One or more occurrences of an automatic report.
pub struct ErrorOccurrence<'a> {
    pub kind: &'a str,
    pub source: &'a str,
    pub fingerprint: &'a str,
    pub message: &'a str,
    pub stack: Option<&'a str>,
    pub user_id: Option<&'a str>,
    pub printer_id: Option<&'a str>,
    pub job_id: Option<&'a str>,
    pub page_url: Option<&'a str>,
    pub user_agent: Option<&'a str>,
    pub version: Option<&'a str>,
    pub context: Option<&'a str>,
    /// How many times it happened (the client batches repeats).
    pub count: i64,
}

/// What recording an occurrence did.
#[derive(Debug, PartialEq, Eq)]
pub enum Recorded {
    /// A fingerprint not seen before: a new report.
    New(String),
    /// Counted on an existing report.
    Counted(String),
    /// Counted on a report that was resolved, which is open again.
    Regressed(String),
    /// A new fingerprint past the cap on automatic reports.
    Dropped,
}

#[derive(Default)]
pub struct FeedbackFilter {
    pub automatic: Option<bool>,
    pub kind: Option<String>,
    /// A status, or `open` (new or acknowledged).
    pub status: Option<String>,
    /// Only this account's: its manual reports, and the automatic ones it
    /// hit.
    pub user_id: Option<String>,
    pub limit: i64,
}

const SELECT: &str = "SELECT f.id, f.automatic, f.kind, f.source, f.message, f.fingerprint, f.user_id, u.username,
        f.printer_id, p.name, f.job_id, j.model_name, f.page_url, f.user_agent, f.version, f.count,
        f.created_at, f.last_seen, f.status, f.admin_note, f.updated_at,
        (SELECT COUNT(DISTINCT o.user_id) FROM feedback_occurrences o WHERE o.feedback_id = f.id AND o.user_id != ''),
        (SELECT group_concat(DISTINCT o.version) FROM feedback_occurrences o WHERE o.feedback_id = f.id AND o.version != '')
     FROM feedback f
     LEFT JOIN users u ON u.id = f.user_id
     LEFT JOIN printers p ON p.id = f.printer_id
     LEFT JOIN jobs j ON j.id = f.job_id";

fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Feedback> {
    let versions: Option<String> = r.get(22)?;
    Ok(Feedback {
        id: r.get(0)?,
        automatic: r.get(1)?,
        kind: r.get(2)?,
        source: r.get(3)?,
        message: r.get(4)?,
        stack: None,
        fingerprint: r.get(5)?,
        user_id: r.get(6)?,
        username: r.get(7)?,
        printer_id: r.get(8)?,
        printer_name: r.get(9)?,
        job_id: r.get(10)?,
        job_name: r.get(11)?,
        page_url: r.get(12)?,
        user_agent: r.get(13)?,
        version: r.get(14)?,
        context: None,
        count: r.get(15)?,
        created_at: r.get(16)?,
        last_seen: r.get(17)?,
        status: r.get(18)?,
        admin_note: r.get(19)?,
        updated_at: r.get(20)?,
        affected_users: r.get(21)?,
        versions: versions
            .map(|v| v.split(',').map(str::to_string).collect())
            .unwrap_or_default(),
        occurrences: Vec::new(),
    })
}

impl Db {
    pub fn create_feedback(&self, f: &NewFeedback<'_>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO feedback (id, automatic, kind, source, message, user_id, printer_id, job_id,
                                   page_url, user_agent, version, context)
             VALUES (?1, 0, ?2, 'manual', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                f.kind,
                f.message,
                f.user_id,
                f.printer_id,
                f.job_id,
                f.page_url,
                f.user_agent,
                f.version,
                f.context
            ],
        )
        .unwrap();
        id
    }

    /// Count an automatic report under its fingerprint, creating it when
    /// new (unless `max_reports` automatic reports exist already). The
    /// report keeps the latest details; the (user, version) row its own
    /// count.
    pub fn record_error(&self, e: &ErrorOccurrence<'_>, max_reports: i64) -> Recorded {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT id, status FROM feedback WHERE fingerprint = ?1",
                params![e.fingerprint],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .unwrap();
        let recorded = match existing {
            Some((id, status)) => {
                let regressed = status == "resolved";
                tx.execute(
                    "UPDATE feedback SET
                        count = count + ?2, last_seen = datetime('now'), message = ?3,
                        stack = COALESCE(?4, stack), page_url = ?5, user_agent = ?6, version = ?7,
                        context = COALESCE(?8, context),
                        job_id = COALESCE(?9, job_id), printer_id = COALESCE(?10, printer_id),
                        status = CASE WHEN status = 'resolved' THEN 'new' ELSE status END,
                        updated_at = CASE WHEN status = 'resolved' THEN datetime('now') ELSE updated_at END
                     WHERE id = ?1",
                    params![
                        id,
                        e.count,
                        e.message,
                        e.stack,
                        e.page_url,
                        e.user_agent,
                        e.version,
                        e.context,
                        e.job_id,
                        e.printer_id
                    ],
                )
                .unwrap();
                if regressed { Recorded::Regressed(id) } else { Recorded::Counted(id) }
            }
            None => {
                let stored: i64 = tx
                    .query_row("SELECT COUNT(*) FROM feedback WHERE automatic = 1", [], |r| r.get(0))
                    .unwrap();
                if stored >= max_reports {
                    return Recorded::Dropped;
                }
                let id = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO feedback (id, automatic, kind, source, message, stack, fingerprint, user_id,
                                           printer_id, job_id, page_url, user_agent, version, context, count)
                     VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                    params![
                        id,
                        e.kind,
                        e.source,
                        e.message,
                        e.stack,
                        e.fingerprint,
                        e.user_id,
                        e.printer_id,
                        e.job_id,
                        e.page_url,
                        e.user_agent,
                        e.version,
                        e.context,
                        e.count
                    ],
                )
                .unwrap();
                Recorded::New(id)
            }
        };
        let id = match &recorded {
            Recorded::New(id) | Recorded::Counted(id) | Recorded::Regressed(id) => id.clone(),
            Recorded::Dropped => unreachable!(),
        };
        tx.execute(
            "INSERT INTO feedback_occurrences (feedback_id, user_id, version, count, page_url, user_agent, message)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (feedback_id, user_id, version) DO UPDATE SET
                count = count + excluded.count, last_seen = datetime('now'),
                page_url = excluded.page_url, user_agent = excluded.user_agent, message = excluded.message",
            params![
                id,
                e.user_id.unwrap_or(""),
                e.version.unwrap_or(""),
                e.count,
                e.page_url,
                e.user_agent,
                e.message
            ],
        )
        .unwrap();
        tx.execute(
            "DELETE FROM feedback_occurrences WHERE feedback_id = ?1 AND rowid NOT IN (
                SELECT rowid FROM feedback_occurrences WHERE feedback_id = ?1
                ORDER BY last_seen DESC, rowid DESC LIMIT ?2)",
            params![id, OCCURRENCES_KEPT],
        )
        .unwrap();
        tx.commit().unwrap();
        recorded
    }

    /// Newest activity first, without stacks or contexts (see
    /// `get_feedback`).
    pub fn list_feedback(&self, filter: &FeedbackFilter) -> Vec<Feedback> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "{SELECT}
             WHERE (?1 IS NULL OR f.automatic = ?1)
               AND (?2 IS NULL OR f.kind = ?2)
               AND (?3 IS NULL OR f.status = ?3 OR (?3 = 'open' AND f.status IN ('new', 'acknowledged')))
               AND (?4 IS NULL
                    OR (f.automatic = 0 AND f.user_id = ?4)
                    OR (f.automatic = 1 AND EXISTS (
                        SELECT 1 FROM feedback_occurrences o WHERE o.feedback_id = f.id AND o.user_id = ?4)))
             ORDER BY f.last_seen DESC, f.rowid DESC LIMIT ?5"
        );
        let mut stmt = conn.prepare(&sql).unwrap();
        stmt.query_map(
            params![filter.automatic, filter.kind, filter.status, filter.user_id, filter.limit],
            from_row,
        )
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    /// One report with its stack and context (occurrences: see
    /// `feedback_occurrences`).
    pub fn get_feedback(&self, id: &str) -> Option<Feedback> {
        let conn = self.conn.lock().unwrap();
        let mut f = conn
            .query_row(&format!("{SELECT} WHERE f.id = ?1"), params![id], from_row)
            .optional()
            .unwrap()?;
        let (stack, context): (Option<String>, Option<String>) = conn
            .query_row("SELECT stack, context FROM feedback WHERE id = ?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        f.stack = stack;
        f.context = context.and_then(|c| serde_json::from_str(&c).ok());
        Some(f)
    }

    /// Who hit an automatic report, most recent first; `user_id` narrows to
    /// one account.
    pub fn feedback_occurrences(&self, id: &str, user_id: Option<&str>) -> Vec<FeedbackOccurrence> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT o.user_id, u.username, o.version, o.count, o.first_seen, o.last_seen,
                        o.page_url, o.user_agent, o.message
                 FROM feedback_occurrences o LEFT JOIN users u ON u.id = o.user_id
                 WHERE o.feedback_id = ?1 AND (?2 IS NULL OR o.user_id = ?2)
                 ORDER BY o.last_seen DESC, o.rowid DESC",
            )
            .unwrap();
        stmt.query_map(params![id, user_id], |r| {
            let user: String = r.get(0)?;
            Ok(FeedbackOccurrence {
                user_id: (!user.is_empty()).then_some(user),
                username: r.get(1)?,
                version: r.get(2)?,
                count: r.get(3)?,
                first_seen: r.get(4)?,
                last_seen: r.get(5)?,
                page_url: r.get(6)?,
                user_agent: r.get(7)?,
                message: r.get(8)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    /// Triage: status and/or note. False if there is no such report.
    pub fn update_feedback(&self, id: &str, status: Option<&str>, admin_note: Option<&str>) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE feedback SET status = COALESCE(?2, status), admin_note = COALESCE(?3, admin_note),
                                 updated_at = datetime('now')
             WHERE id = ?1",
            params![id, status, admin_note],
        )
        .unwrap()
            > 0
    }

    pub fn delete_feedback(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM feedback WHERE id = ?1", params![id]).unwrap() > 0
    }

    /// Reports per (automatic, status), for tab counts; `user_id` as in
    /// `FeedbackFilter`.
    pub fn feedback_counts(&self, user_id: Option<&str>) -> Vec<(bool, String, i64)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT f.automatic, f.status, COUNT(*) FROM feedback f
                 WHERE ?1 IS NULL
                    OR (f.automatic = 0 AND f.user_id = ?1)
                    OR (f.automatic = 1 AND EXISTS (
                        SELECT 1 FROM feedback_occurrences o WHERE o.feedback_id = f.id AND o.user_id = ?1))
                 GROUP BY f.automatic, f.status",
            )
            .unwrap();
        stmt.query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDb(std::path::PathBuf, Db);
    impl Drop for TempDb {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }
    fn temp_db() -> TempDb {
        let dir = std::env::temp_dir().join(format!("farmslicer-feedback-{}", uuid::Uuid::new_v4()));
        let db = Db::open(&dir);
        TempDb(dir, db)
    }

    fn occurrence<'a>(fingerprint: &'a str, user: Option<&'a str>, version: &'a str) -> ErrorOccurrence<'a> {
        ErrorOccurrence {
            kind: "app",
            source: "window",
            fingerprint,
            message: "boom",
            stack: Some("at f (index.js)"),
            user_id: user,
            printer_id: None,
            job_id: None,
            page_url: Some("/slice"),
            user_agent: None,
            version: Some(version),
            context: None,
            count: 1,
        }
    }

    #[test]
    fn errors_are_counted_per_fingerprint_and_user() {
        let t = temp_db();
        let Recorded::New(id) = t.1.record_error(&occurrence("fp1", Some("u1"), "v1"), 10) else {
            panic!("first occurrence is new")
        };
        assert_eq!(t.1.record_error(&occurrence("fp1", Some("u1"), "v1"), 10), Recorded::Counted(id.clone()));
        assert_eq!(t.1.record_error(&occurrence("fp1", Some("u2"), "v2"), 10), Recorded::Counted(id.clone()));
        let f = t.1.get_feedback(&id).unwrap();
        assert_eq!(f.count, 3);
        assert_eq!(f.affected_users, 2);
        assert_eq!(f.versions.len(), 2);
        assert_eq!(t.1.feedback_occurrences(&id, None).len(), 2);
        let mine = t.1.feedback_occurrences(&id, Some("u1"));
        assert_eq!((mine.len(), mine[0].count), (1, 2));
    }

    #[test]
    fn resolved_errors_reopen_when_seen_again() {
        let t = temp_db();
        let Recorded::New(id) = t.1.record_error(&occurrence("fp", None, ""), 10) else { panic!() };
        assert!(t.1.update_feedback(&id, Some("resolved"), Some("fixed in the next build")));
        assert_eq!(t.1.record_error(&occurrence("fp", None, ""), 10), Recorded::Regressed(id.clone()));
        let f = t.1.get_feedback(&id).unwrap();
        assert_eq!((f.status.as_str(), f.admin_note.as_str()), ("new", "fixed in the next build"));
        assert!(t.1.update_feedback(&id, Some("wont_fix"), None));
        assert_eq!(t.1.record_error(&occurrence("fp", None, ""), 10), Recorded::Counted(id.clone()));
        assert_eq!(t.1.get_feedback(&id).unwrap().status, "wont_fix");
    }

    #[test]
    fn new_fingerprints_stop_at_the_cap() {
        let t = temp_db();
        assert!(matches!(t.1.record_error(&occurrence("a", None, ""), 2), Recorded::New(_)));
        assert!(matches!(t.1.record_error(&occurrence("b", None, ""), 2), Recorded::New(_)));
        assert_eq!(t.1.record_error(&occurrence("c", None, ""), 2), Recorded::Dropped);
        assert!(matches!(t.1.record_error(&occurrence("a", None, ""), 2), Recorded::Counted(_)), "known ones still count");
    }

    #[test]
    fn occurrence_rows_are_pruned() {
        let t = temp_db();
        let versions: Vec<String> = (0..OCCURRENCES_KEPT + 5).map(|i| format!("v{i}")).collect();
        let mut id = String::new();
        for v in &versions {
            if let Recorded::New(new) | Recorded::Counted(new) = t.1.record_error(&occurrence("fp", Some("u"), v), 10) {
                id = new;
            }
        }
        assert_eq!(t.1.feedback_occurrences(&id, None).len() as i64, OCCURRENCES_KEPT);
        assert_eq!(t.1.get_feedback(&id).unwrap().count, OCCURRENCES_KEPT + 5, "the total keeps counting");
    }

    #[test]
    fn users_see_their_own() {
        let t = temp_db();
        let manual = |user: &'static str| NewFeedback {
            kind: "idea",
            message: "more colours",
            user_id: Some(user),
            printer_id: None,
            job_id: None,
            page_url: None,
            user_agent: None,
            version: None,
            context: Some(r#"{"viewport":"1x1"}"#),
        };
        let mine = t.1.create_feedback(&manual("u1"));
        t.1.create_feedback(&manual("u2"));
        t.1.record_error(&occurrence("hit-by-u1", Some("u1"), ""), 10);
        t.1.record_error(&occurrence("hit-by-u2", Some("u2"), ""), 10);
        let own = t.1.list_feedback(&FeedbackFilter { user_id: Some("u1".into()), limit: 100, ..Default::default() });
        assert_eq!(own.len(), 2, "a manual report and an error they hit");
        assert!(own.iter().any(|f| f.id == mine));
        let all = t.1.list_feedback(&FeedbackFilter { limit: 100, ..Default::default() });
        assert_eq!(all.len(), 4);
        let manual_only = t.1.list_feedback(&FeedbackFilter { automatic: Some(false), limit: 100, ..Default::default() });
        assert_eq!(manual_only.len(), 2);
        t.1.update_feedback(&mine, Some("acknowledged"), None);
        let other = manual_only.iter().find(|f| f.id != mine).unwrap();
        t.1.update_feedback(&other.id, Some("resolved"), None);
        let open = |status: &str| {
            t.1.list_feedback(&FeedbackFilter { automatic: Some(false), status: Some(status.into()), limit: 100, ..Default::default() })
                .len()
        };
        assert_eq!((open("open"), open("acknowledged"), open("resolved"), open("new")), (1, 1, 1, 0));
        assert!(all.iter().all(|f| f.context.is_none()), "lists carry no context");
        assert_eq!(t.1.get_feedback(&mine).unwrap().context, Some(serde_json::json!({"viewport": "1x1"})));
        let counts = t.1.feedback_counts(Some("u1"));
        assert_eq!(counts.iter().map(|c| c.2).sum::<i64>(), 2);
        assert!(t.1.delete_feedback(&mine));
        assert!(t.1.get_feedback(&mine).is_none());
    }
}
