//! Thumbnail overlays: a label (from the inherited `thumbnail_label` group
//! setting) and a logo (the nearest group's uploaded image) drawn on every
//! plate thumbnail of a job charged to the group.
//!
//! The label is a template: `{key}` is the identifier the nearest group was
//! created under (a self-service subgroup's value, e.g. a team number),
//! `{group}` the job's group name. Logos are stored normalised (PNG, at most
//! [`LOGO_MAX`] px a side) under `data/logos/<group id>.png`.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Multipart, Path, State};
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde_json::{Value, json};

use crate::auth::CurrentUser;
use crate::db::Job;
use crate::groups::Tree;
use crate::groups_api;
use crate::server::AppState;

pub const LOGO_MAX: u32 = 256;
/// Labels longer than this are cut (they have to fit a thumbnail corner).
pub const LABEL_MAX: usize = 24;

/// What to draw on a job's thumbnails.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Overlay {
    pub label: String,
    /// RGBA, rows top-down.
    pub logo: Option<(Vec<u8>, u32, u32)>,
}

/// The label font: `FARMSLICER_FONT`, else the one shipped in
/// `resources/fonts` (SIL OFL, see resources/fonts/OFL.txt).
pub fn font_path() -> String {
    std::env::var("FARMSLICER_FONT").unwrap_or_else(|_| {
        std::fs::canonicalize("resources/fonts/Sarabun-SemiBold.ttf")
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "resources/fonts/Sarabun-SemiBold.ttf".to_string())
    })
}

fn logo_path(state: &AppState, group_id: &str) -> PathBuf {
    state.data_dir.join("logos").join(format!("{group_id}.png"))
}

/// Fill a label template for `group_id`.
pub fn label_for(tree: &Tree, group_id: &str) -> String {
    let template = tree.effective(group_id).thumbnail_label;
    if template.trim().is_empty() {
        return String::new();
    }
    let path = tree.path(group_id);
    let key = path.iter().find_map(|g| g.self_key.clone()).unwrap_or_default();
    let name = path.first().map(|g| g.name.clone()).unwrap_or_default();
    let label = template.replace("{key}", &key).replace("{group}", &name);
    label.trim().chars().take(LABEL_MAX).collect()
}

/// The nearest group on the way up (itself first) with a logo.
fn logo_group(state: &AppState, tree: &Tree, group_id: &str) -> Option<String> {
    tree.path(group_id)
        .iter()
        .map(|g| g.id.clone())
        .find(|id| logo_path(state, id).exists())
}

fn decode_rgba(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory(bytes).ok()?.to_rgba8();
    let (w, h) = img.dimensions();
    Some((img.into_raw(), w, h))
}

pub fn overlay_for_job(state: &AppState, job: &Job) -> Overlay {
    let Some(group_id) = job.group_id.as_deref() else { return Overlay::default() };
    let tree = Tree::load(&state.db);
    if tree.get(group_id).is_none() {
        return Overlay::default();
    }
    let logo = logo_group(state, &tree, group_id)
        .and_then(|g| std::fs::read(logo_path(state, &g)).ok())
        .and_then(|bytes| decode_rgba(&bytes));
    Overlay { label: label_for(&tree, group_id), logo }
}

/// Decode any supported image, shrink it to fit [`LOGO_MAX`], re-encode as PNG.
pub fn normalise_logo(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("not a PNG or JPEG image: {e}"))?;
    let img = if img.width() > LOGO_MAX || img.height() > LOGO_MAX {
        img.resize(LOGO_MAX, LOGO_MAX, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let mut out = std::io::Cursor::new(Vec::new());
    img.to_rgba8()
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| format!("can't encode the logo: {e}"))?;
    Ok(out.into_inner())
}

type ApiError = (StatusCode, Json<Value>);

fn err(code: StatusCode, msg: impl Into<String>) -> ApiError {
    (code, Json(json!({"error": msg.into()})))
}

fn png_response(bytes: Vec<u8>) -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "no-cache")], bytes)
}

/// `GET /api/groups/{id}/logo`: the group's own logo.
async fn get_logo(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Result<impl IntoResponse, ApiError> {
    let bytes = std::fs::read(logo_path(&state, &id)).map_err(|_| err(StatusCode::NOT_FOUND, "no logo"))?;
    Ok(png_response(bytes))
}

/// `PUT /api/groups/{id}/logo` (multipart `file`): its managers and admins.
async fn put_logo(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    if tree.get(&id).is_none() {
        return Err(err(StatusCode::NOT_FOUND, "no such group"));
    }
    if !viewer.can_manage(&tree, &id) {
        return Err(err(StatusCode::FORBIDDEN, "only the group's managers can change its logo"));
    }
    let mut data = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))?
    {
        if field.name() == Some("file") {
            data = Some(field.bytes().await.map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))?);
        }
    }
    let data = data.ok_or_else(|| err(StatusCode::BAD_REQUEST, "no file"))?;
    if data.len() > 10 << 20 {
        return Err(err(StatusCode::PAYLOAD_TOO_LARGE, "logos are limited to 10 MB"));
    }
    let png = tokio::task::spawn_blocking(move || normalise_logo(&data))
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    let path = logo_path(&state, &id);
    std::fs::create_dir_all(path.parent().expect("logos dir")).ok();
    std::fs::write(&path, &png).map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    println!("group {id}: {} set its thumbnail logo ({} bytes)", user.username, png.len());
    Ok(Json(json!({"ok": true})))
}

async fn delete_logo(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let (tree, viewer) = groups_api::context(&state, &user);
    if tree.get(&id).is_none() {
        return Err(err(StatusCode::NOT_FOUND, "no such group"));
    }
    if !viewer.can_manage(&tree, &id) {
        return Err(err(StatusCode::FORBIDDEN, "only the group's managers can change its logo"));
    }
    std::fs::remove_file(logo_path(&state, &id)).ok();
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/groups/{id}/overlay`: what a job charged to the group gets:
/// `{label, logo_group}` (`logo_group` = whose logo applies, or null).
async fn group_overlay(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let tree = Tree::load(&state.db);
    if tree.get(&id).is_none() {
        return Err(err(StatusCode::NOT_FOUND, "no such group"));
    }
    Ok(Json(json!({
        "label": label_for(&tree, &id),
        "logo_group": logo_group(&state, &tree, &id),
    })))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/groups/{id}/logo", get(get_logo).put(put_logo).delete(delete_logo))
        .route("/api/groups/{id}/overlay", get(group_overlay))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logos_are_shrunk_to_png() {
        let mut big = image::RgbaImage::new(1000, 500);
        big.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(big).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let png = normalise_logo(bytes.get_ref()).unwrap();
        let (rgba, w, h) = decode_rgba(&png).unwrap();
        assert_eq!((w, h), (256, 128));
        assert_eq!(rgba.len(), 256 * 128 * 4);
        assert!(normalise_logo(b"not an image").is_err());
    }
}
