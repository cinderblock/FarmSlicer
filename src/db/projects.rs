//! Projects (demand): what someone needs printed, item by item, and which
//! job plates carry those items (src/projects.rs has the rules).

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::{ACTIVE_PRINT_STATUSES, Db};

pub(super) fn migrate(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
            user_id TEXT, -- no FK, like jobs.user_id
            client_ref TEXT, -- opaque: whoever the work is for, as the ordering tool names them
            external_ref TEXT, -- the ordering tool's own id (idempotent creation)
            status TEXT NOT NULL DEFAULT 'open', -- open | printed | ready | shipped | on_hold | cancelled
            status_note TEXT,
            priority INTEGER NOT NULL DEFAULT 0,
            due_at TEXT,
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            printed_at TEXT,
            shipped_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS projects_external
            ON projects(COALESCE(group_id, ''), external_ref) WHERE external_ref IS NOT NULL;
        CREATE INDEX IF NOT EXISTS projects_group ON projects(group_id, status);
        CREATE TABLE IF NOT EXISTS project_items (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            idx INTEGER NOT NULL,
            name TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            -- The recipe: a job and one of its models (model, profiles,
            -- overrides, rotation). NULL model_idx: the job's only part.
            job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
            model_idx INTEGER,
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS project_items_project ON project_items(project_id, idx);
        -- Which items a job's plates carry: per plate, each part (`model:N`
        -- for a model of the job, `object:<name>` for an upload's objects)
        -- belongs to at most one item, with how many copies.
        CREATE TABLE IF NOT EXISTS job_items (
            job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            plate INTEGER NOT NULL,
            part TEXT NOT NULL,
            item_id TEXT NOT NULL REFERENCES project_items(id) ON DELETE CASCADE,
            model_idx INTEGER,
            name TEXT NOT NULL,
            copies INTEGER NOT NULL,
            PRIMARY KEY (job_id, plate, part)
        );
        CREATE INDEX IF NOT EXISTS job_items_item ON job_items(item_id);",
    )
    .expect("failed to create project tables");
}

#[derive(Debug, Serialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    pub user_id: Option<String>,
    pub username: Option<String>,
    pub client_ref: Option<String>,
    pub external_ref: Option<String>,
    pub status: String,
    pub status_note: Option<String>,
    pub priority: i64,
    pub due_at: Option<String>,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
    pub printed_at: Option<String>,
    pub shipped_at: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct Item {
    pub id: String,
    pub project_id: String,
    pub idx: i64,
    pub name: String,
    pub quantity: i64,
    pub job_id: Option<String>,
    pub model_idx: Option<i64>,
    pub notes: String,
    pub created_at: String,
}

/// Where an item's copies stand, counted from prints, outcomes and the
/// queue (never stored per copy).
#[derive(Debug, Serialize, Clone, Default, PartialEq)]
pub struct Progress {
    pub good: i64,
    pub failed: i64,
    /// On finished prints nobody has checked.
    pub unchecked: i64,
    /// On prints still on a printer, or waiting for approval.
    pub printing: i64,
    /// On queued plates not sent yet.
    pub queued: i64,
}

/// A part of a job plate that is for an item.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct JobItem {
    pub job_id: String,
    pub plate: i64,
    /// `model:N` or `object:<name>` (src/projects.rs `part_key`).
    pub part: String,
    pub item_id: String,
    pub model_idx: Option<i64>,
    pub name: String,
    pub copies: i64,
}

pub struct NewProject<'a> {
    pub name: &'a str,
    pub group_id: Option<&'a str>,
    pub user_id: Option<&'a str>,
    pub client_ref: Option<&'a str>,
    pub external_ref: Option<&'a str>,
    pub priority: i64,
    pub due_at: Option<&'a str>,
    pub notes: &'a str,
}

const PROJECT_SELECT: &str = "SELECT p.id, p.name, p.group_id, g.name, p.user_id, u.username, p.client_ref,
        p.external_ref, p.status, p.status_note, p.priority, p.due_at, p.notes, p.created_at, p.updated_at,
        p.printed_at, p.shipped_at
     FROM projects p LEFT JOIN groups g ON g.id = p.group_id LEFT JOIN users u ON u.id = p.user_id";

fn project_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        group_id: r.get(2)?,
        group_name: r.get(3)?,
        user_id: r.get(4)?,
        username: r.get(5)?,
        client_ref: r.get(6)?,
        external_ref: r.get(7)?,
        status: r.get(8)?,
        status_note: r.get(9)?,
        priority: r.get(10)?,
        due_at: r.get(11)?,
        notes: r.get(12)?,
        created_at: r.get(13)?,
        updated_at: r.get(14)?,
        printed_at: r.get(15)?,
        shipped_at: r.get(16)?,
    })
}

const ITEM_SELECT: &str =
    "SELECT id, project_id, idx, name, quantity, job_id, model_idx, notes, created_at FROM project_items";

fn item_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Item> {
    Ok(Item {
        id: r.get(0)?,
        project_id: r.get(1)?,
        idx: r.get(2)?,
        name: r.get(3)?,
        quantity: r.get(4)?,
        job_id: r.get(5)?,
        model_idx: r.get(6)?,
        notes: r.get(7)?,
        created_at: r.get(8)?,
    })
}

/// Filters for the project list; None = any.
#[derive(Debug, Default)]
pub struct ProjectFilter {
    pub status: Option<Vec<String>>,
    pub group_ids: Option<Vec<String>>,
    pub client_ref: Option<String>,
    pub external_ref: Option<String>,
    pub search: Option<String>,
}

impl Db {
    /// A new project, or the existing one with the same `external_ref` in
    /// the same group (`false` = it existed).
    pub fn create_project(&self, p: &NewProject<'_>) -> (Project, bool) {
        if let Some(ext) = p.external_ref {
            if let Some(existing) = self.project_by_external_ref(p.group_id, ext) {
                return (existing, false);
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO projects (id, name, group_id, user_id, client_ref, external_ref, priority, due_at, notes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![id, p.name, p.group_id, p.user_id, p.client_ref, p.external_ref, p.priority, p.due_at, p.notes],
            )
            .unwrap();
        }
        (self.get_project(&id).expect("project just inserted"), true)
    }

    pub fn project_by_external_ref(&self, group_id: Option<&str>, external_ref: &str) -> Option<Project> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("{PROJECT_SELECT} WHERE COALESCE(p.group_id, '') = COALESCE(?1, '') AND p.external_ref = ?2"),
            params![group_id, external_ref],
            project_from_row,
        )
        .optional()
        .unwrap()
    }

    pub fn get_project(&self, id: &str) -> Option<Project> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("{PROJECT_SELECT} WHERE p.id = ?1"), params![id], project_from_row)
            .optional()
            .unwrap()
    }

    /// Projects, most urgent first: priority, due date, age.
    pub fn list_projects(&self, f: &ProjectFilter, limit: i64) -> Vec<Project> {
        let mut sql = format!("{PROJECT_SELECT} WHERE 1 = 1");
        let mut args: Vec<String> = Vec::new();
        let list = |args: &mut Vec<String>, values: &[String]| -> String {
            values
                .iter()
                .map(|v| {
                    args.push(v.clone());
                    format!("?{}", args.len())
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        if let Some(s) = &f.status {
            let l = list(&mut args, s);
            sql += &format!(" AND p.status IN ({})", if l.is_empty() { "NULL".into() } else { l });
        }
        if let Some(g) = &f.group_ids {
            let l = list(&mut args, g);
            sql += &format!(" AND p.group_id IN ({})", if l.is_empty() { "NULL".into() } else { l });
        }
        if let Some(c) = &f.client_ref {
            args.push(c.clone());
            sql += &format!(" AND p.client_ref = ?{}", args.len());
        }
        if let Some(e) = &f.external_ref {
            args.push(e.clone());
            sql += &format!(" AND p.external_ref = ?{}", args.len());
        }
        if let Some(q) = &f.search {
            args.push(format!("%{}%", q.replace('%', "")));
            let n = args.len();
            sql += &format!(" AND (p.name LIKE ?{n} OR p.client_ref LIKE ?{n} OR p.external_ref LIKE ?{n})");
        }
        args.push(limit.to_string());
        sql += &format!(
            " ORDER BY p.status IN ('shipped', 'cancelled'), p.priority DESC, p.due_at IS NULL, p.due_at, p.created_at
              LIMIT ?{}",
            args.len()
        );
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql).unwrap();
        stmt.query_map(rusqlite::params_from_iter(args.iter()), project_from_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_project(
        &self,
        id: &str,
        name: &str,
        client_ref: Option<&str>,
        external_ref: Option<&str>,
        priority: i64,
        due_at: Option<&str>,
        notes: &str,
        group_id: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE projects SET name = ?2, client_ref = ?3, external_ref = ?4, priority = ?5, due_at = ?6,
                    notes = ?7, group_id = ?8, updated_at = datetime('now')
             WHERE id = ?1",
            params![id, name, client_ref, external_ref, priority, due_at, notes, group_id],
        )
        .map(|_| ())
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
                "another project of that group has this external_ref".to_string()
            }
            e => e.to_string(),
        })
    }

    /// Move a project to `status`, stamping printed_at / shipped_at.
    /// Returns whether it changed.
    pub fn set_project_status(&self, id: &str, status: &str, note: Option<&str>) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE projects SET status = ?2, status_note = ?3,
                    printed_at = CASE WHEN ?2 = 'printed' THEN datetime('now') WHEN ?2 = 'open' THEN NULL ELSE printed_at END,
                    shipped_at = CASE WHEN ?2 = 'shipped' THEN datetime('now') ELSE shipped_at END,
                    updated_at = datetime('now')
             WHERE id = ?1 AND status != ?2",
            params![id, status, note],
        )
        .unwrap()
            > 0
    }

    pub fn delete_project(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM projects WHERE id = ?1", params![id]).unwrap() > 0
    }

    // -- Items --

    pub fn add_item(
        &self,
        project_id: &str,
        name: &str,
        quantity: i64,
        job_id: Option<&str>,
        model_idx: Option<i64>,
        notes: &str,
    ) -> Item {
        let id = uuid::Uuid::new_v4().to_string();
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO project_items (id, project_id, idx, name, quantity, job_id, model_idx, notes)
                 VALUES (?1, ?2, (SELECT COALESCE(MAX(idx), -1) + 1 FROM project_items WHERE project_id = ?2),
                         ?3, ?4, ?5, ?6, ?7)",
                params![id, project_id, name, quantity, job_id, model_idx, notes],
            )
            .unwrap();
            conn.execute("UPDATE projects SET updated_at = datetime('now') WHERE id = ?1", params![project_id])
                .unwrap();
        }
        self.get_item(&id).expect("item just inserted")
    }

    pub fn get_item(&self, id: &str) -> Option<Item> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("{ITEM_SELECT} WHERE id = ?1"), params![id], item_from_row)
            .optional()
            .unwrap()
    }

    pub fn project_items(&self, project_id: &str) -> Vec<Item> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("{ITEM_SELECT} WHERE project_id = ?1 ORDER BY idx")).unwrap();
        stmt.query_map(params![project_id], item_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn update_item(&self, id: &str, name: &str, quantity: i64, notes: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE project_items SET name = ?2, quantity = ?3, notes = ?4 WHERE id = ?1",
            params![id, name, quantity, notes],
        )
        .unwrap()
            > 0
    }

    pub fn delete_item(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM project_items WHERE id = ?1", params![id]).unwrap() > 0
    }

    // -- Which plates carry which items --

    /// Say that the copies of `part` on plate `plate` of `job_id` are for
    /// `item_id`, and count outcomes already recorded for them. False when
    /// the part is another item's already.
    pub fn link_job_item(&self, j: &JobItem) -> bool {
        let conn = self.conn.lock().unwrap();
        let taken: Option<String> = conn
            .query_row(
                "SELECT item_id FROM job_items WHERE job_id = ?1 AND plate = ?2 AND part = ?3",
                params![j.job_id, j.plate, j.part],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        if taken.as_deref().is_some_and(|t| t != j.item_id) {
            return false;
        }
        conn.execute(
            "INSERT OR REPLACE INTO job_items (job_id, plate, part, item_id, model_idx, name, copies)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![j.job_id, j.plate, j.part, j.item_id, j.model_idx, j.name, j.copies],
        )
        .unwrap();
        conn.execute(
            "UPDATE print_outcomes SET item_id = ?3
             WHERE (item_id IS NULL OR item_id = ?3)
               AND print_id IN (SELECT id FROM prints WHERE job_id = ?1 AND plate = ?2)
               AND ((?4 IS NOT NULL AND model_idx = ?4) OR (?4 IS NULL AND model_idx IS NULL AND name = ?5))",
            params![j.job_id, j.plate, j.item_id, j.model_idx, j.name],
        )
        .unwrap();
        true
    }

    /// Stop counting a job's plates for the project's items (outcomes keep
    /// what they were for).
    pub fn unlink_job(&self, project_id: &str, job_id: &str) -> usize {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM job_items WHERE job_id = ?1
               AND item_id IN (SELECT id FROM project_items WHERE project_id = ?2)",
            params![job_id, project_id],
        )
        .unwrap()
    }

    /// The items plate `plate` of `job_id` carries.
    pub fn job_plate_items(&self, job_id: &str, plate: i64) -> Vec<JobItem> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT job_id, plate, part, item_id, model_idx, name, copies FROM job_items
                 WHERE job_id = ?1 AND plate = ?2",
            )
            .unwrap();
        stmt.query_map(params![job_id, plate], job_item_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// Every job plate carrying one of the project's items.
    pub fn project_job_items(&self, project_id: &str) -> Vec<JobItem> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT ji.job_id, ji.plate, ji.part, ji.item_id, ji.model_idx, ji.name, ji.copies
                 FROM job_items ji JOIN project_items i ON i.id = ji.item_id
                 WHERE i.project_id = ?1 ORDER BY ji.job_id, ji.plate, ji.part",
            )
            .unwrap();
        stmt.query_map(params![project_id], job_item_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// The projects whose items a job's plates carry.
    pub fn projects_of_job(&self, job_id: &str) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT i.project_id FROM job_items ji JOIN project_items i ON i.id = ji.item_id
                 WHERE ji.job_id = ?1",
            )
            .unwrap();
        stmt.query_map(params![job_id], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// Each item of the project with where its copies stand.
    pub fn project_progress(&self, project_id: &str) -> Vec<(String, Progress)> {
        let active = ACTIVE_PRINT_STATUSES
            .iter()
            .chain(&["pending_approval"])
            .map(|s| format!("'{s}'"))
            .collect::<Vec<_>>()
            .join(", ");
        let queued = if self.has_queue() {
            "(SELECT COALESCE(SUM(ji.copies), 0) FROM job_items ji
                JOIN queue_entries q ON q.job_id = ji.job_id AND q.plate = ji.plate
              WHERE ji.item_id = i.id AND q.status = 'queued')"
        } else {
            "0"
        };
        let sql = format!(
            "SELECT i.id,
                (SELECT COALESCE(SUM(o.good), 0) FROM print_outcomes o WHERE o.item_id = i.id),
                (SELECT COALESCE(SUM(o.failed), 0) FROM print_outcomes o WHERE o.item_id = i.id),
                (SELECT COALESCE(SUM(ji.copies), 0) FROM job_items ji
                    JOIN prints p ON p.job_id = ji.job_id AND p.plate = ji.plate
                  WHERE ji.item_id = i.id AND p.status = 'finished' AND p.outcome IS NULL),
                (SELECT COALESCE(SUM(ji.copies), 0) FROM job_items ji
                    JOIN prints p ON p.job_id = ji.job_id AND p.plate = ji.plate
                  WHERE ji.item_id = i.id AND p.status IN ({active})),
                {queued}
             FROM project_items i WHERE i.project_id = ?1 ORDER BY i.idx"
        );
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql).unwrap();
        stmt.query_map(params![project_id], |r| {
            Ok((
                r.get(0)?,
                Progress { good: r.get(1)?, failed: r.get(2)?, unchecked: r.get(3)?, printing: r.get(4)?, queued: r.get(5)? },
            ))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    /// Every print of a job, oldest first.
    pub fn prints_of_job(&self, job_id: &str) -> Vec<super::PrintRecord> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("{} WHERE p.job_id = ?1 ORDER BY p.created_at, p.rowid", Self::PRINT_SELECT))
            .unwrap();
        stmt.query_map(params![job_id], Self::print_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// The queue's table exists (step 4 adds it; progress counts it then).
    fn has_queue(&self) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.prepare("SELECT 1 FROM queue_entries LIMIT 0").is_ok()
    }
}

fn job_item_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<JobItem> {
    Ok(JobItem {
        job_id: r.get(0)?,
        plate: r.get(1)?,
        part: r.get(2)?,
        item_id: r.get(3)?,
        model_idx: r.get(4)?,
        name: r.get(5)?,
        copies: r.get(6)?,
    })
}
