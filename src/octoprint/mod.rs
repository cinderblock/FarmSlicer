//! Printers behind OctoPrint (1.x and 2.0): status over its push socket
//! (`link`), uploads, commands, pictures and the camera over REST.
//!
//! Connection settings: the address is OctoPrint's (`host`, default port
//! 80 as on OctoPi; `host:5000`; or a URL with a path prefix); the "access
//! code" field holds an API key (User Settings → Application Keys).
//! Reference: `plans/printer-drivers/octoprint.md`.

pub mod link;
pub mod status;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use serde_json::json;

use crate::camera::CameraKind;
use crate::db::{PrintRecord, Printer};
use crate::package::Image;
use crate::printer::{CommandError, DriverHandle, http};
use crate::printing::SendStep;
use crate::server::AppState;

/// FarmSlicer's folder in OctoPrint's local storage.
const UPLOAD_DIR: &str = "farmslicer";

fn upload_timeout(bytes: usize) -> Duration {
    Duration::from_secs(60 + bytes as u64 / 100_000)
}

fn handle(state: &AppState, printer: &Printer) -> Result<link::Handle, String> {
    match state.printers.handle(&printer.id) {
        Some(DriverHandle::OctoPrint(h)) => Ok(h),
        _ => Err(CommandError::NotConfigured.to_string()),
    }
}

/// `api/files/local/<path>` with each path segment encoded.
fn file_url(config: &link::Config, path: &str) -> url::Url {
    let mut url = http::join(&config.base, "api/files/local/");
    url.path_segments_mut()
        .expect("http URLs have paths")
        .pop_if_empty()
        .extend(path.split('/'));
    url
}

/// Upload the G-code, then select and start that very file (a bare
/// `start` would reprint whatever file is still selected).
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
        .text("path", UPLOAD_DIR)
        .text("userdata", json!({"farmslicer": {"print_id": print.id}}).to_string())
        .part("file", part);
    let upload = link::call(
        config
            .request(reqwest::Method::POST, "api/files/local")
            .timeout(upload_timeout(data.len()))
            .multipart(form),
    );
    tokio::pin!(upload);
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    let result = loop {
        tokio::select! {
            r = &mut upload => break r.map_err(|e| format!("upload failed: {e}"))?,
            _ = tick.tick() => step(SendStep::Uploading((sent.load(Ordering::Relaxed) * 100 / total.max(1)) as i64)),
        }
    };
    let path = result["files"]["local"]["path"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| format!("{UPLOAD_DIR}/{}", print.file_name));

    step(SendStep::Starting);
    println!("Print {}: uploaded to {} as {path}; starting it", print.id, printer.name);
    h.check_idle()?;
    let start = http::client()
        .post(file_url(&config, &path))
        .header("X-Api-Key", &config.api_key)
        .json(&json!({"command": "select", "print": true}));
    match link::call(start).await {
        Ok(_) => Ok(()),
        Err(CommandError::Refused(why)) => Err(format!("OctoPrint refused to start the print: {why}")),
        Err(e) => Err(e.to_string()),
    }
}

/// The picture of a file in OctoPrint's storage: OctoPrint 2.0's own
/// thumbnail, or the Slicer Thumbnails plugin's (1.x).
pub async fn picture(printer: &Printer, path: &str) -> Result<Option<Image>, String> {
    let config = link::Config::from_printer(printer).ok_or("no address or API key")?;
    let info = match link::call(http::client().get(file_url(&config, path)).header("X-Api-Key", &config.api_key)).await {
        Ok(info) => info,
        Err(CommandError::Refused(m)) if m.contains("404") || m.to_ascii_lowercase().contains("not found") => {
            return Ok(None);
        }
        Err(e) => return Err(e.to_string()),
    };
    let Some(url) = info["refs"]["thumbnail"].as_str().or_else(|| info["thumbnail"].as_str()) else {
        return Ok(None);
    };
    let Ok(url) = config.base.join(url.trim_start_matches('/')).or_else(|_| url::Url::parse(url)) else {
        return Ok(None);
    };
    let response = http::client()
        .get(url)
        .header("X-Api-Key", &config.api_key)
        .send()
        .await
        .map_err(|e| http::explain(&e))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let content_type = match response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()) {
        Some(t) if t.starts_with("image/jpeg") => "image/jpeg",
        _ => "image/png",
    };
    let bytes = response.bytes().await.map_err(|e| http::explain(&e))?;
    Ok(Some(Image { bytes: bytes.to_vec(), content_type }))
}

/// A webcam URL from OctoPrint's settings, made reachable from here. The
/// stream URL is for browsers, relative to OctoPrint's web page; the
/// snapshot URL is for OctoPrint itself and usually on loopback.
fn camera_url(base: &url::Url, raw: &str) -> Option<url::Url> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.starts_with('/') {
        let mut root = base.clone();
        root.set_path("/");
        return root.join(raw).ok();
    }
    let mut url = url::Url::parse(raw).ok()?;
    if matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1" | "[::1]")) {
        url.set_host(base.host_str()).ok()?;
    }
    matches!(url.scheme(), "http" | "https").then_some(url)
}

/// The printer's camera, from OctoPrint's webcam settings.
pub async fn camera(printer: &Printer) -> Result<CameraKind, String> {
    let config = link::Config::from_printer(printer).ok_or("the printer has no address or API key")?;
    let settings = link::call(config.request(reqwest::Method::GET, "api/settings"))
        .await
        .map_err(|e| format!("can't read OctoPrint's settings: {e}"))?;
    let webcam = &settings["webcam"];
    if webcam["webcamEnabled"].as_bool() == Some(false) {
        return Err("OctoPrint's webcam is switched off".into());
    }
    let first = webcam["webcams"].as_array().and_then(|w| w.first()).map(|w| &w["compat"]);
    let pick = |key: &str, compat: &str| {
        first
            .and_then(|c| c[compat].as_str())
            .or_else(|| webcam[key].as_str())
            .unwrap_or("")
            .to_string()
    };
    let stream = camera_url(&config.base, &pick("streamUrl", "stream"));
    // mjpg-streamer behind OctoPi's /webcam/ answers snapshots on the same
    // path; the configured snapshot URL is usually loopback on the Pi.
    let snapshot = stream
        .as_ref()
        .filter(|u| u.query() == Some("action=stream"))
        .map(|u| {
            let mut s = u.clone();
            s.set_query(Some("action=snapshot"));
            s
        })
        .or_else(|| camera_url(&config.base, &pick("snapshotUrl", "snapshot")));
    if stream.is_none() && snapshot.is_none() {
        return Err("OctoPrint has no webcam set up".into());
    }
    Ok(CameraKind::Mjpeg { stream, snapshot })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camera_urls_point_at_octoprint() {
        let base = url::Url::parse("http://octopi.local/").unwrap();
        let u = |raw| camera_url(&base, raw).map(|u| u.to_string());
        assert_eq!(u("/webcam/?action=stream").as_deref(), Some("http://octopi.local/webcam/?action=stream"));
        assert_eq!(u("http://127.0.0.1:8080/?action=snapshot").as_deref(), Some("http://octopi.local:8080/?action=snapshot"));
        assert_eq!(u(""), None);
    }

    #[test]
    fn file_paths_are_encoded() {
        let config = link::Config { name: "x".into(), base: url::Url::parse("http://pi/octoprint/").unwrap(), api_key: "k".into() };
        assert_eq!(
            file_url(&config, "farmslicer/job #12 (a).gcode").as_str(),
            "http://pi/octoprint/api/files/local/farmslicer/job%20%2312%20(a).gcode"
        );
    }
}
