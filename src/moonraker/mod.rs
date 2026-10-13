//! Klipper printers through Moonraker: status and commands over its
//! WebSocket JSON-RPC (`link`), uploads and pictures over HTTP.
//!
//! Connection settings: the printer's address is Moonraker's (`host`,
//! `host:port`, default 7125, or a URL such as `http://host` for one behind
//! nginx); the "access code" field holds an optional API key (`X-Api-Key`),
//! needed only when the printer doesn't trust FarmSlicer's address.
//! Reference: `plans/printer-drivers/moonraker.md`.

pub mod link;
pub mod status;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::camera::CameraKind;
use crate::db::{PrintRecord, Printer};
use crate::package::Image;
use crate::printer::{CommandError, DriverHandle, http};
use crate::printing::SendStep;
use crate::server::AppState;

/// Where FarmSlicer puts its files on the printer (under `gcodes/`).
const UPLOAD_DIR: &str = "farmslicer";
/// Uploads go to a Raspberry Pi over the LAN, often Wi-Fi: allow ~100 kB/s.
fn upload_timeout(bytes: usize) -> Duration {
    Duration::from_secs(60 + bytes as u64 / 100_000)
}
const START_WAIT: Duration = Duration::from_secs(30);

fn handle(state: &AppState, printer: &Printer) -> Result<link::Handle, String> {
    match state.printers.handle(&printer.id) {
        Some(DriverHandle::Moonraker(h)) => Ok(h),
        _ => Err(CommandError::NotConfigured.to_string()),
    }
}

/// The JSON body of a Moonraker HTTP response: `result` when wrapped.
async fn body(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let text = response.text().await.map_err(|e| http::explain(&e))?;
    let json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() {
        let message = json["error"]["message"].as_str().map(String::from).unwrap_or_else(|| text.trim().to_string());
        return Err(format!("HTTP {status}: {message}"));
    }
    Ok(json.get("result").cloned().unwrap_or(json))
}

/// Upload the G-code and start it. Both ends refuse while the printer is
/// busy: an upload doesn't replace a paused job here.
pub async fn send(
    state: &AppState,
    printer: &Printer,
    print: &PrintRecord,
    data: &[u8],
    step: &mut (dyn FnMut(SendStep) + Send),
) -> Result<(), String> {
    let h = handle(state, printer)?;
    h.check_idle()?;
    let config = h.config().clone();

    let sent = Arc::new(AtomicU64::new(0));
    let total = data.len() as u64;
    let chunks: Vec<Result<Bytes, std::io::Error>> =
        data.chunks(64 << 10).map(|c| Ok(Bytes::copy_from_slice(c))).collect();
    let counter = sent.clone();
    let stream = futures_util::stream::iter(chunks).map(move |chunk| {
        if let Ok(b) = &chunk {
            counter.fetch_add(b.len() as u64, Ordering::Relaxed);
        }
        chunk
    });
    let part = reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), total)
        .file_name(print.file_name.clone())
        .mime_str("application/octet-stream")
        .expect("a valid MIME type");
    let form = reqwest::multipart::Form::new()
        .text("root", "gcodes")
        .text("path", UPLOAD_DIR)
        .text("checksum", hex::encode(Sha256::digest(data)))
        .part("file", part);
    let upload = config
        .request(reqwest::Method::POST, "server/files/upload")
        .timeout(upload_timeout(data.len()))
        .multipart(form)
        .send();
    tokio::pin!(upload);
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    let response = loop {
        tokio::select! {
            r = &mut upload => break r.map_err(|e| format!("upload failed: {}", http::explain(&e)))?,
            _ = tick.tick() => step(SendStep::Uploading((sent.load(Ordering::Relaxed) * 100 / total.max(1)) as i64)),
        }
    };
    let result = body(response).await.map_err(|e| format!("upload failed: {e}"))?;
    let path = result["item"]["path"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| format!("{UPLOAD_DIR}/{}", print.file_name));

    step(SendStep::Starting);
    println!("Print {}: uploaded to {}:{path}; starting it", print.id, printer.name);
    // Someone may have started something during the upload.
    h.check_idle()?;
    match h.call("printer.print.start", json!({ "filename": path }), START_WAIT).await {
        Ok(_) => Ok(()),
        Err(CommandError::Refused(why)) => Err(format!("the printer refused to start the print: {why}")),
        Err(e) => Err(e.to_string()),
    }
}

/// A webcam URL as Moonraker stores it, made reachable from here: relative
/// ones are served by the web server in front of Moonraker (port 80 on the
/// printer's host); `localhost` means the printer.
fn webcam_url(base: &url::Url, raw: Option<&str>) -> Option<url::Url> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    let host = base.host_str()?;
    if raw.starts_with('/') {
        let mut root = base.clone();
        root.set_port(None).ok()?;
        root.set_path("/");
        return root.join(raw).ok();
    }
    let mut url = url::Url::parse(raw).ok()?;
    if matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1" | "[::1]")) {
        url.set_host(Some(host)).ok()?;
    }
    matches!(url.scheme(), "http" | "https").then_some(url)
}

/// The printer's camera: the first enabled webcam in Moonraker's list
/// that serves MJPEG or snapshots.
pub async fn camera(printer: &Printer) -> Result<CameraKind, String> {
    let config = link::Config::from_printer(printer).ok_or("the printer has no address")?;
    let r = config
        .request(reqwest::Method::GET, "server/webcams/list")
        .send()
        .await
        .map_err(|e| format!("can't ask Moonraker for its webcams: {}", http::explain(&e)))?;
    let list = body(r).await.map_err(|e| format!("can't ask Moonraker for its webcams: {e}"))?;
    let webcams = list["webcams"].as_array().cloned().unwrap_or_default();
    for w in webcams.iter().filter(|w| w["enabled"].as_bool() != Some(false)) {
        let service = w["service"].as_str().unwrap_or("");
        let stream = webcam_url(&config.base, w["stream_url"].as_str());
        let snapshot = webcam_url(&config.base, w["snapshot_url"].as_str());
        let kind = match service {
            // Mainsail's "adaptive" mode polls snapshots.
            "mjpegstreamer-adaptive" => CameraKind::Mjpeg { stream: None, snapshot },
            "mjpegstreamer" | "uv4l-mjpeg" | "ipstream" => CameraKind::Mjpeg { stream, snapshot },
            // WebRTC, HLS, ...: only their snapshots.
            _ => CameraKind::Mjpeg { stream: None, snapshot },
        };
        if matches!(&kind, CameraKind::Mjpeg { stream: None, snapshot: None }) {
            continue;
        }
        return Ok(kind);
    }
    Err(if webcams.is_empty() {
        "no webcam is set up in Moonraker (Mainsail/Fluidd: Settings → Webcams)".to_string()
    } else {
        "Moonraker's webcams have neither an MJPEG stream nor a snapshot URL".to_string()
    })
}

/// The picture of a file on the printer: the largest thumbnail Moonraker
/// extracted from it (`.thumbs/` next to the file).
pub async fn picture(printer: &Printer, filename: &str) -> Result<Option<Image>, String> {
    let config = link::Config::from_printer(printer).ok_or("no address")?;
    let meta = config
        .request(reqwest::Method::GET, "server/files/metadata")
        .query(&[("filename", filename)])
        .send()
        .await
        .map_err(|e| http::explain(&e))?;
    let meta = match body(meta).await {
        Ok(m) => m,
        Err(e) if e.starts_with("HTTP 404") => return Ok(None),
        Err(e) => return Err(e),
    };
    let Some(best) = meta["thumbnails"]
        .as_array()
        .and_then(|t| t.iter().max_by_key(|t| t["width"].as_i64().unwrap_or(0) * t["height"].as_i64().unwrap_or(0)))
    else {
        return Ok(None);
    };
    let Some(relative) = best["relative_path"].as_str() else { return Ok(None) };
    let dir = filename.rsplit_once('/').map(|(d, _)| format!("{d}/")).unwrap_or_default();
    let response = config
        .request(reqwest::Method::GET, &format!("server/files/gcodes/{dir}{relative}"))
        .send()
        .await
        .map_err(|e| http::explain(&e))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let content_type = if relative.ends_with(".jpg") || relative.ends_with(".jpeg") { "image/jpeg" } else { "image/png" };
    let bytes = response.bytes().await.map_err(|e| http::explain(&e))?;
    Ok(Some(Image { bytes: bytes.to_vec(), content_type }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webcam_urls_point_at_the_printer() {
        let base = url::Url::parse("http://10.0.0.7:7125/").unwrap();
        let u = |raw| webcam_url(&base, raw).map(|u| u.to_string());
        assert_eq!(u(Some("/webcam/?action=stream")).as_deref(), Some("http://10.0.0.7/webcam/?action=stream"));
        assert_eq!(u(Some("http://localhost:8080/?action=snapshot")).as_deref(), Some("http://10.0.0.7:8080/?action=snapshot"));
        assert_eq!(u(Some("http://cam.lan/mjpg")).as_deref(), Some("http://cam.lan/mjpg"));
        assert_eq!(u(Some("")), None);
        assert_eq!(u(None), None);
    }
}
