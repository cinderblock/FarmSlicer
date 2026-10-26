mod auth;
mod autoplate;
mod auth_api;
mod cost;
mod bambu;
mod camera;
mod config_policy;
mod db;
mod discovery;
mod dispatch;
mod events;
mod farm_api;
mod feedback;
mod feedback_api;
mod gcode;
mod groups;
mod groups_api;
mod incidents;
mod integration;
mod join_api;
mod moonraker;
mod notifications;
mod nozzles;
mod octoprint;
mod outcomes;
mod overlay;
mod package;
mod placement;
mod pools;
mod printer;
mod printer_thumbs;
mod printers_api;
mod printing;
mod preview_api;
mod reports_api;
mod prusalink;
mod prints_api;
mod projects;
mod projects_api;
mod profiles;
mod progress;
mod query;
mod queue;
mod queue_api;
mod quota;
mod safety;
mod sdcp;
mod server;
mod slicer;
mod webhooks;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(9337);
    // Listen address; HOST=127.0.0.1 keeps a test server off the network.
    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());

    let data_dir = PathBuf::from("data");
    let db = Arc::new(db::Db::open(&data_dir));
    // Bambu's error texts kept from earlier runs (src/bambu/hms.rs).
    bambu::hms::init(&data_dir);

    // libslic3r progress ticks land in the jobs table so the UI can poll them.
    {
        let db = db.clone();
        progress::install_sink(Box::new(move |job_id, percent, message| {
            db.update_job_progress(job_id, percent, message);
        }));
    }

    // OrcaSlicer's resources/ tree: profiles for us, nozzle/flush tables for
    // libslic3r. Overridable so the container can mount it elsewhere.
    let resources_dir = std::env::var("ORCA_RESOURCES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("extern/OrcaSlicer/resources"));
    let slicer = slicer::new_slicer(&resources_dir.to_string_lossy());
    let profile_store = profiles::ProfileStore::load(&resources_dir.join("profiles"));

    let discovered = Arc::new(Mutex::new(HashMap::new()));

    tokio::spawn(discovery::run(discovered.clone()));

    // Reap browser jobs whose tab went away (no progress tick for 2 minutes).
    {
        let db = db.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                tick.tick().await;
                let n = db.fail_stale_browser_jobs(120);
                if n > 0 {
                    println!("failed {n} stale browser job(s)");
                }
            }
        });
    }

    let rp = match auth::Rp::from_env() {
        Ok(rp) => rp,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    println!(
        "Passkeys: relying party '{}', canonical origin {} (FARMSLICER_ORIGINS)",
        rp.rp_id, rp.origin
    );
    if auth::auth_disabled() {
        println!("Auth DISABLED (FARMSLICER_NO_AUTH is set): every request runs as owner");
    } else if auth::setup_required(&db) {
        println!("First run: no usable accounts. Open the web UI to create the owner account with a passkey.");
    } else {
        println!("Auth enabled: {} account(s)", db.user_count());
    }
    println!("{}", auth::describe_network());

    // Connect to every printer whose protocol FarmSlicer speaks and whose
    // connection settings are complete.
    let printers = printer::PrinterHub::new();
    printers.sync(&db.list_printers());

    let state = Arc::new(server::AppState::new(
        db,
        data_dir,
        slicer,
        profile_store,
        discovered,
        printers,
        rp,
    ));

    // Follow sent prints through their printers' reports.
    tokio::spawn(printing::track(state.clone()));
    tokio::spawn(webhooks::run(state.clone()));
    tokio::spawn(dispatch::run(state.clone()));
    // Check stored packages the current G-code checker hasn't seen.
    safety::spawn_recheck(state.clone());

    let app = server::router(state);

    let listener = tokio::net::TcpListener::bind((host.as_str(), port))
        .await
        .expect("failed to bind");

    println!("FarmSlicer listening on http://localhost:{port}");

    axum::serve(listener, app).await.expect("server error");
}
