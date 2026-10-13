//! Prusa printers through PrusaLink (Buddy firmware: MK4/MK4S, MK3.5/3.9,
//! MINI, XL, CORE One; also the Raspberry Pi Prusa-Link for the MK3):
//! status by polling (`link`), uploads, start, pause/resume/stop and
//! pictures over its HTTP API. PrusaLink has no speed, temperature, G-code
//! or camera endpoints, so those controls aren't offered.
//!
//! Connection settings: the printer's address (port 80) and, in the
//! "access code" field, the PrusaLink password from the printer's
//! Settings → Network → PrusaLink.
//! Reference: `plans/printer-drivers/prusalink.md`.

pub mod link;
pub mod status;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;

use crate::db::{PrintRecord, Printer};
use crate::package::Image;
use crate::printer::{CommandError, DriverHandle, http};
use crate::printing::SendStep;
use crate::server::AppState;

/// FarmSlicer's folder on the printer's USB stick.
const UPLOAD_DIR: &str = "farmslicer";

/// Prusa printers take uploads at 60-370 kB/s (Wi-Fi is the slow end).
fn upload_timeout(bytes: usize) -> Duration {
    Duration::from_secs(60 + bytes as u64 / 30_000)
}

fn handle(state: &AppState, printer: &Printer) -> Result<link::Handle, String> {
    match state.printers.handle(&printer.id) {
        Some(DriverHandle::PrusaLink(h)) => Ok(h),
        _ => Err(CommandError::NotConfigured.to_string()),
    }
}

/// Upload into FarmSlicer's folder, then start the file (two steps, so a
/// refused start says so instead of leaving a quiet upload).
pub async fn send(
    state: &AppState,
    printer: &Printer,
    print: &PrintRecord,
    data: &[u8],
    step: &mut (dyn FnMut(SendStep) + Send),
) -> Result<(), String> {
    let h = handle(state, printer)?;
    h.check_idle()?;
    let c = h.config().clone();

    // PrusaLink doesn't create folders on upload.
    match link::call(c.request(reqwest::Method::PUT, c.file_url(UPLOAD_DIR)).header("Create-Folder", "?1")).await {
        Ok(_) => {}
        Err(CommandError::Refused(m)) if m.contains("409") => {} // already there
        Err(e) => return Err(format!("can't make the {UPLOAD_DIR} folder: {e}")),
    }

    let path = format!("{UPLOAD_DIR}/{}", print.file_name);
    let sent = Arc::new(AtomicU64::new(0));
    let total = data.len() as u64;
    let chunks: Vec<Result<Bytes, std::io::Error>> =
        data.chunks(32 << 10).map(|c| Ok(Bytes::copy_from_slice(c))).collect();
    let counter = sent.clone();
    let stream = futures_util::stream::iter(chunks).map(move |chunk| {
        if let Ok(b) = &chunk {
            counter.fetch_add(b.len() as u64, Ordering::Relaxed);
        }
        chunk
    });
    let upload = link::call(
        c.request(reqwest::Method::PUT, c.file_url(&path))
            // PrusaLink refuses chunked uploads: say how long it is.
            .header(reqwest::header::CONTENT_LENGTH, total)
            .header(reqwest::header::CONTENT_TYPE, "text/x.gcode")
            .header("Overwrite", "?1")
            .timeout(upload_timeout(data.len()))
            .body(reqwest::Body::wrap_stream(stream)),
    );
    tokio::pin!(upload);
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
            r = &mut upload => { r.map_err(|e| format!("upload failed: {e}"))?; break; }
            _ = tick.tick() => step(SendStep::Uploading((sent.load(Ordering::Relaxed) * 100 / total.max(1)) as i64)),
        }
    }

    step(SendStep::Starting);
    println!("Print {}: uploaded to {} as {path}; starting it", print.id, printer.name);
    h.check_idle()?;
    match link::call(c.request(reqwest::Method::POST, c.file_url(&path))).await {
        Ok(_) => {
            h.watch();
            Ok(())
        }
        Err(CommandError::Refused(why)) => Err(format!("the printer refused to start the print: {why}")),
        Err(e) => Err(e.to_string()),
    }
}

/// The picture of the printer's current job (for prints started
/// elsewhere): its `/thumb/l/` preview, the first PNG larger than 16x16
/// in the file.
pub async fn picture(printer: &Printer) -> Result<Option<Image>, String> {
    let c = link::Config::from_printer(printer).ok_or("no address or password")?;
    let job = link::call(c.request(reqwest::Method::GET, c.url("api/v1/job"))).await.map_err(|e| e.to_string())?;
    let Some(thumb) = job["file"]["refs"]["thumbnail"].as_str() else { return Ok(None) };
    let response = c
        .request(reqwest::Method::GET, c.url(thumb))
        .send()
        .await
        .map_err(|e| http::explain(&e))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let bytes = response.bytes().await.map_err(|e| http::explain(&e))?;
    Ok(Some(Image { bytes: bytes.to_vec(), content_type: "image/png" }))
}
