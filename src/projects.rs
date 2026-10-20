//! Projects: the demand side. A project is what someone needs printed: items
//! (a part and how many), each with a *recipe* (a job and one of its
//! models). Job plates carry items (`job_items`: per plate, each part
//! belongs to at most one item), so a print's outcome counts towards the
//! items its copies are for, and an item's progress (good, failed,
//! unchecked, printing, queued, missing) is counted, never stored per copy.
//!
//! A project moves `open` → `printed` by itself when every item has enough
//! good copies (and back, should a record be corrected); `ready`,
//! `shipped`, `on_hold` and `cancelled` are set by people or the ordering
//! software (fulfillment). FarmSlicer keeps no customer records: a project
//! carries the ordering tool's opaque `client_ref` and `external_ref`.

use serde::{Deserialize, Serialize};

use crate::db::{Item, Job, JobItem, Progress, Project};
use crate::groups::{Tree, Viewer};
use crate::outcomes::Line;
use crate::server::AppState;

/// Every status; `printed` is only ever set automatically.
pub const STATUSES: &[&str] = &["open", "printed", "ready", "shipped", "on_hold", "cancelled"];
pub const SETTABLE: &[&str] = &["open", "ready", "shipped", "on_hold", "cancelled"];

/// Most items per project, and the largest quantity of one.
pub const MAX_ITEMS: usize = 500;
pub const MAX_QUANTITY: i64 = 100_000;

pub fn can_see(tree: &Tree, viewer: &Viewer, p: &Project) -> bool {
    viewer.admin
        || p.user_id.as_deref() == Some(viewer.user.id.as_str())
        || p.group_id.as_deref().is_some_and(|g| viewer.is_active_member(g) || viewer.can_manage(tree, g))
}

pub fn can_edit(tree: &Tree, viewer: &Viewer, p: &Project) -> bool {
    viewer.admin
        || p.user_id.as_deref() == Some(viewer.user.id.as_str())
        || p.group_id.as_deref().is_some_and(|g| viewer.can_manage(tree, g))
}

/// Copies still without a plate: wanted minus what is good, unchecked,
/// printing or queued.
pub fn missing(quantity: i64, p: &Progress) -> i64 {
    (quantity - p.good - p.unchecked - p.printing - p.queued).max(0)
}

pub fn done(quantity: i64, p: &Progress) -> bool {
    p.good >= quantity
}

/// An item with where its copies stand.
#[derive(Debug, Serialize, Clone)]
pub struct ItemView {
    #[serde(flatten)]
    pub item: Item,
    #[serde(flatten)]
    pub progress: Progress,
    pub missing: i64,
    pub done: bool,
}

/// A project's totals, for lists.
#[derive(Debug, Serialize, Clone, Default, PartialEq)]
pub struct Summary {
    pub items: i64,
    pub items_done: i64,
    pub wanted: i64,
    pub good: i64,
    pub failed: i64,
    pub unchecked: i64,
    pub printing: i64,
    pub queued: i64,
    pub missing: i64,
}

pub fn summarize(items: &[ItemView]) -> Summary {
    let mut s = Summary::default();
    for i in items {
        s.items += 1;
        s.items_done += i.done as i64;
        s.wanted += i.item.quantity;
        // An item's surplus doesn't make up for another's shortfall.
        s.good += i.progress.good.min(i.item.quantity);
        s.failed += i.progress.failed;
        s.unchecked += i.progress.unchecked;
        s.printing += i.progress.printing;
        s.queued += i.progress.queued;
        s.missing += i.missing;
    }
    s
}

pub fn item_views(state: &AppState, project_id: &str) -> Vec<ItemView> {
    let progress = state.db.project_progress(project_id);
    state
        .db
        .project_items(project_id)
        .into_iter()
        .map(|item| {
            let p = progress.iter().find(|(id, _)| *id == item.id).map(|(_, p)| p.clone()).unwrap_or_default();
            ItemView { missing: missing(item.quantity, &p), done: done(item.quantity, &p), item, progress: p }
        })
        .collect()
}

/// Move the project between `open` and `printed` as its items say. Other
/// statuses are people's to change.
pub fn refresh(state: &AppState, project_id: &str) {
    let Some(project) = state.db.get_project(project_id) else { return };
    let items = item_views(state, project_id);
    let all_done = !items.is_empty() && items.iter().all(|i| i.done);
    let next = match (project.status.as_str(), all_done) {
        ("open", true) => "printed",
        ("printed", false) => "open",
        _ => return,
    };
    if state.db.set_project_status(project_id, next, None) {
        println!("Project {} ({}): {} -> {next}", project.id, project.name, project.status);
        crate::events::project_status(state, project_id);
    }
}

/// Refresh every project a print's job carries items for.
pub fn refresh_for_job(state: &AppState, job_id: Option<&str>) {
    if let Some(job_id) = job_id {
        for p in state.db.projects_of_job(job_id) {
            refresh(state, &p);
        }
    }
}

// -- Parts of a job ----------------------------------------------------------------

/// The key a line's part is linked by: `model:N` for a model of a
/// FarmSlicer job, `object:<name>` for an upload's objects.
pub fn part_key(line: &Line) -> String {
    match line.model_idx {
        Some(m) => format!("model:{m}"),
        None => format!("object:{}", line.name),
    }
}

/// A part of a job: the same model (or object name) on every plate it is
/// on, with its copies per plate.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JobPart {
    pub key: String,
    pub model_idx: Option<i64>,
    pub name: String,
    /// (plate, copies), plates 1-based.
    pub plates: Vec<(i64, i64)>,
}

impl JobPart {
    pub fn copies(&self) -> i64 {
        self.plates.iter().map(|(_, c)| c).sum()
    }
}

/// The plates of a job (1-based): its package's, else its layout's.
pub fn job_plate_numbers(job: &Job) -> Vec<u32> {
    match crate::printing::package_of(job) {
        Some(pkg) => pkg.plates.iter().map(|p| p.index).collect(),
        None => (1..=crate::server::job_plates(job).plates.len() as u32).collect(),
    }
}

/// Group plate lines into the job's parts, in the order they first appear.
pub fn parts_of(lines_by_plate: &[(u32, Vec<Line>)]) -> Vec<JobPart> {
    let mut parts: Vec<JobPart> = Vec::new();
    for (plate, lines) in lines_by_plate {
        for l in lines {
            let key = part_key(l);
            match parts.iter_mut().find(|p| p.key == key) {
                Some(p) => p.plates.push((*plate as i64, l.planned)),
                None => parts.push(JobPart {
                    key,
                    model_idx: l.model_idx,
                    name: l.name.clone(),
                    plates: vec![(*plate as i64, l.planned)],
                }),
            }
        }
    }
    parts
}

pub fn job_parts(state: &AppState, job: &Job) -> Vec<JobPart> {
    let lines: Vec<(u32, Vec<Line>)> = job_plate_numbers(job)
        .into_iter()
        .map(|n| (n, crate::outcomes::job_plate_lines(state, job, n)))
        .collect();
    parts_of(&lines)
}

/// What to do with one part of a job being linked to a project.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct LinkItem {
    /// Which part: a model index (FarmSlicer jobs) or an object name
    /// (uploads); omitted = the job's only part.
    #[serde(default)]
    pub model: Option<i64>,
    #[serde(default)]
    pub part: Option<String>,
    /// Count it for this existing item...
    #[serde(default)]
    pub item_id: Option<String>,
    /// ...or make an item (name defaults to the part's, quantity to its
    /// copies on the job).
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub quantity: Option<i64>,
}

/// Count `job`'s parts for `project`'s items: the ones named in `items`,
/// or every part as a new item when `items` is empty. Returns the items
/// the job now counts for.
pub fn link_job(state: &AppState, project: &Project, job: &Job, items: &[LinkItem]) -> Result<Vec<Item>, String> {
    let parts = job_parts(state, job);
    if parts.is_empty() {
        return Err("the job has nothing on its plates".into());
    }
    let wanted: Vec<LinkItem> = if items.is_empty() {
        parts
            .iter()
            .map(|p| LinkItem {
                model: p.model_idx,
                part: p.model_idx.is_none().then(|| p.name.clone()),
                ..Default::default()
            })
            .collect()
    } else {
        items.to_vec()
    };
    let existing = state.db.project_items(&project.id);
    if existing.len() + wanted.iter().filter(|w| w.item_id.is_none()).count() > MAX_ITEMS {
        return Err(format!("a project holds at most {MAX_ITEMS} items"));
    }
    // Check everything before changing anything.
    let mut plan: Vec<(&JobPart, &LinkItem)> = Vec::new();
    for w in &wanted {
        let part = match (w.model, w.part.as_deref()) {
            (Some(m), _) => parts.iter().find(|p| p.model_idx == Some(m)),
            (None, Some(name)) => parts.iter().find(|p| p.model_idx.is_none() && p.name == name),
            (None, None) if parts.len() == 1 => parts.first(),
            (None, None) => return Err("the job has several parts: say which (model or part)".into()),
        }
        .ok_or_else(|| "the job has no such part".to_string())?;
        if plan.iter().any(|(p, _)| p.key == part.key) {
            return Err(format!("{} is given twice", part.name));
        }
        if let Some(id) = &w.item_id {
            if !existing.iter().any(|i| &i.id == id) {
                return Err("no such item in this project".into());
            }
        }
        if let Some(q) = w.quantity {
            if !(1..=MAX_QUANTITY).contains(&q) {
                return Err(format!("quantity: 1 to {MAX_QUANTITY}"));
            }
        }
        for (plate, _) in &part.plates {
            if let Some(other) = state
                .db
                .job_plate_items(&job.id, *plate)
                .into_iter()
                .find(|j| j.part == part.key && Some(&j.item_id) != w.item_id.as_ref())
            {
                let whose = state.db.get_item(&other.item_id).map(|i| i.name).unwrap_or_default();
                return Err(format!("{} on plate {plate} already counts for another item ({whose})", part.name));
            }
        }
        plan.push((part, w));
    }
    let mut linked = Vec::new();
    for (part, w) in plan {
        let item = match &w.item_id {
            Some(id) => state.db.get_item(id).expect("checked above"),
            None => state.db.add_item(
                &project.id,
                w.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&part.name),
                w.quantity.unwrap_or_else(|| part.copies()),
                Some(&job.id),
                part.model_idx,
                "",
            ),
        };
        for (plate, copies) in &part.plates {
            state.db.link_job_item(&JobItem {
                job_id: job.id.clone(),
                plate: *plate,
                part: part.key.clone(),
                item_id: item.id.clone(),
                model_idx: part.model_idx,
                name: part.name.clone(),
                copies: *copies,
            });
        }
        linked.push(item);
    }
    refresh(state, &project.id);
    Ok(linked)
}

/// A new item made from one part of `job` (its recipe). Its copies on the
/// job's plates count for it unless they count for another item already
/// (the job was made for another project): then it is a recipe only, and
/// its copies need plates of their own. Returns the item and whether the
/// job's plates count for it.
pub fn recipe_item(state: &AppState, project: &Project, job: &Job, w: &LinkItem) -> Result<(Item, bool), String> {
    let parts = job_parts(state, job);
    let part = match (w.model, w.part.as_deref()) {
        (Some(m), _) => parts.iter().find(|p| p.model_idx == Some(m)),
        (None, Some(name)) => parts.iter().find(|p| p.model_idx.is_none() && p.name == name),
        (None, None) if parts.len() == 1 => parts.first(),
        (None, None) => return Err(format!("{} has several parts: say which (model or part)", job.model_name)),
    }
    .ok_or_else(|| format!("{} has no such part", job.model_name))?;
    let quantity = w.quantity.unwrap_or_else(|| part.copies());
    if !(1..=MAX_QUANTITY).contains(&quantity) {
        return Err(format!("quantity: 1 to {MAX_QUANTITY}"));
    }
    let free = part
        .plates
        .iter()
        .all(|(plate, _)| !state.db.job_plate_items(&job.id, *plate).iter().any(|j| j.part == part.key));
    let item = state.db.add_item(
        &project.id,
        w.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&part.name),
        quantity,
        Some(&job.id),
        part.model_idx,
        "",
    );
    if free {
        for (plate, copies) in &part.plates {
            state.db.link_job_item(&JobItem {
                job_id: job.id.clone(),
                plate: *plate,
                part: part.key.clone(),
                item_id: item.id.clone(),
                model_idx: part.model_idx,
                name: part.name.clone(),
                copies: *copies,
            });
        }
    }
    Ok((item, free))
}

/// A date (`YYYY-MM-DD`) or date and time (`YYYY-MM-DD HH:MM[:SS]`, or
/// RFC 3339, taken as UTC) in the database's form.
pub fn parse_due(text: &str) -> Result<String, String> {
    let t = text.trim();
    if let Ok(d) = chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d") {
        return Ok(d.format("%Y-%m-%d").to_string());
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(t) {
        return Ok(dt.naive_utc().format("%Y-%m-%d %H:%M:%S").to_string());
    }
    for f in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"] {
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(t, f) {
            return Ok(dt.format("%Y-%m-%d %H:%M:%S").to_string());
        }
    }
    Err(format!("due_at: expected a date (YYYY-MM-DD) or date and time, not {t:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(model: Option<i64>, name: &str, planned: i64) -> Line {
        Line { line: 0, item_id: None, model_idx: model, name: name.into(), planned }
    }

    #[test]
    fn parts_span_plates() {
        let parts = parts_of(&[
            (1, vec![line(Some(0), "A", 6), line(Some(1), "B", 1)]),
            (2, vec![line(Some(0), "A", 2)]),
        ]);
        assert_eq!(parts.len(), 2);
        assert_eq!((parts[0].key.as_str(), parts[0].copies(), parts[0].plates.clone()), ("model:0", 8, vec![(1, 6), (2, 2)]));
        assert_eq!(parts[1].key, "model:1");
        let uploads = parts_of(&[(2, vec![line(None, "Clip", 3)])]);
        assert_eq!((uploads[0].key.as_str(), uploads[0].plates[0]), ("object:Clip", (2, 3)));
    }

    #[test]
    fn missing_counts_what_is_on_its_way() {
        let p = Progress { good: 3, failed: 2, unchecked: 1, printing: 2, queued: 1 };
        assert_eq!(missing(10, &p), 3);
        assert_eq!(missing(5, &p), 0);
        assert!(!done(5, &p));
        assert!(done(3, &p));
    }

    #[test]
    fn summaries_cap_each_item() {
        let item = |q, good| ItemView {
            item: Item {
                id: String::new(),
                project_id: String::new(),
                idx: 0,
                name: String::new(),
                quantity: q,
                job_id: None,
                model_idx: None,
                notes: String::new(),
                created_at: String::new(),
            },
            progress: Progress { good, ..Default::default() },
            missing: (q - good).max(0),
            done: good >= q,
        };
        let s = summarize(&[item(4, 6), item(4, 1)]);
        assert_eq!((s.wanted, s.good, s.items_done, s.missing), (8, 5, 1, 3));
    }

    #[test]
    fn due_dates() {
        assert_eq!(parse_due("2026-11-01").unwrap(), "2026-11-01");
        assert_eq!(parse_due("2026-11-01 09:30").unwrap(), "2026-11-01 09:30:00");
        assert_eq!(parse_due("2026-11-01T09:30:00-07:00").unwrap(), "2026-11-01 16:30:00");
        assert!(parse_due("next tuesday").is_err());
    }
}
