//! Which defaults people change. Every job made on the Slice page records
//! what the page proposed (`jobs.proposed_json`) next to what it was made
//! from (`inputs_json`, `overrides_json`); `GET /api/reports/defaults`
//! (admins) counts, per setting, how many jobs changed it and to what.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    routing::get,
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::auth::{self, CurrentUser};
use crate::server::{AppState, JobInputs};

/// Overrides the report shows as settings of their own (the Supports
/// section's), not as Quick Settings.
const SUPPORT_KEYS: &[&str] = &[
    "enable_support",
    "support_type",
    "support_on_build_plate_only",
    "support_filament",
    "support_interface_filament",
];

/// One setting: how many jobs had a proposal for it, how many changed it,
/// and what they changed it to (most common first).
#[derive(Debug, Serialize, PartialEq)]
pub struct SettingStat {
    pub key: String,
    pub label: String,
    pub jobs: usize,
    pub changed: usize,
    pub to: Vec<(String, usize)>,
}

#[derive(Default)]
struct Tally {
    label: String,
    jobs: usize,
    changed: usize,
    to: BTreeMap<String, usize>,
    /// A Quick Setting: every job had the profile's value proposed.
    every_job: bool,
}

#[derive(Default)]
struct Report {
    settings: BTreeMap<String, Tally>,
    jobs: usize,
}

impl Report {
    /// One job's value for a setting against what the page proposed.
    fn see(&mut self, key: &str, label: &str, proposed: &str, actual: &str) {
        let t = self.settings.entry(key.to_string()).or_default();
        t.label = label.to_string();
        t.jobs += 1;
        if proposed != actual {
            t.changed += 1;
            *t.to.entry(actual.to_string()).or_default() += 1;
        }
    }

    /// A Quick Setting the job set (the page proposes the profile's value).
    fn override_set(&mut self, key: &str, value: &str) {
        let t = self.settings.entry(key.to_string()).or_default();
        t.label = key.to_string();
        t.every_job = true;
        t.changed += 1;
        *t.to.entry(value.to_string()).or_default() += 1;
    }

    fn finish(self) -> Vec<SettingStat> {
        let total = self.jobs;
        let mut out: Vec<SettingStat> = self
            .settings
            .into_iter()
            .map(|(key, mut t)| {
                if t.every_job {
                    t.jobs = total;
                }
                let mut to: Vec<(String, usize)> = t.to.into_iter().collect();
                to.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
                to.truncate(5);
                SettingStat { key, label: t.label, jobs: t.jobs, changed: t.changed, to }
            })
            .collect();
        out.sort_by(|a, b| {
            let share = |s: &SettingStat| s.changed as f64 / s.jobs.max(1) as f64;
            share(b).total_cmp(&share(a)).then_with(|| b.changed.cmp(&a.changed)).then_with(|| a.key.cmp(&b.key))
        });
        out
    }
}

/// A profile name without its printer suffix ("Bambu PLA Basic @BBL X1C").
fn short(name: &str) -> String {
    name.split(" @").next().unwrap_or(name).trim().to_string()
}

/// The nozzle size in a machine profile's name ("... 0.4 nozzle").
fn nozzle_of(machine: &str) -> Option<String> {
    let words: Vec<&str> = machine.split_whitespace().collect();
    match words.as_slice() {
        [.., size, "nozzle"] => Some(size.to_string()),
        _ => None,
    }
}

/// How supports were printed: "the part's filament", or the interface and
/// base filaments.
fn support_materials(filaments: &[String], interface: Option<usize>, base: Option<usize>) -> String {
    let at = |i: Option<usize>| i.filter(|&i| i >= 1).and_then(|i| filaments.get(i - 1));
    match at(interface) {
        None => "the part's filament".into(),
        Some(iface) => {
            let base = at(base).or(filaments.first()).map(|b| short(b)).unwrap_or_default();
            format!("interface {}, base {}", short(iface), base)
        }
    }
}

fn as_str(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(if *b { "1" } else { "0" }.into()),
        _ => None,
    }
}

/// Add one job to the report.
fn tally(report: &mut Report, proposed: &Value, inputs: &JobInputs, overrides: &Map<String, Value>) {
    let text = |key: &str| proposed.get(key).and_then(Value::as_str).map(String::from);
    if let Some(p) = text("process") {
        report.see("process", "Print quality", &short(&p), &short(&inputs.process));
    }
    if let (Some(p), Some(a)) = (text("filament"), inputs.filaments.first()) {
        report.see("filament", "Filament", &short(&p), &short(a));
    }
    if let (Some(p), Some(a)) = (text("nozzle"), nozzle_of(&inputs.machine)) {
        report.see("nozzle", "Nozzle", &p, &a);
    }
    if let Some(p) = text("bed_type") {
        if !inputs.bed_type.is_empty() {
            report.see("bed_type", "Build plate", &p, &inputs.bed_type);
        }
    }
    let supports = proposed.get("supports");
    let enabled = overrides.get("enable_support").and_then(as_str).map(|v| v == "1");
    if let (Some(p), Some(on)) = (supports.and_then(|s| s.get("enabled")).and_then(Value::as_bool), enabled) {
        let word = |b: bool| if b { "on" } else { "off" };
        report.see("enable_support", "Supports", word(p), word(on));
        if on {
            let index = |key: &str| overrides.get(key).and_then(as_str).and_then(|v| v.parse().ok());
            let actual = support_materials(
                &inputs.filaments,
                index("support_interface_filament"),
                index("support_filament"),
            );
            if let Some(m) = supports.and_then(|s| s.get("materials")) {
                let proposed_materials = match (m.get("mode").and_then(Value::as_str), m.get("interface"), m.get("base")) {
                    (Some("separate"), Some(Value::String(i)), Some(Value::String(b))) => {
                        format!("interface {}, base {}", short(i), short(b))
                    }
                    _ => "the part's filament".into(),
                };
                report.see("support_materials", "Support material", &proposed_materials, &actual);
            }
            let style = overrides.get("support_type").and_then(as_str).unwrap_or_else(|| "the profile's".into());
            report.see("support_type", "Support style", "the profile's", &style);
        }
    }
    // Quick Settings: each one a user set is a change from the profile.
    for (key, value) in overrides {
        if !SUPPORT_KEYS.contains(&key.as_str()) {
            report.override_set(key, &as_str(value).unwrap_or_else(|| value.to_string()));
        }
    }
    report.jobs += 1;
}

#[derive(Deserialize)]
struct ReportQuery {
    /// Jobs from the last this many days (default 90; 0 = all).
    #[serde(default)]
    days: Option<u32>,
}

/// `GET /api/reports/defaults?days=90`: settings people change, most
/// changed first.
async fn defaults_report(
    State(state): State<Arc<AppState>>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Query(q): Query<ReportQuery>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    auth::require_admin(&user)?;
    let days = q.days.unwrap_or(90);
    let jobs = state.db.jobs_with_proposals(days);
    let mut report = Report::default();
    let mut counted = 0;
    for (inputs, proposed, overrides) in &jobs {
        let (Ok(inputs), Ok(proposed)) = (serde_json::from_str::<JobInputs>(inputs), serde_json::from_str::<Value>(proposed))
        else {
            continue;
        };
        let overrides: Map<String, Value> =
            overrides.as_deref().and_then(|o| serde_json::from_str(o).ok()).unwrap_or_default();
        tally(&mut report, &proposed, &inputs, &overrides);
        counted += 1;
    }
    Ok(Json(json!({"days": days, "jobs": counted, "settings": report.finish()})))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/api/reports/defaults", get(defaults_report))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(machine: &str, process: &str, filaments: &[&str], bed: &str) -> JobInputs {
        JobInputs {
            machine: machine.into(),
            process: process.into(),
            filaments: filaments.iter().map(|s| s.to_string()).collect(),
            bed_type: bed.into(),
            ..Default::default()
        }
    }

    fn proposed() -> Value {
        json!({
            "nozzle": "0.4", "bed_type": "Textured PEI Plate",
            "process": "0.20mm Standard @BBL X1C", "filament": "Bambu PLA Basic @BBL X1C",
            "supports": {"enabled": true, "materials": {"mode": "separate", "interface": "Bambu Support For PLA @BBL X1C", "base": "Bambu PLA Basic @BBL X1C"}},
            "overrides": {}
        })
    }

    fn overrides(pairs: &[(&str, &str)]) -> Map<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), json!(v))).collect()
    }

    #[test]
    fn counts_what_people_change() {
        let mut r = Report::default();
        let x1c = "Bambu Lab X1 Carbon 0.4 nozzle";
        // As proposed.
        tally(
            &mut r,
            &proposed(),
            &inputs(x1c, "0.20mm Standard @BBL X1C", &["Bambu PLA Basic @BBL X1C", "Bambu Support For PLA @BBL X1C"], "Textured PEI Plate"),
            &overrides(&[("enable_support", "1"), ("support_filament", "1"), ("support_interface_filament", "2")]),
        );
        // Supports in the part's filament, finer layers, a different plate.
        tally(
            &mut r,
            &proposed(),
            &inputs(x1c, "0.12mm Fine @BBL X1C", &["Bambu PLA Basic @BBL X1C"], "Cool Plate"),
            &overrides(&[("enable_support", "1"), ("support_filament", "0"), ("support_interface_filament", "0"), ("wall_loops", "4")]),
        );
        // Supports off, a 0.6 nozzle.
        tally(
            &mut r,
            &proposed(),
            &inputs("Bambu Lab X1 Carbon 0.6 nozzle", "0.20mm Standard @BBL X1C", &["Bambu PLA Basic @BBL X1C"], "Textured PEI Plate"),
            &overrides(&[("enable_support", "0")]),
        );
        let stats = r.finish();
        let get = |k: &str| stats.iter().find(|s| s.key == k).unwrap_or_else(|| panic!("{k}: {stats:?}"));
        assert_eq!((get("enable_support").jobs, get("enable_support").changed), (3, 1));
        assert_eq!(get("enable_support").to, vec![("off".to_string(), 1)]);
        assert_eq!((get("support_materials").jobs, get("support_materials").changed), (2, 1));
        assert_eq!(get("support_materials").to, vec![("the part's filament".to_string(), 1)]);
        assert_eq!((get("process").changed, get("bed_type").changed, get("nozzle").changed), (1, 1, 1));
        assert_eq!(get("nozzle").to, vec![("0.6".to_string(), 1)]);
        assert_eq!(get("process").to, vec![("0.12mm Fine".to_string(), 1)]);
        // A Quick Setting counts every job, changed on one.
        assert_eq!((get("wall_loops").jobs, get("wall_loops").changed), (3, 1));
        assert_eq!(get("support_type").changed, 0);
    }

    #[test]
    fn names_and_nozzles() {
        assert_eq!(short("Bambu PLA Basic @BBL X1C"), "Bambu PLA Basic");
        assert_eq!(nozzle_of("Bambu Lab H2D 0.4 nozzle"), Some("0.4".into()));
        assert_eq!(nozzle_of("Voron 2.4 350"), None);
        assert_eq!(support_materials(&["A".into(), "B".into()], Some(2), Some(1)), "interface B, base A");
        assert_eq!(support_materials(&["A".into()], Some(0), Some(0)), "the part's filament");
    }
}
