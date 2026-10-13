//! Farm-floor helpers: equipment reports and pre-heating.
//!
//! - Anyone signed in can report a problem with a printer; admins see the
//!   open reports and resolve them.
//! - Anyone signed in can pre-heat an idle printer for the filament in a tray
//!   (or cool it down), but never one that is printing.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{self, CurrentUser};
use crate::db::Printer;
use crate::printer::status::state;
use crate::printer::{Command, PrinterStatus};
use crate::server::AppState;

type ApiError = (StatusCode, Json<Value>);

fn err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

fn printer(state: &AppState, id: &str) -> Result<Printer, ApiError> {
    state.db.get_printer(id).ok_or_else(|| err(StatusCode::NOT_FOUND, "no such printer"))
}

// -- Equipment reports -----------------------------------------------------------

#[derive(Deserialize)]
struct NewReport {
    description: String,
}

async fn create_report(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<NewReport>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let p = printer(&state, &id)?;
    let description = body.description.trim();
    if description.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "describe the problem"));
    }
    if description.chars().count() > 2000 {
        return Err(err(StatusCode::BAD_REQUEST, "keep it under 2000 characters"));
    }
    let report = state.db.create_printer_report(&p, Some(&user.id), description);
    println!("Printer {}: {} reported a problem: {description}", p.name, user.username);
    Ok((StatusCode::CREATED, Json(json!({"id": report}))))
}

#[derive(Deserialize)]
struct ReportsQuery {
    #[serde(default, deserialize_with = "crate::query::flag")]
    open: Option<bool>,
}

/// Admins: every report. Others: their own.
async fn list_reports(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Query(q): Query<ReportsQuery>,
) -> Json<Value> {
    let admin = auth::is_admin(&user);
    let reports: Vec<_> = state
        .db
        .list_printer_reports(q.open.unwrap_or(false))
        .into_iter()
        .filter(|r| admin || r.user_id.as_deref() == Some(user.id.as_str()))
        .collect();
    Json(json!(reports))
}

async fn resolve_report(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    auth::require_admin(&user)?;
    if state.db.resolve_printer_report(&id, &user.username) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(err(StatusCode::NOT_FOUND, "no such open report"))
    }
}

// -- Pre-heating -----------------------------------------------------------------

/// Typical nozzle and bed temperatures by material, for trays that don't say.
fn material_temps(material: &str) -> (i64, i64) {
    let m = material.to_ascii_uppercase();
    let base = m.split(['-', ' ']).next().unwrap_or("");
    match base {
        "PLA" => (220, 60),
        "PETG" | "PET" | "PCTG" => (250, 70),
        "ABS" | "ASA" => (260, 100),
        "TPU" => (230, 40),
        "PA" | "PA6" | "PAHT" | "PA12" | "PPA" => (280, 100),
        "PC" => (270, 110),
        "PVA" | "BVOH" => (220, 55),
        _ => (220, 60),
    }
}

/// Is the printer free to heat? (Never interfere with a print.)
fn idle(state: &AppState, p: &Printer) -> Result<PrinterStatus, ApiError> {
    if state.db.list_prints(Some(&p.id), true, 1).into_iter().next().is_some() {
        return Err(err(StatusCode::CONFLICT, format!("{} has a print in progress", p.name)));
    }
    let status = state
        .printers
        .status(&p.id)
        .ok_or_else(|| err(StatusCode::CONFLICT, format!("{} isn't connected", p.name)))?;
    if !status.online {
        return Err(err(StatusCode::CONFLICT, format!("{} is offline", p.name)));
    }
    if state::is_busy(status.state.as_deref()) {
        return Err(err(StatusCode::CONFLICT, format!("{} is printing", p.name)));
    }
    Ok(status)
}

async fn heat(state: &AppState, p: &Printer, nozzle: i64, bed: i64) -> Result<Json<Value>, ApiError> {
    let result = state.printers.command(&p.id, &Command::Heat { nozzle, bed }).await;
    crate::prints_api::command_response(result).map(|_| Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct Preheat {
    /// Heat for the filament in this tray slot (see status `Tray::slot`).
    slot: i64,
}

async fn preheat(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<Preheat>,
) -> Result<Json<Value>, ApiError> {
    let p = printer(&state, &id)?;
    let status = idle(&state, &p)?;
    let tray = status
        .ams
        .iter()
        .flat_map(|u| u.trays.iter())
        .chain(status.external.iter())
        .find(|t| t.slot == body.slot && t.material.is_some())
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "that slot holds no filament"))?;
    let material = tray.material.clone().unwrap_or_default();
    let (default_nozzle, bed) = material_temps(&material);
    let nozzle = match (tray.nozzle_temp_min, tray.nozzle_temp_max) {
        (Some(lo), Some(hi)) if lo > 0 && hi >= lo => (lo + hi) / 2 / 5 * 5,
        _ => default_nozzle,
    };
    println!("Printer {}: {} pre-heats for {material} (nozzle {nozzle}, bed {bed})", p.name, user.username);
    let result = heat(&state, &p, nozzle, bed).await?;
    let mut v = result.0;
    v["nozzle"] = json!(nozzle);
    v["bed"] = json!(bed);
    Ok(Json(v))
}

async fn cooldown(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let p = printer(&state, &id)?;
    idle(&state, &p)?;
    println!("Printer {}: {} cools it down", p.name, user.username);
    heat(&state, &p, 0, 0).await
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/printers/{id}/reports", post(create_report))
        .route("/api/printer-reports", get(list_reports))
        .route("/api/printer-reports/{id}/resolve", post(resolve_report))
        .route("/api/printers/{id}/preheat", post(preheat))
        .route("/api/printers/{id}/cooldown", post(cooldown))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temps_by_material() {
        assert_eq!(material_temps("PLA"), (220, 60));
        assert_eq!(material_temps("pla-cf"), (220, 60));
        assert_eq!(material_temps("PETG HF"), (250, 70));
        assert_eq!(material_temps("PA6-CF"), (280, 100));
        assert_eq!(material_temps("weird"), (220, 60));
    }
}
