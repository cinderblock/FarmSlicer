//! `/api/printer-access` and `/api/certifications`: printer access rules
//! and certifications (policy in src/access.rs). Rules and certifications
//! are made by holders of `printers.manage`; certifications are given by
//! holders of `certifications.grant`; everyone may ask where they stand.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post, put},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::access::{self, EFFECTS, TARGET_KINDS};
use crate::audit::{self, Target};
use crate::auth::{self, CurrentUser};
use crate::db::{AccessRule, Certification, Principal, User};
use crate::groups::Tree;
use crate::groups_api;
use crate::permissions::Cap;
use crate::server::AppState;

type ApiError = (StatusCode, Json<Value>);

fn err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

/// The target's name for people and the audit log.
fn target_name(state: &AppState, kind: &str, id: &str) -> Option<String> {
    match kind {
        "printer" => state.db.get_printer(id).map(|p| p.name),
        "pool" => state.db.get_pool(id).map(|p| format!("pool {}", p.name)),
        "model" => Some(id.to_string()),
        "site" => Some("every printer".into()),
        _ => None,
    }
}

fn rule_json(state: &AppState, tree: &Tree, r: &AccessRule) -> Value {
    let mut v = json!(r);
    v["target_name"] = json!(target_name(state, &r.target_kind, &r.target_id));
    v["who"] = json!(access::describe(&state.db, tree, &r.principal));
    v["approver_names"] = json!(r.approvers.iter().map(|p| access::describe(&state.db, tree, p)).collect::<Vec<_>>());
    v
}

fn rule_target(r: &AccessRule) -> String {
    format!("{}:{}", r.target_kind, r.target_id)
}

/// `GET /api/printer-access`: rules, certifications with their holders,
/// and what rules can target.
async fn overview(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Result<Json<Value>, ApiError> {
    if !auth::can(&user, Cap::PrintersManage) && !auth::can(&user, Cap::CertificationsGrant) {
        return Err(auth::missing(Cap::PrintersManage));
    }
    let tree = Tree::load(&state.db);
    let rules: Vec<Value> = state.db.list_access_rules().iter().map(|r| rule_json(&state, &tree, r)).collect();
    let holders = state.db.list_cert_holders();
    let certifications: Vec<Value> = state
        .db
        .list_certifications()
        .iter()
        .map(|c| {
            let mut v = json!(c);
            v["holders"] = json!(holders.iter().filter(|h| h.cert_id == c.id).collect::<Vec<_>>());
            v["rules"] = json!(state.db.certification_rule_count(&c.id));
            v
        })
        .collect();
    let printers = state.db.list_printers();
    let mut models: Vec<String> = printers.iter().map(|p| p.machine_profile.trim().to_string()).filter(|m| !m.is_empty()).collect();
    models.sort();
    models.dedup();
    Ok(Json(json!({
        "rules": rules,
        "certifications": certifications,
        "targets": {
            "printers": printers.iter().map(|p| json!({"id": p.id, "name": p.name, "model": p.machine_profile})).collect::<Vec<_>>(),
            "pools": state.db.list_pools().iter().map(|p| json!({"id": p.id, "name": p.name})).collect::<Vec<_>>(),
            "models": models,
        },
    })))
}

/// `GET /api/printer-access/mine`: where the caller stands with each printer.
async fn mine(State(state): State<Arc<AppState>>, Extension(CurrentUser(user)): Extension<CurrentUser>) -> Json<Value> {
    let (tree, viewer) = groups_api::context(&state, &user);
    let list: Vec<Value> = state
        .db
        .list_printers()
        .iter()
        .map(|p| {
            let d = access::decide(&state.db, &tree, Some(&viewer), p);
            json!({"printer_id": p.id, "name": p.name, "effect": d.effect, "why": d.why})
        })
        .collect();
    Json(json!({
        "printers": list,
        "certifications": state.db.certs_of_user(&user.id).iter().map(|h| {
            let mut v = json!(h);
            v["name"] = json!(state.db.get_certification(&h.cert_id).map(|c| c.name));
            v
        }).collect::<Vec<_>>(),
    }))
}

#[derive(Deserialize)]
struct RuleBody {
    #[serde(default)]
    target_kind: Option<String>,
    #[serde(default)]
    target_id: Option<String>,
    who: Principal,
    effect: String,
    #[serde(default)]
    approvers: Vec<Principal>,
    #[serde(default)]
    note: String,
}

/// A person may be named by username as well as by id.
fn by_username(state: &AppState, p: &mut Principal) {
    if p.kind == "user" && state.db.get_user(&p.id).is_none() {
        if let Some(u) = state.db.get_user_by_username(p.id.trim()) {
            p.id = u.id;
        }
    }
}

fn check_rule(state: &AppState, tree: &Tree, body: &mut RuleBody) -> Result<(), ApiError> {
    by_username(state, &mut body.who);
    for a in &mut body.approvers {
        by_username(state, a);
    }
    let bad = |e: String| err(StatusCode::BAD_REQUEST, e);
    access::validate_principal(&state.db, tree, &body.who).map_err(bad)?;
    if !EFFECTS.contains(&body.effect.as_str()) {
        return Err(bad(format!("effect: one of {}", EFFECTS.join(", "))));
    }
    if body.effect != "approve" && !body.approvers.is_empty() {
        return Err(bad("approvers go with effect 'approve'".into()));
    }
    if body.approvers.len() > 20 {
        return Err(bad("approvers: at most 20".into()));
    }
    for a in &body.approvers {
        if a.kind == "everyone" {
            return Err(bad("approvers: name who approves (not everyone)".into()));
        }
        access::validate_principal(&state.db, tree, a).map_err(|e| bad(format!("approvers: {e}")))?;
    }
    if body.note.len() > 300 {
        return Err(bad("note: up to 300 characters".into()));
    }
    Ok(())
}

async fn create_rule(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(mut body): Json<RuleBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    auth::require(&user, Cap::PrintersManage)?;
    let tree = Tree::load(&state.db);
    let kind = body.target_kind.clone().unwrap_or_default();
    if !TARGET_KINDS.contains(&kind.as_str()) {
        return Err(err(StatusCode::BAD_REQUEST, format!("target_kind: one of {}", TARGET_KINDS.join(", "))));
    }
    let id = match kind.as_str() {
        "site" => String::new(),
        _ => body.target_id.clone().map(|t| t.trim().to_string()).unwrap_or_default(),
    };
    let ok = match kind.as_str() {
        "printer" => state.db.get_printer(&id).is_some(),
        "pool" => state.db.get_pool(&id).is_some(),
        "model" => !id.is_empty() && id.len() <= 120,
        _ => true,
    };
    if !ok {
        return Err(err(StatusCode::BAD_REQUEST, format!("no such {kind}: '{id}'")));
    }
    check_rule(&state, &tree, &mut body)?;
    let rule = AccessRule {
        id: uuid::Uuid::new_v4().to_string(),
        target_kind: kind,
        target_id: id,
        position: 0,
        principal: body.who,
        effect: body.effect,
        approvers: body.approvers,
        note: body.note.trim().to_string(),
        created_by: Some(user.id.clone()),
        created_at: String::new(),
    };
    state.db.save_access_rule(&rule);
    let rule = state.db.get_access_rule(&rule.id).unwrap();
    let v = rule_json(&state, &tree, &rule);
    audit::record(
        &state.db,
        &user,
        "access.rule.create",
        Target { kind: "printer_access", id: &rule_target(&rule), name: v["target_name"].as_str().unwrap_or("") },
        json!({"who": v["who"], "effect": rule.effect, "approvers": v["approver_names"], "note": rule.note}),
    );
    crate::dispatch::poke(&state);
    Ok((StatusCode::CREATED, Json(v)))
}

async fn update_rule(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(mut body): Json<RuleBody>,
) -> Result<Json<Value>, ApiError> {
    auth::require(&user, Cap::PrintersManage)?;
    let tree = Tree::load(&state.db);
    let old = state.db.get_access_rule(&id).ok_or_else(|| err(StatusCode::NOT_FOUND, "no such rule"))?;
    check_rule(&state, &tree, &mut body)?;
    let before = rule_json(&state, &tree, &old);
    let rule = AccessRule { principal: body.who, effect: body.effect, approvers: body.approvers, note: body.note.trim().to_string(), ..old };
    state.db.save_access_rule(&rule);
    let v = rule_json(&state, &tree, &rule);
    audit::record(
        &state.db,
        &user,
        "access.rule.update",
        Target { kind: "printer_access", id: &rule_target(&rule), name: v["target_name"].as_str().unwrap_or("") },
        json!({
            "from": {"who": before["who"], "effect": before["effect"], "approvers": before["approver_names"]},
            "to": {"who": v["who"], "effect": v["effect"], "approvers": v["approver_names"]},
        }),
    );
    crate::dispatch::poke(&state);
    Ok(Json(v))
}

async fn delete_rule(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    auth::require(&user, Cap::PrintersManage)?;
    let tree = Tree::load(&state.db);
    let old = state.db.get_access_rule(&id).ok_or_else(|| err(StatusCode::NOT_FOUND, "no such rule"))?;
    let v = rule_json(&state, &tree, &old);
    state.db.delete_access_rule(&id);
    audit::record(
        &state.db,
        &user,
        "access.rule.delete",
        Target { kind: "printer_access", id: &rule_target(&old), name: v["target_name"].as_str().unwrap_or("") },
        json!({"who": v["who"], "effect": old.effect}),
    );
    crate::dispatch::poke(&state);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct OrderBody {
    target_kind: String,
    #[serde(default)]
    target_id: String,
    ids: Vec<String>,
}

/// `PUT /api/printer-access/order`: a target's rules in the order given.
async fn order_rules(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<OrderBody>,
) -> Result<StatusCode, ApiError> {
    auth::require(&user, Cap::PrintersManage)?;
    let mine: Vec<String> = state
        .db
        .list_access_rules()
        .into_iter()
        .filter(|r| r.target_kind == body.target_kind && r.target_id == body.target_id)
        .map(|r| r.id)
        .collect();
    let mut given = body.ids.clone();
    given.sort();
    let mut have = mine.clone();
    have.sort();
    if given != have {
        return Err(err(StatusCode::BAD_REQUEST, "ids: every rule of that target, once each"));
    }
    state.db.order_access_rules(&body.target_kind, &body.target_id, &body.ids);
    let name = target_name(&state, &body.target_kind, &body.target_id).unwrap_or_default();
    audit::record(
        &state.db,
        &user,
        "access.rule.order",
        Target { kind: "printer_access", id: &format!("{}:{}", body.target_kind, body.target_id), name: &name },
        json!({}),
    );
    crate::dispatch::poke(&state);
    Ok(StatusCode::NO_CONTENT)
}

// ---- certifications ---------------------------------------------------------------

#[derive(Deserialize)]
struct CertBody {
    name: String,
    #[serde(default)]
    description: String,
    /// How long a grant lasts; None = until taken back.
    #[serde(default)]
    valid_days: Option<i64>,
}

fn check_cert(body: &CertBody) -> Result<(), ApiError> {
    let n = body.name.trim();
    if n.is_empty() || n.chars().count() > 60 {
        return Err(err(StatusCode::BAD_REQUEST, "name: 1-60 characters"));
    }
    if body.description.len() > 300 {
        return Err(err(StatusCode::BAD_REQUEST, "description: up to 300 characters"));
    }
    if body.valid_days.is_some_and(|d| !(1..=3650).contains(&d)) {
        return Err(err(StatusCode::BAD_REQUEST, "valid_days: 1-3650, or none"));
    }
    Ok(())
}

fn cert_target(c: &Certification) -> Target<'_> {
    Target { kind: "certification", id: &c.id, name: &c.name }
}

async fn create_cert(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<CertBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    auth::require(&user, Cap::PrintersManage)?;
    check_cert(&body)?;
    let c = Certification {
        id: uuid::Uuid::new_v4().to_string(),
        name: body.name.trim().to_string(),
        description: body.description.trim().to_string(),
        valid_days: body.valid_days,
        created_at: String::new(),
    };
    state.db.save_certification(&c).map_err(|e| err(StatusCode::CONFLICT, e))?;
    let c = state.db.get_certification(&c.id).unwrap();
    audit::record(&state.db, &user, "certification.create", cert_target(&c), json!({"valid_days": c.valid_days}));
    Ok((StatusCode::CREATED, Json(json!(c))))
}

async fn update_cert(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<CertBody>,
) -> Result<Json<Value>, ApiError> {
    auth::require(&user, Cap::PrintersManage)?;
    let old = state.db.get_certification(&id).ok_or_else(|| err(StatusCode::NOT_FOUND, "no such certification"))?;
    check_cert(&body)?;
    let c = Certification { name: body.name.trim().to_string(), description: body.description.trim().to_string(), valid_days: body.valid_days, ..old.clone() };
    state.db.save_certification(&c).map_err(|e| err(StatusCode::CONFLICT, e))?;
    audit::record(
        &state.db,
        &user,
        "certification.update",
        cert_target(&c),
        json!({"from": {"name": old.name, "valid_days": old.valid_days}, "to": {"name": c.name, "valid_days": c.valid_days}}),
    );
    Ok(Json(json!(c)))
}

async fn delete_cert(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    auth::require(&user, Cap::PrintersManage)?;
    let old = state.db.get_certification(&id).ok_or_else(|| err(StatusCode::NOT_FOUND, "no such certification"))?;
    let rules = state.db.certification_rule_count(&id);
    if rules > 0 {
        return Err(err(
            StatusCode::CONFLICT,
            format!("{rules} access rule{} name{} it; change those first", if rules == 1 { "" } else { "s" }, if rules == 1 { "s" } else { "" }),
        ));
    }
    state.db.delete_certification(&id);
    audit::record(&state.db, &user, "certification.delete", cert_target(&old), json!({}));
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct GrantBody {
    username: String,
    /// Overrides the certification's own validity for this grant.
    #[serde(default)]
    valid_days: Option<i64>,
    #[serde(default)]
    note: String,
}

async fn grant(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<GrantBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    auth::require(&user, Cap::CertificationsGrant)?;
    let c = state.db.get_certification(&id).ok_or_else(|| err(StatusCode::NOT_FOUND, "no such certification"))?;
    let target: User = state
        .db
        .get_user_by_username(body.username.trim())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "no such user"))?;
    if body.valid_days.is_some_and(|d| !(1..=3650).contains(&d)) {
        return Err(err(StatusCode::BAD_REQUEST, "valid_days: 1-3650"));
    }
    if body.note.len() > 300 {
        return Err(err(StatusCode::BAD_REQUEST, "note: up to 300 characters"));
    }
    let days = body.valid_days.or(c.valid_days);
    state.db.grant_certification(&target.id, &c.id, &user.id, days, &body.note);
    audit::record(
        &state.db,
        &user,
        "certification.grant",
        cert_target(&c),
        json!({"user": target.username, "valid_days": days, "note": body.note.trim()}),
    );
    crate::dispatch::poke(&state);
    let holder = state.db.certs_of_user(&target.id).into_iter().find(|h| h.cert_id == c.id);
    Ok((StatusCode::CREATED, Json(json!(holder))))
}

async fn revoke(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((id, user_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    auth::require(&user, Cap::CertificationsGrant)?;
    let c = state.db.get_certification(&id).ok_or_else(|| err(StatusCode::NOT_FOUND, "no such certification"))?;
    let name = state.db.get_user(&user_id).map(|u| u.username).unwrap_or_default();
    if !state.db.revoke_certification(&user_id, &id) {
        return Err(err(StatusCode::NOT_FOUND, "they don't hold it"));
    }
    audit::record(&state.db, &user, "certification.revoke", cert_target(&c), json!({"user": name}));
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/printer-access", get(overview))
        .route("/api/printer-access/mine", get(mine))
        .route("/api/printer-access/rules", post(create_rule))
        .route("/api/printer-access/rules/{id}", put(update_rule).delete(delete_rule))
        .route("/api/printer-access/order", put(order_rules))
        .route("/api/certifications", post(create_cert))
        .route("/api/certifications/{id}", put(update_cert).delete(delete_cert))
        .route("/api/certifications/{id}/holders", post(grant))
        .route("/api/certifications/{id}/holders/{user_id}", delete(revoke))
}
