//! Folders in libraries and what's filed in them (src/folders.rs has the
//! rules).

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::Db;

pub(super) fn migrate(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
            library_kind TEXT NOT NULL,   -- user | group
            library_id TEXT NOT NULL,     -- the user's or the group's id
            name TEXT NOT NULL,
            created_by TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS folders_name
            ON folders(library_kind, library_id, COALESCE(parent_id, ''), name COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS folder_items (
            kind TEXT NOT NULL,           -- job | project
            item_id TEXT NOT NULL,
            folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
            filed_by TEXT,
            filed_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (kind, item_id)
        );
        CREATE INDEX IF NOT EXISTS folder_items_folder ON folder_items(folder_id);",
    )
    .expect("failed to create folder tables");
}

#[derive(Debug, Clone, Serialize)]
pub struct Folder {
    pub id: String,
    pub parent_id: Option<String>,
    pub library_kind: String,
    pub library_id: String,
    pub name: String,
    pub created_by: Option<String>,
    pub created_at: String,
}

fn folder_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        library_kind: r.get(2)?,
        library_id: r.get(3)?,
        name: r.get(4)?,
        created_by: r.get(5)?,
        created_at: r.get(6)?,
    })
}

const COLS: &str = "id, parent_id, library_kind, library_id, name, created_by, created_at";

fn name_error(e: rusqlite::Error, name: &str) -> String {
    if e.to_string().contains("UNIQUE") {
        format!("there is already a folder named '{}' there", name.trim())
    } else {
        e.to_string()
    }
}

impl Db {
    pub fn list_folders(&self) -> Vec<Folder> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM folders ORDER BY name COLLATE NOCASE")).unwrap();
        stmt.query_map([], folder_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn get_folder(&self, id: &str) -> Option<Folder> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {COLS} FROM folders WHERE id = ?1"), params![id], folder_from_row)
            .optional()
            .unwrap()
    }

    pub fn create_folder(&self, f: &Folder) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO folders (id, parent_id, library_kind, library_id, name, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![f.id, f.parent_id, f.library_kind, f.library_id, f.name.trim(), f.created_by],
        )
        .map(|_| ())
        .map_err(|e| name_error(e, &f.name))
    }

    /// Rename and/or move within its library.
    pub fn update_folder(&self, id: &str, name: &str, parent_id: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE folders SET name = ?2, parent_id = ?3 WHERE id = ?1", params![id, name.trim(), parent_id])
            .map(|_| ())
            .map_err(|e| name_error(e, name))
    }

    /// Delete a folder; its subfolders and what's filed in it move up to
    /// its parent (the library's top level when it had none). A subfolder
    /// whose name is taken there keeps its place under a "(moved)" name.
    pub fn delete_folder(&self, id: &str) -> bool {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        let Some(parent): Option<Option<String>> = tx
            .query_row("SELECT parent_id FROM folders WHERE id = ?1", params![id], |r| r.get(0))
            .optional()
            .unwrap()
        else {
            return false;
        };
        let children: Vec<(String, String)> = {
            let mut stmt = tx.prepare("SELECT id, name FROM folders WHERE parent_id = ?1").unwrap();
            stmt.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().filter_map(|r| r.ok()).collect()
        };
        for (child, name) in children {
            if tx.execute("UPDATE folders SET parent_id = ?2 WHERE id = ?1", params![child, parent]).is_err() {
                tx.execute(
                    "UPDATE folders SET parent_id = ?2, name = ?3 WHERE id = ?1",
                    params![child, parent, format!("{name} (moved)")],
                )
                .ok();
            }
        }
        match &parent {
            Some(p) => tx.execute("UPDATE folder_items SET folder_id = ?2 WHERE folder_id = ?1", params![id, p]),
            None => tx.execute("DELETE FROM folder_items WHERE folder_id = ?1", params![id]),
        }
        .unwrap();
        tx.execute("DELETE FROM folders WHERE id = ?1", params![id]).unwrap();
        tx.commit().unwrap();
        true
    }

    /// File an item in a folder, or (None) take it back to its library's top.
    pub fn file_item(&self, kind: &str, item_id: &str, folder_id: Option<&str>, by: &str) {
        let conn = self.conn.lock().unwrap();
        match folder_id {
            Some(f) => conn.execute(
                "INSERT INTO folder_items (kind, item_id, folder_id, filed_by) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (kind, item_id) DO UPDATE SET folder_id = excluded.folder_id,
                     filed_by = excluded.filed_by, filed_at = datetime('now')",
                params![kind, item_id, f, by],
            ),
            None => conn.execute("DELETE FROM folder_items WHERE kind = ?1 AND item_id = ?2", params![kind, item_id]),
        }
        .unwrap();
    }

    /// Every (kind, item, folder).
    pub fn list_folder_items(&self) -> Vec<(String, String, String)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT kind, item_id, folder_id FROM folder_items").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// A library is going away (a group, an account): its folders go too.
    pub fn delete_library_folders(&self, kind: &str, id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM folder_items WHERE folder_id IN (SELECT id FROM folders WHERE library_kind = ?1 AND library_id = ?2)",
            params![kind, id],
        )
        .ok();
        conn.execute("DELETE FROM folders WHERE library_kind = ?1 AND library_id = ?2", params![kind, id]).ok();
    }
}
