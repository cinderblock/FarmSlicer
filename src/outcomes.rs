//! How prints turned out: what a print holds (its *lines*: one per kind of
//! part, with how many copies), and the record of how many copies came out
//! good or failed, and why.
//!
//! The printer only knows "finished" or "failed"; a finished plate of six
//! can still hold one copy of spaghetti, so a person records the outcome.
//! A print the printer ends as failed or cancelled is recorded as all
//! failed automatically (people can correct it); a finished one waits
//! ("unchecked") unless the site setting `finished_outcome` is `good`.
//!
//! The pure part (lines from a plate, checking a record) is unit-tested;
//! [`print_lines`] and [`record_automatic`] read the database.

use serde::{Deserialize, Serialize};

use crate::db::{Job, PrintRecord};
use crate::placement::PlateLayout;
use crate::server::AppState;

/// Why copies failed. `printer_error` and `cancelled` are what automatic
/// records say.
pub const REASONS: &[(&str, &str)] = &[
    ("spaghetti", "Spaghetti / came loose mid-print"),
    ("adhesion", "Didn't stick to the bed"),
    ("warping", "Warping or curling"),
    ("layer_shift", "Layer shift"),
    ("under_extrusion", "Under-extrusion / gaps"),
    ("stringing", "Stringing or blobs"),
    ("surface", "Surface quality"),
    ("dimensions", "Wrong size / doesn't fit"),
    ("supports", "Supports failed or won't come off"),
    ("filament", "Filament ran out or tangled"),
    ("clog", "Nozzle clog"),
    ("cancelled", "Cancelled"),
    ("printer_error", "Printer error"),
    ("other", "Other"),
];

pub fn valid_reason(reason: &str) -> bool {
    REASONS.iter().any(|(r, _)| *r == reason)
}

/// One kind of part in a print.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Line {
    /// 0-based, in plate order.
    pub line: i64,
    /// The project item these copies are for (src/projects.rs), if any.
    pub item_id: Option<String>,
    /// Which of the job's models, for FarmSlicer's own jobs.
    pub model_idx: Option<i64>,
    pub name: String,
    /// Copies on the plate.
    pub planned: i64,
}

/// A line with its outcome.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LineOutcome {
    #[serde(flatten)]
    pub line: Line,
    pub good: i64,
    pub failed: i64,
    pub reason: Option<String>,
}

/// A model's name without its file extension ("Bracket.stl" → "Bracket").
pub fn part_name(file: &str) -> String {
    let base = file.rsplit(['/', '\\']).next().unwrap_or(file);
    let lower = base.to_ascii_lowercase();
    for ext in [".gcode.3mf", ".3mf", ".stl", ".step", ".stp", ".obj", ".amf"] {
        if lower.ends_with(ext) && base.len() > ext.len() {
            return base[..base.len() - ext.len()].to_string();
        }
    }
    base.to_string()
}

/// The lines of one plate of a FarmSlicer job: its parts grouped by model,
/// in the order the models first appear.
pub fn lines_from_layout(plate: &PlateLayout, model_names: &[String]) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    for o in &plate.objects {
        match lines.iter_mut().find(|l| l.model_idx == Some(o.model as i64)) {
            Some(l) => l.planned += 1,
            None => lines.push(Line {
                line: lines.len() as i64,
                item_id: None,
                model_idx: Some(o.model as i64),
                name: model_names.get(o.model).map(|n| part_name(n)).unwrap_or_else(|| format!("Model {}", o.model + 1)),
                planned: 1,
            }),
        }
    }
    lines
}

/// The lines of a plate from a package's object list (one name per copy),
/// grouped by name; a plate that lists none is one line of one copy.
pub fn lines_from_objects(objects: &[String], fallback: &str) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    for name in objects {
        let name = if name.trim().is_empty() { fallback } else { name.trim() };
        match lines.iter_mut().find(|l| l.name == name) {
            Some(l) => l.planned += 1,
            None => lines.push(Line { line: lines.len() as i64, item_id: None, model_idx: None, name: name.to_string(), planned: 1 }),
        }
    }
    if lines.is_empty() {
        lines.push(Line { line: 0, item_id: None, model_idx: None, name: fallback.to_string(), planned: 1 });
    }
    lines
}

/// What someone says about a print.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct OutcomeRequest {
    /// Every copy: `good` or `failed`.
    #[serde(default)]
    pub all: Option<String>,
    /// Per line (the lines not named keep `all`'s verdict, or must be named).
    #[serde(default)]
    pub lines: Vec<LineRequest>,
    /// The reason for failed copies when a line gives none.
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LineRequest {
    pub line: i64,
    pub good: i64,
    pub failed: i64,
    #[serde(default)]
    pub reason: Option<String>,
}

/// The print as a whole: `good` (every copy), `failed` (none good) or
/// `partial`.
pub fn summary(lines: &[LineOutcome]) -> &'static str {
    let planned: i64 = lines.iter().map(|l| l.line.planned).sum();
    let good: i64 = lines.iter().map(|l| l.good).sum();
    if good >= planned {
        "good"
    } else if good == 0 {
        "failed"
    } else {
        "partial"
    }
}

/// Check a request against the print's lines: every copy accounted for
/// (good + failed = planned), failed copies with a known reason.
pub fn resolve(lines: &[Line], req: &OutcomeRequest) -> Result<Vec<LineOutcome>, String> {
    let all = match req.all.as_deref() {
        None => None,
        Some(v @ ("good" | "failed")) => Some(v),
        Some(other) => return Err(format!("all: expected \"good\" or \"failed\", not {other:?}")),
    };
    let default_reason = req.reason.as_deref().map(str::trim).filter(|r| !r.is_empty());
    if let Some(r) = default_reason {
        if !valid_reason(r) {
            return Err(format!("unknown reason {r:?}"));
        }
    }
    for l in &req.lines {
        if !lines.iter().any(|x| x.line == l.line) {
            return Err(format!("the print has no line {}", l.line));
        }
        if req.lines.iter().filter(|x| x.line == l.line).count() > 1 {
            return Err(format!("line {} is given twice", l.line));
        }
    }
    let mut out = Vec::new();
    for line in lines {
        let (good, failed, reason) = match (req.lines.iter().find(|l| l.line == line.line), all) {
            (Some(l), _) => (l.good, l.failed, l.reason.as_deref().map(str::trim).filter(|r| !r.is_empty())),
            (None, Some("good")) => (line.planned, 0, None),
            (None, Some(_)) => (0, line.planned, None),
            (None, None) => return Err(format!("say how {} came out", line.name)),
        };
        if good < 0 || failed < 0 || good + failed != line.planned {
            return Err(format!(
                "{}: {good} good and {failed} failed, but the plate has {} cop{}",
                line.name,
                line.planned,
                if line.planned == 1 { "y" } else { "ies" }
            ));
        }
        let reason = match (failed > 0, reason.or(default_reason)) {
            (false, _) => None,
            (true, Some(r)) if valid_reason(r) => Some(r.to_string()),
            (true, Some(r)) => return Err(format!("unknown reason {r:?}")),
            (true, None) => return Err(format!("{}: why did {failed} fail?", line.name)),
        };
        out.push(LineOutcome { line: line.clone(), good, failed, reason });
    }
    Ok(out)
}

/// Every copy good, or every copy failed for `reason`.
pub fn uniform(lines: &[Line], good: bool, reason: &str) -> Vec<LineOutcome> {
    lines
        .iter()
        .map(|l| LineOutcome {
            line: l.clone(),
            good: if good { l.planned } else { 0 },
            failed: if good { 0 } else { l.planned },
            reason: (!good).then(|| reason.to_string()),
        })
        .collect()
}

// -- From the database -------------------------------------------------------------

/// The lines of plate `plate` (1-based) of `job`.
pub fn job_plate_lines(state: &AppState, job: &Job, plate: u32) -> Vec<Line> {
    let fallback = crate::printing::display_name(&job.model_name);
    if job.source == "upload" {
        let objects = crate::printing::package_of(job)
            .and_then(|p| p.plate(plate).map(|p| p.objects.clone()))
            .unwrap_or_default();
        lines_from_objects(&objects, &fallback)
    } else {
        let names: Vec<String> = state.db.job_models(&job.id).into_iter().map(|m| m.name).collect();
        let plates = crate::server::job_plates(job);
        match plates.plates.get(plate as usize - 1) {
            Some(layout) => lines_from_layout(layout, &names),
            None => lines_from_objects(&[], &fallback),
        }
    }
}

/// The lines of a print: as recorded when there is a record, else from its
/// job's plate.
pub fn print_lines(state: &AppState, print: &PrintRecord) -> Vec<Line> {
    let recorded = state.db.print_outcome_lines(&print.id);
    if !recorded.is_empty() {
        return recorded.into_iter().map(|l| l.line).collect();
    }
    match print.job_id.as_deref().and_then(|j| state.db.get_job(j)) {
        Some(job) => job_plate_lines(state, &job, print.plate.max(1) as u32),
        None => lines_from_objects(&[], &print.name),
    }
}

/// The site's choice for finished prints: `ask` (default) or `good`.
pub fn finished_outcome(state: &AppState) -> String {
    state
        .db
        .get_setting("finished_outcome")
        .filter(|v| v == "good" || v == "ask")
        .unwrap_or_else(|| "ask".to_string())
}

/// Record what the printer's end of `print` (already moved to `status`)
/// says about its copies, unless someone has recorded it already. A print
/// that never started holds no copies to count.
pub fn record_automatic(state: &AppState, print: &PrintRecord, status: &str, error: Option<&str>) {
    let Some(now) = state.db.get_print(&print.id) else { return };
    if now.outcome.is_some() || now.started_at.is_none() {
        return;
    }
    let lines = print_lines(state, &now);
    let (good, reason, by) = match status {
        "failed" => (false, "printer_error", "printer"),
        "cancelled" => (false, "cancelled", "printer"),
        "finished" if finished_outcome(state) == "good" => (true, "", "auto"),
        _ => return,
    };
    let outcomes = uniform(&lines, good, reason);
    state.db.set_print_outcome(&now.id, summary(&outcomes), by, error, &outcomes);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::placement::PlateObject;

    fn layout(models: &[usize]) -> PlateLayout {
        PlateLayout { objects: models.iter().map(|&m| PlateObject { model: m, placement: None }).collect() }
    }

    #[test]
    fn lines_group_parts_by_model() {
        let names = vec!["parts/Bracket.stl".to_string(), "Clip v2.3mf".to_string()];
        let l = lines_from_layout(&layout(&[1, 0, 1, 1]), &names);
        assert_eq!(l.len(), 2);
        assert_eq!((l[0].name.as_str(), l[0].planned, l[0].model_idx), ("Clip v2", 3, Some(1)));
        assert_eq!((l[1].name.as_str(), l[1].planned, l[1].line), ("Bracket", 1, 1));
    }

    #[test]
    fn lines_from_package_objects() {
        let objs: Vec<String> = ["A", "B", "A", ""].iter().map(|s| s.to_string()).collect();
        let l = lines_from_objects(&objs, "Plate");
        assert_eq!(l.iter().map(|l| (l.name.as_str(), l.planned)).collect::<Vec<_>>(), vec![("A", 2), ("B", 1), ("Plate", 1)]);
        let l = lines_from_objects(&[], "Benchy");
        assert_eq!((l.len(), l[0].planned, l[0].name.as_str()), (1, 1, "Benchy"));
    }

    fn two_lines() -> Vec<Line> {
        lines_from_layout(&layout(&[0, 0, 0, 0, 0, 0, 1]), &["A.stl".into(), "B.stl".into()])
    }

    #[test]
    fn all_good_and_all_failed() {
        let lines = two_lines();
        let r = resolve(&lines, &OutcomeRequest { all: Some("good".into()), ..Default::default() }).unwrap();
        assert_eq!(summary(&r), "good");
        assert_eq!((r[0].good, r[1].good), (6, 1));
        let e = resolve(&lines, &OutcomeRequest { all: Some("failed".into()), ..Default::default() }).unwrap_err();
        assert!(e.contains("why"), "{e}");
        let r = resolve(&lines, &OutcomeRequest { all: Some("failed".into()), reason: Some("adhesion".into()), ..Default::default() })
            .unwrap();
        assert_eq!(summary(&r), "failed");
        assert_eq!(r[0].reason.as_deref(), Some("adhesion"));
    }

    #[test]
    fn per_line_counts_must_add_up() {
        let lines = two_lines();
        let one_bad = OutcomeRequest {
            all: Some("good".into()),
            lines: vec![LineRequest { line: 0, good: 5, failed: 1, reason: Some("spaghetti".into()) }],
            ..Default::default()
        };
        let r = resolve(&lines, &one_bad).unwrap();
        assert_eq!(summary(&r), "partial");
        assert_eq!((r[0].good, r[0].failed, r[1].good), (5, 1, 1));
        assert_eq!(r[1].reason, None);

        let short = OutcomeRequest {
            lines: vec![
                LineRequest { line: 0, good: 4, failed: 1, reason: Some("spaghetti".into()) },
                LineRequest { line: 1, good: 1, failed: 0, reason: None },
            ],
            ..Default::default()
        };
        assert!(resolve(&lines, &short).unwrap_err().contains("6 copies"));
        let missing = OutcomeRequest { lines: vec![LineRequest { line: 0, good: 6, failed: 0, reason: None }], ..Default::default() };
        assert!(resolve(&lines, &missing).unwrap_err().contains("B"));
        let bad_reason = OutcomeRequest { all: Some("failed".into()), reason: Some("gremlins".into()), ..Default::default() };
        assert!(resolve(&lines, &bad_reason).unwrap_err().contains("gremlins"));
        let no_line = OutcomeRequest {
            all: Some("good".into()),
            lines: vec![LineRequest { line: 9, good: 1, failed: 0, reason: None }],
            ..Default::default()
        };
        assert!(resolve(&lines, &no_line).is_err());
    }

    #[test]
    fn names_lose_their_extension() {
        assert_eq!(part_name("C:\\x\\Bracket v2.STL"), "Bracket v2");
        assert_eq!(part_name("a/b/plate.gcode.3mf"), "plate");
        assert_eq!(part_name(".stl"), ".stl");
        assert_eq!(part_name("Thing"), "Thing");
    }
}
