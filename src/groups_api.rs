//! HTTP handlers for groups, their members, join links, libraries and
//! quota usage, plus the site-wide runtime settings. Policy lives in
//! src/groups.rs and src/quota.rs.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, put},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

use crate::auth::{self, CurrentUser};
use crate::db::{Group, JobFilter, JoinLink, Membership};
use crate::groups::{self, GroupSettings, Tree, Viewer};
use crate::quota::{self, GroupQuotas, Rule};
use crate::server::AppState;

type ApiError = (StatusCode, Json<Value>);

fn err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

fn not_found() -> ApiError {
    err(StatusCode::NOT_FOUND, "group not found")
}

fn forbidden(msg: &str) -> ApiError {
    err(StatusCode::FORBIDDEN, msg)
}

pub fn context(state: &AppState, user: &crate::db::User) -> (Tree, Viewer) {
    (Tree::load(&state.db), Viewer::load(&state.db, user))
}

/// May the viewer look at this group at all?
fn can_view(tree: &Tree, viewer: &Viewer, id: &str) -> bool {
    viewer.membership(id).is_some() || viewer.can_manage(tree, id)
}

pub fn group_summary(tree: &Tree, viewer: &Viewer, g: &Group, counts: &HashMap<String, i64>) -> Value {
    let mine = viewer.membership(&g.id);
    json!({
        "id": g.id,
        "parent_id": g.parent_id,
        "name": g.name,
        "path": tree.display_path(&g.id),
        "description": g.description,
        "self_key": g.self_key,
        "member_count": counts.get(&g.id).copied().unwrap_or(0),
        "my_role": mine.map(|m| m.role.clone()),
        "my_status": mine.map(|m| m.status.clone()),
        "can_manage": viewer.can_manage(tree, &g.id),
        "created_at": g.created_at,
    })
}

fn member_json(m: &Membership) -> Value {
    json!({
        "user_id": m.user_id,
        "username": m.username,
        "kind": m.user_kind,
        "role": m.role,
        "status": m.status,
        "quotas": m.quotas.as_deref().map(quota::parse_rules),
        "joined_at": m.joined_at,
    })
}

pub fn link_json(state: &AppState, l: &JoinLink) -> Value {
    json!({
        "id": l.id,
        "group_id": l.group_id,
        "code": l.code,
        "url": format!("{}join/{}", state.rp.origin, l.code),
        "public": l.public,
        "bypass_approval": l.bypass_approval,
        "label": l.label,
        "max_uses": l.max_uses,
        "uses": l.uses,
        "expires_at": l.expires_at,
        "disabled": l.disabled,
        "created_at": l.created_at,
    })
}

// ---- groups --------------------------------------------------------------------

/// Groups the caller belongs to or manages (admins: all), flat, with paths.
async fn list_groups(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Json<Value> {
    let (tree, viewer) = context(&state, &user);
    let counts = state.db.member_counts();
    let mut out: Vec<(&Group, String)> = tree
        .groups
        .values()
        .filter(|g| can_view(&tree, &viewer, &g.id))
        .map(|g| (g, tree.display_path(&g.id)))
        .collect();
    out.sort_by(|a, b| groups::natural_cmp(&a.1, &b.1));
    Json(json!(out
        .into_iter()
        .map(|(g, _)| group_summary(&tree, &viewer, g, &counts))
        .collect::<Vec<_>>()))
}

#[derive(Deserialize)]
struct CreateGroup {
    name: String,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    settings: Option<GroupSettings>,
}

fn valid_name(name: &str) -> Result<(), ApiError> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 80 {
        return Err(err(StatusCode::BAD_REQUEST, "name: 1-80 characters"));
    }
    Ok(())
}

async fn create_group(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<CreateGroup>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    auth::require_full(&user)?;
    let (tree, viewer) = context(&state, &user);
    valid_name(&body.name)?;
    match &body.parent_id {
        None if !viewer.admin => return Err(forbidden("only admins create top-level groups")),
        Some(p) if tree.get(p).is_none() => return Err(not_found()),
        Some(p) if !viewer.can_manage(&tree, p) => {
            return Err(forbidden("you don't manage the parent group"));
        }
        _ => {}
    }
    let settings = body.settings.unwrap_or_default();
    settings.validate().map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    if settings.listed.is_some() && !viewer.admin {
        return Err(forbidden("only admins list groups on the sign-in page"));
    }
    let group = state
        .db
        .create_group(
            body.parent_id.as_deref(),
            &body.name,
            body.description.as_deref().unwrap_or(""),
            &serde_json::to_string(&settings).unwrap(),
            None,
            Some(&user.id),
        )
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    let (tree, viewer) = context(&state, &user);
    Ok((
        StatusCode::CREATED,
        Json(group_summary(&tree, &viewer, &group, &state.db.member_counts())),
    ))
}

async fn get_group(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = context(&state, &user);
    let Some(g) = tree.get(&id) else { return Err(not_found()) };
    if !can_view(&tree, &viewer, &id) {
        return Err(not_found());
    }
    let counts = state.db.member_counts();
    let manage = viewer.can_manage(&tree, &id);
    let mut v = group_summary(&tree, &viewer, g, &counts);
    let obj = v.as_object_mut().unwrap();
    obj.insert("settings".into(), json!(tree.settings(&id)));
    obj.insert("effective".into(), json!(tree.effective(&id)));
    obj.insert("quotas".into(), json!(GroupQuotas::parse(&g.quotas)));
    obj.insert("can_govern".into(), json!(viewer.can_govern(&tree, &id)));
    obj.insert("is_admin".into(), json!(viewer.admin));
    obj.insert(
        "ancestors".into(),
        json!(tree
            .path(&id)
            .iter()
            .skip(1)
            .rev()
            .map(|a| json!({"id": a.id, "name": a.name}))
            .collect::<Vec<_>>()),
    );
    let children: Vec<Value> = if manage {
        tree.children(&id)
            .into_iter()
            .map(|c| group_summary(&tree, &viewer, c, &counts))
            .collect()
    } else {
        Vec::new()
    };
    obj.insert("children".into(), json!(children));
    Ok(Json(v))
}

#[derive(Deserialize)]
struct UpdateGroup {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    /// Present → move the group (`null` = make it top-level). Admins only.
    #[serde(default, deserialize_with = "deserialize_some")]
    parent_id: Option<Option<String>>,
    #[serde(default)]
    settings: Option<GroupSettings>,
    #[serde(default)]
    quotas: Option<GroupQuotas>,
}

/// Distinguish an absent field (None) from an explicit null (Some(None)).
fn deserialize_some<'de, T, D>(d: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    T::deserialize(d).map(Some)
}

async fn update_group(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<UpdateGroup>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = context(&state, &user);
    let Some(g) = tree.get(&id).cloned() else { return Err(not_found()) };
    if !viewer.can_manage(&tree, &id) {
        return Err(if can_view(&tree, &viewer, &id) { forbidden("you don't manage this group") } else { not_found() });
    }
    let name = body.name.unwrap_or(g.name.clone());
    valid_name(&name)?;
    let description = body.description.unwrap_or(g.description.clone());

    let settings_json = match body.settings {
        Some(settings) => {
            settings.validate().map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
            if settings.listed != tree.settings(&id).listed && !viewer.admin {
                return Err(forbidden("only admins list groups on the sign-in page"));
            }
            serde_json::to_string(&settings).unwrap()
        }
        None => g.settings.clone(),
    };
    let quotas_json = match body.quotas {
        Some(q) => {
            if !viewer.can_govern(&tree, &id) {
                return Err(forbidden("a group's quotas are set by admins or managers of a parent group"));
            }
            q.validate().map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
            serde_json::to_string(&q).unwrap()
        }
        None => g.quotas.clone(),
    };
    let parent_id = match body.parent_id {
        Some(new_parent) => {
            if !viewer.admin {
                return Err(forbidden("only admins move groups"));
            }
            if let Some(p) = &new_parent {
                if tree.get(p).is_none() {
                    return Err(err(StatusCode::BAD_REQUEST, "no such parent group"));
                }
                if tree.is_within(p, &id) {
                    return Err(err(StatusCode::BAD_REQUEST, "a group cannot move below itself"));
                }
            }
            new_parent
        }
        None => g.parent_id.clone(),
    };
    state
        .db
        .update_group(&id, parent_id.as_deref(), &name, &description, &settings_json, &quotas_json);
    get_group(State(state), Extension(CurrentUser(user)), Path(id)).await
}

async fn delete_group(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let (tree, viewer) = context(&state, &user);
    if tree.get(&id).is_none() || !can_view(&tree, &viewer, &id) {
        return Err(not_found());
    }
    if !viewer.can_govern(&tree, &id) {
        return Err(forbidden("groups are deleted by admins or managers of a parent group"));
    }
    if !tree.children(&id).is_empty() {
        return Err(err(StatusCode::CONFLICT, "delete or move its subgroups first"));
    }
    state
        .db
        .delete_group(&id)
        .map_err(|e| err(StatusCode::CONFLICT, e))?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- members ---------------------------------------------------------------------

async fn list_members(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = context(&state, &user);
    if tree.get(&id).is_none() || !can_view(&tree, &viewer, &id) {
        return Err(not_found());
    }
    if !viewer.can_manage(&tree, &id) && !viewer.is_active_member(&id) {
        return Err(forbidden("your membership is waiting for approval"));
    }
    let members: Vec<Value> = state.db.group_members(&id).iter().map(member_json).collect();
    Ok(Json(json!(members)))
}

#[derive(Deserialize)]
struct AddMember {
    username: String,
    #[serde(default)]
    role: Option<String>,
}

fn valid_role(role: &str) -> Result<(), ApiError> {
    if matches!(role, "member" | "manager") {
        Ok(())
    } else {
        Err(err(StatusCode::BAD_REQUEST, "role must be member or manager"))
    }
}

async fn add_member(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<AddMember>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (tree, viewer) = context(&state, &user);
    if tree.get(&id).is_none() || !viewer.can_manage(&tree, &id) {
        return Err(not_found());
    }
    let role = body.role.as_deref().unwrap_or("member");
    valid_role(role)?;
    let Some(target) = state.db.get_user_by_username(&body.username) else {
        return Err(err(StatusCode::NOT_FOUND, "no such user"));
    };
    state.db.upsert_membership(&id, &target.id, role, "active");
    let m = state.db.get_membership(&id, &target.id).unwrap();
    Ok((StatusCode::CREATED, Json(member_json(&m))))
}

#[derive(Deserialize)]
struct UpdateMember {
    #[serde(default)]
    role: Option<String>,
    /// "active" approves a pending member.
    #[serde(default)]
    status: Option<String>,
    /// Present → per-member quota override (`null` = back to the group's).
    #[serde(default, deserialize_with = "deserialize_some")]
    quotas: Option<Option<Vec<Rule>>>,
}

async fn update_member(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((id, user_id)): Path<(String, String)>,
    Json(body): Json<UpdateMember>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = context(&state, &user);
    if tree.get(&id).is_none() || !viewer.can_manage(&tree, &id) {
        return Err(not_found());
    }
    let Some(m) = state.db.get_membership(&id, &user_id) else {
        return Err(err(StatusCode::NOT_FOUND, "not a member"));
    };
    let role = body.role.unwrap_or(m.role.clone());
    valid_role(&role)?;
    let status = body.status.unwrap_or(m.status.clone());
    if !matches!(status.as_str(), "active" | "pending") {
        return Err(err(StatusCode::BAD_REQUEST, "status must be active or pending"));
    }
    if let Some(q) = &body.quotas {
        if !viewer.can_govern(&tree, &id) {
            return Err(forbidden("member quotas are set by admins or managers of a parent group"));
        }
        if let Some(rules) = q {
            quota::validate_rules(rules).map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
        }
        let json = q.as_ref().map(|r| serde_json::to_string(r).unwrap());
        state.db.set_membership_quotas(&id, &user_id, json.as_deref());
    }
    state.db.upsert_membership(&id, &user_id, &role, &status);
    Ok(Json(member_json(&state.db.get_membership(&id, &user_id).unwrap())))
}

/// Managers remove members; anyone may leave.
async fn remove_member(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((id, user_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let (tree, viewer) = context(&state, &user);
    if tree.get(&id).is_none() || !can_view(&tree, &viewer, &id) {
        return Err(not_found());
    }
    if user_id != user.id && !viewer.can_manage(&tree, &id) {
        return Err(forbidden("you don't manage this group"));
    }
    if state.db.delete_membership(&id, &user_id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(err(StatusCode::NOT_FOUND, "not a member"))
    }
}

// ---- library ---------------------------------------------------------------------

/// Jobs charged to the group or its subgroups that the caller may see, each
/// with its season; the current season first.
async fn group_library(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = context(&state, &user);
    if tree.get(&id).is_none() || !can_view(&tree, &viewer, &id) {
        return Err(not_found());
    }
    let season_start = tree.effective(&id).season_start;
    let filter = JobFilter { group_ids: Some(tree.subtree(&id)), ..Default::default() };
    let slices: HashMap<String, String> = state
        .db
        .list_slices_filtered(&filter)
        .into_iter()
        .map(|s| (s.job_id, s.id))
        .collect();
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let current = groups::season_year(&now, &season_start);
    let jobs: Vec<Value> = state
        .db
        .list_jobs_filtered(&filter)
        .into_iter()
        .filter(|j| viewer.can_see_job(&tree, j))
        .map(|j| {
            let season = groups::season_year(&j.created_at, &season_start);
            json!({
                "id": j.id,
                "model_name": j.model_name,
                "status": j.status,
                "source": j.source,
                "created_at": j.created_at,
                "username": j.username,
                "group_id": j.group_id,
                "group_name": j.group_name,
                "print_time_sec": j.print_time_sec,
                "filament_used_g": j.filament_used_g,
                "has_model": crate::server::model_available(&j),
                "slice_id": slices.get(&j.id),
                "season": season,
            })
        })
        .collect();
    let mut years: Vec<i32> = jobs.iter().filter_map(|j| j["season"].as_i64()).map(|y| y as i32).collect();
    years.push(current);
    years.sort_unstable_by(|a, b| b.cmp(a));
    years.dedup();
    let seasons: Vec<Value> = years
        .iter()
        .map(|y| json!({"year": y, "label": groups::season_label(*y, &season_start), "current": *y == current}))
        .collect();
    Ok(Json(json!({
        "season_start": season_start,
        "current_season": current,
        "seasons": seasons,
        "jobs": jobs,
    })))
}

async fn group_usage(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = context(&state, &user);
    if tree.get(&id).is_none() || !can_view(&tree, &viewer, &id) {
        return Err(not_found());
    }
    let lines = quota::group_lines(&state.db, &tree, &user, &id);
    // Managers also get each member's usage of the per-member rules that
    // apply here (this group's and its ancestors').
    let members: Vec<Value> = if viewer.can_manage(&tree, &id) {
        state
            .db
            .group_members(&id)
            .iter()
            .filter_map(|m| state.db.get_user(&m.user_id))
            .map(|u| {
                let lines: Vec<quota::Line> = quota::group_lines(&state.db, &tree, &u, &id)
                    .into_iter()
                    .filter(|l| l.scope == "member")
                    .collect();
                json!({"user_id": u.id, "username": u.username, "lines": lines})
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(Json(json!({"lines": lines, "members": members})))
}

// ---- join links ------------------------------------------------------------------

async fn list_links(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = context(&state, &user);
    if tree.get(&id).is_none() || !viewer.can_manage(&tree, &id) {
        return Err(not_found());
    }
    let links: Vec<Value> = state.db.list_join_links(&id).iter().map(|l| link_json(&state, l)).collect();
    Ok(Json(json!(links)))
}

#[derive(Deserialize)]
struct CreateLink {
    #[serde(default)]
    public: bool,
    /// Public links: the human-chosen code (3-40 of a-z 0-9 -).
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    label: Option<String>,
    /// Default: secret links skip approval, public ones don't.
    #[serde(default)]
    bypass_approval: Option<bool>,
    #[serde(default)]
    max_uses: Option<i64>,
    #[serde(default)]
    expires_hours: Option<i64>,
}

/// "group" is taken by the web UI's /join/group/<id> route.
fn valid_public_code(code: &str) -> bool {
    code != "group"
        && (3..=40).contains(&code.len())
        && code.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !code.starts_with('-')
        && !code.ends_with('-')
}

async fn create_link(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<CreateLink>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (tree, viewer) = context(&state, &user);
    if tree.get(&id).is_none() || !viewer.can_manage(&tree, &id) {
        return Err(not_found());
    }
    let code = if body.public {
        let code = body.code.as_deref().unwrap_or("").trim().to_lowercase();
        if !valid_public_code(&code) {
            return Err(err(StatusCode::BAD_REQUEST, "public link code: 3-40 of a-z, 0-9 and -"));
        }
        code
    } else {
        auth::random_token()[..24].to_string()
    };
    if body.max_uses.is_some_and(|n| n < 1) || body.expires_hours.is_some_and(|h| h < 1) {
        return Err(err(StatusCode::BAD_REQUEST, "max_uses and expires_hours must be positive"));
    }
    let link = state
        .db
        .create_join_link(
            &id,
            &code,
            body.public,
            body.bypass_approval.unwrap_or(!body.public),
            body.label.as_deref().unwrap_or(""),
            body.max_uses,
            body.expires_hours,
            &user.id,
        )
        .map_err(|e| err(StatusCode::CONFLICT, e))?;
    Ok((StatusCode::CREATED, Json(link_json(&state, &link))))
}

#[derive(Deserialize)]
struct UpdateLink {
    disabled: bool,
}

fn managed_link(state: &AppState, user: &crate::db::User, id: &str, link_id: &str) -> Result<JoinLink, ApiError> {
    let (tree, viewer) = context(state, user);
    match state.db.get_join_link(link_id) {
        Some(l) if l.group_id == id && viewer.can_manage(&tree, id) => Ok(l),
        _ => Err(err(StatusCode::NOT_FOUND, "link not found")),
    }
}

async fn update_link(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((id, link_id)): Path<(String, String)>,
    Json(body): Json<UpdateLink>,
) -> Result<Json<Value>, ApiError> {
    managed_link(&state, &user, &id, &link_id)?;
    state.db.set_join_link_disabled(&link_id, body.disabled);
    Ok(Json(link_json(&state, &state.db.get_join_link(&link_id).unwrap())))
}

async fn delete_link(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path((id, link_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    managed_link(&state, &user, &id, &link_id)?;
    state.db.delete_join_link(&link_id);
    Ok(StatusCode::NO_CONTENT)
}

// ---- site settings (admins) --------------------------------------------------------

pub const GUEST_SESSION_DAYS_DEFAULT: i64 = 365;

pub fn guest_session_days(state: &AppState) -> i64 {
    state
        .db
        .get_setting("guest_session_days")
        .and_then(|v| v.parse().ok())
        .filter(|d: &i64| *d >= 1)
        .unwrap_or(GUEST_SESSION_DAYS_DEFAULT)
}

fn settings_json(state: &AppState) -> Value {
    let tree = Tree::load(&state.db);
    json!({
        "season_start": tree.site_season_start(),
        "default_user_quotas": quota::site_default_rules(&state.db, "full"),
        "default_guest_quotas": quota::site_default_rules(&state.db, "guest"),
        "guest_session_days": guest_session_days(state),
        "print_rules": groups::PrintRules::site_default(&state.db),
        "filament_prices": crate::cost::Prices::load(&state.db),
        "guide_notes": state.db.get_setting("guide_notes").unwrap_or_default(),
        "uploads": groups::site_uploads(&state.db),
        "gcode_limits": crate::gcode::site_limits(&state.db),
    })
}

async fn get_settings(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&user)?;
    Ok(Json(settings_json(&state)))
}

#[derive(Deserialize)]
struct UpdateSettings {
    #[serde(default)]
    season_start: Option<String>,
    #[serde(default)]
    default_user_quotas: Option<Vec<Rule>>,
    #[serde(default)]
    default_guest_quotas: Option<Vec<Rule>>,
    #[serde(default)]
    guest_session_days: Option<i64>,
    /// Rules for personal jobs and groups that set none.
    #[serde(default)]
    print_rules: Option<groups::PrintRules>,
    /// Currency and price per kg by material, for cost estimates.
    #[serde(default)]
    filament_prices: Option<crate::cost::Prices>,
    /// The farm's own notes on the Guide page (plain text).
    #[serde(default)]
    guide_notes: Option<String>,
    /// Pre-sliced uploads for personal jobs and groups that set none:
    /// allow | review | deny.
    #[serde(default)]
    uploads: Option<String>,
    /// What the G-code check tolerates (src/gcode/check.rs `Limits`).
    #[serde(default)]
    gcode_limits: Option<crate::gcode::Limits>,
}

async fn update_settings(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(body): Json<UpdateSettings>,
) -> Result<Json<Value>, ApiError> {
    auth::require_admin(&user)?;
    if let Some(s) = &body.season_start {
        if groups::parse_month_day(s).is_none() {
            return Err(err(StatusCode::BAD_REQUEST, "season_start must be MM-DD"));
        }
    }
    for rules in [&body.default_user_quotas, &body.default_guest_quotas].into_iter().flatten() {
        quota::validate_rules(rules).map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    }
    if body.guest_session_days.is_some_and(|d| !(1..=3650).contains(&d)) {
        return Err(err(StatusCode::BAD_REQUEST, "guest_session_days: 1-3650"));
    }
    if let Some(s) = &body.season_start {
        state.db.set_setting("season_start", Some(&json!(s.trim()).to_string()));
    }
    if let Some(r) = &body.default_user_quotas {
        state.db.set_setting("default_user_quotas", Some(&serde_json::to_string(r).unwrap()));
    }
    if let Some(r) = &body.default_guest_quotas {
        state.db.set_setting("default_guest_quotas", Some(&serde_json::to_string(r).unwrap()));
    }
    if let Some(d) = body.guest_session_days {
        state.db.set_setting("guest_session_days", Some(&d.to_string()));
    }
    if let Some(r) = &body.print_rules {
        r.validate().map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
        state.db.set_setting("print_rules", Some(&serde_json::to_string(r).unwrap()));
    }
    if let Some(n) = &body.guide_notes {
        if n.chars().count() > 20_000 {
            return Err(err(StatusCode::BAD_REQUEST, "guide notes are limited to 20000 characters"));
        }
        state.db.set_setting("guide_notes", Some(n.trim()));
    }
    if let Some(p) = &body.filament_prices {
        p.validate().map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
        state.db.set_setting("filament_prices", Some(&serde_json::to_string(p).unwrap()));
    }
    if let Some(u) = &body.uploads {
        groups::validate_uploads(u).map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
        state.db.set_setting("uploads", Some(u));
    }
    if let Some(l) = &body.gcode_limits {
        l.validate().map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
        if *l != crate::gcode::site_limits(&state.db) {
            state.db.set_setting("gcode_limits", Some(&serde_json::to_string(l).unwrap()));
            // Stored checks were made with the old limits.
            crate::safety::spawn_recheck(state.clone());
        }
    }
    Ok(Json(settings_json(&state)))
}

/// `GET /api/guide`: what the Guide page shows besides its fixed text.
async fn guide(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "notes": state.db.get_setting("guide_notes").unwrap_or_default(),
        "print_rules": groups::PrintRules::site_default(&state.db),
        "gcode_limits": crate::gcode::site_limits(&state.db),
        "uploads": groups::site_uploads(&state.db),
    }))
}

// ---- the caller's own groups and usage ------------------------------------------------

/// Usage of every rule that applies to the caller: their own, and per
/// group they can charge jobs to.
async fn my_usage(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Json<Value> {
    let (tree, viewer) = context(&state, &user);
    let groups: Vec<Value> = viewer
        .chargeable(&tree)
        .into_iter()
        .map(|(id, path)| {
            json!({
                "group_id": id,
                "path": path,
                "lines": quota::group_lines(&state.db, &tree, &user, &id),
            })
        })
        .collect();
    Json(json!({
        "user": quota::user_lines(&state.db, &tree, &user),
        "groups": groups,
    }))
}

/// Behind `auth::require_auth`.
pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/groups", get(list_groups).post(create_group))
        .route("/api/groups/{id}", get(get_group).put(update_group).delete(delete_group))
        .route("/api/groups/{id}/members", get(list_members).post(add_member))
        .route("/api/groups/{id}/members/{user_id}", put(update_member).delete(remove_member))
        .route("/api/groups/{id}/library", get(group_library))
        .route("/api/groups/{id}/usage", get(group_usage))
        .route("/api/groups/{id}/links", get(list_links).post(create_link))
        .route("/api/groups/{id}/links/{link_id}", put(update_link).delete(delete_link))
        .route("/api/settings", get(get_settings).put(update_settings))
        .route("/api/guide", get(guide))
        .route("/api/me/usage", get(my_usage))
}
