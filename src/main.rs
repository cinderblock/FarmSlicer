mod db;
mod discovery;
mod profiles;
mod progress;
mod server;
mod slicer;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(9337);

    let data_dir = PathBuf::from("data");
    let db = Arc::new(db::Db::open(&data_dir));

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

    let passphrase = server::AppState::passphrase();
    if passphrase.is_some() {
        println!("Auth enabled (ADMIN_PASSPHRASE set)");
    } else {
        println!("Auth disabled (no ADMIN_PASSPHRASE)");
    }

    let state = Arc::new(server::AppState::new(
        db,
        data_dir,
        slicer,
        profile_store,
        discovered,
        passphrase,
    ));

    let app = server::router(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("failed to bind");

    println!("FarmSlicer listening on http://localhost:{port}");

    axum::serve(listener, app).await.expect("server error");
}
