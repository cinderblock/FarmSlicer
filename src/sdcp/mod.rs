//! Elegoo Centauri Carbon (and Centauri) printers over SDCP v3: status and
//! commands on a WebSocket (`link`), uploads, pictures and the camera over
//! HTTP. The Centauri Carbon 2 speaks another protocol (MQTT) and isn't
//! covered.
//!
//! Connection settings: the printer's address (ports 3030, 80 and 3031 are
//! fixed; `host?ws=..&http=..&video=..` overrides them) and, optionally, its
//! mainboard id in the serial number field (learnt from the printer when
//! empty). No password: SDCP has none.
//! Reference: `plans/printer-drivers/sdcp.md`.

pub mod link;
pub mod status;

use std::time::Duration;

use md5::{Digest, Md5};
use serde_json::{Value, json};

use crate::camera::CameraKind;
use crate::db::{PrintRecord, Printer};
use crate::package::{Image, Plate};
use crate::printer::{CommandError, DriverHandle, http};
use crate::printing::{PrintOptions, SendStep};
use crate::server::AppState;

const CHUNK: usize = 1 << 20;
/// After an upload the printer checks the file before it will start it.
const CHECK_WAIT: Duration = Duration::from_secs(60);
const START_WAIT: Duration = Duration::from_secs(30);

fn handle(state: &AppState, printer: &Printer) -> Result<link::Handle, String> {
    match state.printers.handle(&printer.id) {
        Some(DriverHandle::Sdcp(h)) => Ok(h),
        _ => Err(CommandError::NotConfigured.to_string()),
    }
}

/// `PrintPlatformType`: 0 the textured side of the plate, 1 the smooth one
/// (OrcaSlicer sends 1 for its "Cool Plate").
fn platform(plate: &Plate, printer: &Printer) -> i64 {
    let bed = plate.bed_type.as_deref().unwrap_or(printer.plate_type.as_str());
    i64::from(bed.eq_ignore_ascii_case("Cool Plate"))
}

/// Upload in 1 MiB parts (the printer checks the whole file's MD5 after the
/// last), wait while it checks the file, then start it (Cmd 128, with the
/// full payload Elegoo's clients send).
pub async fn send(
    state: &AppState,
    printer: &Printer,
    print: &PrintRecord,
    data: &[u8],
    plate: &Plate,
    options: &PrintOptions,
    step: &mut (dyn FnMut(SendStep) + Send),
) -> Result<(), String> {
    let h = handle(state, printer)?;
    h.refresh().await;
    h.check_idle()?;
    let e = h.config().endpoint.clone();
    let md5 = hex::encode(Md5::digest(data));
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    let total = data.len();
    for (n, chunk) in data.chunks(CHUNK).enumerate() {
        let offset = n * CHUNK;
        let part = reqwest::multipart::Part::bytes(chunk.to_vec())
            .file_name(print.file_name.clone())
            .mime_str("application/octet-stream")
            .expect("a valid MIME type");
        let form = reqwest::multipart::Form::new()
            .text("TotalSize", total.to_string())
            .text("Uuid", uuid.clone())
            .text("Offset", offset.to_string())
            .text("Check", "1")
            .text("S-File-MD5", md5.clone())
            .part("File", part);
        let response = http::client()
            .post(e.http("uploadFile/upload"))
            .timeout(Duration::from_secs(120))
            .multipart(form)
            .send()
            .await
            .map_err(|err| format!("upload failed: {}", http::explain(&err)))?;
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if body["code"].as_str() != Some("000000") {
            return Err(format!("upload failed: the printer said {}", body["messages"]));
        }
        step(SendStep::Uploading(((offset + chunk.len()) * 100 / total.max(1)) as i64));
    }

    step(SendStep::Starting);
    println!("Print {}: uploaded to {}; waiting for it to check the file", print.id, printer.name);
    // The check starts a moment after the last part (OrcaSlicer waits too).
    tokio::time::sleep(Duration::from_secs(1)).await;
    let deadline = tokio::time::Instant::now() + CHECK_WAIT;
    loop {
        let st = h.refresh().await;
        if !status::has_code(&st, 8) && !status::has_code(&st, 2) {
            break;
        }
        if tokio::time::Instant::now() > deadline {
            return Err("the printer took too long to check the file".into());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    h.check_idle()?;
    let start = json!({
        "Filename": format!("/local/{}", print.file_name),
        "StartLayer": 0,
        "Calibration_switch": i64::from(options.bed_leveling),
        "PrintPlatformType": platform(plate, printer),
        "Tlp_Switch": i64::from(options.timelapse),
    });
    match h.call(link::cmd::START, start, START_WAIT).await {
        Ok(Some(reply)) => link::check_ack(link::cmd::START, &reply).map_err(|err| format!("the printer refused to start the print: {err}")),
        // No answer: it may have started anyway; the tracker will tell.
        Ok(None) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

/// The picture of the printer's current (or last) task: the thumbnail it
/// took from the G-code when the print started.
pub async fn picture(state: &AppState, printer: &Printer) -> Result<Option<Image>, String> {
    let h = handle(state, printer)?;
    let task = h.status().get("PrintInfo").and_then(|p| p["TaskId"].as_str().map(String::from)).unwrap_or_default();
    if task.is_empty() {
        return Ok(None);
    }
    let url = h.config().endpoint.http(&format!("board-resource/history_image/{}.png", urlencode(&task)));
    let response = http::client().get(url).send().await.map_err(|e| http::explain(&e))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let bytes = response.bytes().await.map_err(|e| http::explain(&e))?;
    Ok(Some(Image { bytes: bytes.to_vec(), content_type: "image/png" }))
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// The camera: switched on (Cmd 386) and read as MJPEG on port 3031. The
/// printer serves about one viewer, so the camera hub's one shared feed per
/// printer matters here.
pub async fn camera(state: &AppState, printer: &Printer) -> Result<CameraKind, String> {
    let h = handle(state, printer)?;
    let reply = h
        .call(link::cmd::CAMERA, json!({"Enable": 1}), link::COMMAND_WAIT)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("the printer didn't answer")?;
    link::check_ack(link::cmd::CAMERA, &reply).map_err(|e| e.to_string())?;
    let e = &h.config().endpoint;
    // The reply's VideoUrl ("<ip>:3031/video", no scheme) names the
    // printer's own address; the configured one is what reaches it.
    let stream = url::Url::parse(&format!("http://{}:{}/video", e.host, e.video_port)).map_err(|err| err.to_string())?;
    Ok(CameraKind::Mjpeg { stream: Some(stream), snapshot: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_ids_in_urls() {
        assert_eq!(urlencode("295cb186-daf5"), "295cb186-daf5");
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
    }
}
