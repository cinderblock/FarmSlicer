//! FarmSlicer as a print host for desktop slicers: the two calls of
//! OctoPrint's API that OrcaSlicer, PrusaSlicer and SuperSlicer make when a
//! printer's print host is "OctoPrint", under `/api/octoprint/`. The slicer's
//! host URL is `https://<farm>/api/octoprint` and its API key a FarmSlicer
//! API key (sent as `X-Api-Key`, which `auth` accepts like a bearer token).
//!
//! - `GET  /api/octoprint/api/version`: the connection test. Slicers want
//!   `api`, and `text` starting with "OctoPrint". OrcaSlicer asks before
//!   every upload too.
//! - `POST /api/octoprint/api/files/local`: multipart `file`, `print`
//!   ("true" for "Upload and print"), `path` (the dialog's folder, unused),
//!   `plateindex` (OrcaSlicer, 1-based, with "Use 3MF instead of G-code").
//!   The file becomes a job as `POST /api/uploads` makes one
//!   (`prints_api::store_upload`); with `print`, its plate also goes into
//!   the print queue: the queue and the printers' send modes decide where
//!   and when it prints, not the slicer.
//!
//! Slicers show an error as `HTTP <status>: <body>`, so errors here are
//! plain text. Plan: `plans/slicer-upload-and-mcp.md`.

use std::sync::Arc;

use axum::extract::{Multipart, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde_json::{Value, json};

use crate::auth::{self, CurrentUser};
use crate::queue_api::{Placement, enqueue};
use crate::server::AppState;

/// The OctoPrint version we answer as: a recent one, so slicers don't
/// fall back to anything older.
const OCTOPRINT_VERSION: &str = "1.11.0";

fn text_err(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], msg.into()).into_response()
}

/// The API's JSON errors, as the plain text slicers show.
fn plain((code, Json(body)): (StatusCode, Json<Value>)) -> Response {
    let msg = body["error"].as_str().map(str::to_string).unwrap_or_else(|| body.to_string());
    text_err(code, msg)
}

/// `GET /api/octoprint/api/version`.
async fn version() -> Json<Value> {
    Json(json!({
        "api": "0.1",
        "server": OCTOPRINT_VERSION,
        "text": format!("OctoPrint {OCTOPRINT_VERSION} (FarmSlicer {})", env!("CARGO_PKG_VERSION")),
    }))
}

/// "true"/"false" form values as OctoPrint reads them.
fn truthy(v: &str) -> bool {
    matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "yes" | "1" | "on")
}

/// Which plates "Upload and print" queues: the one OrcaSlicer names when
/// the package has it, the only one when there is one, else every plate.
fn plates_to_queue(available: &[u32], named: Option<u32>) -> Vec<i64> {
    match named {
        Some(n) if available.contains(&n) => vec![n as i64],
        _ if available.len() == 1 => vec![available[0] as i64],
        _ => available.iter().map(|n| *n as i64).collect(),
    }
}

/// `POST /api/octoprint/api/files/local`.
async fn upload(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(auth::KeyScope(scope)): Extension<auth::KeyScope>,
    mut multipart: Multipart,
) -> Response {
    let mut file: Option<(String, axum::body::Bytes)> = None;
    let mut print = false;
    let mut plate_index: Option<u32> = None;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => return text_err(StatusCode::BAD_REQUEST, e.to_string()),
        };
        match field.name().unwrap_or("") {
            "file" => {
                let name = field.file_name().unwrap_or("upload.gcode").to_string();
                match field.bytes().await {
                    Ok(data) => file = Some((name, data)),
                    Err(e) => return text_err(StatusCode::BAD_REQUEST, e.to_string()),
                }
            }
            "print" => print = truthy(&field.text().await.unwrap_or_default()),
            "plateindex" => plate_index = field.text().await.ok().and_then(|v| v.trim().parse().ok()),
            _ => {}
        }
    }
    let Some((name, data)) = file else {
        return text_err(StatusCode::BAD_REQUEST, "no file");
    };
    // The folder from the slicer's dialog would be a path inside the name.
    let name = name.rsplit(['/', '\\']).next().unwrap_or(&name).to_string();
    if print && scope.is_some() {
        return text_err(
            StatusCode::FORBIDDEN,
            "an integration key can upload but not queue prints: use Upload, not Upload and print",
        );
    }

    let job = match crate::prints_api::store_upload(&state, &user, scope.as_ref(), &name, data, None).await {
        Ok(job) => job,
        Err(e) => return plain(e),
    };
    let mut queued = Vec::new();
    if print {
        let Some(pkg) = crate::printing::package_of(&job) else {
            return text_err(StatusCode::INTERNAL_SERVER_ERROR, "the upload has nothing printable");
        };
        let available: Vec<u32> = pkg.plates.iter().map(|p| p.index).collect();
        let plates = plates_to_queue(&available, plate_index);
        queued = enqueue(&state, &user, &job, &plates, 1, &Placement::default())
            .into_iter()
            .map(|e| json!({"id": e.id, "plate": e.plate}))
            .collect();
    }
    let resource = format!("/api/jobs/{}", job.id);
    (
        StatusCode::CREATED,
        [(header::LOCATION, resource.clone())],
        Json(json!({
            "files": {"local": {
                "name": name,
                "path": name,
                "origin": "local",
                "refs": {"resource": resource},
            }},
            "done": true,
            "effectiveSelect": print,
            "effectivePrint": print,
            "farmslicer": {"job_id": job.id, "job": format!("/jobs/{}", job.id), "queued": queued},
        })),
    )
        .into_response()
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/octoprint/api/version", get(version))
        .route("/api/octoprint/api/files/local", post(upload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_and_print_queues_the_named_plate() {
        assert_eq!(plates_to_queue(&[1, 2, 3], Some(2)), vec![2]);
        assert_eq!(plates_to_queue(&[1, 2], None), vec![1, 2], "no plate named: every plate");
        assert_eq!(plates_to_queue(&[1, 2], Some(5)), vec![1, 2], "a plate it doesn't have: every plate");
        assert_eq!(plates_to_queue(&[3], Some(1)), vec![3], "a one-plate export keeps its own number");
        assert!(truthy("true") && truthy(" True ") && !truthy("false") && !truthy(""));
    }
}
