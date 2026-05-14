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
        for col in &["config_json", "overrides_json"] {
            if conn.prepare(&format!("SELECT {col} FROM jobs LIMIT 0")).is_err() {
                conn.execute_batch(
                    &format!("ALTER TABLE jobs ADD COLUMN {col} TEXT;")
                ).ok();
            }
        }

        Db { conn: Mutex::new(conn) }
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

    pub fn list_jobs(&self) -> Vec<Job> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT j.id, j.model_name, j.model_path, j.status, j.progress,
                        j.printer_id, p.name, j.routing, j.gcode_path,
                        j.print_time_sec, j.filament_used_g, j.error,
                        j.config_json, j.overrides_json,
                        j.created_at, j.updated_at
                 FROM jobs j LEFT JOIN printers p ON j.printer_id = p.id
                 ORDER BY j.created_at DESC",
            )
            .unwrap();
        stmt.query_map([], |row| {
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
                created_at: row.get(14)?,
                updated_at: row.get(15)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn create_job(
        &self,
        model_name: &str,
        model_path: &str,
        printer_id: Option<&str>,
        routing: &str,
        config_json: Option<&str>,
        overrides_json: Option<&str>,
    ) -> Job {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO jobs (id, model_name, model_path, printer_id, routing, config_json, overrides_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, model_name, model_path, printer_id, routing, config_json, overrides_json],
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

    pub fn complete_job(
        &self,
        id: &str,
        gcode_path: &str,
        print_time_sec: f64,
        filament_used_g: f64,
    ) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET status = 'done', progress = 100, gcode_path = ?2,
             print_time_sec = ?3, filament_used_g = ?4, updated_at = datetime('now')
             WHERE id = ?1",
            params![id, gcode_path, print_time_sec, filament_used_g],
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
}
