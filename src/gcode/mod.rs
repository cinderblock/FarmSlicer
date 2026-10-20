//! Checking G-code before it reaches a printer. See `plans/gcode-safety.md`.
//!
//! - [`lex`]: one line → command and words, read the way firmware does.
//! - [`template`]: vendor templates → lines, placeholders marked.
//! - [`data`]: what Bambu's own G-code does (generated from profiles).
//! - [`check`]: simulate a plate and report what it does differently.

pub mod check;
pub mod data;
#[cfg(test)]
mod harvest;
pub mod lex;
#[cfg(test)]
mod template;

use std::collections::BTreeMap;
use std::io::{BufReader, Read};
use std::path::Path;

use crate::package::{self, MAX_GCODE_BYTES, Package, PackageFormat, Plate};
pub use check::{Limits, PlateCheck, Severity};

/// Identifies the checker, its data and the limits, so a stored result made
/// with anything different is redone.
pub fn fingerprint(limits: &Limits) -> String {
    use md5::{Digest, Md5};
    let mut h = Md5::new();
    h.update(check::CHECKER_VERSION.to_le_bytes());
    for part in [
        include_str!("data/orca.json"),
        include_str!("data/bambustudio.json"),
        include_str!("data/slicer.json"),
        include_str!("data/printers.json"),
    ] {
        h.update(part.as_bytes());
    }
    h.update(serde_json::to_string(limits).expect("limits serialize").as_bytes());
    format!("{}-{}", check::CHECKER_VERSION, &hex::encode(h.finalize())[..12])
}

/// The site's limits (setting `gcode_limits`), defaults for what's unset.
pub fn site_limits(db: &crate::db::Db) -> Limits {
    db.get_setting("gcode_limits").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

/// Whether the plate has a check made with `fingerprint`.
pub fn is_current(plate: &Plate, fingerprint: &str) -> bool {
    plate.check.as_ref().is_some_and(|c| c.checker == fingerprint)
}

/// A package understates its print when its G-code takes this much longer
/// (or uses this much more filament) than it says: the slack covers
/// calibrations the estimate leaves out, and purge lines.
fn understated(declared: Option<f64>, computed: f64, slack: f64) -> bool {
    match declared {
        Some(d) if d > 0.0 => computed > d * 1.25 + slack,
        _ => computed > 0.0,
    }
}

/// Settle what to go by: the package's own numbers, unless the G-code
/// shows they're understated.
fn reconcile(plate: &Plate, c: &mut PlateCheck) {
    let computed_time = c.stats.time_sec;
    if understated(plate.print_time_sec, computed_time, 600.0) {
        c.time_sec = computed_time.max(plate.print_time_sec.unwrap_or(0.0));
        if let Some(d) = plate.print_time_sec.filter(|d| *d > 0.0) {
            c.findings.push(check::Finding {
                severity: Severity::Info,
                code: "understated_time".into(),
                message: format!(
                    "says it takes {}; its G-code takes about {} (FarmSlicer goes by that)",
                    check::minutes(d),
                    check::minutes(computed_time)
                ),
                line: None,
                count: 1,
            });
        }
    } else {
        c.time_sec = plate.print_time_sec.unwrap_or(computed_time);
    }
    let computed_g = c.stats.total_g();
    if understated(plate.weight_g, computed_g, 8.0) {
        c.grams = computed_g.max(plate.weight_g.unwrap_or(0.0));
        if let Some(d) = plate.weight_g.filter(|d| *d > 0.0) {
            c.findings.push(check::Finding {
                severity: Severity::Info,
                code: "understated_filament".into(),
                message: format!("says it uses {d:.1} g; its G-code uses about {computed_g:.1} g (FarmSlicer goes by that)"),
                line: None,
                count: 1,
            });
        }
    } else {
        c.grams = plate.weight_g.unwrap_or(computed_g);
        // The package's own split per filament.
        c.filament_g = plate.filaments.iter().map(|f| (f.id, f.used_g)).collect();
    }
}

/// Print time to go by (rules, quotas).
pub fn effective_time(plate: &Plate) -> Option<f64> {
    plate.check.as_ref().map(|c| c.time_sec).or(plate.print_time_sec)
}

/// Grams of filament `id` (1-based) to go by (cost).
pub fn effective_grams(plate: &Plate, id: u32) -> f64 {
    let declared = plate.filaments.iter().find(|f| f.id == id).map(|f| f.used_g).unwrap_or(0.0);
    plate.check.as_ref().and_then(|c| c.filament_g.get(&id).copied()).unwrap_or(declared)
}

/// What the package's own settings say about filaments (for densities and
/// the materials of filaments slice_info doesn't list).
#[derive(Default)]
struct ProjectSettings {
    types: Vec<String>,
    densities: Vec<f64>,
    diameter: Option<f64>,
}

fn project_settings<R: Read + std::io::Seek>(zip: &mut zip::ZipArchive<R>) -> ProjectSettings {
    let Ok(mut f) = zip.by_name("Metadata/project_settings.config") else { return Default::default() };
    let mut text = String::new();
    if f.by_ref().take(16 << 20).read_to_string(&mut text).is_err() {
        return Default::default();
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return Default::default() };
    let list = |k: &str| -> Vec<String> {
        match v.get(k) {
            Some(serde_json::Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
            Some(serde_json::Value::String(s)) => s.split([',', ';']).map(|x| x.trim().to_string()).collect(),
            _ => Vec::new(),
        }
    };
    ProjectSettings {
        types: list("filament_type"),
        densities: list("filament_density").iter().filter_map(|d| d.trim().parse().ok()).collect(),
        diameter: list("filament_diameter").first().and_then(|d| d.trim().parse().ok()),
    }
}

/// Check every plate of a package (already accepted by
/// [`package::inspect`]).
pub fn check_package(path: &Path, pkg: &Package, limits: &Limits) -> Result<BTreeMap<u32, PlateCheck>, String> {
    let mut out = BTreeMap::new();
    match pkg.format {
        PackageFormat::Bambu3mf => {
            let file = std::fs::File::open(path).map_err(|e| format!("can't open the package: {e}"))?;
            let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("can't read the package: {e}"))?;
            let settings = project_settings(&mut zip);
            for plate in &pkg.plates {
                let entry = zip
                    .by_name(&package::bambu::gcode_entry(plate.index))
                    .map_err(|e| format!("can't read plate {}: {e}", plate.index))?;
                out.insert(plate.index, check_plate(entry, pkg.format, plate, &settings, limits)?);
            }
        }
        // The file is the one plate's G-code, for another make's firmware:
        // the checks every printer gets, without Bambu's allowlist (see
        // `Declared::other_firmware`).
        PackageFormat::Gcode => {
            let s = package::gcode::filament_settings(path)?;
            let settings = ProjectSettings { types: s.types, densities: s.densities, diameter: s.diameter };
            let file = std::fs::File::open(path).map_err(|e| format!("can't open the package: {e}"))?;
            for plate in &pkg.plates {
                out.insert(plate.index, check_plate(&file, pkg.format, plate, &settings, limits)?);
            }
        }
    }
    Ok(out)
}

fn check_plate(
    gcode: impl Read,
    format: PackageFormat,
    plate: &Plate,
    settings: &ProjectSettings,
    limits: &Limits,
) -> Result<PlateCheck, String> {
    // Materials by filament id: the package's list, else its settings'.
    let mut materials = settings.types.clone();
    for f in &plate.filaments {
        let i = f.id.saturating_sub(1) as usize;
        if materials.len() <= i {
            materials.resize(i + 1, String::new());
        }
        materials[i] = f.material.clone();
    }
    let declared = check::Declared {
        // Plain G-code names its printer model the way the slicer's
        // profiles do; data has none of those, so that's "no data for it".
        model_id: plate.printer_model_id.clone().or_else(|| plate.printer_model.clone()),
        materials,
        densities: settings.densities.clone(),
        filament_diameter: settings.diameter.unwrap_or(1.75),
        other_firmware: format == PackageFormat::Gcode || plate.for_other_firmware(),
    };
    let reader = BufReader::with_capacity(1 << 16, gcode.take(MAX_GCODE_BYTES));
    let mut result = check::check(reader, data::data(), &declared, limits)
        .map_err(|e| format!("can't read plate {}: {e}", plate.index))?;
    reconcile(plate, &mut result);
    result.verdict = result.findings.iter().map(|f| f.severity).max();
    result.checker = fingerprint(limits);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real packages from `FARMSLICER_SAMPLE_PACKAGES` must come out clean;
    /// prints what each does.
    #[test]
    fn sample_packages_are_clean() {
        let Some(dir) = std::env::var_os("FARMSLICER_SAMPLE_PACKAGES") else { return };
        let mut failures = Vec::new();
        let mut paths: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).collect();
        paths.sort();
        for path in paths {
            if !path.to_string_lossy().ends_with(".gcode.3mf") && !path.to_string_lossy().ends_with(".gcode") {
                continue;
            }
            let pkg = package::inspect(&path).unwrap();
            let checks = check_package(&path, &pkg, &Limits::default()).unwrap();
            for (index, c) in checks {
                let plate = pkg.plate(index).unwrap();
                let s = &c.stats;
                println!(
                    "{} plate {index} [{}]: time {:.0}s vs declared {:?} ({:.2}x), {:.1} g vs declared {:?}, nozzle {} bed {} idle {:.0}s dwell {:.0}s",
                    path.file_name().unwrap().to_string_lossy(),
                    plate.printer_model_id.as_deref().or(plate.printer_model.as_deref()).unwrap_or("?"),
                    s.time_sec,
                    plate.print_time_sec,
                    s.time_sec / plate.print_time_sec.unwrap_or(f64::NAN),
                    s.total_g(),
                    plate.weight_g,
                    s.max_nozzle_c,
                    s.max_bed_c,
                    s.longest_heated_idle_sec,
                    s.longest_dwell_sec,
                );
                for f in &c.findings {
                    println!("    {:?} {} (line {:?}, x{}): {}", f.severity, f.code, f.line, f.count, f.message);
                    if f.severity >= Severity::Review {
                        failures.push(format!("{}: {}", path.display(), f.message));
                    }
                }
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }
}
