use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

mod feedback;
mod outcomes;
pub use feedback::{ErrorOccurrence, Feedback, FeedbackFilter, NewFeedback, Recorded};

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
    /// Where the printer stands ("Bay 1"); the Printers page groups by it.
    pub area: String,
    /// The build plate installed (`curr_bed_type` names); "" = unknown.
    pub plate_type: String,
    /// Dual-nozzle printers: which nozzle supports and parts prefer
    /// (`nozzles::PRIORITY_VALUES`); "" = the default.
    pub nozzle_priority: String,
}

/// A problem someone reported with a printer.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PrinterReport {
    pub id: String,
    pub printer_id: Option<String>,
    pub printer_name: String,
    pub user_id: Option<String>,
    pub username: Option<String>,
    pub description: String,
    pub created_at: String,
    pub resolved_at: Option<String>,
    pub resolved_by: Option<String>,
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
    /// Who created the job (None for jobs from before accounts existed).
    pub user_id: Option<String>,
    pub username: Option<String>,
    /// The group the job is charged to and shared with (None = personal).
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    /// Bytes kept on the server for this job: model (if stored) + G-code.
    pub stored_bytes: i64,
    /// The printable package (`.gcode.3mf`) on the server, when there is one.
    #[serde(skip)]
    pub package_path: Option<String>,
    /// What the package holds (src/package/ `Package`, JSON); its
    /// presence means the job can be sent to a printer.
    pub package_json: Option<String>,
    /// Where the model was put on the bed (src/placement.rs, JSON); None =
    /// centred as loaded. Jobs from before `plate_json` only.
    pub placement_json: Option<String>,
    /// What the job was made from (`server::JobInputs`, JSON).
    pub inputs_json: Option<String>,
    /// What the Slice page proposed before the user changed anything (JSON).
    pub proposed_json: Option<String>,
    /// The parts on the plate (`placement::PlateLayout`, JSON).
    pub plate_json: Option<String>,
    /// Which nozzle each filament prints from and why, on dual-nozzle
    /// printers (`nozzles::Plan`, JSON); None = the slicer chose.
    pub nozzle_plan_json: Option<String>,
    /// How many source models the job has, and how many of them stayed in
    /// the user's browser.
    pub model_count: i64,
    pub local_models: i64,
}

/// One of a job's source models (table `job_models`).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JobModel {
    pub idx: i64,
    pub name: String,
    /// '' = kept in the user's browser only.
    #[serde(skip)]
    pub path: String,
    pub bytes: i64,
    pub sha256: Option<String>,
}

impl JobModel {
    /// Is the file on the server (not just in someone's browser)?
    pub fn stored(&self) -> bool {
        !self.path.is_empty() && Path::new(&self.path).exists()
    }
}

/// A job sent to a printer.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PrintRecord {
    pub id: String,
    pub job_id: Option<String>,
    pub plate: i64,
    pub printer_id: Option<String>,
    /// Kept so history survives the printer's removal.
    pub printer_name: String,
    pub user_id: Option<String>,
    pub username: Option<String>,
    pub group_id: Option<String>,
    /// The file's name on the printer.
    pub file_name: String,
    /// What the printer shows as the job name.
    pub name: String,
    /// JSON: the `ams_mapping` sent (tray slot per project filament, -1 unused).
    pub ams_mapping: Option<String>,
    /// JSON: the print options (src/printing.rs `PrintOptions`).
    pub options: Option<String>,
    /// Why it needs approval (pending_approval), and who decided.
    pub approval_reason: Option<String>,
    pub decided_by: Option<String>,
    /// Its G-code needs review (src/gcode/): only an admin may approve it.
    pub safety_review: bool,
    /// pending_approval | uploading | starting | printing | paused | finished
    /// | failed | cancelled | rejected
    pub status: String,
    /// Upload percent while uploading, then print percent.
    pub progress: i64,
    pub error: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub updated_at: String,
    /// How it came out (src/outcomes.rs): None = not recorded, else
    /// `good` | `partial` | `failed`; who said so ("printer" and "auto" for
    /// automatic records), when, and their note.
    pub outcome: Option<String>,
    pub outcome_by: Option<String>,
    pub outcome_at: Option<String>,
    pub outcome_note: Option<String>,
}

/// Custom G-code that failed its check or a print (src/incidents.rs).
#[derive(Debug, Serialize, Clone)]
pub struct GcodeIncident {
    pub id: String,
    pub created_at: String,
    /// Whoever the G-code came from (the job's creator).
    pub user_id: Option<String>,
    pub username: Option<String>,
    /// Whoever sent the print (print incidents).
    pub sent_by: Option<String>,
    pub sent_by_username: Option<String>,
    pub job_id: Option<String>,
    pub print_id: Option<String>,
    pub job_name: String,
    pub printer_name: Option<String>,
    /// upload | browser | server
    pub source: String,
    /// check | print_failed | printer_error
    pub kind: String,
    /// block | review | error
    pub severity: String,
    pub summary: String,
}

pub struct NewIncident<'a> {
    pub user_id: Option<&'a str>,
    pub sent_by: Option<&'a str>,
    pub job_id: Option<&'a str>,
    pub print_id: Option<&'a str>,
    pub job_name: &'a str,
    pub printer_name: Option<&'a str>,
    pub source: &'a str,
    pub kind: &'a str,
    pub severity: &'a str,
    pub summary: &'a str,
    pub dedupe: &'a str,
}

/// Print statuses that still need the printer.
pub const ACTIVE_PRINT_STATUSES: &[&str] = &["uploading", "starting", "printing", "paused"];

/// `ACTIVE_PRINT_STATUSES` as an SQL list: `'uploading', 'starting', ...`.
fn active_print_sql() -> String {
    ACTIVE_PRINT_STATUSES
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(", ")
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
    /// From the job: creator, group, and whether its model file is kept.
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub has_model: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct User {
    pub id: String,
    pub username: String,
    /// "owner" | "admin" | "user"
    pub role: String,
    pub created_at: String,
    pub last_login: Option<String>,
    /// "full" (signs in with a passkey) | "guest" (no credential: a
    /// long-lived session plus one-time sign-in codes; limited access).
    pub kind: String,
    /// Per-user quota rules (JSON array, see src/quota.rs); None = the site
    /// default for the account kind.
    pub quotas: Option<String>,
    /// Approved for access from outside the local network (passkey
    /// sessions only; see `auth::authenticate`).
    pub remote_access: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PasskeyRecord {
    /// Credential id, hex.
    pub id: String,
    pub user_id: String,
    pub name: String,
    /// webauthn-rs `Passkey`, serialised as JSON.
    #[serde(skip_serializing)]
    pub passkey_json: String,
    pub created_at: String,
    pub last_used: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Invite {
    pub user_id: String,
    pub created_by: Option<String>,
    pub created_at: String,
    pub expires_at: String,
    pub used_at: Option<String>,
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

        // Printers added as "klipper" before FarmSlicer spoke Moonraker.
        conn.execute("UPDATE printers SET protocol = 'moonraker' WHERE protocol = 'klipper'", [])
            .expect("failed to migrate printer protocols");

        // Migrations — add columns that may not exist in older databases
        for col in &["machine_profile", "nozzle_diameter", "serial_number", "access_code", "area", "plate_type", "nozzle_priority"] {
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

        // Accounts (see src/auth.rs): passkeys only. Session tokens, API keys,
        // invite tokens and recovery codes are stored as SHA-256 digests.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                role TEXT NOT NULL DEFAULT 'user',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_login TEXT
            );
            CREATE TABLE IF NOT EXISTS passkeys (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                passkey_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_used TEXT
            );
            CREATE TABLE IF NOT EXISTS invites (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_by TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at TEXT NOT NULL,
                used_at TEXT
            );
            CREATE TABLE IF NOT EXISTS recovery_codes (
                code_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                used_at TEXT
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
        // A short-lived password-based schema existed before passkeys; drop
        // the column so the NOT NULL constraint can't block inserts.
        if conn.prepare("SELECT password_hash FROM users LIMIT 0").is_ok() {
            conn.execute_batch("ALTER TABLE users DROP COLUMN password_hash;").ok();
        }
        if conn.prepare("SELECT kind FROM users LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'full';").ok();
        }
        if conn.prepare("SELECT quotas FROM users LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE users ADD COLUMN quotas TEXT;").ok();
        }
        if conn.prepare("SELECT remote_access FROM users LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE users ADD COLUMN remote_access INTEGER NOT NULL DEFAULT 0;").ok();
        }
        // How a session was made: 'passkey' | 'recovery' | 'code' (guest).
        // Older sessions have none and don't count from the internet.
        if conn.prepare("SELECT method FROM sessions LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN method TEXT;").ok();
        }

        // Groups (see src/groups.rs): a tree; members, join links, and
        // site-wide runtime settings. Settings and quotas are JSON.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS groups (
                id TEXT PRIMARY KEY,
                parent_id TEXT REFERENCES groups(id) ON DELETE RESTRICT,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                settings TEXT NOT NULL DEFAULT '{}',
                quotas TEXT NOT NULL DEFAULT '{}',
                self_key TEXT,
                created_by TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS groups_parent_self_key
                ON groups(parent_id, self_key) WHERE self_key IS NOT NULL;
            CREATE TABLE IF NOT EXISTS group_members (
                group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role TEXT NOT NULL DEFAULT 'member',
                status TEXT NOT NULL DEFAULT 'active',
                quotas TEXT,
                joined_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (group_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_id);
            CREATE TABLE IF NOT EXISTS join_links (
                id TEXT PRIMARY KEY,
                group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                code TEXT NOT NULL UNIQUE COLLATE NOCASE,
                public INTEGER NOT NULL DEFAULT 0,
                bypass_approval INTEGER NOT NULL DEFAULT 0,
                label TEXT NOT NULL DEFAULT '',
                max_uses INTEGER,
                uses INTEGER NOT NULL DEFAULT 0,
                expires_at TEXT,
                disabled INTEGER NOT NULL DEFAULT 0,
                created_by TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );"
        ).expect("failed to create group tables");
        if conn.prepare("SELECT group_id FROM jobs LIMIT 0").is_err() {
            conn.execute_batch(
                "ALTER TABLE jobs ADD COLUMN group_id TEXT REFERENCES groups(id) ON DELETE SET NULL;"
            ).ok();
        }
        if conn.prepare("SELECT stored_bytes FROM jobs LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE jobs ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;").ok();
        }
        for col in &["package_path", "package_json", "placement_json"] {
            if conn.prepare(&format!("SELECT {col} FROM jobs LIMIT 0")).is_err() {
                conn.execute_batch(&format!("ALTER TABLE jobs ADD COLUMN {col} TEXT;")).ok();
            }
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS prints (
                id TEXT PRIMARY KEY,
                job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
                plate INTEGER NOT NULL DEFAULT 1,
                printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL,
                printer_name TEXT NOT NULL,
                user_id TEXT, -- no FK, like jobs.user_id: FARMSLICER_NO_AUTH runs as a stand-in owner with no users row
                group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
                file_name TEXT NOT NULL,
                name TEXT NOT NULL,
                ams_mapping TEXT,
                status TEXT NOT NULL,
                progress INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                started_at TEXT,
                finished_at TEXT,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS printer_reports (
                id TEXT PRIMARY KEY,
                printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL,
                printer_name TEXT NOT NULL,
                user_id TEXT,
                description TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                resolved_at TEXT,
                resolved_by TEXT
            );
            CREATE INDEX IF NOT EXISTS prints_printer ON prints(printer_id, status);
            CREATE INDEX IF NOT EXISTS prints_job ON prints(job_id);"
        ).expect("failed to create prints table");
        for col in &["options", "approval_reason", "decided_by"] {
            if conn.prepare(&format!("SELECT {col} FROM prints LIMIT 0")).is_err() {
                conn.execute_batch(&format!("ALTER TABLE prints ADD COLUMN {col} TEXT;")).ok();
            }
        }
        if conn.prepare("SELECT safety_review FROM prints LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE prints ADD COLUMN safety_review INTEGER NOT NULL DEFAULT 0;").ok();
        }
        outcomes::migrate(&conn);
        // Custom G-code that failed its check or a print (src/incidents.rs).
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS gcode_incidents (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                user_id TEXT, -- whoever the G-code came from (the job's creator)
                sent_by TEXT, -- whoever sent the print, for print incidents
                job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
                print_id TEXT REFERENCES prints(id) ON DELETE SET NULL,
                job_name TEXT NOT NULL,
                printer_name TEXT,
                source TEXT NOT NULL,
                kind TEXT NOT NULL,
                severity TEXT NOT NULL,
                summary TEXT NOT NULL,
                dedupe TEXT NOT NULL UNIQUE
            );
            CREATE INDEX IF NOT EXISTS gcode_incidents_user ON gcode_incidents(user_id, created_at);",
        )
        .expect("failed to create gcode_incidents");
        // Feedback: manual reports and automatic error reports, one table
        // (src/feedback.rs). Automatic ones are deduplicated by
        // `fingerprint`; each keeps a row per (user, version) that hit it.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS feedback (
                id TEXT PRIMARY KEY,
                automatic INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL, -- printer | slicer | app | bug | idea | other
                source TEXT NOT NULL, -- manual | window | promise | console | react | api | resource | server
                message TEXT NOT NULL,
                stack TEXT, -- automatic: the latest one
                fingerprint TEXT UNIQUE, -- automatic only
                user_id TEXT, -- no FK, like jobs.user_id; automatic: who hit it first
                printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL,
                job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
                page_url TEXT,
                user_agent TEXT,
                version TEXT,
                context TEXT, -- JSON
                count INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')), -- automatic: first seen
                last_seen TEXT NOT NULL DEFAULT (datetime('now')),
                status TEXT NOT NULL DEFAULT 'new', -- new | acknowledged | resolved | wont_fix
                admin_note TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS feedback_list ON feedback(automatic, last_seen);
            CREATE INDEX IF NOT EXISTS feedback_user ON feedback(user_id);
            CREATE TABLE IF NOT EXISTS feedback_occurrences (
                feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL DEFAULT '', -- '' = no user (server)
                version TEXT NOT NULL DEFAULT '',
                count INTEGER NOT NULL DEFAULT 0,
                first_seen TEXT NOT NULL DEFAULT (datetime('now')),
                last_seen TEXT NOT NULL DEFAULT (datetime('now')),
                page_url TEXT,
                user_agent TEXT,
                message TEXT, -- the latest raw message
                PRIMARY KEY (feedback_id, user_id, version)
            );
            CREATE INDEX IF NOT EXISTS feedback_occurrences_user ON feedback_occurrences(user_id);",
        )
        .expect("failed to create feedback tables");
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS jobs_group ON jobs(group_id);
             CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id);"
        ).ok();
        // A job's source models, in the order they were given (a plate can
        // hold several). `path` = '' when the model stayed in the user's
        // browser ("keep on this device"); `sha256` lets that browser find
        // it again.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS job_models (
                job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                idx INTEGER NOT NULL,
                name TEXT NOT NULL,
                path TEXT NOT NULL DEFAULT '',
                bytes INTEGER NOT NULL DEFAULT 0,
                sha256 TEXT,
                PRIMARY KEY (job_id, idx)
            );
            -- Jobs from before job_models: their one kept model.
            INSERT OR IGNORE INTO job_models (job_id, idx, name, path, bytes)
                SELECT id, 0, model_name, model_path, 0 FROM jobs
                WHERE model_path != '' AND id NOT IN (SELECT job_id FROM job_models);",
        )
        .expect("failed to create job_models");
        // What the job was made from (profiles, plate, printer: re-slicing
        // starts from it), what the Slice page proposed (the defaults-changed
        // report compares the two), and where each part sits on the plate.
        for col in &["inputs_json", "proposed_json", "plate_json", "nozzle_plan_json"] {
            if conn.prepare(&format!("SELECT {col} FROM jobs LIMIT 0")).is_err() {
                conn.execute_batch(&format!("ALTER TABLE jobs ADD COLUMN {col} TEXT;")).ok();
            }
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
            kind: row.get(5)?,
            quotas: row.get(6)?,
            remote_access: row.get(7)?,
        })
    }

    pub fn user_count(&self) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
            .unwrap_or(0)
    }

    /// True when nobody can possibly sign in: no passkeys anywhere, no live
    /// invite, no unused recovery code. The installation then counts as not
    /// set up (see `auth::setup_required`).
    pub fn no_way_in(&self) -> bool {
        let conn = self.conn.lock().unwrap();
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0) };
        // Guests' sign-in codes live in recovery_codes too; they don't make
        // the installation administrable, so only full accounts count.
        count("SELECT COUNT(*) FROM passkeys") == 0
            && count("SELECT COUNT(*) FROM invites WHERE used_at IS NULL AND expires_at > datetime('now')") == 0
            && count(
                "SELECT COUNT(*) FROM recovery_codes r JOIN users u ON u.id = r.user_id
                 WHERE r.used_at IS NULL AND u.kind = 'full'",
            ) == 0
    }

    /// Remove full accounts that have no passkey (first-run re-bootstrap:
    /// such accounts are unreachable; guests never have one and keep their
    /// sign-in codes). Cascades to their sessions, keys, invites.
    pub fn delete_users_without_passkeys(&self) -> usize {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM users WHERE kind = 'full' AND id NOT IN (SELECT DISTINCT user_id FROM passkeys)",
            [],
        )
        .unwrap_or(0)
    }

    pub fn list_users(&self) -> Vec<User> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, username, role, created_at, last_login, kind, quotas, remote_access FROM users ORDER BY created_at")
            .unwrap();
        stmt.query_map([], Self::user_from_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn get_user(&self, id: &str) -> Option<User> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, username, role, created_at, last_login, kind, quotas, remote_access FROM users WHERE id = ?1",
            params![id],
            Self::user_from_row,
        )
        .ok()
    }

    pub fn get_user_by_username(&self, username: &str) -> Option<User> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, username, role, created_at, last_login, kind, quotas, remote_access FROM users WHERE username = ?1",
            params![username.trim()],
            Self::user_from_row,
        )
        .ok()
    }

    /// Creates the account row. `id` is caller-chosen so a registration
    /// ceremony can be bound to it before the row exists.
    pub fn create_user(&self, id: &str, username: &str, role: &str, kind: &str) -> Result<User, String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO users (id, username, role, kind) VALUES (?1, ?2, ?3, ?4)",
            params![id, username.trim(), role, kind],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                "that username is taken".to_string()
            } else {
                e.to_string()
            }
        })?;
        conn.query_row(
            "SELECT id, username, role, created_at, last_login, kind, quotas, remote_access FROM users WHERE id = ?1",
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

    // -- Passkeys --

    fn passkey_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PasskeyRecord> {
        Ok(PasskeyRecord {
            id: row.get(0)?,
            user_id: row.get(1)?,
            name: row.get(2)?,
            passkey_json: row.get(3)?,
            created_at: row.get(4)?,
            last_used: row.get(5)?,
        })
    }

    pub fn add_passkey(&self, id: &str, user_id: &str, name: &str, passkey_json: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO passkeys (id, user_id, name, passkey_json) VALUES (?1, ?2, ?3, ?4)",
            params![id, user_id, name.trim(), passkey_json],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    pub fn list_passkeys(&self, user_id: &str) -> Vec<PasskeyRecord> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, user_id, name, passkey_json, created_at, last_used FROM passkeys WHERE user_id = ?1 ORDER BY created_at")
            .unwrap();
        stmt.query_map(params![user_id], Self::passkey_from_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn get_passkey(&self, id: &str) -> Option<PasskeyRecord> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, user_id, name, passkey_json, created_at, last_used FROM passkeys WHERE id = ?1",
            params![id],
            Self::passkey_from_row,
        )
        .ok()
    }

    pub fn passkey_count(&self, user_id: &str) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM passkeys WHERE user_id = ?1",
            params![user_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Store the updated credential (sign counter / backup flags) after a login.
    pub fn touch_passkey(&self, id: &str, passkey_json: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE passkeys SET passkey_json = ?2, last_used = datetime('now') WHERE id = ?1",
            params![id, passkey_json],
        )
        .ok();
    }

    pub fn rename_passkey(&self, id: &str, user_id: &str, name: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE passkeys SET name = ?3 WHERE id = ?1 AND user_id = ?2",
            params![id, user_id, name.trim()],
        )
        .unwrap_or(0)
            > 0
    }

    pub fn delete_passkey(&self, id: &str, user_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2",
            params![id, user_id],
        )
        .unwrap_or(0)
            > 0
    }

    // -- Invites (enrolment links) --

    pub fn create_invite(&self, token_hash: &str, user_id: &str, created_by: Option<&str>, ttl_hours: i64) {
        let conn = self.conn.lock().unwrap();
        // One live invite per user.
        conn.execute("DELETE FROM invites WHERE user_id = ?1", params![user_id])
            .ok();
        conn.execute(
            "INSERT INTO invites (token_hash, user_id, created_by, expires_at)
             VALUES (?1, ?2, ?3, datetime('now', ?4 || ' hours'))",
            params![token_hash, user_id, created_by, format!("+{ttl_hours}")],
        )
        .unwrap();
    }

    /// A valid (unused, unexpired) invite and its user.
    pub fn get_invite(&self, token_hash: &str) -> Option<(Invite, User)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT i.user_id, i.created_by, i.created_at, i.expires_at, i.used_at,
                    u.id, u.username, u.role, u.created_at, u.last_login, u.kind, u.quotas, u.remote_access
             FROM invites i JOIN users u ON u.id = i.user_id
             WHERE i.token_hash = ?1 AND i.used_at IS NULL AND i.expires_at > datetime('now')",
            params![token_hash],
            |row| {
                Ok((
                    Invite {
                        user_id: row.get(0)?,
                        created_by: row.get(1)?,
                        created_at: row.get(2)?,
                        expires_at: row.get(3)?,
                        used_at: row.get(4)?,
                    },
                    User {
                        id: row.get(5)?,
                        username: row.get(6)?,
                        role: row.get(7)?,
                        created_at: row.get(8)?,
                        last_login: row.get(9)?,
                        kind: row.get(10)?,
                        quotas: row.get(11)?,
                        remote_access: row.get(12)?,
                    },
                ))
            },
        )
        .ok()
    }

    pub fn use_invite(&self, token_hash: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE invites SET used_at = datetime('now') WHERE token_hash = ?1",
            params![token_hash],
        )
        .ok();
    }

    pub fn pending_invite_expiry(&self, user_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT expires_at FROM invites WHERE user_id = ?1 AND used_at IS NULL AND expires_at > datetime('now')",
            params![user_id],
            |r| r.get(0),
        )
        .ok()
    }

    // -- Recovery codes --

    /// Replace the user's recovery code (one live code per user).
    pub fn set_recovery_code(&self, user_id: &str, code_hash: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM recovery_codes WHERE user_id = ?1", params![user_id])
            .ok();
        conn.execute(
            "INSERT INTO recovery_codes (code_hash, user_id) VALUES (?1, ?2)",
            params![code_hash, user_id],
        )
        .unwrap();
    }

    pub fn recovery_code_valid(&self, user_id: &str, code_hash: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM recovery_codes WHERE user_id = ?1 AND code_hash = ?2 AND used_at IS NULL",
            params![user_id, code_hash],
            |_| Ok(()),
        )
        .is_ok()
    }

    pub fn use_recovery_code(&self, code_hash: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE recovery_codes SET used_at = datetime('now') WHERE code_hash = ?1",
            params![code_hash],
        )
        .ok();
    }

    pub fn delete_user(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM users WHERE id = ?1", params![id])
            .unwrap_or(0)
            > 0
    }

    // -- Sessions --

    /// `method`: how the session was made ('passkey' | 'recovery' | 'code').
    pub fn create_session(&self, token_hash: &str, user_id: &str, ttl_days: i64, method: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at, method)
             VALUES (?1, ?2, datetime('now', ?3 || ' days'), ?4)",
            params![token_hash, user_id, format!("+{ttl_days}"), method],
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

    /// The session's user and how the session was made (None for sessions
    /// from before that was recorded).
    pub fn session_user(&self, token_hash: &str) -> Option<(User, Option<String>)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT u.id, u.username, u.role, u.created_at, u.last_login, u.kind, u.quotas, u.remote_access,
                    s.method
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?1 AND s.expires_at > datetime('now')",
            params![token_hash],
            |row| Ok((Self::user_from_row(row)?, row.get(8)?)),
        )
        .ok()
    }

    pub fn delete_session(&self, token_hash: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE token_hash = ?1", params![token_hash])
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
                "SELECT u.id, u.username, u.role, u.created_at, u.last_login, u.kind, u.quotas, u.remote_access
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
            .prepare("SELECT id, name, machine_profile, nozzle_diameter, protocol, address, serial_number, access_code, status, current_job, area, plate_type, nozzle_priority FROM printers ORDER BY name")
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
                area: row.get(10)?,
                plate_type: row.get(11)?,
                nozzle_priority: row.get(12)?,
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
        area: &str,
        plate_type: &str,
        nozzle_priority: &str,
    ) -> Printer {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO printers (id, name, machine_profile, nozzle_diameter, protocol, address, serial_number, access_code, area, plate_type, nozzle_priority) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![id, name, machine_profile, nozzle_diameter, protocol, address, serial_number, access_code, area, plate_type, nozzle_priority],
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
            area: area.to_string(),
            plate_type: plate_type.to_string(),
            nozzle_priority: nozzle_priority.to_string(),
        }
    }

    pub fn get_printer(&self, id: &str) -> Option<Printer> {
        self.list_printers().into_iter().find(|p| p.id == id)
    }

    /// Change the fields that are `Some`; returns the updated printer.
    #[allow(clippy::too_many_arguments)]
    pub fn update_printer(
        &self,
        id: &str,
        name: Option<&str>,
        machine_profile: Option<&str>,
        nozzle_diameter: Option<&str>,
        protocol: Option<&str>,
        address: Option<&str>,
        serial_number: Option<&str>,
        access_code: Option<&str>,
        area: Option<&str>,
        plate_type: Option<&str>,
        nozzle_priority: Option<&str>,
    ) -> Option<Printer> {
        {
            let conn = self.conn.lock().unwrap();
            let n = conn
                .execute(
                    "UPDATE printers SET
                        name = COALESCE(?2, name),
                        machine_profile = COALESCE(?3, machine_profile),
                        nozzle_diameter = COALESCE(?4, nozzle_diameter),
                        protocol = COALESCE(?5, protocol),
                        address = COALESCE(?6, address),
                        serial_number = COALESCE(?7, serial_number),
                        access_code = COALESCE(?8, access_code),
                        area = COALESCE(?9, area),
                        plate_type = COALESCE(?10, plate_type),
                        nozzle_priority = COALESCE(?11, nozzle_priority)
                     WHERE id = ?1",
                    params![id, name, machine_profile, nozzle_diameter, protocol, address, serial_number, access_code, area, plate_type, nozzle_priority],
                )
                .unwrap();
            if n == 0 {
                return None;
            }
        }
        self.get_printer(id)
    }

    pub fn delete_printer(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        // jobs.printer_id references printers without ON DELETE: untag the
        // printer's jobs first, or the foreign key refuses the delete.
        conn.execute("UPDATE jobs SET printer_id = NULL WHERE printer_id = ?1", params![id])
            .unwrap();
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
                j.created_at, j.updated_at,
                j.user_id, u.username, j.group_id, g.name, j.stored_bytes,
                j.package_path, j.package_json, j.placement_json,
                j.inputs_json, j.proposed_json, j.plate_json, j.nozzle_plan_json,
                (SELECT COUNT(*) FROM job_models m WHERE m.job_id = j.id),
                (SELECT COUNT(*) FROM job_models m WHERE m.job_id = j.id AND m.path = '')
         FROM jobs j
         LEFT JOIN printers p ON j.printer_id = p.id
         LEFT JOIN users u ON j.user_id = u.id
         LEFT JOIN groups g ON j.group_id = g.id";

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
            user_id: row.get(19)?,
            username: row.get(20)?,
            group_id: row.get(21)?,
            group_name: row.get(22)?,
            stored_bytes: row.get(23)?,
            package_path: row.get(24)?,
            package_json: row.get(25)?,
            placement_json: row.get(26)?,
            inputs_json: row.get(27)?,
            proposed_json: row.get(28)?,
            plate_json: row.get(29)?,
            nozzle_plan_json: row.get(30)?,
            model_count: row.get(31)?,
            local_models: row.get(32)?,
        })
    }

    pub fn list_jobs(&self) -> Vec<Job> {
        self.list_jobs_filtered(&JobFilter::default())
    }

    /// Jobs matching `filter`, newest first.
    pub fn list_jobs_filtered(&self, filter: &JobFilter) -> Vec<Job> {
        let (where_sql, args) = filter.sql();
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("{} {where_sql} ORDER BY j.created_at DESC", Self::JOB_SELECT))
            .unwrap();
        stmt.query_map(rusqlite::params_from_iter(args.iter()), Self::job_from_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    /// Usage totals over the jobs matching `filter` (failed and cancelled
    /// jobs don't count). Flow metrics count jobs created at or after
    /// `since` (SQLite datetime text); storage is always the running total.
    pub fn usage(&self, filter: &JobFilter, since: &str) -> Usage {
        let (where_sql, mut args) = filter.sql();
        let joiner = if where_sql.is_empty() { "WHERE" } else { "AND" };
        args.push(since.to_string());
        let n = args.len();
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!(
                "SELECT
                    COALESCE(SUM(CASE WHEN j.created_at >= ?{n} THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN j.created_at >= ?{n} THEN COALESCE(j.filament_used_g, 0) ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN j.created_at >= ?{n} THEN COALESCE(j.print_time_sec, 0) ELSE 0 END), 0),
                    COALESCE(SUM(j.stored_bytes), 0)
                 FROM jobs j {where_sql} {joiner} j.status NOT IN ('failed', 'cancelled')"
            ),
            rusqlite::params_from_iter(args.iter()),
            |r| {
                Ok(Usage {
                    slices: r.get(0)?,
                    filament_g: r.get(1)?,
                    print_sec: r.get(2)?,
                    stored_bytes: r.get(3)?,
                })
            },
        )
        .unwrap_or_default()
    }

    pub fn set_job_group(&self, id: &str, group_id: Option<&str>) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET group_id = ?2, updated_at = datetime('now') WHERE id = ?1",
            params![id, group_id],
        )
        .unwrap_or(0)
            > 0
    }

    pub fn add_job_stored_bytes(&self, id: &str, bytes: i64) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET stored_bytes = stored_bytes + ?2 WHERE id = ?1",
            params![id, bytes],
        )
        .ok();
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
        group_id: Option<&str>,
        model_bytes: i64,
        placement_json: Option<&str>,
    ) -> Job {
        let id = uuid::Uuid::new_v4().to_string();
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO jobs (id, model_name, model_path, printer_id, routing, config_json, overrides_json, source, user_id, group_id, stored_bytes, placement_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![id, model_name, model_path, printer_id, routing, config_json, overrides_json, source, user_id, group_id, model_bytes, placement_json],
            )
            .unwrap();
        }
        self.get_job(&id).expect("job just inserted")
    }

    /// Record one of a job's source models (`path` '' = kept in the browser).
    pub fn add_job_model(&self, job_id: &str, idx: i64, name: &str, path: &str, bytes: i64, sha256: Option<&str>) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO job_models (job_id, idx, name, path, bytes, sha256) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![job_id, idx, name, path, bytes, sha256],
        )
        .unwrap();
    }

    /// A job's source models, in order.
    pub fn job_models(&self, job_id: &str) -> Vec<JobModel> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT idx, name, path, bytes, sha256 FROM job_models WHERE job_id = ?1 ORDER BY idx")
            .unwrap();
        stmt.query_map(params![job_id], |r| {
            Ok(JobModel {
                idx: r.get(0)?,
                name: r.get(1)?,
                path: r.get(2)?,
                bytes: r.get(3)?,
                sha256: r.get(4)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    /// What a job was made from, what was proposed, and its plate layout.
    pub fn set_job_inputs(&self, id: &str, inputs: &str, proposed: Option<&str>, plate: Option<&str>) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET inputs_json = ?2, proposed_json = ?3, plate_json = ?4 WHERE id = ?1",
            params![id, inputs, proposed, plate],
        )
        .ok();
    }

    pub fn set_job_nozzle_plan(&self, id: &str, plan: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE jobs SET nozzle_plan_json = ?2 WHERE id = ?1", params![id, plan]).ok();
    }

    /// Prints of the job that still need its package: waiting for approval
    /// or on their way to (or on) a printer.
    pub fn job_prints_in_progress(&self, job_id: &str) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM prints WHERE job_id = ?1 AND status IN ('pending_approval', {})",
                active_print_sql()
            ),
            params![job_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Delete a job and its slice records. Returns the files it had on disk
    /// (models, G-code, package) for the caller to remove; None = no such
    /// job. Prints and incidents keep their history (`job_id` → NULL).
    pub fn delete_job(&self, id: &str) -> Option<Vec<String>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().ok()?;
        let (model_path, gcode_path, package_path): (String, Option<String>, Option<String>) = tx
            .query_row(
                "SELECT model_path, gcode_path, package_path FROM jobs WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok()?;
        let mut files: Vec<String> = Vec::new();
        {
            let mut stmt = tx.prepare("SELECT path FROM job_models WHERE job_id = ?1").ok()?;
            files.extend(stmt.query_map(params![id], |r| r.get(0)).ok()?.filter_map(|r| r.ok()));
            let mut stmt = tx.prepare("SELECT gcode_path FROM slices WHERE job_id = ?1").ok()?;
            files.extend(stmt.query_map(params![id], |r| r.get(0)).ok()?.filter_map(|r| r.ok()));
        }
        files.push(model_path);
        files.extend(gcode_path);
        files.extend(package_path);
        tx.execute("DELETE FROM slices WHERE job_id = ?1", params![id]).ok()?;
        tx.execute("DELETE FROM jobs WHERE id = ?1", params![id]).ok()?;
        tx.commit().ok()?;
        files.retain(|f| !f.is_empty());
        files.sort();
        files.dedup();
        Some(files)
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

    /// Print time and filament to count for the job (quotas, cost), as the
    /// G-code check settled them.
    pub fn set_job_stats(&self, id: &str, print_time_sec: f64, filament_used_g: f64) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET print_time_sec = ?2, filament_used_g = ?3, updated_at = datetime('now') WHERE id = ?1",
            params![id, print_time_sec, filament_used_g],
        )
        .unwrap();
    }

    /// What jobs of the last `days` days (0 = all) were made from and what
    /// the Slice page proposed for them: (inputs, proposed, overrides).
    pub fn jobs_with_proposals(&self, days: u32) -> Vec<(String, String, Option<String>)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT inputs_json, proposed_json, overrides_json FROM jobs
                 WHERE inputs_json IS NOT NULL AND proposed_json IS NOT NULL
                   AND (?1 = 0 OR created_at >= datetime('now', '-' || ?1 || ' days'))
                 ORDER BY created_at DESC",
            )
            .unwrap();
        stmt.query_map(params![days], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    /// Jobs that have a package (for re-checking their G-code).
    pub fn jobs_with_packages(&self) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM jobs WHERE package_json IS NOT NULL ORDER BY created_at DESC").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn set_job_package(&self, id: &str, package_path: &str, package_json: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET package_path = ?2, package_json = ?3, updated_at = datetime('now') WHERE id = ?1",
            params![id, package_path, package_json],
        )
        .unwrap();
    }

    // -- Printer reports --

    // -- G-code incidents --

    /// Record an incident unless one with the same `dedupe` key exists;
    /// true if it was new.
    pub fn record_gcode_incident(&self, i: &NewIncident<'_>) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO gcode_incidents
                (id, user_id, sent_by, job_id, print_id, job_name, printer_name, source, kind, severity, summary, dedupe)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                uuid::Uuid::new_v4().to_string(),
                i.user_id,
                i.sent_by,
                i.job_id,
                i.print_id,
                i.job_name,
                i.printer_name,
                i.source,
                i.kind,
                i.severity,
                i.summary,
                i.dedupe
            ],
        )
        .unwrap()
            > 0
    }

    /// Newest first; `user_id` narrows to one user's G-code.
    pub fn list_gcode_incidents(&self, user_id: Option<&str>, limit: i64) -> Vec<GcodeIncident> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT i.id, i.created_at, i.user_id, u.username, i.sent_by, s.username, i.job_id, i.print_id,
                        i.job_name, i.printer_name, i.source, i.kind, i.severity, i.summary
                 FROM gcode_incidents i
                 LEFT JOIN users u ON u.id = i.user_id
                 LEFT JOIN users s ON s.id = i.sent_by
                 WHERE ?1 IS NULL OR i.user_id = ?1
                 ORDER BY i.created_at DESC, i.rowid DESC LIMIT ?2",
            )
            .unwrap();
        stmt.query_map(params![user_id, limit], |r| {
            Ok(GcodeIncident {
                id: r.get(0)?,
                created_at: r.get(1)?,
                user_id: r.get(2)?,
                username: r.get(3)?,
                sent_by: r.get(4)?,
                sent_by_username: r.get(5)?,
                job_id: r.get(6)?,
                print_id: r.get(7)?,
                job_name: r.get(8)?,
                printer_name: r.get(9)?,
                source: r.get(10)?,
                kind: r.get(11)?,
                severity: r.get(12)?,
                summary: r.get(13)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    /// Per user: how many incidents, and when the last was.
    pub fn gcode_incident_counts(&self) -> std::collections::HashMap<String, (i64, String)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT user_id, COUNT(*), MAX(created_at) FROM gcode_incidents WHERE user_id IS NOT NULL GROUP BY user_id")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?))))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn create_printer_report(&self, printer: &Printer, user_id: Option<&str>, description: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO printer_reports (id, printer_id, printer_name, user_id, description) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, printer.id, printer.name, user_id, description],
        )
        .unwrap();
        id
    }

    /// Newest first; `open` = unresolved only.
    pub fn list_printer_reports(&self, open: bool) -> Vec<PrinterReport> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT r.id, r.printer_id, r.printer_name, r.user_id, u.username, r.description,
                        r.created_at, r.resolved_at, r.resolved_by
                 FROM printer_reports r LEFT JOIN users u ON r.user_id = u.id
                 WHERE (?1 = 0 OR r.resolved_at IS NULL)
                 ORDER BY r.created_at DESC, r.rowid DESC LIMIT 500",
            )
            .unwrap();
        stmt.query_map(params![open as i64], |row| {
            Ok(PrinterReport {
                id: row.get(0)?,
                printer_id: row.get(1)?,
                printer_name: row.get(2)?,
                user_id: row.get(3)?,
                username: row.get(4)?,
                description: row.get(5)?,
                created_at: row.get(6)?,
                resolved_at: row.get(7)?,
                resolved_by: row.get(8)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn resolve_printer_report(&self, id: &str, by: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE printer_reports SET resolved_at = datetime('now'), resolved_by = ?2 WHERE id = ?1 AND resolved_at IS NULL",
            params![id, by],
        )
        .unwrap()
            > 0
    }

    // -- Prints --

    const PRINT_SELECT: &'static str =
        "SELECT p.id, p.job_id, p.plate, p.printer_id, p.printer_name, p.user_id, u.username,
                p.group_id, p.file_name, p.name, p.ams_mapping, p.status, p.progress, p.error,
                p.created_at, p.started_at, p.finished_at, p.updated_at,
                p.options, p.approval_reason, p.decided_by, p.safety_review,
                p.outcome, p.outcome_by, p.outcome_at, p.outcome_note
         FROM prints p LEFT JOIN users u ON p.user_id = u.id";

    fn print_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PrintRecord> {
        Ok(PrintRecord {
            id: row.get(0)?,
            job_id: row.get(1)?,
            plate: row.get(2)?,
            printer_id: row.get(3)?,
            printer_name: row.get(4)?,
            user_id: row.get(5)?,
            username: row.get(6)?,
            group_id: row.get(7)?,
            file_name: row.get(8)?,
            name: row.get(9)?,
            ams_mapping: row.get(10)?,
            status: row.get(11)?,
            progress: row.get(12)?,
            error: row.get(13)?,
            created_at: row.get(14)?,
            started_at: row.get(15)?,
            finished_at: row.get(16)?,
            updated_at: row.get(17)?,
            options: row.get(18)?,
            approval_reason: row.get(19)?,
            decided_by: row.get(20)?,
            safety_review: row.get(21)?,
            outcome: row.get(22)?,
            outcome_by: row.get(23)?,
            outcome_at: row.get(24)?,
            outcome_note: row.get(25)?,
        })
    }

    /// A new print: `uploading`, or `pending_approval` when
    /// `approval_reason` is given without `decided_by` (an admin who sent it
    /// anyway records both).
    #[allow(clippy::too_many_arguments)]
    pub fn create_print(
        &self,
        id: &str,
        job_id: &str,
        plate: i64,
        printer: &Printer,
        user_id: Option<&str>,
        group_id: Option<&str>,
        file_name: &str,
        name: &str,
        ams_mapping: &str,
        options: &str,
        approval_reason: Option<&str>,
        safety_review: bool,
        decided_by: Option<&str>,
    ) -> PrintRecord {
        let status = if approval_reason.is_some() && decided_by.is_none() { "pending_approval" } else { "uploading" };
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO prints (id, job_id, plate, printer_id, printer_name, user_id, group_id, file_name, name, ams_mapping, options, approval_reason, status, safety_review, decided_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![id, job_id, plate, printer.id, printer.name, user_id, group_id, file_name, name, ams_mapping, options, approval_reason, status, safety_review, decided_by],
            )
            .unwrap();
        }
        self.get_print(id).expect("print just inserted")
    }

    /// Decide a pending print: approved → `uploading`, else `rejected`
    /// (with `note`). False if it wasn't pending.
    pub fn decide_print(&self, id: &str, approve: bool, by: &str, note: Option<&str>) -> bool {
        let conn = self.conn.lock().unwrap();
        let (status, finished) = if approve { ("uploading", false) } else { ("rejected", true) };
        conn.execute(
            "UPDATE prints SET status = ?2, decided_by = ?3, error = COALESCE(?4, error),
                    finished_at = CASE WHEN ?5 THEN datetime('now') ELSE finished_at END,
                    updated_at = datetime('now')
             WHERE id = ?1 AND status = 'pending_approval'",
            params![id, status, by, note, finished],
        )
        .unwrap()
            > 0
    }

    /// Prints waiting for approval, oldest first.
    pub fn pending_prints(&self) -> Vec<PrintRecord> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("{} WHERE p.status = 'pending_approval' ORDER BY p.created_at, p.rowid", Self::PRINT_SELECT))
            .unwrap();
        stmt.query_map([], Self::print_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn get_print(&self, id: &str) -> Option<PrintRecord> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("{} WHERE p.id = ?1", Self::PRINT_SELECT), params![id], Self::print_from_row)
            .ok()
    }

    /// Finished prints nobody has said the outcome of, oldest first.
    pub fn unchecked_prints(&self, limit: i64) -> Vec<PrintRecord> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "{} WHERE p.status = 'finished' AND p.outcome IS NULL ORDER BY p.finished_at, p.rowid LIMIT ?1",
                Self::PRINT_SELECT
            ))
            .unwrap();
        stmt.query_map(params![limit], Self::print_from_row).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// Newest first. `printer_id` narrows to one printer, `active` to prints
    /// still using their printer.
    pub fn list_prints(&self, printer_id: Option<&str>, active: bool, limit: i64) -> Vec<PrintRecord> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "{} WHERE (?1 IS NULL OR p.printer_id = ?1) AND (?2 = 0 OR p.status IN ({}))
             ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?3",
            Self::PRINT_SELECT,
            active_print_sql()
        );
        let mut stmt = conn.prepare(&sql).unwrap();
        stmt.query_map(params![printer_id, active as i64, limit], Self::print_from_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    /// Move an active print to `status`; final statuses are never left.
    /// Stamps started_at on the first `printing`/`paused` and finished_at on
    /// a final status. Returns whether the print changed.
    pub fn update_print(&self, id: &str, status: &str, progress: Option<i64>, error: Option<&str>) -> bool {
        let finished = !ACTIVE_PRINT_STATUSES.contains(&status);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            &format!(
                "UPDATE prints SET status = ?2,
                    progress = COALESCE(?3, progress),
                    error = COALESCE(?4, error),
                    started_at = CASE WHEN ?2 IN ('printing', 'paused') AND started_at IS NULL
                                      THEN datetime('now') ELSE started_at END,
                    finished_at = CASE WHEN ?5 THEN datetime('now') ELSE finished_at END,
                    updated_at = datetime('now')
                 WHERE id = ?1 AND status IN ({})
                   AND (status != ?2 OR progress != COALESCE(?3, progress) OR ?4 IS NOT NULL)",
                active_print_sql()
            ),
            params![id, status, progress, error, finished],
        )
        .unwrap()
            > 0
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

    const SLICE_SELECT: &'static str =
        "SELECT s.id, s.job_id, s.model_name, s.gcode_path, s.print_time_sec, s.filament_used_g,
                s.file_size, s.created_at, j.user_id, u.username, j.group_id, g.name,
                EXISTS (SELECT 1 FROM job_models m WHERE m.job_id = j.id AND m.path != '')
         FROM slices s
         JOIN jobs j ON j.id = s.job_id
         LEFT JOIN users u ON j.user_id = u.id
         LEFT JOIN groups g ON j.group_id = g.id";

    fn slice_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SliceRecord> {
        Ok(SliceRecord {
            id: row.get(0)?,
            job_id: row.get(1)?,
            model_name: row.get(2)?,
            gcode_path: row.get(3)?,
            print_time_sec: row.get(4)?,
            filament_used_g: row.get(5)?,
            file_size: row.get(6)?,
            created_at: row.get(7)?,
            user_id: row.get(8)?,
            username: row.get(9)?,
            group_id: row.get(10)?,
            group_name: row.get(11)?,
            has_model: row.get(12)?,
        })
    }

    /// Slices of the jobs matching `filter`, newest first.
    pub fn list_slices_filtered(&self, filter: &JobFilter) -> Vec<SliceRecord> {
        let (where_sql, args) = filter.sql();
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("{} {where_sql} ORDER BY s.created_at DESC", Self::SLICE_SELECT))
            .unwrap();
        stmt.query_map(rusqlite::params_from_iter(args.iter()), Self::slice_from_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn get_slice(&self, id: &str) -> Option<SliceRecord> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("{} WHERE s.id = ?1", Self::SLICE_SELECT),
            params![id],
            Self::slice_from_row,
        )
        .ok()
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
            user_id: None,
            username: None,
            group_id: None,
            group_name: None,
            has_model: false,
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

// ---- Job filters and usage --------------------------------------------------

/// Which jobs a query covers. Empty filter = every job.
#[derive(Debug, Default, Clone)]
pub struct JobFilter {
    /// Visibility: jobs created by this user, or charged to one of these
    /// groups. None = no visibility restriction (admins).
    pub visible_to: Option<(String, Vec<String>)>,
    /// Only jobs created by this user.
    pub user_id: Option<String>,
    /// Only jobs charged to one of these groups.
    pub group_ids: Option<Vec<String>>,
}

impl JobFilter {
    fn sql(&self) -> (String, Vec<String>) {
        fn placeholders(args: &mut Vec<String>, values: &[String]) -> String {
            values
                .iter()
                .map(|v| {
                    args.push(v.clone());
                    format!("?{}", args.len())
                })
                .collect::<Vec<_>>()
                .join(", ")
        }
        let mut clauses: Vec<String> = Vec::new();
        let mut args: Vec<String> = Vec::new();
        if let Some((user_id, groups)) = &self.visible_to {
            args.push(user_id.clone());
            let mine = format!("j.user_id = ?{}", args.len());
            if groups.is_empty() {
                clauses.push(mine);
            } else {
                let list = placeholders(&mut args, groups);
                clauses.push(format!("({mine} OR j.group_id IN ({list}))"));
            }
        }
        if let Some(user_id) = &self.user_id {
            args.push(user_id.clone());
            clauses.push(format!("j.user_id = ?{}", args.len()));
        }
        if let Some(groups) = &self.group_ids {
            if groups.is_empty() {
                clauses.push("0".into());
            } else {
                let list = placeholders(&mut args, groups);
                clauses.push(format!("j.group_id IN ({list})"));
            }
        }
        if clauses.is_empty() {
            (String::new(), args)
        } else {
            (format!("WHERE {}", clauses.join(" AND ")), args)
        }
    }
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct Usage {
    pub slices: i64,
    pub filament_g: f64,
    pub print_sec: f64,
    pub stored_bytes: i64,
}

// ---- Groups -------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Group {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub description: String,
    /// JSON object, see `groups::GroupSettings`.
    pub settings: String,
    /// JSON object, see `quota::GroupQuotas`.
    pub quotas: String,
    /// Identifier this group was self-created under (e.g. a team number).
    pub self_key: Option<String>,
    pub created_by: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Membership {
    pub group_id: String,
    pub user_id: String,
    pub username: String,
    pub user_kind: String,
    /// "member" | "manager"
    pub role: String,
    /// "active" | "pending" (waiting for a manager's approval)
    pub status: String,
    /// Per-member quota override (JSON array), None = the group's default.
    pub quotas: Option<String>,
    pub joined_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JoinLink {
    pub id: String,
    pub group_id: String,
    pub code: String,
    pub public: bool,
    pub bypass_approval: bool,
    pub label: String,
    pub max_uses: Option<i64>,
    pub uses: i64,
    pub expires_at: Option<String>,
    pub disabled: bool,
    pub created_by: Option<String>,
    pub created_at: String,
}

const GROUP_COLS: &str =
    "id, parent_id, name, description, settings, quotas, self_key, created_by, created_at";

const MEMBER_SELECT: &str = "SELECT m.group_id, m.user_id, u.username, u.kind, m.role, m.status, m.quotas, m.joined_at
     FROM group_members m JOIN users u ON u.id = m.user_id";

const LINK_COLS: &str = "id, group_id, code, public, bypass_approval, label, max_uses, uses, expires_at, disabled, created_by, created_at";

impl Db {
    fn group_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Group> {
        Ok(Group {
            id: row.get(0)?,
            parent_id: row.get(1)?,
            name: row.get(2)?,
            description: row.get(3)?,
            settings: row.get(4)?,
            quotas: row.get(5)?,
            self_key: row.get(6)?,
            created_by: row.get(7)?,
            created_at: row.get(8)?,
        })
    }

    fn membership_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Membership> {
        Ok(Membership {
            group_id: row.get(0)?,
            user_id: row.get(1)?,
            username: row.get(2)?,
            user_kind: row.get(3)?,
            role: row.get(4)?,
            status: row.get(5)?,
            quotas: row.get(6)?,
            joined_at: row.get(7)?,
        })
    }

    fn link_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<JoinLink> {
        Ok(JoinLink {
            id: row.get(0)?,
            group_id: row.get(1)?,
            code: row.get(2)?,
            public: row.get::<_, i64>(3)? != 0,
            bypass_approval: row.get::<_, i64>(4)? != 0,
            label: row.get(5)?,
            max_uses: row.get(6)?,
            uses: row.get(7)?,
            expires_at: row.get(8)?,
            disabled: row.get::<_, i64>(9)? != 0,
            created_by: row.get(10)?,
            created_at: row.get(11)?,
        })
    }

    pub fn list_groups(&self) -> Vec<Group> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("SELECT {GROUP_COLS} FROM groups ORDER BY name COLLATE NOCASE"))
            .unwrap();
        stmt.query_map([], Self::group_from_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn get_group(&self, id: &str) -> Option<Group> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {GROUP_COLS} FROM groups WHERE id = ?1"),
            params![id],
            Self::group_from_row,
        )
        .ok()
    }

    /// The child of `parent_id` created under `self_key`, if any.
    pub fn child_group_by_key(&self, parent_id: &str, self_key: &str) -> Option<Group> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {GROUP_COLS} FROM groups WHERE parent_id = ?1 AND self_key = ?2"),
            params![parent_id, self_key],
            Self::group_from_row,
        )
        .ok()
    }

    pub fn create_group(
        &self,
        parent_id: Option<&str>,
        name: &str,
        description: &str,
        settings: &str,
        self_key: Option<&str>,
        created_by: Option<&str>,
    ) -> Result<Group, String> {
        let id = uuid::Uuid::new_v4().to_string();
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO groups (id, parent_id, name, description, settings, self_key, created_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, parent_id, name.trim(), description.trim(), settings, self_key, created_by],
            )
            .map_err(|e| e.to_string())?;
        }
        self.get_group(&id).ok_or_else(|| "group vanished".to_string())
    }

    pub fn update_group(
        &self,
        id: &str,
        parent_id: Option<&str>,
        name: &str,
        description: &str,
        settings: &str,
        quotas: &str,
    ) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE groups SET parent_id = ?2, name = ?3, description = ?4, settings = ?5, quotas = ?6
             WHERE id = ?1",
            params![id, parent_id, name.trim(), description.trim(), settings, quotas],
        )
        .unwrap_or(0)
            > 0
    }

    /// Fails while the group has subgroups (ON DELETE RESTRICT). Its jobs
    /// become personal jobs of their creators.
    pub fn delete_group(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM groups WHERE id = ?1", params![id])
            .map(|n| n > 0)
            .map_err(|e| e.to_string())
    }

    // -- Members --

    pub fn memberships_of_user(&self, user_id: &str) -> Vec<Membership> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("{MEMBER_SELECT} WHERE m.user_id = ?1"))
            .unwrap();
        stmt.query_map(params![user_id], Self::membership_from_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn group_members(&self, group_id: &str) -> Vec<Membership> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "{MEMBER_SELECT} WHERE m.group_id = ?1 ORDER BY m.status DESC, u.username COLLATE NOCASE"
            ))
            .unwrap();
        stmt.query_map(params![group_id], Self::membership_from_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn get_membership(&self, group_id: &str, user_id: &str) -> Option<Membership> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("{MEMBER_SELECT} WHERE m.group_id = ?1 AND m.user_id = ?2"),
            params![group_id, user_id],
            Self::membership_from_row,
        )
        .ok()
    }

    /// Active member counts per group.
    pub fn member_counts(&self) -> std::collections::HashMap<String, i64> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT group_id, COUNT(*) FROM group_members WHERE status = 'active' GROUP BY group_id")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    /// Add a member, or update role/status of an existing one.
    pub fn upsert_membership(&self, group_id: &str, user_id: &str, role: &str, status: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO group_members (group_id, user_id, role, status) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (group_id, user_id) DO UPDATE SET role = excluded.role, status = excluded.status",
            params![group_id, user_id, role, status],
        )
        .unwrap();
    }

    pub fn set_membership_quotas(&self, group_id: &str, user_id: &str, quotas: Option<&str>) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE group_members SET quotas = ?3 WHERE group_id = ?1 AND user_id = ?2",
            params![group_id, user_id, quotas],
        )
        .unwrap_or(0)
            > 0
    }

    pub fn delete_membership(&self, group_id: &str, user_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM group_members WHERE group_id = ?1 AND user_id = ?2",
            params![group_id, user_id],
        )
        .unwrap_or(0)
            > 0
    }

    // -- Join links --

    pub fn list_join_links(&self, group_id: &str) -> Vec<JoinLink> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("SELECT {LINK_COLS} FROM join_links WHERE group_id = ?1 ORDER BY created_at"))
            .unwrap();
        stmt.query_map(params![group_id], Self::link_from_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn get_join_link(&self, id: &str) -> Option<JoinLink> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {LINK_COLS} FROM join_links WHERE id = ?1"),
            params![id],
            Self::link_from_row,
        )
        .ok()
    }

    /// A usable link: not disabled, not expired, uses left.
    pub fn live_join_link_by_code(&self, code: &str) -> Option<JoinLink> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!(
                "SELECT {LINK_COLS} FROM join_links
                 WHERE code = ?1 AND disabled = 0
                   AND (expires_at IS NULL OR expires_at > datetime('now'))
                   AND (max_uses IS NULL OR uses < max_uses)"
            ),
            params![code.trim()],
            Self::link_from_row,
        )
        .ok()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_join_link(
        &self,
        group_id: &str,
        code: &str,
        public: bool,
        bypass_approval: bool,
        label: &str,
        max_uses: Option<i64>,
        expires_hours: Option<i64>,
        created_by: &str,
    ) -> Result<JoinLink, String> {
        let id = uuid::Uuid::new_v4().to_string();
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO join_links (id, group_id, code, public, bypass_approval, label, max_uses, expires_at, created_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
                         CASE WHEN ?8 IS NULL THEN NULL ELSE datetime('now', '+' || ?8 || ' hours') END, ?9)",
                params![id, group_id, code, public as i64, bypass_approval as i64, label.trim(), max_uses, expires_hours, created_by],
            )
            .map_err(|e| {
                if e.to_string().contains("UNIQUE") {
                    "that link code is taken".to_string()
                } else {
                    e.to_string()
                }
            })?;
        }
        self.get_join_link(&id).ok_or_else(|| "link vanished".to_string())
    }

    pub fn set_join_link_disabled(&self, id: &str, disabled: bool) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE join_links SET disabled = ?2 WHERE id = ?1",
            params![id, disabled as i64],
        )
        .unwrap_or(0)
            > 0
    }

    pub fn delete_join_link(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM join_links WHERE id = ?1", params![id])
            .unwrap_or(0)
            > 0
    }

    pub fn count_join_link_use(&self, id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE join_links SET uses = uses + 1 WHERE id = ?1", params![id])
            .ok();
    }

    // -- Site settings --

    pub fn get_setting(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
            .ok()
    }

    pub fn set_setting(&self, key: &str, value: Option<&str>) {
        let conn = self.conn.lock().unwrap();
        match value {
            Some(v) => conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, v],
            ),
            None => conn.execute("DELETE FROM settings WHERE key = ?1", params![key]),
        }
        .ok();
    }

    // -- Account kind and per-user quotas --

    pub fn set_user_kind(&self, id: &str, kind: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE users SET kind = ?2 WHERE id = ?1", params![id, kind])
            .ok();
    }

    pub fn set_user_quotas(&self, id: &str, quotas: Option<&str>) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE users SET quotas = ?2 WHERE id = ?1", params![id, quotas])
            .unwrap_or(0)
            > 0
    }

    pub fn set_user_remote_access(&self, id: &str, allowed: bool) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE users SET remote_access = ?2 WHERE id = ?1", params![id, allowed])
            .unwrap_or(0)
            > 0
    }
}
