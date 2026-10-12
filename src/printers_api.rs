//! Printers: the farm's printer list (admins manage it) and their live status.
//!
//! A printer's LAN access code is write-only: no response ever carries it,
//! only whether one is set. Serial numbers are shown to admins only.

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use axum::{Extension, Json, Router};
use futures_util::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast::error::RecvError;

use crate::auth::{self, CurrentUser};
use crate::db::{Printer, User};
use crate::server::AppState;

type ApiError = (StatusCode, Json<Value>);

fn not_found() -> ApiError {
    (StatusCode::NOT_FOUND, Json(json!({"error": "no such printer"})))
}

fn view(p: &Printer, user: &User) -> Value {
    let admin = auth::is_admin(user);
    json!({
        "id": p.id,
        "name": p.name,
        "machine_profile": p.machine_profile,
        "nozzle_diameter": p.nozzle_diameter,
        "protocol": p.protocol,
        "address": p.address,
        "serial_number": if admin { Some(&p.serial_number) } else { None },
        "access_code_set": !p.access_code.is_empty(),
        "current_job": p.current_job,
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
    let printers: Vec<Value> = state.db.list_printers().iter().map(|p| view(p, &user)).collect();
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
    let printer = state.db.create_printer(
        name,
        body.machine_profile.as_deref().unwrap_or(""),
        body.nozzle_diameter.as_deref().unwrap_or(""),
        body.protocol.as_deref().unwrap_or("bambu"),
        body.address.as_deref().unwrap_or("").trim(),
        body.serial_number.as_deref().unwrap_or("").trim(),
        body.access_code.as_deref().unwrap_or("").trim(),
    );
    resync(&state);
    Ok((StatusCode::CREATED, Json(view(&printer, &user))))
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
        )
        .ok_or_else(not_found)?;
    resync(&state);
    Ok(Json(view(&printer, &user)))
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

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/printers", get(list_printers).post(create_printer))
        .route("/api/printers/status", get(list_status))
        .route("/api/printers/events", get(status_events))
        .route("/api/printers/{id}", axum::routing::patch(update_printer).delete(delete_printer))
        .route("/api/printers/{id}/report", get(raw_report))
}
