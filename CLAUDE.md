# CLAUDE.md

FarmSlicer — web-first headless slicing service for small 3D print farms.
Rust backend (axum + tokio), libslic3r (via OrcaSlicer submodule) for slicing, React frontend.

## Build & Run

```bash
cargo build
cargo run          # Server on http://localhost:3000
```

## Project Structure

- `src/main.rs` — Entry point, starts axum server
- `src/server.rs` — HTTP router and route handlers
- `extern/OrcaSlicer/` — Git submodule (source for libslic3r + profiles)
- `data/` — Runtime data (gitignored): SQLite db, uploaded models, G-code output

## Architecture

Rust handles HTTP, auth, job queue, printer comms, and database.
libslic3r linked natively via cxx crate (direct Rust↔C++ interop).
React frontend with server-side data embedding for fast page loads.

## Dependencies

- axum — HTTP server + WebSocket
- tokio — Async runtime
- rusqlite — SQLite (bundled)
- serde / serde_json — Serialization
- tower-http — Static file serving, CORS

## Key Conventions

- Rust 2024 edition
- OrcaSlicer reference at `../OrcaSlicer/`
