//! Keeping unchecked G-code off printers: runs the G-code check
//! (src/gcode/) on every job's package, stores each plate's result in the
//! job's `package_json`, and settles the print time and filament quotas and
//! costs go by. Sending (src/prints_api.rs) refuses or holds plates by
//! what the check found. See plans/gcode-safety.md.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::package::Package;
use crate::db::Job;
use crate::gcode::{self, Severity};
use crate::printing;
use crate::server::AppState;

/// Check every plate of the job's package and store the results. Blocking:
/// it reads all of the G-code.
pub fn check_job(state: &AppState, job_id: &str) -> Result<Package, String> {
    let job = state.db.get_job(job_id).ok_or("the job is gone")?;
    let mut pkg = printing::package_of(&job).ok_or("the job has no package")?;
    let path = job.package_path.clone().ok_or("the job has no package")?;
    let limits = gcode::site_limits(&state.db);
    let checks = gcode::check_package(Path::new(&path), &pkg, &limits)?;
    for plate in pkg.plates.iter_mut() {
        plate.check = checks.get(&plate.index).cloned();
    }
    state
        .db
        .set_job_package(job_id, &path, &serde_json::to_string(&pkg).expect("packages serialize"));
    // Quotas and costs count every plate, as the job's own numbers do.
    if pkg.plates.iter().any(|p| p.check.is_some()) {
        state.db.set_job_stats(job_id, pkg.total_time_sec(), pkg.total_grams());
    }
    for plate in &pkg.plates {
        let Some(c) = &plate.check else { continue };
        let worst = match c.verdict {
            None => "clean".to_string(),
            Some(v) => format!("{v:?}").to_lowercase(),
        };
        let shown: Vec<String> = c
            .findings
            .iter()
            .filter(|f| f.severity >= Severity::Review)
            .map(|f| format!("{} (line {})", f.message, f.line.unwrap_or(0)))
            .collect();
        println!(
            "job {job_id}: plate {} G-code check: {worst}{}",
            plate.index,
            if shown.is_empty() { String::new() } else { format!(": {}", shown.join("; ")) }
        );
        if job.source == "server" && c.needs_review() {
            // Our own slicer wrote it: either an admin's overrides did
            // something unusual, or the data is missing something.
            let overridden = job.overrides_json.as_deref().is_some_and(|o| !matches!(o.trim(), "" | "{}"));
            eprintln!(
                "job {job_id}: FarmSlicer's own slice fails the G-code check{} ({})",
                if overridden {
                    "; check its overrides, else src/gcode/data needs updating"
                } else {
                    "; src/gcode/data needs updating"
                },
                shown.join("; ")
            );
        }
    }
    crate::incidents::after_check(state, &job, &pkg);
    Ok(pkg)
}

/// The job's package with a current check on every plate: plates checked
/// with another checker, data or limits are checked again first.
pub async fn checked_package(state: &Arc<AppState>, job: &Job) -> Result<Package, String> {
    let pkg = printing::package_of(job).ok_or("the job has no package")?;
    let fingerprint = gcode::fingerprint(&gcode::site_limits(&state.db));
    if pkg.plates.iter().all(|p| gcode::is_current(p, &fingerprint)) {
        return Ok(pkg);
    }
    let state = state.clone();
    let id = job.id.clone();
    tokio::task::spawn_blocking(move || check_job(&state, &id))
        .await
        .map_err(|e| format!("the G-code check failed: {e}"))?
}

/// Browser jobs whose G-code can't be read as a package (so they can't be
/// sent): settle their numbers from the G-code itself, so a client can't report
/// zero grams to dodge quotas. Blocking.
pub fn settle_gcode_stats(state: &AppState, job_id: &str, gcode_path: &str) {
    let Ok(file) = std::fs::File::open(gcode_path) else { return };
    let reader = std::io::BufReader::with_capacity(1 << 16, file);
    let declared = gcode::check::Declared { filament_diameter: 1.75, ..Default::default() };
    let Ok(c) = gcode::check::check(reader, gcode::data::data(), &declared, &gcode::site_limits(&state.db)) else { return };
    let Some(job) = state.db.get_job(job_id) else { return };
    let time = job.print_time_sec.unwrap_or(0.0);
    let grams = job.filament_used_g.unwrap_or(0.0);
    let (ct, cg) = (c.stats.time_sec, c.stats.total_g());
    if ct > time * 1.25 + 600.0 || cg > grams * 1.25 + 8.0 {
        println!("job {job_id}: reported {time:.0} s, {grams:.1} g; its G-code takes {ct:.0} s, {cg:.1} g; counting that");
        state.db.set_job_stats(job_id, time.max(ct), grams.max(cg));
    }
}

static RECHECK: Mutex<()> = Mutex::new(());
static AGAIN: AtomicBool = AtomicBool::new(false);

/// Re-check, in the background, every stored package whose checks are
/// missing or were made with another checker, data or limits. Called at
/// startup and when the limits change; calls while one runs make it run
/// once more afterwards.
pub fn spawn_recheck(state: Arc<AppState>) {
    AGAIN.store(true, Ordering::SeqCst);
    std::thread::spawn(move || loop {
        {
            // Another thread is at it; it sees AGAIN before it stops.
            let Ok(_running) = RECHECK.try_lock() else { return };
            recheck_while_asked(&state);
        }
        if !AGAIN.load(Ordering::SeqCst) {
            return;
        }
    });
}

fn recheck_while_asked(state: &Arc<AppState>) {
    while AGAIN.swap(false, Ordering::SeqCst) {
        let fingerprint = gcode::fingerprint(&gcode::site_limits(&state.db));
        let mut done = 0;
        for id in state.db.jobs_with_packages() {
            let Some(job) = state.db.get_job(&id) else { continue };
            let Some(pkg) = printing::package_of(&job) else { continue };
            if pkg.plates.iter().all(|p| gcode::is_current(p, &fingerprint)) {
                continue;
            }
            match check_job(state, &id) {
                Ok(_) => done += 1,
                Err(e) => eprintln!("job {id}: can't check its G-code: {e}"),
            }
        }
        if done > 0 {
            println!("G-code check: re-checked {done} package(s)");
        }
    }
}
