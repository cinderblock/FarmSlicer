//! The G-code behind a job's preview (web/src/components/preview/):
//! `GET /api/jobs/{id}/gcode?plate=N`.
//!
//! Whoever can see the job gets its G-code: the plain file when the job has
//! one, otherwise plate N of its `.gcode.3mf` (checked by
//! src/package/zipcheck.rs first, like everything else that reads a
//! package). Files run to hundreds of MB, so nothing is loaded whole: a
//! blocking task reads the file and feeds the response through a small
//! channel, at the pace the client reads.
//!
//! Compression (G-code shrinks 3-5x): a plate in a package is already
//! deflated, and a gzip stream is a deflate stream with a 10-byte header and
//! a trailer holding the CRC-32 and size, both of which the zip directory
//! records. So a client that accepts gzip gets the plate's compressed bytes
//! as they are in the archive, at no CPU cost. Plain files (and stored
//! entries) are gzipped on the fly at the fastest level. `X-Gcode-Bytes`
//! carries the uncompressed size either way, for progress bars.

use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::auth::CurrentUser;
use crate::db::Job;
use crate::package::{self, PackageFormat, bambu, zipcheck};
use crate::printing;
use crate::prints_api::visible_job;
use crate::server::AppState;

type ApiError = (StatusCode, Json<Value>);

fn api_err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/api/jobs/{id}/gcode", get(job_gcode))
}

/// Bytes per message on the way to the client.
const CHUNK: usize = 256 * 1024;
/// Messages buffered between the reading task and the response.
const QUEUE: usize = 8;

#[derive(Deserialize)]
struct GcodeQuery {
    plate: Option<u32>,
}

/// Where a job's G-code is.
#[derive(Debug, PartialEq)]
enum Source {
    /// A plain G-code file.
    File(PathBuf),
    /// Plate N's G-code inside a `.gcode.3mf`.
    Plate(PathBuf, u32),
}

/// The file holding the G-code of `plate` (default: the first) of a job.
fn source_of(job: &Job, plate: Option<u32>) -> Result<Source, ApiError> {
    let not_found = |msg: &str| api_err(StatusCode::NOT_FOUND, msg);
    // Plain G-code next to (or instead of) the package. Uploaded packages
    // are the job's "G-code" too, so look at what the file is.
    let plain = job
        .gcode_path
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| p.is_file() && package::sniff(p) == Ok(PackageFormat::Gcode));
    let pkg = printing::package_of(job).filter(|p| p.format == PackageFormat::Bambu3mf && !p.plates.is_empty());
    let project = job.package_path.as_deref().map(PathBuf::from).filter(|p| p.is_file());

    match (pkg, project) {
        (Some(pkg), Some(project)) => {
            let first = pkg.plates[0].index;
            let index = plate.unwrap_or(first);
            if pkg.plate(index).is_none() {
                return Err(not_found(&format!("this job has no plate {index}")));
            }
            // A single-plate slice keeps the same G-code as a plain file.
            match plain {
                Some(file) if pkg.plates.len() == 1 => Ok(Source::File(file)),
                _ => Ok(Source::Plate(project, index)),
            }
        }
        _ => match (plain, plate) {
            (Some(file), None | Some(1)) => Ok(Source::File(file)),
            (Some(_), Some(n)) => Err(not_found(&format!("this job has no plate {n}"))),
            (None, _) if matches!(job.status.as_str(), "queued" | "slicing") => {
                Err(not_found("this job has no G-code yet"))
            }
            (None, _) => Err(not_found("this job has no G-code")),
        },
    }
}

/// Does the request accept a gzip-encoded response?
fn accepts_gzip(headers: &HeaderMap) -> bool {
    let Some(value) = headers.get(header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    value.split(',').any(|item| {
        let mut parts = item.split(';').map(str::trim);
        let coding = parts.next().unwrap_or("");
        let refused = parts.any(|p| {
            p.strip_prefix("q=").and_then(|q| q.parse::<f32>().ok()).is_some_and(|q| q <= 0.0)
        });
        (coding.eq_ignore_ascii_case("gzip") || coding == "*") && !refused
    })
}

/// What the response carries, known before the first byte is sent.
struct Meta {
    /// Uncompressed size of the G-code.
    size: u64,
    gzip: bool,
    /// Bytes on the wire, when known up front.
    length: Option<u64>,
}

type Chunks = mpsc::Sender<Result<Bytes, std::io::Error>>;

/// `Write` into the response channel, in `CHUNK`-sized messages. Fails once
/// the client has gone, which stops the reading task.
struct ChannelWriter {
    tx: Chunks,
    buf: Vec<u8>,
}

impl ChannelWriter {
    fn new(tx: Chunks) -> Self {
        Self { tx, buf: Vec::with_capacity(CHUNK) }
    }

    fn send(&mut self) -> std::io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let chunk = Bytes::from(std::mem::replace(&mut self.buf, Vec::with_capacity(CHUNK)));
        self.tx
            .blocking_send(Ok(chunk))
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "the client went away"))
    }
}

impl Write for ChannelWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let n = data.len().min(CHUNK - self.buf.len());
        self.buf.extend_from_slice(&data[..n]);
        if self.buf.len() == CHUNK {
            self.send()?;
        }
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.send()
    }
}

/// The fixed gzip member header: deflate, no flags, no time, unknown OS.
const GZIP_HEADER: [u8; 10] = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255];

/// Copy `from` to the client, gzipping it on the way when asked to.
fn pump(from: &mut impl Read, gzip: bool, out: ChannelWriter) -> std::io::Result<()> {
    if gzip {
        let mut encoder = flate2::write::GzEncoder::new(out, flate2::Compression::fast());
        std::io::copy(from, &mut encoder)?;
        encoder.finish()?.flush()
    } else {
        let mut out = out;
        std::io::copy(from, &mut out)?;
        out.flush()
    }
}

/// Read the G-code and stream it into `tx`. Runs on a blocking thread.
/// Problems found before the first byte go to `meta` (an error response);
/// later ones end the body early, which the client sees as a failed
/// download.
fn produce(source: Source, gzip: bool, meta: oneshot::Sender<Result<Meta, ApiError>>, tx: Chunks) {
    let fail = |code: StatusCode, msg: String| api_err(code, msg);
    let opened = (|| -> Result<(Meta, Box<dyn FnOnce(ChannelWriter) -> std::io::Result<()>>), ApiError> {
        match source {
            Source::File(path) => {
                let mut file = File::open(&path)
                    .map_err(|e| fail(StatusCode::INTERNAL_SERVER_ERROR, format!("can't open the G-code: {e}")))?;
                let size = file.metadata().map(|m| m.len()).unwrap_or(0);
                let length = (!gzip).then_some(size);
                Ok((Meta { size, gzip, length }, Box::new(move |out| pump(&mut file, gzip, out))))
            }
            Source::Plate(path, index) => {
                let unreadable = |e: String| fail(StatusCode::UNPROCESSABLE_ENTITY, format!("the job's package is unreadable: {e}"));
                let mut file = File::open(&path)
                    .map_err(|e| fail(StatusCode::INTERNAL_SERVER_ERROR, format!("can't open the package: {e}")))?;
                zipcheck::verify(&mut file).map_err(unreadable)?;
                let mut zip = zip::ZipArchive::new(file).map_err(|e| unreadable(e.to_string()))?;
                let entry = bambu::gcode_entry(index);
                let at = zip
                    .index_for_name(&entry)
                    .ok_or_else(|| fail(StatusCode::NOT_FOUND, format!("the package has no {entry}")))?;
                let (size, compressed, method, crc) = {
                    let raw = zip.by_index_raw(at).map_err(|e| unreadable(e.to_string()))?;
                    (raw.size(), raw.compressed_size(), raw.compression(), raw.crc32())
                };
                if size > package::MAX_GCODE_BYTES {
                    return Err(unreadable(format!("{entry} is too large")));
                }
                use zip::CompressionMethod::{Deflated, Stored};
                match method {
                    // The archive's deflate stream, framed as gzip.
                    Deflated if gzip => Ok((
                        Meta { size, gzip, length: Some(GZIP_HEADER.len() as u64 + compressed + 8) },
                        Box::new(move |mut out: ChannelWriter| {
                            let mut raw = zip.by_index_raw(at).map_err(std::io::Error::other)?;
                            out.write_all(&GZIP_HEADER)?;
                            std::io::copy(&mut raw, &mut out)?;
                            out.write_all(&crc.to_le_bytes())?;
                            out.write_all(&(size as u32).to_le_bytes())?;
                            out.flush()
                        }),
                    )),
                    // Inflated here (the zip reader checks the CRC at the end).
                    Deflated | Stored => Ok((
                        Meta { size, gzip, length: (!gzip).then_some(size) },
                        Box::new(move |out| {
                            let mut entry = zip.by_index(at).map_err(std::io::Error::other)?;
                            pump(&mut entry, gzip, out)
                        }),
                    )),
                    other => Err(unreadable(format!("{entry} is compressed with {other:?}, which isn't supported"))),
                }
            }
        }
    })();
    match opened {
        Ok((m, run)) => {
            if meta.send(Ok(m)).is_err() {
                return;
            }
            let err_tx = tx.clone();
            if let Err(e) = run(ChannelWriter::new(tx)) {
                if e.kind() != std::io::ErrorKind::BrokenPipe {
                    eprintln!("G-code preview: reading failed: {e}");
                    let _ = err_tx.blocking_send(Err(e));
                }
            }
        }
        Err(e) => {
            let _ = meta.send(Err(e));
        }
    }
}

/// A file name for the download: the model's, ending in `.gcode`.
fn download_name(job: &Job, source: &Source) -> String {
    let stem: String = job
        .model_name
        .trim_end_matches(".gcode.3mf")
        .trim_end_matches(".3mf")
        .trim_end_matches(".stl")
        .trim_end_matches(".gcode")
        .chars()
        .filter(|c| c.is_ascii_graphic() && !matches!(c, '"' | '\\' | ';') || *c == ' ')
        .collect();
    let stem = if stem.trim().is_empty() { "job".to_string() } else { stem };
    match source {
        Source::Plate(_, n) => format!("{stem}-plate{n}.gcode"),
        Source::File(_) => format!("{stem}.gcode"),
    }
}

/// `GET /api/jobs/{id}/gcode?plate=N`: the job's G-code (plate N of a
/// package; default the first), to whoever can see the job.
async fn job_gcode(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Query(q): Query<GcodeQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (job, _, _) = visible_job(&state, &user, &id)?;
    let source = source_of(&job, q.plate)?;
    let filename = download_name(&job, &source);
    let gzip = accepts_gzip(&headers);

    let (tx, rx) = mpsc::channel(QUEUE);
    let (meta_tx, meta_rx) = oneshot::channel();
    tokio::task::spawn_blocking(move || produce(source, gzip, meta_tx, tx));
    let meta = meta_rx
        .await
        .map_err(|_| api_err(StatusCode::INTERNAL_SERVER_ERROR, "reading the G-code failed"))??;

    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
    let mut response = Body::from_stream(stream).into_response();
    let h = response.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    h.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    // A job's G-code never changes (re-slicing makes a new job).
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
    h.insert("x-gcode-bytes", HeaderValue::from(meta.size));
    if meta.gzip {
        h.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    }
    if let Some(n) = meta.length {
        h.insert(header::CONTENT_LENGTH, HeaderValue::from(n));
    }
    if let Ok(v) = HeaderValue::from_str(&format!("inline; filename=\"{filename}\"")) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(accept: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::ACCEPT_ENCODING, HeaderValue::from_str(accept).unwrap());
        h
    }

    #[test]
    fn gzip_negotiation() {
        assert!(accepts_gzip(&headers("gzip, deflate, br")));
        assert!(accepts_gzip(&headers("br;q=1.0, gzip;q=0.8")));
        assert!(accepts_gzip(&headers("*")));
        assert!(!accepts_gzip(&headers("gzip;q=0")));
        assert!(!accepts_gzip(&headers("identity")));
        assert!(!accepts_gzip(&HeaderMap::new()));
    }

    #[test]
    fn deflate_entries_pass_through_as_gzip() {
        // What `produce` sends for a deflated entry must be a valid gzip
        // stream of the entry's content.
        let dir = std::env::temp_dir().join(format!("fs-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.gcode.3mf");
        let gcode: String = (0..5000).map(|i| format!("G1 X{} Y{} E0.1\n", i % 200, i % 170)).collect();
        {
            let mut w = zip::ZipWriter::new(File::create(&path).unwrap());
            let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            w.start_file("Metadata/plate_2.gcode", opts).unwrap();
            w.write_all(gcode.as_bytes()).unwrap();
            w.finish().unwrap();
        }
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let run = |gzip: bool| -> (Meta, Vec<u8>) {
            let (tx, mut rx) = mpsc::channel(QUEUE);
            let (meta_tx, meta_rx) = oneshot::channel();
            let source = Source::Plate(path.clone(), 2);
            let task = std::thread::spawn(move || produce(source, gzip, meta_tx, tx));
            let meta = rt.block_on(meta_rx).unwrap().map_err(|e| e.1.0.to_string()).unwrap();
            let mut body = Vec::new();
            while let Some(chunk) = rt.block_on(rx.recv()) {
                body.extend_from_slice(&chunk.unwrap());
            }
            task.join().unwrap();
            (meta, body)
        };
        let (meta, body) = run(true);
        assert!(meta.gzip);
        assert_eq!(meta.size, gcode.len() as u64);
        assert_eq!(meta.length, Some(body.len() as u64));
        let mut inflated = String::new();
        flate2::read::GzDecoder::new(&body[..]).read_to_string(&mut inflated).unwrap();
        assert_eq!(inflated, gcode);

        let (meta, body) = run(false);
        assert!(!meta.gzip);
        assert_eq!(body, gcode.as_bytes());

        // No such plate: an error before any byte.
        let (tx, _rx) = mpsc::channel(QUEUE);
        let (meta_tx, meta_rx) = oneshot::channel();
        produce(Source::Plate(path.clone(), 1), true, meta_tx, tx);
        let err = rt.block_on(meta_rx).unwrap().err().unwrap();
        assert_eq!(err.0, StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(&dir).ok();
    }
}
