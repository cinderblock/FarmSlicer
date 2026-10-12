use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

pub struct Db {
    conn: Mutex<Connection>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Printer {
    pub id: String,
    pub name: String,
    pub machine_profile: String,
    pub nozzle_diameter: String,
    pub protocol: String,
    pub address: String,
    pub serial_number: String,
    pub access_code: String,
    pub status: String,
    pub current_job: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Job {
    pub id: String,
    pub model_name: String,
    pub model_path: String,
    pub status: String,
    pub progress: i32,
    pub printer_id: Option<String>,
    pub printer_name: Option<String>,
    pub routing: String,
    pub gcode_path: Option<String>,
    pub print_time_sec: Option<f64>,
    pub filament_used_g: Option<f64>,
    pub error: Option<String>,
    pub config_json: Option<String>,
    pub overrides_json: Option<String>,
    /// Current slicing step, e.g. "Generating perimeters".
    pub progress_message: Option<String>,
    /// JSON array of non-fatal slicer messages.
    pub warnings: Option<String>,
    /// Where the slicing ran: "server" (libslic3r in this process) or
    /// "browser" (the WebAssembly engine in the user's browser, G-code
    /// uploaded afterwards).
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SliceRecord {
    pub id: String,
    pub job_id: String,
    pub model_name: String,
    pub gcode_path: String,
    pub print_time_sec: f64,
    pub filament_used_g: f64,
    pub file_size: i64,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct User {
    pub id: String,
    pub username: String,
    /// "owner" | "admin" | "user"
    pub role: String,
    pub created_at: String,
    pub last_login: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApiKey {
    pub id: String,
    pub user_id: String,
    pub name: String,
    /// First characters of the key, for display ("fsk_ab12…").
    pub prefix: String,
    pub created_at: String,
    pub last_used: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomProfile {
    pub id: String,
    pub name: String,
    pub profile_type: String,
    pub base_profile: String,
    pub overrides: String,
    pub created_at: String,
    pub updated_at: String,
}

impl Db {
    pub fn open(data_dir: &Path) -> Self {
        std::fs::create_dir_all(data_dir).expect("failed to create data dir");
        let db_path = data_dir.join("farmslicer.db");
        let conn = Connection::open(&db_path).expect("failed to open database");
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .expect("failed to set pragmas");

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS printers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                machine_profile TEXT NOT NULL DEFAULT '',
                nozzle_diameter TEXT NOT NULL DEFAULT '',
                protocol TEXT NOT NULL DEFAULT 'bambu',
                address TEXT NOT NULL DEFAULT '',
                serial_number TEXT NOT NULL DEFAULT '',
                access_code TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'offline',
                current_job TEXT
            );
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                model_name TEXT NOT NULL,
                model_path TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                progress INTEGER NOT NULL DEFAULT 0,
                printer_id TEXT REFERENCES printers(id),
                routing TEXT NOT NULL DEFAULT 'auto',
                gcode_path TEXT,
                print_time_sec REAL,
                filament_used_g REAL,
                error TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS slices (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL REFERENCES jobs(id),
                model_name TEXT NOT NULL,
                gcode_path TEXT NOT NULL,
                print_time_sec REAL NOT NULL,
                filament_used_g REAL NOT NULL,
                file_size INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );"
        ).expect("failed to create tables");

        // Migrations — add columns that may not exist in older databases
        for col in &["machine_profile", "nozzle_diameter", "serial_number", "access_code"] {
            if conn.prepare(&format!("SELECT {col} FROM printers LIMIT 0")).is_err() {
                conn.execute_batch(
                    &format!("ALTER TABLE printers ADD COLUMN {col} TEXT NOT NULL DEFAULT '';")
                ).ok();
            }
        }
        for col in &["config_json", "overrides_json", "progress_message", "warnings"] {
            if conn.prepare(&format!("SELECT {col} FROM jobs LIMIT 0")).is_err() {
                conn.execute_batch(
                    &format!("ALTER TABLE jobs ADD COLUMN {col} TEXT;")
                ).ok();
            }
        }
        if conn.prepare("SELECT source FROM jobs LIMIT 0").is_err() {
            conn.execute_batch(
                "ALTER TABLE jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'server';"
            ).ok();
        }

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS custom_profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                profile_type TEXT NOT NULL,
                base_profile TEXT NOT NULL,
                overrides TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );"
        ).expect("failed to create custom_profiles table");

        // Accounts (see src/auth.rs). Session tokens and API keys are stored
        // as SHA-256 digests only.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                role TEXT NOT NULL DEFAULT 'user',
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_login TEXT
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS api_keys (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                prefix TEXT NOT NULL,
                key_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_used TEXT
            );"
        ).expect("failed to create account tables");
        if conn.prepare("SELECT user_id FROM jobs LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE jobs ADD COLUMN user_id TEXT;").ok();
        }

        Db { conn: Mutex::new(conn) }
    }

    // -- Users --

    fn user_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<User> {
        Ok(User {
            id: row.get(0)?,
            username: row.get(1)?,
            role: row.get(2)?,
            created_at: row.get(3)?,
            last_login: row.get(4)?,
        })
    }

    pub fn user_count(&self) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
            .unwrap_or(0)
    }

    pub fn list_users(&self) -> Vec<User> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, username, role, created_at, last_login FROM users ORDER BY created_at")
            .unwrap();
        stmt.query_map([], Self::user_from_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn get_user(&self, id: &str) -> Option<User> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, username, role, created_at, last_login FROM users WHERE id = ?1",
            params![id],
            Self::user_from_row,
        )
        .ok()
    }

    /// The user plus their password hash, for login.
    pub fn get_user_credentials(&self, username: &str) -> Option<(User, String)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, username, role, created_at, last_login, password_hash FROM users WHERE username = ?1",
            params![username.trim()],
            |row| Ok((Self::user_from_row(row)?, row.get::<_, String>(5)?)),
        )
        .ok()
    }

    pub fn create_user(&self, username: &str, role: &str, password_hash: &str) -> Result<User, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO users (id, username, role, password_hash) VALUES (?1, ?2, ?3, ?4)",
            params![id, username.trim(), role, password_hash],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                "that username is taken".to_string()
            } else {
                e.to_string()
            }
        })?;
        conn.query_row(
            "SELECT id, username, role, created_at, last_login FROM users WHERE id = ?1",
            params![id],
            Self::user_from_row,
        )
        .map_err(|e| e.to_string())
    }

    pub fn update_user_role(&self, id: &str, role: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE users SET role = ?2 WHERE id = ?1", params![id, role])
            .unwrap_or(0)
            > 0
    }

    pub fn update_user_password(&self, id: &str, password_hash: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE users SET password_hash = ?2 WHERE id = ?1",
            params![id, password_hash],
        )
        .unwrap_or(0)
            > 0
    }

    pub fn delete_user(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM users WHERE id = ?1", params![id])
            .unwrap_or(0)
            > 0
    }

    // -- Sessions --

    pub fn create_session(&self, token_hash: &str, user_id: &str, ttl_days: i64) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at)
             VALUES (?1, ?2, datetime('now', ?3 || ' days'))",
            params![token_hash, user_id, format!("+{ttl_days}")],
        )
        .unwrap();
        conn.execute(
            "UPDATE users SET last_login = datetime('now') WHERE id = ?1",
            params![user_id],
        )
        .ok();
        // Opportunistic cleanup of expired sessions.
        conn.execute("DELETE FROM sessions WHERE expires_at < datetime('now')", [])
            .ok();
    }

    pub fn session_user(&self, token_hash: &str) -> Option<User> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT u.id, u.username, u.role, u.created_at, u.last_login
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?1 AND s.expires_at > datetime('now')",
            params![token_hash],
            Self::user_from_row,
        )
        .ok()
    }

    pub fn delete_session(&self, token_hash: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE token_hash = ?1", params![token_hash])
            .ok();
    }

    pub fn delete_user_sessions(&self, user_id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE user_id = ?1", params![user_id])
            .ok();
    }

    // -- API keys --

    fn api_key_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ApiKey> {
        Ok(ApiKey {
            id: row.get(0)?,
            user_id: row.get(1)?,
            name: row.get(2)?,
            prefix: row.get(3)?,
            created_at: row.get(4)?,
            last_used: row.get(5)?,
        })
    }

    pub fn create_api_key(&self, user_id: &str, name: &str, prefix: &str, key_hash: &str) -> ApiKey {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO api_keys (id, user_id, name, prefix, key_hash) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, user_id, name.trim(), prefix, key_hash],
        )
        .unwrap();
        conn.query_row(
            "SELECT id, user_id, name, prefix, created_at, last_used FROM api_keys WHERE id = ?1",
            params![id],
            Self::api_key_from_row,
        )
        .unwrap()
    }

    pub fn list_api_keys(&self, user_id: &str) -> Vec<ApiKey> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, user_id, name, prefix, created_at, last_used FROM api_keys WHERE user_id = ?1 ORDER BY created_at")
            .unwrap();
        stmt.query_map(params![user_id], Self::api_key_from_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn api_key_user(&self, key_hash: &str) -> Option<User> {
        let conn = self.conn.lock().unwrap();
        let user = conn
            .query_row(
                "SELECT u.id, u.username, u.role, u.created_at, u.last_login
                 FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?1",
                params![key_hash],
                Self::user_from_row,
            )
            .ok()?;
        conn.execute(
            "UPDATE api_keys SET last_used = datetime('now') WHERE key_hash = ?1",
            params![key_hash],
        )
        .ok();
        Some(user)
    }

    pub fn delete_api_key(&self, id: &str, user_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM api_keys WHERE id = ?1 AND user_id = ?2",
            params![id, user_id],
        )
        .unwrap_or(0)
            > 0
    }

    // -- Printers --

    pub fn list_printers(&self) -> Vec<Printer> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, machine_profile, nozzle_diameter, protocol, address, serial_number, access_code, status, current_job FROM printers ORDER BY name")
            .unwrap();
        stmt.query_map([], |row| {
            Ok(Printer {
                id: row.get(0)?,
                name: row.get(1)?,
                machine_profile: row.get(2)?,
                nozzle_diameter: row.get(3)?,
                protocol: row.get(4)?,
                address: row.get(5)?,
                serial_number: row.get(6)?,
                access_code: row.get(7)?,
                status: row.get(8)?,
                current_job: row.get(9)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn create_printer(
        &self,
        name: &str,
        machine_profile: &str,
        nozzle_diameter: &str,
        protocol: &str,
        address: &str,
        serial_number: &str,
        access_code: &str,
    ) -> Printer {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO printers (id, name, machine_profile, nozzle_diameter, protocol, address, serial_number, access_code) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, name, machine_profile, nozzle_diameter, protocol, address, serial_number, access_code],
        )
        .unwrap();
        Printer {
            id,
            name: name.to_string(),
            machine_profile: machine_profile.to_string(),
            nozzle_diameter: nozzle_diameter.to_string(),
            protocol: protocol.to_string(),
            address: address.to_string(),
            serial_number: serial_number.to_string(),
            access_code: access_code.to_string(),
            status: "offline".to_string(),
            current_job: None,
        }
    }

    pub fn delete_printer(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM printers WHERE id = ?1", params![id])
            .unwrap()
            > 0
    }

    // -- Jobs --

    const JOB_SELECT: &'static str =
        "SELECT j.id, j.model_name, j.model_path, j.status, j.progress,
                j.printer_id, p.name, j.routing, j.gcode_path,
                j.print_time_sec, j.filament_used_g, j.error,
                j.config_json, j.overrides_json,
                j.progress_message, j.warnings, j.source,
                j.created_at, j.updated_at
         FROM jobs j LEFT JOIN printers p ON j.printer_id = p.id";

    fn job_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
        Ok(Job {
            id: row.get(0)?,
            model_name: row.get(1)?,
            model_path: row.get(2)?,
            status: row.get(3)?,
            progress: row.get(4)?,
            printer_id: row.get(5)?,
            printer_name: row.get(6)?,
            routing: row.get(7)?,
            gcode_path: row.get(8)?,
            print_time_sec: row.get(9)?,
            filament_used_g: row.get(10)?,
            error: row.get(11)?,
            config_json: row.get(12)?,
            overrides_json: row.get(13)?,
            progress_message: row.get(14)?,
            warnings: row.get(15)?,
            source: row.get(16)?,
            created_at: row.get(17)?,
            updated_at: row.get(18)?,
        })
    }

    pub fn list_jobs(&self) -> Vec<Job> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("{} ORDER BY j.created_at DESC", Self::JOB_SELECT))
            .unwrap();
        stmt.query_map([], Self::job_from_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn get_job(&self, id: &str) -> Option<Job> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("{} WHERE j.id = ?1", Self::JOB_SELECT),
            params![id],
            Self::job_from_row,
        )
        .ok()
    }

    pub fn create_job(
        &self,
        model_name: &str,
        model_path: &str,
        printer_id: Option<&str>,
        routing: &str,
        config_json: Option<&str>,
        overrides_json: Option<&str>,
        source: &str,
        user_id: Option<&str>,
    ) -> Job {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO jobs (id, model_name, model_path, printer_id, routing, config_json, overrides_json, source, user_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, model_name, model_path, printer_id, routing, config_json, overrides_json, source, user_id],
        )
        .unwrap();
        let created_at: String = conn
            .query_row("SELECT created_at FROM jobs WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap();
        Job {
            id,
            model_name: model_name.to_string(),
            model_path: model_path.to_string(),
            status: "queued".to_string(),
            progress: 0,
            printer_id: printer_id.map(String::from),
            printer_name: None,
            routing: routing.to_string(),
            gcode_path: None,
            print_time_sec: None,
            filament_used_g: None,
            error: None,
            config_json: config_json.map(String::from),
            overrides_json: overrides_json.map(String::from),
            progress_message: None,
            warnings: None,
            source: source.to_string(),
            created_at: created_at.clone(),
            updated_at: created_at,
        }
    }

    pub fn update_job_status(&self, id: &str, status: &str, progress: i32) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET status = ?2, progress = ?3, updated_at = datetime('now') WHERE id = ?1",
            params![id, status, progress],
        )
        .unwrap();
    }

    /// Progress tick from the slicer (server or browser). Only touches jobs
    /// that are still running so a late tick can't resurrect a finished job.
    pub fn update_job_progress(&self, id: &str, progress: i32, message: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET progress = ?2, progress_message = ?3, updated_at = datetime('now')
             WHERE id = ?1 AND status IN ('queued', 'slicing')",
            params![id, progress, message],
        )
        .unwrap();
    }

    pub fn complete_job(
        &self,
        id: &str,
        gcode_path: &str,
        print_time_sec: f64,
        filament_used_g: f64,
        warnings: Option<&str>,
    ) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET status = 'done', progress = 100, progress_message = NULL, gcode_path = ?2,
             print_time_sec = ?3, filament_used_g = ?4, warnings = ?5, updated_at = datetime('now')
             WHERE id = ?1",
            params![id, gcode_path, print_time_sec, filament_used_g, warnings],
        )
        .unwrap();
    }

    pub fn fail_job(&self, id: &str, error: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET status = 'failed', error = ?2, updated_at = datetime('now') WHERE id = ?1",
            params![id, error],
        )
        .unwrap();
    }

    /// Browser jobs are driven by a tab; if it closes mid-slice nothing ever
    /// reports back. Fail any browser job that has not ticked for `max_age`
    /// seconds. Returns how many were failed.
    pub fn fail_stale_browser_jobs(&self, max_age_secs: i64) -> usize {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET status = 'failed', progress_message = NULL,
                error = 'browser stopped reporting (tab closed or engine crashed)',
                updated_at = datetime('now')
             WHERE source = 'browser' AND status = 'slicing'
               AND updated_at < datetime('now', ?1 || ' seconds')",
            params![format!("-{max_age_secs}")],
        )
        .unwrap_or(0)
    }

    pub fn cancel_job(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET status = 'cancelled', updated_at = datetime('now')
             WHERE id = ?1 AND status IN ('queued', 'slicing')",
            params![id],
        )
        .unwrap()
            > 0
    }

    // -- Slices --

    pub fn list_slices(&self) -> Vec<SliceRecord> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, job_id, model_name, gcode_path, print_time_sec, filament_used_g, file_size, created_at
                 FROM slices ORDER BY created_at DESC",
            )
            .unwrap();
        stmt.query_map([], |row| {
            Ok(SliceRecord {
                id: row.get(0)?,
                job_id: row.get(1)?,
                model_name: row.get(2)?,
                gcode_path: row.get(3)?,
                print_time_sec: row.get(4)?,
                filament_used_g: row.get(5)?,
                file_size: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn create_slice(
        &self,
        job_id: &str,
        model_name: &str,
        gcode_path: &str,
        print_time_sec: f64,
        filament_used_g: f64,
        file_size: i64,
    ) -> SliceRecord {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO slices (id, job_id, model_name, gcode_path, print_time_sec, filament_used_g, file_size)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, job_id, model_name, gcode_path, print_time_sec, filament_used_g, file_size],
        )
        .unwrap();
        let created_at: String = conn
            .query_row("SELECT created_at FROM slices WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap();
        SliceRecord {
            id,
            job_id: job_id.to_string(),
            model_name: model_name.to_string(),
            gcode_path: gcode_path.to_string(),
            print_time_sec,
            filament_used_g,
            file_size,
            created_at,
        }
    }

    // -- Custom Profiles --

    pub fn list_custom_profiles(&self) -> Vec<CustomProfile> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, profile_type, base_profile, overrides, created_at, updated_at FROM custom_profiles ORDER BY name")
            .unwrap();
        stmt.query_map([], |row| {
            Ok(CustomProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                profile_type: row.get(2)?,
                base_profile: row.get(3)?,
                overrides: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn get_custom_profile(&self, id: &str) -> Option<CustomProfile> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, profile_type, base_profile, overrides, created_at, updated_at FROM custom_profiles WHERE id = ?1",
            params![id],
            |row| {
                Ok(CustomProfile {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    profile_type: row.get(2)?,
                    base_profile: row.get(3)?,
                    overrides: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .ok()
    }

    pub fn create_custom_profile(
        &self,
        name: &str,
        profile_type: &str,
        base_profile: &str,
        overrides: &str,
    ) -> CustomProfile {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO custom_profiles (id, name, profile_type, base_profile, overrides) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, profile_type, base_profile, overrides],
        )
        .unwrap();
        let created_at: String = conn
            .query_row("SELECT created_at FROM custom_profiles WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap();
        CustomProfile {
            id,
            name: name.to_string(),
            profile_type: profile_type.to_string(),
            base_profile: base_profile.to_string(),
            overrides: overrides.to_string(),
            created_at: created_at.clone(),
            updated_at: created_at,
        }
    }

    pub fn update_custom_profile(&self, id: &str, name: &str, overrides: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE custom_profiles SET name = ?2, overrides = ?3, updated_at = datetime('now') WHERE id = ?1",
            params![id, name, overrides],
        )
        .unwrap()
            > 0
    }

    pub fn delete_custom_profile(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM custom_profiles WHERE id = ?1", params![id])
            .unwrap()
            > 0
    }
}
