//! Feedback API (policy and limits: src/feedback.rs).
//!
//! - `POST /api/feedback`: a manual report from the Feedback button.
//! - `POST /api/feedback/errors`: a batch of automatic error reports from
//!   the browser (`web/src/errorReporting.ts`), rate-limited per account.
//! - `GET /api/feedback`: admins see every report; everyone else their own
//!   manual reports and the automatic ones they hit (only their own
//!   occurrences of those). `?automatic=1|0`, `?kind=`, `?status=` (or
//!   `open`: new or acknowledged),
//!   `?mine=1` (admins: just their own), `?limit=`.
//! - `GET /api/feedback/counts`: reports per status, manual and automatic.
//! - `GET /api/feedback/{id}`: one report with its stack, context and
//!   occurrences.
//! - `PUT /api/feedback/{id}` (`status`, `admin_note`) and `DELETE`: admins.
//!
//! Like the rest of the API these need a signed-in account; approved remote
//! accounts can send feedback from the internet. Errors from before
//! sign-in wait in the browser.

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{self, CurrentUser};
use crate::db::{ErrorOccurrence, Feedback, FeedbackFilter, NewFeedback, Recorded, User};
use crate::feedback::{self as policy, Limit};
use crate::groups_api;
use crate::server::AppState;

type ApiError = (StatusCode, Json<Value>);

fn err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

fn rate_limited(limit: Limit, what: &str) -> ApiError {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({
            "error": format!("too many {what} for now; try again in a minute"),
            "retry_after_secs": limit.refill_secs().ceil() as u64,
        })),
    )
}

/// An optional text field: trimmed, empty as None, cut to `max` characters.
fn field(value: Option<&str>, max: usize) -> Option<String> {
    value.map(str::trim).filter(|s| !s.is_empty()).map(|s| policy::truncate(s, max))
}

fn user_agent(headers: &HeaderMap) -> Option<String> {
    field(headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()), policy::MAX_USER_AGENT)
}

// ---- manual reports ---------------------------------------------------------------------

#[derive(Deserialize)]
struct NewReport {
    kind: String,
    message: String,
    #[serde(default)]
    printer_id: Option<String>,
    #[serde(default)]
    job_id: Option<String>,
    /// The page the report was written on.
    #[serde(default)]
    page_url: Option<String>,
    /// The web app's build (`__BUILD_VERSION__`).
    #[serde(default)]
    version: Option<String>,
    /// Diagnostics, when the reporter agreed to include them.
    #[serde(default)]
    context: Option<Value>,
}

async fn create(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    headers: HeaderMap,
    Json(body): Json<NewReport>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if !policy::KINDS.contains(&body.kind.as_str()) {
        return Err(err(StatusCode::BAD_REQUEST, format!("kind must be one of {}", policy::KINDS.join(", "))));
    }
    let message = body.message.trim();
    if message.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "write what happened"));
    }
    if message.chars().count() > policy::MAX_MESSAGE {
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!("keep it under {} characters", policy::MAX_MESSAGE),
        ));
    }
    let printer_id = body.printer_id.as_deref().filter(|p| !p.is_empty());
    if printer_id.is_some_and(|p| state.db.get_printer(p).is_none()) {
        return Err(err(StatusCode::BAD_REQUEST, "no such printer"));
    }
    let job_id = body.job_id.as_deref().filter(|j| !j.is_empty());
    if let Some(j) = job_id {
        let (tree, viewer) = groups_api::context(&state, &user);
        if !state.db.get_job(j).is_some_and(|job| viewer.can_see_job(&tree, &job)) {
            return Err(err(StatusCode::BAD_REQUEST, "no such job"));
        }
    }
    if policy::take(&user.id, Limit::Manual, 1) == 0 {
        return Err(rate_limited(Limit::Manual, "reports"));
    }
    let context = policy::limit_context(body.context.as_ref(), policy::MAX_CONTEXT);
    let id = state.db.create_feedback(&NewFeedback {
        kind: &body.kind,
        message,
        user_id: Some(&user.id),
        printer_id,
        job_id,
        page_url: field(body.page_url.as_deref(), policy::MAX_URL).as_deref(),
        user_agent: user_agent(&headers).as_deref(),
        version: field(body.version.as_deref(), policy::MAX_VERSION).as_deref(),
        context: context.as_deref(),
    });
    println!("Feedback ({}) from {}: {}", body.kind, user.username, policy::truncate(message, 300));
    Ok((StatusCode::CREATED, Json(json!(state.db.get_feedback(&id)))))
}

// ---- automatic reports ----------------------------------------------------------------

#[derive(Deserialize)]
struct ErrorBatch {
    reports: Vec<ClientError>,
}

#[derive(Deserialize)]
struct ClientError {
    /// Where it was caught (`feedback::CLIENT_SOURCES`).
    source: String,
    message: String,
    #[serde(default)]
    stack: Option<String>,
    /// `app` unless the client knows better (`slicer` for its engine).
    #[serde(default)]
    kind: Option<String>,
    /// The page it happened on.
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    version: Option<String>,
    /// How many times it happened since the last batch.
    #[serde(default)]
    count: Option<i64>,
    #[serde(default)]
    context: Option<Value>,
}

async fn create_errors(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    headers: HeaderMap,
    Json(batch): Json<ErrorBatch>,
) -> Result<Json<Value>, ApiError> {
    if batch.reports.len() > policy::MAX_BATCH {
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!("at most {} reports per request", policy::MAX_BATCH),
        ));
    }
    if batch.reports.is_empty() {
        return Ok(Json(json!({"accepted": 0, "dropped": 0})));
    }
    let granted = policy::take(&user.id, Limit::Errors, batch.reports.len());
    if granted == 0 {
        return Err(rate_limited(Limit::Errors, "error reports"));
    }
    let agent = user_agent(&headers);
    let mut accepted = 0;
    for r in batch.reports.iter().take(granted) {
        let message = policy::truncate(r.message.trim(), policy::MAX_ERROR_MESSAGE);
        if message.is_empty() || !policy::CLIENT_SOURCES.contains(&r.source.as_str()) {
            continue;
        }
        let kind = r.kind.as_deref().filter(|k| policy::KINDS.contains(k)).unwrap_or("app");
        let stack = field(r.stack.as_deref(), policy::MAX_STACK);
        let context = policy::limit_context(r.context.as_ref(), policy::MAX_ERROR_CONTEXT);
        let recorded = policy::record(
            &state.db,
            &ErrorOccurrence {
                kind,
                source: &r.source,
                fingerprint: &policy::fingerprint(&r.source, &message, stack.as_deref()),
                message: &message,
                stack: stack.as_deref(),
                user_id: Some(&user.id),
                printer_id: None,
                job_id: None,
                page_url: field(r.url.as_deref(), policy::MAX_URL).as_deref(),
                user_agent: agent.as_deref(),
                version: field(r.version.as_deref(), policy::MAX_VERSION).as_deref(),
                context: context.as_deref(),
                count: r.count.unwrap_or(1).clamp(1, policy::MAX_REPEAT),
            },
            &user.username,
        );
        if recorded != Recorded::Dropped {
            accepted += 1;
        }
    }
    Ok(Json(json!({"accepted": accepted, "dropped": batch.reports.len() - accepted})))
}

// ---- reading and triage ---------------------------------------------------------------

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default, deserialize_with = "crate::query::flag")]
    automatic: Option<bool>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default, deserialize_with = "crate::query::flag")]
    mine: Option<bool>,
    #[serde(default)]
    limit: Option<i64>,
}

/// An automatic report as one of the accounts that hit it sees it: their
/// own occurrences only, nothing about anyone else's.
fn as_reporter(state: &AppState, mut f: Feedback, user: &User, with_occurrences: bool) -> Feedback {
    if !f.automatic {
        return f;
    }
    let own = state.db.feedback_occurrences(&f.id, Some(&user.id));
    f.count = own.iter().map(|o| o.count).sum();
    if let Some(latest) = own.first() {
        f.last_seen = latest.last_seen.clone();
        f.message = latest.message.clone().unwrap_or(f.message);
        f.page_url = latest.page_url.clone();
        f.user_agent = latest.user_agent.clone();
        f.version = Some(latest.version.clone()).filter(|v| !v.is_empty());
    }
    if let Some(first) = own.iter().map(|o| o.first_seen.as_str()).min() {
        f.created_at = first.to_string();
    }
    f.user_id = Some(user.id.clone());
    f.username = Some(user.username.clone());
    f.fingerprint = None;
    f.printer_id = None;
    f.printer_name = None;
    f.job_id = None;
    f.job_name = None;
    f.context = None;
    f.affected_users = 1;
    f.versions = own.iter().map(|o| o.version.clone()).filter(|v| !v.is_empty()).collect();
    f.occurrences = if with_occurrences { own } else { Vec::new() };
    f
}

async fn list(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Query(q): Query<ListQuery>,
) -> Json<Value> {
    let admin = auth::is_admin(&user);
    let own = !admin || q.mine.unwrap_or(false);
    let filter = FeedbackFilter {
        automatic: q.automatic,
        kind: q.kind.filter(|k| !k.is_empty()),
        status: q.status.filter(|s| !s.is_empty()),
        user_id: own.then(|| user.id.clone()),
        limit: q.limit.unwrap_or(200).clamp(1, 500),
    };
    let items: Vec<Feedback> = state
        .db
        .list_feedback(&filter)
        .into_iter()
        .map(|f| if own { as_reporter(&state, f, &user, false) } else { f })
        .collect();
    Json(json!(items))
}

async fn counts(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Json<Value> {
    let own = (!auth::is_admin(&user)).then_some(user.id.as_str());
    let mut out = json!({"manual": {}, "automatic": {}});
    for status in policy::STATUSES {
        out["manual"][status] = json!(0);
        out["automatic"][status] = json!(0);
    }
    for (automatic, status, n) in state.db.feedback_counts(own) {
        out[if automatic { "automatic" } else { "manual" }][status] = json!(n);
    }
    Json(out)
}

/// A report the caller may read: admins any; others their own manual
/// reports and the automatic ones they hit (as they see them).
fn readable(state: &AppState, user: &User, id: &str) -> Result<Feedback, ApiError> {
    let not_found = || err(StatusCode::NOT_FOUND, "no such report");
    let mut f = state.db.get_feedback(id).ok_or_else(not_found)?;
    if auth::is_admin(user) {
        if f.automatic {
            f.occurrences = state.db.feedback_occurrences(id, None);
        }
        return Ok(f);
    }
    if f.automatic {
        let reporter = as_reporter(state, f, user, true);
        return if reporter.occurrences.is_empty() { Err(not_found()) } else { Ok(reporter) };
    }
    if f.user_id.as_deref() == Some(user.id.as_str()) { Ok(f) } else { Err(not_found()) }
}

async fn get_one(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!(readable(&state, &user, &id)?)))
}

#[derive(Deserialize)]
struct Triage {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    admin_note: Option<String>,
}

async fn update(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<Triage>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&user)?;
    if let Some(s) = &body.status {
        if !policy::STATUSES.contains(&s.as_str()) {
            return Err(err(
                StatusCode::BAD_REQUEST,
                format!("status must be one of {}", policy::STATUSES.join(", ")),
            ));
        }
    }
    let note = body.admin_note.as_deref().map(str::trim);
    if note.is_some_and(|n| n.chars().count() > policy::MAX_NOTE) {
        return Err(err(StatusCode::BAD_REQUEST, format!("keep the note under {} characters", policy::MAX_NOTE)));
    }
    if !state.db.update_feedback(&id, body.status.as_deref(), note) {
        return Err(err(StatusCode::NOT_FOUND, "no such report"));
    }
    Ok(Json(json!(readable(&state, &user, &id)?)))
}

async fn delete(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    auth::require_admin(&user)?;
    if state.db.delete_feedback(&id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(err(StatusCode::NOT_FOUND, "no such report"))
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/feedback", get(list).post(create))
        .route("/api/feedback/errors", post(create_errors))
        .route("/api/feedback/counts", get(counts))
        .route("/api/feedback/{id}", get(get_one).put(update).delete(delete))
        // Reports are small; the API's default allows model uploads.
        .layer(DefaultBodyLimit::max(policy::MAX_BODY))
}
