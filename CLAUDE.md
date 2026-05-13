# CLAUDE.md

FarmSlicer — web-first headless slicing service for small 3D print farms.
Rust backend (axum + tokio), libslic3r (via OrcaSlicer submodule) for slicing, React + TypeScript frontend.

## Build & Run

### Prerequisites (Windows)

1. **Rust toolchain** — `rustup` with stable MSVC target
2. **CMake** — must appear in PATH before Strawberry Perl's `c/bin`
3. **Strawberry Perl** — needed for OpenSSL build (MSYS perl won't work)
4. **Visual Studio Build Tools** — C++ workload with MSVC and Windows SDK
5. **Node.js** — for frontend build

### Build OrcaSlicer deps (one-time)

```bash
# From extern/OrcaSlicer/deps:
mkdir build && cd build
cmake .. -G "Visual Studio 17 2022" -A x64
cmake --build . --config Release --target dep_CURL dep_TBB dep_Boost dep_OCCT dep_OpenVDB
# Then build libslic3r itself:
cd ../../
mkdir build && cd build
cmake .. -G "Visual Studio 17 2022" -A x64 -DSLIC3R_GUI=OFF
cmake --build . --config Release --target libslic3r libslic3r_cgal libnest2d
```

### Build & run FarmSlicer

```bash
cd web && npm install && npx vite build && cd ..
cargo build
# Copy OCCT/GMP/MPFR DLLs to target/debug/ (they're dynamic)
cargo run          # Server on http://localhost:3000
```

## Project Structure

- `src/main.rs` — Entry point, initializes slicer + profile store, starts server
- `src/server.rs` — HTTP router, API handlers, background slicing via spawn_blocking
- `src/profiles.rs` — OrcaSlicer profile loading with JSON inheritance resolution
- `src/slicer.rs` — cxx bridge FFI to libslic3r
- `src/db.rs` — SQLite persistence (printers, jobs, slices) with WAL mode
- `cxx/slicer_bridge.cpp` — C++ side: Model::read_from_file → Print::apply → process → export_gcode
- `cxx/slicer_bridge.h` — Slicer class declaration
- `cxx/nanosvg_impl.cpp` — NanoSVG implementation shim (normally in GUI code we don't build)
- `build.rs` — Links 40+ libraries from OrcaSlicer deps
- `web/` — React + TypeScript + Three.js frontend (Vite)
- `extern/OrcaSlicer/` — Git submodule (libslic3r source + 859 printer profiles)
- `data/` — Runtime (gitignored): SQLite db, uploaded models, G-code output
- `dist/web/` — Built frontend assets served by axum

## API Endpoints

- `GET /api/health` — Health check
- `GET /api/profiles/machines` — List instantiable machine profiles
- `GET /api/profiles/processes?machine=NAME` — Compatible process profiles
- `GET /api/profiles/filaments?machine=NAME` — Compatible filament profiles
- `GET /api/printers` / `POST /api/printers` — Printer CRUD
- `DELETE /api/printers/{id}`
- `GET /api/jobs` / `POST /api/jobs` — Job management (multipart: model + profile names)
- `POST /api/jobs/{id}/cancel`
- `GET /api/slices` — Completed slice records
- `GET /api/slices/{id}/download` — Download G-code

## Architecture

- Rust handles HTTP, job queue, database, and profile resolution
- libslic3r linked natively via cxx crate (direct Rust↔C++ interop, no bindgen)
- `SlicerHandle(UniquePtr<Slicer>)` with `unsafe impl Send + Sync`, behind `Mutex`
- Slicing runs in `tokio::task::spawn_blocking` to avoid blocking async runtime
- Profile system resolves OrcaSlicer JSON inheritance chains and merges machine + process + filament into single config
- SPA fallback: non-API routes serve index.html for client-side routing

## Known Issues

- `issues/eigen-2d-3d-matrix-mismatch.md` — Eigen 5.x debug assertion in ExtrusionEntity.hpp:513, worked around with NDEBUG define
- End-to-end slicing with real STL not yet tested — profile config may need tweaks for DynamicPrintConfig::load_from_json()
- `print_time_sec` always returns 0 (TODO in slicer_bridge.cpp)

## Dependencies

- axum (ws, multipart) — HTTP server
- tokio (full) — Async runtime
- rusqlite (bundled) — SQLite
- serde / serde_json — Serialization
- tower-http (fs, cors) — Static files, CORS
- cxx / cxx-build — Rust↔C++ FFI
- uuid — ID generation

## Key Conventions

- Rust 2024 edition
- NDEBUG must be defined in build.rs (Eigen 5.x compatibility)
- OrcaSlicer submodule at `extern/OrcaSlicer/`
