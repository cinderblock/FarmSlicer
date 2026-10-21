//! Printers that take the queue by themselves. Each printer has a send
//! mode:
//!
//! - `manual` (the default): someone presses Send next (or sends a plate).
//! - `confirm`: when the printer is free and someone has said its bed is
//!   clear since its last print (the Queue page, or "the bed is clear" with
//!   a print's outcome), the next plate that fits goes out.
//! - `yolo`: the next plate goes out as soon as the printer is free, with
//!   no confirmation (auto-ejecting and belt printers, or an operator who
//!   accepts the risk), after failed prints too: printers that check their
//!   bed refuse to start on one that isn't clear. After such a refusal it
//!   waits for the bed, so it never retries in a loop.
//!
//! The queue's sends go out as whoever set the mode (an admin or an
//! operator of the printer), through the same checks as any send; a plate
//! the checks refuse (filament not loaded, G-code that needs a review) is
//! skipped for ten minutes and the next one is tried. The mode setter
//! losing their rights stops the printer taking the queue.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::auth::CurrentUser;
use crate::db::{Dispatch, Printer};
use crate::groups_api;
use crate::server::AppState;

pub const MODES: &[&str] = &["manual", "confirm", "yolo"];

/// A plate a printer refused is left alone this long.
const SKIP_FOR: Duration = Duration::from_secs(600);

fn wake() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

fn skipped() -> &'static Mutex<HashMap<(String, String), Instant>> {
    static SKIPPED: OnceLock<Mutex<HashMap<(String, String), Instant>>> = OnceLock::new();
    SKIPPED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How a printer takes the queue.
pub fn send_mode(state: &AppState, printer: &Printer) -> String {
    state.db.dispatch(&printer.id).send_mode
}

/// Something changed that may let a printer take the next plate.
pub fn poke(_state: &AppState) {
    wake().notify_one();
}

/// What a printer in an automatic mode is waiting for, if anything but a
/// plate: "bed" (someone to say it's clear).
pub fn waiting_for(state: &AppState, d: &Dispatch) -> Option<&'static str> {
    if d.send_mode == "manual" {
        return None;
    }
    let last = state.db.list_prints(Some(&d.printer_id), false, 1).into_iter().next();
    let ready = ready(
        &d.send_mode,
        last.as_ref().is_some_and(|p| p.status == "failed" && crate::printing::refused_start(p.error.as_deref())),
        last.as_ref().and_then(|p| p.finished_at.as_deref()),
        d.bed_clear_at.as_deref(),
    );
    (!ready).then_some("bed")
}

/// May a printer in `mode` take a plate, its last print having ended as
/// `last` at `ended_at` (None: it has never printed) and the bed last said
/// clear at `cleared_at`? (Times in the database's sortable format.)
pub fn ready(mode: &str, refused: bool, ended_at: Option<&str>, cleared_at: Option<&str>) -> bool {
    let cleared_since_last = match (cleared_at, ended_at) {
        (Some(c), Some(e)) => c >= e,
        (Some(_), None) => true,
        (None, _) => false,
    };
    match mode {
        // On whatever the last print left (the printer checks the bed and
        // refuses when it must), except after such a refusal.
        "yolo" => !refused || cleared_since_last,
        "confirm" => cleared_since_last,
        _ => false,
    }
}

/// One pass: every automatic printer that is free and ready gets its next
/// plate.
async fn tick(state: &Arc<AppState>) {
    for d in state.db.automatic_printers() {
        let Some(printer) = state.db.get_printer(&d.printer_id) else { continue };
        if crate::prints_api::busy_reason(state, &printer).is_some() || waiting_for(state, &d).is_some() {
            continue;
        }
        // Sends go out as whoever set the mode, while they may.
        let Some(user) = d.set_by.as_deref().and_then(|u| state.db.get_user(u)) else { continue };
        let (tree, viewer) = groups_api::context(state, &user);
        if !viewer.admin && !crate::pools::operates(state, &viewer, Some(&printer.id)) {
            continue;
        }
        let now = Instant::now();
        skipped().lock().unwrap().retain(|_, at| now.duration_since(*at) < SKIP_FOR);
        let candidates: Vec<_> = state
            .db
            .list_queue(&["queued"], 500)
            .into_iter()
            .filter(|e| !e.held)
            .filter(|e| !skipped().lock().unwrap().contains_key(&(printer.id.clone(), e.id.clone())))
            .filter(|e| crate::queue::fit(state, e, &printer).refused.is_none())
            .collect();
        for e in candidates {
            let body = crate::queue_api::SendBody::default();
            match crate::queue_api::send_entry(state, &user, &tree, &viewer, &e, &printer.id, &body).await {
                Ok(_) => {
                    println!("Dispatch: {} ({}) takes {} plate {} by itself", printer.name, d.send_mode, e.job_name, e.plate);
                    state.db.set_bed_clear(&printer.id, false);
                    break;
                }
                Err((_, Json(err))) => {
                    println!(
                        "Dispatch: {} skips {} plate {} for now: {}",
                        printer.name,
                        e.job_name,
                        e.plate,
                        err["error"].as_str().unwrap_or("refused")
                    );
                    skipped().lock().unwrap().insert((printer.id.clone(), e.id.clone()), Instant::now());
                }
            }
        }
    }
}

/// What the last report of each printer said, for spotting changes.
type Seen = HashMap<String, (Option<bool>, Option<String>)>;

/// Signs, in a printer's reports, that someone cleared its bed: the door
/// closed after being open (the person reached in), or a Prusa set to
/// READY on its screen. Each counts as "the bed is clear" from then on;
/// a door cycle during a print doesn't, as the print ends after it.
fn watch(state: &AppState, status: &crate::printer::status::PrinterStatus, seen: &mut Seen) -> bool {
    let now = (status.door_open, status.vendor_state.clone());
    let Some((door, vendor)) = seen.insert(status.printer_id.clone(), now) else { return false };
    let closed = door == Some(true) && status.door_open == Some(false);
    let ready = vendor.as_deref() != Some("READY") && status.vendor_state.as_deref() == Some("READY");
    if !(closed || ready) {
        return false;
    }
    state.db.set_bed_clear(&status.printer_id, true);
    if let Some(p) = state.db.get_printer(&status.printer_id) {
        println!("Dispatch: {} {}: the bed counts as clear", p.name, if closed { "door opened and closed" } else { "set to READY" });
    }
    true
}

/// Run the dispatcher: on every poke, every printer report (doors), and
/// every 15 s.
pub async fn run(state: Arc<AppState>) {
    let mut events = state.printers.subscribe();
    let mut seen = Seen::new();
    for s in state.printers.statuses() {
        watch(&state, &s, &mut seen);
    }
    loop {
        tick(&state).await;
        loop {
            tokio::select! {
                _ = wake().notified() => break,
                _ = tokio::time::sleep(Duration::from_secs(15)) => break,
                event = events.recv() => match event {
                    Ok(status) => {
                        if watch(&state, &status, &mut seen) {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        for s in state.printers.statuses() {
                            watch(&state, &s, &mut seen);
                        }
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        tokio::time::sleep(Duration::from_secs(15)).await;
                        break;
                    }
                },
            }
        }
    }
}

// -- API -----------------------------------------------------------------------------

type ApiError = (StatusCode, Json<Value>);

fn api_err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

/// A printer's dispatch state for pages: mode, who set it, what it waits for.
pub fn view(state: &AppState, printer_id: &str) -> Value {
    let d = state.db.dispatch(printer_id);
    json!({
        "send_mode": d.send_mode,
        "set_by": d.set_by_name,
        "set_at": d.set_at,
        "bed_clear_at": d.bed_clear_at,
        "waiting_for": waiting_for(state, &d),
        // How the printer can say its bed was cleared: "door" (opened and
        // closed), "ready" (set READY on its screen), else only the button.
        "clear_signal": clear_signal(state, printer_id),
    })
}

/// How a printer tells us its bed was cleared, when it can.
fn clear_signal(state: &AppState, printer_id: &str) -> Option<&'static str> {
    let printer = state.db.get_printer(printer_id)?;
    if state.printers.status(printer_id).is_some_and(|s| s.door_open.is_some()) {
        return Some("door");
    }
    (crate::printer::protocol_of(&printer) == Some(crate::printer::Protocol::PrusaLink)).then_some("ready")
}

#[derive(Deserialize)]
struct ModeBody {
    mode: String,
    /// Required for `yolo`: plates go out with nobody checking the bed.
    #[serde(default)]
    acknowledge: bool,
}

/// `POST /api/printers/{id}/send-mode` (admins, the printer's operators).
async fn set_mode(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<ModeBody>,
) -> Result<Json<Value>, ApiError> {
    let (_, viewer) = groups_api::context(&state, &user);
    let printer = state.db.get_printer(&id).ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such printer"))?;
    if !viewer.admin && !crate::pools::operates(&state, &viewer, Some(&id)) {
        return Err(api_err(StatusCode::FORBIDDEN, "only admins and the printer's operators choose how it takes the queue"));
    }
    if !MODES.contains(&body.mode.as_str()) {
        return Err(api_err(StatusCode::BAD_REQUEST, format!("mode: one of {}", MODES.join(", "))));
    }
    if body.mode == "yolo" && !body.acknowledge {
        return Err(api_err(
            StatusCode::BAD_REQUEST,
            "YOLO sends plates with nobody checking the bed: send acknowledge: true to mean it",
        ));
    }
    if auth_less(&user) && body.mode != "manual" {
        return Err(api_err(StatusCode::CONFLICT, "authentication is disabled: automatic sends need an account to send as"));
    }
    state.db.set_send_mode(&id, &body.mode, &user.id);
    println!("Dispatch: {} sets {} to {}", user.username, printer.name, body.mode);
    poke(&state);
    Ok(Json(view(&state, &id)))
}

/// FARMSLICER_NO_AUTH's stand-in user has no account row to send as.
fn auth_less(user: &crate::db::User) -> bool {
    crate::auth::auth_disabled() && user.id == "dev"
}

/// `POST /api/printers/{id}/bed-clear`: the bed is clear; a printer in
/// `confirm` mode (or `yolo` after the printer refused a start) takes the
/// next plate.
async fn bed_clear(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (_, viewer) = groups_api::context(&state, &user);
    state.db.get_printer(&id).ok_or_else(|| api_err(StatusCode::NOT_FOUND, "no such printer"))?;
    let last_sender = state
        .db
        .list_prints(Some(&id), false, 1)
        .into_iter()
        .next()
        .is_some_and(|p| p.user_id.as_deref() == Some(user.id.as_str()));
    if !viewer.admin && !crate::pools::operates(&state, &viewer, Some(&id)) && !last_sender {
        return Err(api_err(StatusCode::FORBIDDEN, "only admins, the printer's operators and whoever printed last can"));
    }
    state.db.set_bed_clear(&id, true);
    poke(&state);
    Ok(Json(view(&state, &id)))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/printers/{id}/send-mode", post(set_mode))
        .route("/api/printers/{id}/bed-clear", post(bed_clear))
}

#[cfg(test)]
mod tests {
    use super::ready;

    #[test]
    fn confirm_waits_for_the_bed() {
        assert!(!ready("confirm", false, None, None), "even a new printer needs a yes");
        assert!(ready("confirm", false, None, Some("2026-10-20 10:00:00")));
        assert!(!ready("confirm", false, Some("2026-10-20 11:00:00"), Some("2026-10-20 10:00:00")), "cleared before the last print");
        assert!(ready("confirm", false, Some("2026-10-20 11:00:00"), Some("2026-10-20 11:05:00")));
    }

    #[test]
    fn yolo_goes_on_unless_the_printer_refused() {
        assert!(ready("yolo", false, None, None));
        assert!(ready("yolo", false, Some("2026-10-20 11:00:00"), None), "after a print, failed or not");
        assert!(!ready("yolo", true, Some("2026-10-20 11:00:00"), None), "the printer said the bed wasn't ready");
        assert!(!ready("yolo", true, Some("2026-10-20 11:00:00"), Some("2026-10-20 10:00:00")));
        assert!(ready("yolo", true, Some("2026-10-20 11:00:00"), Some("2026-10-20 11:01:00")), "until it's cleared");
    }

    #[test]
    fn manual_never_sends() {
        assert!(!ready("manual", false, None, Some("2026-10-20 11:01:00")));
    }
}
