//! The audit log: a record of who changed who may do what (accounts,
//! roles, memberships, groups, site settings) and who decided approvals.
//! Storage in src/db/audit.rs; `GET /api/audit` (capability `audit.view`).
//!
//! Actions are dotted, noun first (`user.role`, `group.member.add`), so a
//! prefix filters a family. `detail` says what changed (`from`/`to`, the
//! reason): enough to read the entry without the thing it names.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::get,
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::auth::{self, CurrentUser};
use crate::db::{AuditFilter, Db, NewAudit, User};
use crate::permissions::Cap;
use crate::server::AppState;

/// What an entry is about.
pub struct Target<'a> {
    pub kind: &'a str,
    pub id: &'a str,
    pub name: &'a str,
}

pub fn record(db: &Db, actor: &User, action: &str, target: Target<'_>, detail: Value) {
    println!("audit: '{}' {action} {} '{}' {detail}", actor.username, target.kind, target.name);
    db.add_audit(&NewAudit {
        actor_id: Some(&actor.id),
        actor_name: &actor.username,
        action,
        target_kind: target.kind,
        target_id: target.id,
        target_name: target.name,
        detail: &detail,
    });
}

pub fn user(u: &User) -> Target<'_> {
    Target { kind: "user", id: &u.id, name: &u.username }
}

#[derive(Deserialize)]
struct AuditQuery {
    actor: Option<String>,
    action: Option<String>,
    target_kind: Option<String>,
    target: Option<String>,
    before: Option<i64>,
    limit: Option<i64>,
}

/// `GET /api/audit?actor=&action=<prefix>&target_kind=&target=&before=&limit=`,
/// newest first.
async fn list(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Query(q): Query<AuditQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    auth::require(&user, Cap::AuditView)?;
    let nonempty = |s: Option<String>| s.filter(|s| !s.trim().is_empty());
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let entries = state.db.list_audit(&AuditFilter {
        actor_id: nonempty(q.actor),
        action_prefix: nonempty(q.action),
        target_kind: nonempty(q.target_kind),
        target_id: nonempty(q.target),
        before: q.before,
        limit,
    });
    let next = (entries.len() as i64 == limit).then(|| entries.last().map(|e| e.id)).flatten();
    Ok(Json(json!({"entries": entries, "next_before": next})))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/api/audit", get(list))
}
