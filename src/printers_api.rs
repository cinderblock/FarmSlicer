//! Printers: the farm's printer list (admins manage it) and their live status.
//!
//! A printer's LAN access code is write-only: no response ever carries it,
//! only whether one is set. Serial numbers are shown to admins only.

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use axum::{Extension, Json, Router};
use futures_util::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast::error::RecvError;

use crate::auth::{self, CurrentUser};
use crate::camera::{CameraKind, CameraSource, Frame};
use crate::db::{Printer, User};
use crate::printer::{Protocol, protocol_of};
use crate::server::AppState;

type ApiError = (StatusCode, Json<Value>);

fn not_found() -> ApiError {
    (StatusCode::NOT_FOUND, Json(json!({"error": "no such printer"})))
}

fn view(state: &AppState, p: &Printer, user: &User) -> Value {
    let admin = auth::is_admin(user);
    json!({
        "id": p.id,
        "name": p.name,
        "machine_profile": p.machine_profile,
        "nozzle_diameter": p.nozzle_diameter,
        "protocol": p.protocol,
        // null: a protocol FarmSlicer doesn't speak (yet).
        "capabilities": protocol_of(p).map(|proto| proto.capabilities()),
        "address": p.address,
        "serial_number": if admin { Some(&p.serial_number) } else { None },
        "access_code_set": !p.access_code.is_empty(),
        // Its connection settings are complete (FarmSlicer is linked to it).
        "configured": state.printers.handle(&p.id).is_some(),
        "current_job": p.current_job,
        "area": p.area,
        "plate_type": p.plate_type,
        "nozzle_priority": p.nozzle_priority,
        // How it takes the queue (src/dispatch.rs).
        "dispatch": crate::dispatch::view(state, &p.id),
    })
}

/// Reconnect printers after any change to the table.
fn resync(state: &AppState) {
    state.printers.sync(&state.db.list_printers());
}

async fn list_printers(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Json<Value> {
    let printers: Vec<Value> = state.db.list_printers().iter().map(|p| view(&state, p, &user)).collect();
    Json(json!(printers))
}

#[derive(Deserialize)]
struct CreatePrinter {
    name: String,
    machine_profile: Option<String>,
    nozzle_diameter: Option<String>,
    protocol: Option<String>,
    address: Option<String>,
    serial_number: Option<String>,
    access_code: Option<String>,
    area: Option<String>,
    plate_type: Option<String>,
    nozzle_priority: Option<String>,
}

fn check_plate(plate: Option<&str>) -> Result<(), ApiError> {
    match plate.map(str::trim) {
        None | Some("") => Ok(()),
        Some(p) if crate::printing::BED_TYPES.contains(&p) => Ok(()),
        Some(p) => Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("unknown plate type {p:?}; one of {}", crate::printing::BED_TYPES.join(", "))})),
        )),
    }
}

fn check_nozzle_priority(priority: Option<&str>) -> Result<(), ApiError> {
    match priority {
        Some(p) if crate::nozzles::Priority::parse(p).is_none() => Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!(
                "unknown nozzle priority {p:?}; one of {}",
                crate::nozzles::PRIORITY_VALUES.iter().filter(|v| !v.is_empty()).copied().collect::<Vec<_>>().join(", ")
            )})),
        )),
        _ => Ok(()),
    }
}

async fn create_printer(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<CreatePrinter>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    auth::require_admin(&user)?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "name is required"}))));
    }
    check_plate(body.plate_type.as_deref())?;
    check_nozzle_priority(body.nozzle_priority.as_deref())?;
    let printer = state.db.create_printer(
        name,
        body.machine_profile.as_deref().unwrap_or(""),
        body.nozzle_diameter.as_deref().unwrap_or(""),
        body.protocol.as_deref().unwrap_or("bambu"),
        body.address.as_deref().unwrap_or("").trim(),
        body.serial_number.as_deref().unwrap_or("").trim(),
        body.access_code.as_deref().unwrap_or("").trim(),
        body.area.as_deref().unwrap_or("").trim(),
        body.plate_type.as_deref().unwrap_or("").trim(),
        body.nozzle_priority.as_deref().unwrap_or("").trim(),
    );
    resync(&state);
    Ok((StatusCode::CREATED, Json(view(&state, &printer, &user))))
}

/// Fields left out stay as they are; `access_code: ""` clears the code.
#[derive(Deserialize)]
struct UpdatePrinter {
    name: Option<String>,
    machine_profile: Option<String>,
    nozzle_diameter: Option<String>,
    protocol: Option<String>,
    address: Option<String>,
    serial_number: Option<String>,
    access_code: Option<String>,
    area: Option<String>,
    plate_type: Option<String>,
    nozzle_priority: Option<String>,
}

async fn update_printer(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<UpdatePrinter>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&user)?;
    if body.name.as_deref().is_some_and(|n| n.trim().is_empty()) {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "name can't be empty"}))));
    }
    check_plate(body.plate_type.as_deref())?;
    check_nozzle_priority(body.nozzle_priority.as_deref())?;
    let trimmed = |v: &Option<String>| v.as_deref().map(str::trim).map(String::from);
    let printer = state
        .db
        .update_printer(
            &id,
            trimmed(&body.name).as_deref(),
            body.machine_profile.as_deref(),
            body.nozzle_diameter.as_deref(),
            body.protocol.as_deref(),
            trimmed(&body.address).as_deref(),
            trimmed(&body.serial_number).as_deref(),
            trimmed(&body.access_code).as_deref(),
            trimmed(&body.area).as_deref(),
            trimmed(&body.plate_type).as_deref(),
            trimmed(&body.nozzle_priority).as_deref(),
        )
        .ok_or_else(not_found)?;
    resync(&state);
    Ok(Json(view(&state, &printer, &user)))
}

async fn delete_printer(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    auth::require_admin(&user)?;
    if !state.db.delete_printer(&id) {
        return Err(not_found());
    }
    resync(&state);
    Ok(StatusCode::NO_CONTENT)
}

/// Live status of every connected printer (those with an address, serial
/// number and access code).
async fn list_status(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!(state.printers.statuses()))
}

/// Server-sent events: one `status` event per connected printer, then one
/// each time a printer reports.
async fn status_events(
    State(state): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    // Subscribe before taking the snapshot so nothing falls in between.
    let updates = state.printers.subscribe();
    let snapshot = state.printers.statuses();
    let live = futures_util::stream::unfold(updates, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(status) => return Some((status, rx)),
                // A slow client skips intermediate reports; later ones carry
                // the full state anyway.
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    });
    let stream = futures_util::stream::iter(snapshot).chain(live).map(|status| {
        Ok(Event::default()
            .event("status")
            .data(serde_json::to_string(&status).expect("statuses serialize")))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// The merged raw MQTT report, for debugging (admins).
async fn raw_report(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&user)?;
    state.db.get_printer(&id).ok_or_else(not_found)?;
    Ok(Json(state.printers.report(&id).unwrap_or(Value::Null)))
}

/// Where a printer's camera pictures come from, or why there are none.
async fn camera_kind(state: &AppState, p: &Printer) -> Result<CameraKind, String> {
    match protocol_of(p) {
        Some(Protocol::Bambu) => {
            if p.address.trim().is_empty() || p.access_code.trim().is_empty() {
                return Err("the printer has no address or access code set".into());
            }
            let model_id = state
                .profile_store
                .machine_model(&p.machine_profile)
                .and_then(|m| m.model_id.clone())
                .or_else(|| crate::bambu::models::id_for(&p.machine_profile).map(String::from));
            Ok(crate::camera::bambu_kind(model_id.as_deref(), p.address.trim(), p.access_code.trim()))
        }
        Some(Protocol::Moonraker) => crate::moonraker::camera(p).await,
        Some(Protocol::OctoPrint) => crate::octoprint::camera(p).await,
        Some(Protocol::PrusaLink) => Err("PrusaLink has no camera".into()),
        Some(Protocol::Sdcp) => crate::sdcp::camera(state, p).await,
        None => Err("FarmSlicer can't show this printer's camera".into()),
    }
}

/// `GET /api/printers/{id}/camera` (WebSocket): the live camera. First a
/// text message `{"type":"hello","kind":"h264"|"jpeg"}`; then, for H.264, a
/// text `{"type":"h264-init",codec,description(base64 avcC),width,height}`
/// and binary access units `[key u8][timestamp µs i64 LE][AVC data]`; for
/// JPEG, binary JPEG frames. `{"type":"error",message}` ends the stream
/// (also when the printer has no camera FarmSlicer can show).
async fn camera(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let p = state.db.get_printer(&id).ok_or_else(not_found)?;
    let kind = camera_kind(&state, &p).await;
    Ok(ws
        .on_upgrade(move |mut socket| async move {
            match kind {
                Ok(kind) => serve_camera(state, CameraSource { printer_id: p.id, name: p.name, kind }, socket).await,
                Err(message) => {
                    let _ = socket.send(text(json!({"type": "error", "message": message}))).await;
                    let _ = socket.send(Message::Close(None)).await;
                }
            }
        })
        .into_response())
}

fn text(v: Value) -> Message {
    Message::Text(v.to_string().into())
}

/// One frame as a message; None = drop it.
fn encode(frame: &Frame) -> Message {
    match frame {
        Frame::H264Init { codec, description, width, height } => text(json!({
            "type": "h264-init",
            "codec": codec,
            "description": base64::engine::general_purpose::STANDARD.encode(description),
            "width": width,
            "height": height,
        })),
        Frame::H264 { key, timestamp_us, data } => {
            let mut buf = Vec::with_capacity(9 + data.len());
            buf.push(u8::from(*key));
            buf.extend_from_slice(&timestamp_us.to_le_bytes());
            buf.extend_from_slice(data);
            Message::Binary(buf.into())
        }
        Frame::Jpeg(data) => Message::Binary(data.clone()),
        Frame::Error(message) => text(json!({"type": "error", "message": message})),
    }
}

async fn serve_camera(state: Arc<AppState>, source: CameraSource, mut socket: WebSocket) {
    let kind = source.kind.browser_kind();
    if socket.send(text(json!({"type": "hello", "kind": kind}))).await.is_err() {
        return;
    }
    let mut sub = state.cameras.watch(source);
    for frame in &sub.backlog {
        if socket.send(encode(frame)).await.is_err() {
            return;
        }
    }
    // After falling behind, H.264 deltas are useless until the next key frame.
    let mut need_key = false;
    loop {
        tokio::select! {
            frame = sub.frames.recv() => match frame {
                Ok(frame) => {
                    match &*frame {
                        Frame::H264 { key: false, .. } if need_key => continue,
                        Frame::H264 { key: true, .. } => need_key = false,
                        _ => {}
                    }
                    let last = matches!(*frame, Frame::Error(_));
                    if socket.send(encode(&frame)).await.is_err() || last {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => need_key = true,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.recv() => match incoming {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
            },
        }
    }
    let _ = socket.send(Message::Close(None)).await;
}

/// `GET /api/printer-protocols`: the protocols FarmSlicer speaks and what
/// each can do.
async fn list_protocols() -> Json<Value> {
    Json(json!(Protocol::ALL
        .iter()
        .map(|p| json!({"id": p.as_str(), "label": p.label(), "capabilities": p.capabilities(), "connection": p.connection()}))
        .collect::<Vec<_>>()))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/printer-protocols", get(list_protocols))
        .route("/api/printers", get(list_printers).post(create_printer))
        .route("/api/printers/status", get(list_status))
        .route("/api/printers/events", get(status_events))
        .route("/api/printers/{id}", axum::routing::patch(update_printer).delete(delete_printer))
        .route("/api/printers/{id}/report", get(raw_report))
        .route("/api/printers/{id}/camera", get(camera))
}
