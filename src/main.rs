mod db;
mod profiles;
mod server;
mod slicer;

use std::path::PathBuf;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);

    let data_dir = PathBuf::from("data");
    let db = db::Db::open(&data_dir);

    let slicer = slicer::new_slicer();
    let profiles_dir = PathBuf::from("extern/OrcaSlicer/resources/profiles");
    let profile_store = profiles::ProfileStore::load(&profiles_dir);

    let state = Arc::new(server::AppState::new(db, data_dir, slicer, profile_store));

    let app = server::router(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("failed to bind");

    println!("FarmSlicer listening on http://localhost:{port}");

    axum::serve(listener, app).await.expect("server error");
}
