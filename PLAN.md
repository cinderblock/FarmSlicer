# FarmSlicer: Web-First Headless Slicer Architecture Plan

## Goal

Build a web-first slicing service for a small print farm (1-2 concurrent users, a few printers). Rust backend (axum), libslic3r linked natively via cxx crate, React frontend with server-side data embedding for fast page loads. User management, job queues with auto-assign or printer-lock, sliced file retention, and GPU acceleration where feasible.

OrcaSlicer is included as a git submodule at `extern/OrcaSlicer/` and as a local reference at `../OrcaSlicer/`.

## Key Architectural Decisions

- **Rust backend (axum + tokio)** — native C++ FFI via bindgen, single binary deployment, great async, strong typing
- **Native FFI to libslic3r via `cxx`** — direct Rust↔C++ interop (classes, methods, std::string, std::vector). cmake crate builds libslic3r from the submodule. No C wrapper, no subprocess.
- **React + SSG with DB data** — Rust renders HTML shells per route with page data embedded as JSON. React hydrates instantly. Three.js for 3D viewport. Fast first paint, no loading spinners.
- **SQLite via rusqlite** — embedded, zero-config, bundled (no system dependency)
- **Profile system is JSON** — printer/filament/process profiles in `extern/OrcaSlicer/resources/profiles/`

## Project Structure

```
FarmSlicer/
├── Cargo.toml
├── CLAUDE.md
├── PLAN.md
├── extern/
│   └── OrcaSlicer/                 # Git submodule (GitHub)
├── src/
│   ├── main.rs                     # Entry point, starts axum server
│   ├── server.rs                   # HTTP router
│   ├── api/                        # REST API route handlers
│   │   ├── mod.rs
│   │   ├── slice.rs
│   │   ├── jobs.rs
│   │   ├── profiles.rs
│   │   ├── printers.rs
│   │   └── auth.rs
│   ├── slicer/                     # libslic3r integration (cxx)
│   │   ├── mod.rs                  # cxx bridge + safe Rust API
│   │   └── queue.rs                # Job queue + worker pool
│   ├── printer/                    # Printer communication
│   │   ├── mod.rs
│   │   ├── octoprint.rs
│   │   ├── moonraker.rs
│   │   └── bambu.rs
│   ├── store/                      # SQLite persistence
│   │   ├── mod.rs
│   │   ├── db.rs                   # Database setup + migrations
│   │   ├── jobs.rs
│   │   ├── slices.rs
│   │   ├── printers.rs
│   │   └── users.rs
│   ├── auth/                       # Authentication
│   │   └── mod.rs
│   └── ssr/                        # Server-side rendering
│       └── mod.rs                  # HTML shell + embedded data
├── web/                            # React frontend
│   ├── package.json
│   └── src/
├── data/                           # Runtime data (gitignored)
│   ├── farmslicer.db               # SQLite database
│   ├── models/                     # Uploaded model files
│   ├── gcode/                      # Sliced G-code output
│   └── thumbnails/
└── docker/
    └── Dockerfile
```

## Phases

### Phase 0: Project Scaffolding & Slicer Integration
**Status: In progress**

Set up Rust project, prove we can link libslic3r natively.

- [x] Initialize git repo
- [x] Add OrcaSlicer as git submodule from GitHub
- [x] Initialize Cargo project with dependencies (axum, tokio, rusqlite, serde)
- [x] Minimal HTTP server with /api/health
- [x] CLAUDE.md
- [ ] build.rs with cmake crate to build libslic3r from submodule
- [ ] cxx bridge definition for libslic3r (Model, Print, PrintConfig, progress callback)
- [ ] `src/slicer/` — safe Rust wrapper using cxx bridge
- [ ] Verify end-to-end: load STL → apply config → slice → get G-code
- [ ] Serve profiles from `extern/OrcaSlicer/resources/profiles/`

**Key reference in OrcaSlicer:**
- `src/libslic3r/Print.hpp` — Print::apply(), Print::process(), export_gcode()
- `src/libslic3r/PrintBase.hpp` — set_status_callback() for progress
- `src/libslic3r/CMakeLists.txt` — build target + all dependencies
- `src/OrcaSlicer.cpp` line ~1180 — CLI slicing flow

### Phase 1: REST API & Job Queue
**Status: Not started**

Full REST API with async slicing, job tracking, and WebSocket progress.

- [ ] Router with typed extractors (axum)
- [ ] `POST /api/slice` — upload model + config, returns job ID
- [ ] `GET /api/jobs` — list jobs
- [ ] `GET /api/jobs/:id` — job details + status
- [ ] `GET /api/jobs/:id/gcode` — download G-code
- [ ] `DELETE /api/jobs/:id` — cancel / delete
- [ ] `GET /api/profiles` — list profiles
- [ ] `GET /api/profiles/:type/:name` — get profile
- [ ] `POST /api/validate` — validate config
- [ ] WebSocket at `/api/ws/jobs/:id` — real-time progress
- [ ] Tokio task pool for background slicing
- [ ] Progress from libslic3r callback → WebSocket broadcast

### Phase 2: Persistence & Slice Management
**Status: Not started**

SQLite database, slice retention, model storage.

- [ ] rusqlite setup with migrations
- [ ] Job lifecycle: queued → slicing → done/failed/cancelled
- [ ] Slice artifact storage (G-code, thumbnails) in `data/`
- [ ] Retention policy: keep N recent slices per user
- [ ] Re-slice from stored config

**Schema:**
```sql
users (id, username, password_hash, role, api_key, created_at)
jobs (id, user_id, status, model_path, config_json, printer_id, progress, current_step, warnings, error, created_at, started_at, completed_at)
slices (id, job_id, gcode_path, thumbnail_path, file_size, print_time_sec, filament_g, filament_m, created_at)
printers (id, name, protocol, host, api_key, status, capabilities, last_seen)
```

### Phase 3: User Management
**Status: Not started**

- [ ] User CRUD, password hashing (argon2)
- [ ] JWT auth + API key alternative
- [ ] Roles: admin, operator
- [ ] First-run setup

### Phase 4: Printer Management & Job Routing
**Status: Not started**

- [ ] Printer CRUD + status polling
- [ ] Protocol adapters: OctoPrint, Moonraker, Bambu MQTT
- [ ] Auto-assign vs lock-to-printer routing
- [ ] Per-printer print queue + monitoring

### Phase 5: Web Frontend (React + SSG)
**Status: Not started**

- [ ] React + TypeScript + Three.js
- [ ] SSG: Rust renders HTML with embedded JSON data per route, React hydrates
- [ ] Pages: upload/slice, job queue, slice library, printer dashboard, settings
- [ ] 3D model viewer (Three.js), G-code layer preview (future)
- [ ] Responsive for tablet on shop floor

### Phase 6: GPU Acceleration (Research)
**Status: Not started**

Modify libslic3r fork for GPU compute on heaviest operations (infill distance fields, tree support collision, seam placement).

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│              React Frontend (SSG hydration)               │
│            TypeScript + Three.js (3D viewport)            │
└──────────────────────┬──────────────────────────────────┘
                       │ REST + WebSocket
┌──────────────────────▼──────────────────────────────────┐
│               FarmSlicer Server (Rust / axum)             │
│                                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐ │
│  │ REST API │ │ Auth/JWT │ │ WebSocket│ │ SSR/SSG    │ │
│  └────┬─────┘ └──────────┘ └──────────┘ └────────────┘ │
│       │                                                  │
│  ┌────▼─────┐ ┌────────────┐ ┌─────────────────────┐   │
│  │ Job Queue│ │ Slice Store│ │ Printer Manager     │   │
│  │ (tokio)  │ │ (retention)│ │ (OctoPrint/Klipper/ │   │
│  └────┬─────┘ └────────────┘ │  Bambu)             │   │
│       │                      └─────────────────────┘   │
│  ┌────▼────────────────────────────────────────────┐   │
│  │   libslic3r (native via cxx crate)                │   │
│  │   Model I/O → PrintConfig → slice → G-code       │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │         SQLite (rusqlite, bundled)                │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
         │                              │
    ┌────▼────┐                   ┌─────▼─────┐
    │ Printer │                   │  Printer  │
    └─────────┘                   └───────────┘
```

## Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Backend | Rust (axum + tokio) | Native FFI, single binary, safe concurrency |
| Slicer | libslic3r (cxx crate) | Direct C++ interop, progress callbacks, no subprocess overhead |
| Database | SQLite (rusqlite bundled) | Embedded, zero-config |
| Auth | JWT + argon2 | Stateless, secure |
| Frontend | React + TypeScript + Three.js | Modern, strong 3D/WebGL ecosystem |
| SSG | Rust HTML templates + embedded JSON | Fast first paint with DB data |
| Build | Cargo + cmake crate + cxx | Builds libslic3r as part of cargo build |
