//! Joining groups: through a join link (`/join/<code>`) or a group listed
//! on the sign-in page, optionally walking down into subgroups (pick an
//! existing child, or type an identifier that creates the child when it is
//! new), as a signed-in user, a new passkey account, or a guest.
//!
//! The client sends the whole request every time (`entry` + `selection`);
//! the server re-resolves it from scratch, so nothing is trusted between
//! steps. Group creation and membership happen only in the finishing calls.

use axum::{
    extract::{Request, State},
    http::StatusCode,
    response::Response,
    routing::post,
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use webauthn_rs::prelude::*;

use crate::auth::{self, CurrentUser, RegisterPurpose};
use crate::auth_api;
use crate::db::{Group, JoinLink, User};
use crate::groups::{SubgroupPolicy, Tree};
use crate::groups_api;
use crate::server::AppState;

type ApiError = (StatusCode, Json<Value>);

fn err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

fn bad(msg: impl Into<String>) -> ApiError {
    err(StatusCode::BAD_REQUEST, msg)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Entry {
    /// A join link's code.
    #[serde(default)]
    pub code: Option<String>,
    /// A group listed on the sign-in page.
    #[serde(default)]
    pub group: Option<String>,
}

/// One step down the tree: an existing child (`group`) or an identifier
/// for a self-service child (`key`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Step {
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JoinRequest {
    pub entry: Entry,
    #[serde(default)]
    pub selection: Vec<Step>,
}

enum Target {
    Existing(Group),
    Create { parent: Group, key: String, name: String, policy: SubgroupPolicy },
}

struct Resolved {
    link: Option<JoinLink>,
    entry_group: Group,
    /// Groups walked through, entry first (existing ones only).
    walked: Vec<Group>,
    target: Target,
    /// The current group's subgroup policy when the joiner may (or must)
    /// go further down.
    next: Option<SubgroupPolicy>,
    can_finish: bool,
}

impl Resolved {
    /// The group whose effective settings govern this join: the target,
    /// or the parent of a group about to be created (which inherits).
    fn settings_group(&self) -> &Group {
        match &self.target {
            Target::Existing(g) => g,
            Target::Create { parent, .. } => parent,
        }
    }
}

fn resolve(state: &AppState, tree: &Tree, req: &JoinRequest) -> Result<Resolved, ApiError> {
    let gone = || err(StatusCode::NOT_FOUND, "this join link is invalid, disabled or used up");
    let (link, entry_group) = match (&req.entry.code, &req.entry.group) {
        (Some(code), _) => {
            let link = state.db.live_join_link_by_code(code).ok_or_else(gone)?;
            let g = tree.get(&link.group_id).cloned().ok_or_else(gone)?;
            (Some(link), g)
        }
        (None, Some(gid)) => {
            let g = tree.get(gid).cloned().ok_or_else(gone)?;
            if !tree.settings(gid).listed.unwrap_or(false) {
                return Err(gone());
            }
            (None, g)
        }
        (None, None) => return Err(bad("entry needs a code or a group")),
    };

    let mut walked = vec![entry_group.clone()];
    let mut cur = entry_group.clone();
    for (i, step) in req.selection.iter().enumerate() {
        let policy = tree
            .settings(&cur.id)
            .subgroups
            .filter(|p| p.mode != "none")
            .ok_or_else(|| bad(format!("{} has no subgroups to choose from", cur.name)))?;
        match policy.mode.as_str() {
            "choose" => {
                let gid = step.group.as_deref().ok_or_else(|| bad("pick a group"))?;
                let child = tree
                    .children(&cur.id)
                    .into_iter()
                    .find(|c| c.id == gid)
                    .cloned()
                    .ok_or_else(|| bad("that group is not an option here"))?;
                walked.push(child.clone());
                cur = child;
            }
            _ => {
                let key = policy
                    .check_key(step.key.as_deref().unwrap_or(""))
                    .map_err(bad)?;
                match state.db.child_group_by_key(&cur.id, &key) {
                    Some(child) => {
                        walked.push(child.clone());
                        cur = child;
                    }
                    None => {
                        if i + 1 != req.selection.len() {
                            return Err(bad("a new group cannot have further steps"));
                        }
                        let name = policy.child_name(&key);
                        return Ok(Resolved {
                            link,
                            entry_group,
                            walked,
                            target: Target::Create { parent: cur, key, name, policy },
                            next: None,
                            can_finish: true,
                        });
                    }
                }
            }
        }
    }
    let next = tree.settings(&cur.id).subgroups.filter(|p| p.mode != "none");
    let can_finish = !next.as_ref().is_some_and(|p| p.required);
    Ok(Resolved {
        link,
        entry_group,
        walked,
        target: Target::Existing(cur),
        next,
        can_finish,
    })
}

/// (status, role) a new membership would get.
fn outcome(tree: &Tree, r: &Resolved) -> (&'static str, &'static str) {
    match &r.target {
        Target::Create { policy, .. } => (
            "active",
            if policy.creator_becomes_manager { "manager" } else { "member" },
        ),
        Target::Existing(g) => {
            let bypass = r
                .link
                .as_ref()
                .is_some_and(|l| l.bypass_approval && l.group_id == g.id);
            if bypass || tree.effective(&g.id).join_policy == "open" {
                ("active", "member")
            } else {
                ("pending", "member")
            }
        }
    }
}

fn describe(state: &AppState, tree: &Tree, r: &Resolved, user: Option<&User>) -> Value {
    let eff = tree.effective(&r.settings_group().id);
    let (status, role) = outcome(tree, r);
    let target = match &r.target {
        Target::Existing(g) => json!({
            "exists": true,
            "id": g.id,
            "name": g.name,
            "path": tree.display_path(&g.id),
            "description": g.description,
            "membership": user.and_then(|u| state.db.get_membership(&g.id, &u.id)).map(|m| json!({"role": m.role, "status": m.status})),
        }),
        Target::Create { parent, name, .. } => json!({
            "exists": false,
            "name": name,
            "path": format!("{} / {name}", tree.display_path(&parent.id)),
        }),
    };
    let next = r.next.as_ref().map(|p| {
        let current = match &r.target {
            Target::Existing(g) => g.id.clone(),
            Target::Create { .. } => String::new(),
        };
        json!({
            "mode": p.mode,
            "required": p.required,
            "label": p.label,
            "pattern": p.pattern,
            "options": if p.mode == "choose" {
                tree.children(&current).iter().map(|c| json!({"id": c.id, "name": c.name, "description": c.description})).collect::<Vec<_>>()
            } else {
                Vec::new()
            },
        })
    });
    json!({
        "entry": {
            "id": r.entry_group.id,
            "name": r.entry_group.name,
            "description": r.entry_group.description,
            "link_label": r.link.as_ref().map(|l| l.label.clone()),
        },
        "walked": r.walked.iter().map(|g| json!({"id": g.id, "name": g.name})).collect::<Vec<_>>(),
        "target": target,
        "next": next,
        "can_finish": r.can_finish,
        "outcome": {"status": status, "role": role},
        "allow_registration": eff.allow_registration,
        "allow_guests": eff.allow_guests,
        "signed_in": user.map(|u| json!({"username": u.username, "kind": u.kind})),
    })
}

/// Create the target group if needed and add `user` to it.
fn apply(state: &AppState, req: &JoinRequest, user: &User) -> Result<Value, ApiError> {
    let tree = Tree::load(&state.db);
    let r = resolve(state, &tree, req)?;
    if !r.can_finish {
        let label = r.next.as_ref().map(|p| p.label.clone()).unwrap_or_default();
        return Err(bad(if label.is_empty() { "choose a subgroup first".to_string() } else { format!("enter a {label} first") }));
    }
    if user.kind == "guest" && !tree.effective(&r.settings_group().id).allow_guests {
        return Err(err(StatusCode::FORBIDDEN, "guest accounts cannot join this group"));
    }
    let (status, role) = outcome(&tree, &r);
    let group = match &r.target {
        Target::Existing(g) => g.clone(),
        Target::Create { parent, key, name, .. } => {
            match state.db.create_group(Some(&parent.id), name, "", "{}", Some(key), Some(&user.id)) {
                Ok(g) => {
                    println!("join: '{}' created group '{}' under '{}'", user.username, g.name, parent.name);
                    g
                }
                // Someone created it a moment ago: join that one instead.
                Err(_) => state
                    .db
                    .child_group_by_key(&parent.id, key)
                    .ok_or_else(|| err(StatusCode::CONFLICT, "could not create the group"))?,
            }
        }
    };
    let created = matches!(&r.target, Target::Create { .. })
        && group.created_by.as_deref() == Some(user.id.as_str());
    let (status, role) = if matches!(&r.target, Target::Create { .. }) && !created {
        // Lost the creation race: treat as joining an existing group.
        let tree = Tree::load(&state.db);
        let open = tree.effective(&group.id).join_policy == "open";
        (if open { "active" } else { "pending" }, "member")
    } else {
        (status, role)
    };
    match state.db.get_membership(&group.id, &user.id) {
        // Never downgrade an existing membership.
        Some(m) if m.status == "active" || status == "pending" => {}
        Some(m) => state.db.upsert_membership(&group.id, &user.id, &m.role, status),
        None => state.db.upsert_membership(&group.id, &user.id, role, status),
    }
    if let Some(l) = &r.link {
        state.db.count_join_link_use(&l.id);
    }
    let m = state.db.get_membership(&group.id, &user.id).unwrap();
    println!("join: '{}' joined '{}' ({} {})", user.username, group.name, m.status, m.role);
    Ok(json!({
        "group_id": group.id,
        "group_name": group.name,
        "created": created,
        "status": m.status,
        "role": m.role,
    }))
}

// ---- handlers ------------------------------------------------------------------------

/// Public: describe where a join request leads and what the next step is.
async fn join_resolve(State(state): State<Arc<AppState>>, req: Request) -> Result<Json<Value>, ApiError> {
    let user = auth::resolve_user(&state, &req);
    let bytes = axum::body::to_bytes(req.into_body(), 64 * 1024)
        .await
        .map_err(|e| bad(e.to_string()))?;
    let body: JoinRequest = serde_json::from_slice(&bytes).map_err(|e| bad(e.to_string()))?;
    let tree = Tree::load(&state.db);
    let r = resolve(&state, &tree, &body)?;
    Ok(Json(describe(&state, &tree, &r, user.as_ref())))
}

/// Signed in: join.
async fn join_finish(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<JoinRequest>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(apply(&state, &body, &user)?))
}

fn check_new_username(state: &AppState, username: &str) -> Result<String, ApiError> {
    if !auth::valid_username(username) {
        return Err(bad("username: 2-32 characters, letters, digits, . _ -"));
    }
    if state.db.get_user_by_username(username).is_some() {
        return Err(err(StatusCode::CONFLICT, "that username is taken"));
    }
    Ok(username.trim().to_string())
}

#[derive(Deserialize)]
struct RegisterStart {
    request: JoinRequest,
    username: String,
}

/// Public: start enrolling a passkey for a new account that will join.
async fn join_register_start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RegisterStart>,
) -> Result<Json<Value>, ApiError> {
    let tree = Tree::load(&state.db);
    let r = resolve(&state, &tree, &body.request)?;
    if !tree.effective(&r.settings_group().id).allow_registration {
        return Err(err(StatusCode::FORBIDDEN, "this group does not take new accounts; ask for an invite"));
    }
    if !r.can_finish {
        return Err(bad("finish choosing a group first"));
    }
    let username = check_new_username(&state, &body.username)?;
    let user_id = Uuid::new_v4().to_string();
    auth_api::begin_registration(
        &state,
        &user_id,
        &username,
        RegisterPurpose::Join {
            user_id: user_id.clone(),
            username: username.clone(),
            request: Box::new(body.request),
        },
    )
}

/// Public: finish the passkey enrolment, create the account, join.
async fn join_register_finish(
    State(state): State<Arc<AppState>>,
    Json(body): Json<auth_api::FinishRegistration>,
) -> Result<Response, ApiError> {
    let (reg_state, purpose) = auth_api::take_registration(&state, &body.flow_id)?;
    let RegisterPurpose::Join { user_id, username, request } = purpose else {
        return Err(bad("not a join registration"));
    };
    // Re-check everything: the link may have been used up meanwhile.
    let tree = Tree::load(&state.db);
    let r = resolve(&state, &tree, &request)?;
    if !tree.effective(&r.settings_group().id).allow_registration {
        return Err(err(StatusCode::FORBIDDEN, "this group does not take new accounts"));
    }
    let (cred_id, passkey_json) = auth_api::finish_registration(&state, &reg_state, &body.credential)?;
    let user = state
        .db
        .create_user(&user_id, &username, "user", "full")
        .map_err(|e| err(StatusCode::CONFLICT, e))?;
    state
        .db
        .add_passkey(&cred_id, &user.id, &auth_api::key_name(&body.key_name), &passkey_json)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let joined = apply(&state, &request, &user)?;
    let recovery_code = auth_api::issue_recovery_code(&state, &user.id);
    println!("join: new account '{}' registered with a passkey", user.username);
    Ok(auth_api::start_session(
        &state,
        &user,
        json!({"recovery_code": recovery_code, "joined": joined}),
        auth::SESSION_DAYS,
        auth::VIA_PASSKEY,
    ))
}

#[derive(Deserialize)]
struct GuestJoin {
    request: JoinRequest,
    username: String,
}

/// Public: create a guest account (no credential) and join.
async fn join_guest(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GuestJoin>,
) -> Result<Response, ApiError> {
    let tree = Tree::load(&state.db);
    let r = resolve(&state, &tree, &body.request)?;
    if !tree.effective(&r.settings_group().id).allow_guests {
        return Err(err(StatusCode::FORBIDDEN, "this group does not take guest accounts"));
    }
    if !r.can_finish {
        return Err(bad("finish choosing a group first"));
    }
    let username = check_new_username(&state, &body.username)?;
    let user = state
        .db
        .create_user(&Uuid::new_v4().to_string(), &username, "user", "guest")
        .map_err(|e| err(StatusCode::CONFLICT, e))?;
    let joined = match apply(&state, &body.request, &user) {
        Ok(j) => j,
        Err(e) => {
            state.db.delete_user(&user.id);
            return Err(e);
        }
    };
    let code = auth_api::issue_recovery_code(&state, &user.id);
    println!("join: guest account '{}' created", user.username);
    Ok(auth_api::start_session(
        &state,
        &user,
        json!({"signin_code": code, "joined": joined}),
        groups_api::guest_session_days(&state),
        auth::VIA_CODE,
    ))
}

#[derive(Deserialize)]
struct GuestSignin {
    username: String,
    code: String,
}

/// Public: a guest signs in on another device with their one-time code and
/// receives the next one.
async fn guest_signin(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GuestSignin>,
) -> Result<Response, ApiError> {
    let denied = || err(StatusCode::UNAUTHORIZED, "unknown guest or wrong sign-in code");
    let user = state.db.get_user_by_username(&body.username).ok_or_else(denied)?;
    if user.kind != "guest" {
        return Err(err(StatusCode::BAD_REQUEST, "that account signs in with a passkey"));
    }
    let code_hash = auth::sha256_hex(&auth::normalize_recovery_code(&body.code));
    if !state.db.recovery_code_valid(&user.id, &code_hash) {
        return Err(denied());
    }
    state.db.use_recovery_code(&code_hash);
    let next = auth_api::issue_recovery_code(&state, &user.id);
    println!("guest '{}' signed in with a sign-in code", user.username);
    Ok(auth_api::start_session(
        &state,
        &user,
        json!({"signin_code": next}),
        groups_api::guest_session_days(&state),
        auth::VIA_CODE,
    ))
}

/// No authentication required.
pub fn public_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/join/resolve", post(join_resolve))
        .route("/api/join/register/start", post(join_register_start))
        .route("/api/join/register/finish", post(join_register_finish))
        .route("/api/join/guest", post(join_guest))
        .route("/api/auth/guest/signin", post(guest_signin))
}

/// Behind `auth::require_auth`.
pub fn protected_routes() -> Router<Arc<AppState>> {
    Router::new().route("/api/join/finish", post(join_finish))
}
