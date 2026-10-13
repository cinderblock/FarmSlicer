//! The picture of what a printer is printing (or just printed).
//!
//! Prints sent from FarmSlicer use their job's package. Prints started
//! elsewhere (Bambu Studio, the printer's screen, the cloud) are fetched from
//! the printer: the project file is on its storage under the job's name, in
//! `/cache/` (cloud and SD prints) or `/` (LAN uploads), and its plate PNG is
//! taken out of it. Found pictures are cached for half an hour, misses for a
//! minute, and fetches are one at a time per printer.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use bytes::Bytes;
use serde_json::json;

use crate::bambu::ftps;
use crate::package::{self, Image};
use crate::printer::{Protocol, protocol_of};
use crate::printing;
use crate::server::AppState;

const HIT_TTL: Duration = Duration::from_secs(30 * 60);
const MISS_TTL: Duration = Duration::from_secs(60);
/// Projects bigger than this aren't downloaded for their picture.
const MAX_PROJECT: usize = 128 << 20;

#[derive(Default)]
pub struct PrinterThumbs {
    cache: Mutex<HashMap<(String, String), (Option<Bytes>, Instant)>>,
    /// One fetch at a time per printer.
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl PrinterThumbs {
    fn cached(&self, key: &(String, String)) -> Option<Option<Bytes>> {
        let cache = self.cache.lock().unwrap();
        let (png, at) = cache.get(key)?;
        let ttl = if png.is_some() { HIT_TTL } else { MISS_TTL };
        (at.elapsed() < ttl).then(|| png.clone())
    }

    fn store(&self, key: (String, String), png: Option<Bytes>) {
        let mut cache = self.cache.lock().unwrap();
        cache.retain(|_, (_, at)| at.elapsed() < HIT_TTL);
        cache.insert(key, (png, Instant::now()));
    }

    fn lock_for(&self, printer_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.locks.lock().unwrap().entry(printer_id.to_string()).or_default().clone()
    }
}

/// `plate_N` from a reported gcode_file (`/data/Metadata/plate_2.gcode`).
fn plate_index(gcode_file: Option<&str>) -> u32 {
    gcode_file
        .and_then(|f| f.rsplit('/').next())
        .and_then(|f| f.strip_prefix("plate_"))
        .and_then(|f| f.strip_suffix(".gcode"))
        .and_then(|n| n.parse().ok())
        .unwrap_or(1)
}

/// Where a project called `job` may be on the printer.
fn candidates(job: &str) -> Vec<String> {
    let names = if job.ends_with(".3mf") {
        vec![job.to_string()]
    } else {
        vec![format!("{job}.gcode.3mf"), format!("{job}.3mf")]
    };
    ["/cache/", "/"]
        .iter()
        .flat_map(|dir| names.iter().map(move |n| format!("{dir}{n}")))
        .collect()
}

async fn fetch_from_printer(host: &str, code: &str, job: &str, plate: u32) -> Result<Option<Bytes>, String> {
    let mut session = ftps::Session::open(host, ftps::FTPS_PORT, code).await.map_err(|e| e.to_string())?;
    let mut found = None;
    for path in candidates(job) {
        match session.retrieve(&path, MAX_PROJECT).await {
            Ok(Some(bytes)) => {
                found = package::bambu::thumbnail_from_bytes(&bytes, plate).map(Bytes::from);
                if found.is_some() {
                    break;
                }
            }
            Ok(None) => {}
            Err(e) => {
                session.quit().await;
                return Err(e.to_string());
            }
        }
    }
    session.quit().await;
    Ok(found)
}

fn image(img: Image) -> Response {
    ([(header::CONTENT_TYPE, img.content_type), (header::CACHE_CONTROL, "private, max-age=60")], img.bytes).into_response()
}

fn png(bytes: Bytes) -> Response {
    ([(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "private, max-age=60")], bytes).into_response()
}

fn none() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"error": "no picture"}))).into_response()
}

/// `GET /api/printers/{id}/thumbnail`: the current (or last) job's plate.
async fn printer_thumbnail(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let Some(printer) = state.db.get_printer(&id) else { return none() };
    let Some(status) = state.printers.status(&id) else { return none() };
    let Some(job_name) = status.job_key.clone() else { return none() };
    let plate = plate_index(status.job_file.as_deref());

    // One of ours? Its package has the picture.
    for print in state.db.list_prints(Some(&id), false, 20) {
        if printing::task_name(&print) == job_name {
            let picture = print.job_id.as_deref().and_then(|j| state.db.get_job(j)).and_then(|job| {
                let format = printing::package_of(&job)?.format;
                package::thumbnail(std::path::Path::new(job.package_path.as_deref()?), format, print.plate as u32)
            });
            return picture.map(image).unwrap_or_else(none);
        }
    }

    // From the printer.
    if protocol_of(&printer) != Some(Protocol::Bambu) {
        return none();
    }
    let key = (id.clone(), job_name.clone());
    if let Some(hit) = state.printer_thumbs.cached(&key) {
        return hit.map(png).unwrap_or_else(none);
    }
    let lock = state.printer_thumbs.lock_for(&id);
    let _guard = lock.lock().await;
    if let Some(hit) = state.printer_thumbs.cached(&key) {
        return hit.map(png).unwrap_or_else(none);
    }
    let result = fetch_from_printer(printer.address.trim(), printer.access_code.trim(), &job_name, plate).await;
    let picture = match result {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Printer {}: can't fetch the picture of {job_name}: {e}", printer.name);
            None
        }
    };
    state.printer_thumbs.store(key, picture.clone());
    picture.map(png).unwrap_or_else(none)
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/api/printers/{id}/thumbnail", get(printer_thumbnail))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plate_from_gcode_file() {
        assert_eq!(plate_index(Some("/data/Metadata/plate_3.gcode")), 3);
        assert_eq!(plate_index(Some("weird")), 1);
        assert_eq!(plate_index(None), 1);
    }

    #[test]
    fn where_projects_live() {
        assert_eq!(
            candidates("Rail Section"),
            vec![
                "/cache/Rail Section.gcode.3mf",
                "/cache/Rail Section.3mf",
                "/Rail Section.gcode.3mf",
                "/Rail Section.3mf"
            ]
        );
        assert_eq!(candidates("x.gcode.3mf"), vec!["/cache/x.gcode.3mf", "/x.gcode.3mf"]);
    }
}
