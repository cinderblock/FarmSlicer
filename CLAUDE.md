# CLAUDE.md

FarmSlicer — web-first headless slicing service for small 3D print farms.
Rust backend (axum + tokio), libslic3r (via the OrcaSlicer submodule) for slicing
both natively and compiled to WebAssembly for in-browser slicing, React +
TypeScript frontend. AGPL-3.0 (inherited from libslic3r).

`README.md` is the user-facing overview (running, building, API, layout). This
file holds the facts an agent needs that the README doesn't.

## Build & Run

**The Dockerfile is the reference build.** Five stages: `orca-deps` (OrcaSlicer's
C++ deps, slow, cached) → `libslic3r` → `web` (Bun + Vite) → `server` (cargo,
links libslic3r through the cxx bridge) → `runtime` (ubuntu + binary +
`dist/web` + `resources/{profiles,info,flush}`). `docker build -t farmslicer .`
is the whole thing; `--build-arg JOBS=N` caps parallelism on a shared box.

Native builds mirror the Dockerfile's steps:

1. `git submodule update --init` (OrcaSlicer, pinned to tag **v2.4.2**).
2. Build the deps superbuild in `extern/OrcaSlicer/deps/build` with all `dep_*`
   targets except `dep_wxWidgets dep_GLEW dep_GLFW dep_OpenCSG dep_WebView2`,
   then libslic3r in `extern/OrcaSlicer/build` with `-DSLIC3R_GUI=OFF`
   (targets `libslic3r libslic3r_cgal libnest2d`). OrcaSlicer's top-level CMake
   still demands DBus and glfw3 on Linux with the GUI off: `libdbus-1-dev` and
   `-Dglfw3_DIR=docker/cmake-stubs` (an empty package config) satisfy it.
3. `cd web && bun install && bun run build` → `dist/web`.
4. `cargo build --release` → `target/release/farmslicer`; run from the repo root
   (it reads `extern/OrcaSlicer/resources` and serves `dist/web`). Port 9337.

- Linux needs GNU ld (`.cargo/config.toml` sets `-fuse-ld=bfd`): the static
  C++ archives have circular deps that need `--start-group`.
- `FARMSLICER_SKIP_CXX=1 cargo check` typechecks the Rust side without the
  C++ toolchain (build.rs returns early). Use it on Windows/dev machines.
- Windows: Visual Studio Build Tools, Strawberry Perl (MSYS perl can't build
  OpenSSL), CMake before Strawberry's `c/bin` in PATH. `build.rs` expects the
  MSVC layout (`Release/` subdirs, `.lib`), and OCCT/GMP/MPFR DLLs must be
  copied next to the binary. Nobody has built on Windows since the v2.4.2 bump.
- **Prebuilt deps are not portable across compiler major versions**: GCC links
  them with LTO bytecode (`lto1: fatal error: bytecode stream ... generated with
  LTO version 13.1 instead of the expected 15.1`). Rebuild deps with the
  compiler you link with — the reason the build lives in Docker.

### Browser engine (wasm/)

`wasm/build.sh [st|mt|all]` (needs the toolchain from
`wasm/toolchain/bootstrap.sh` + `build-deps.sh all` / `all-mt`). It applies
`wasm/patches/orca-wasm.patch` to the OrcaSlicer tree in place; use
`ORCA_SRC_DIR=<copy>` to keep the submodule pristine next to a native build.
Output: `web/public/wasm/{st,mt}/farmslicer-engine*.{mjs,wasm,data}` +
`manifest.json`. `node wasm/test/smoke.mjs --variant st --config <merged.json>`
slices a cube; `wasm/test/resolve-profile.mjs` produces such a config from the
profiles dir without a server. The `mt` variant needs cross-origin isolation
(COOP/COEP; the server and `vite dev` both send them) and a secure context.

### Dev on buildhost

The LAN build box, buildhost (24 cores, Docker), is where native builds happen; no sudo/apt there
without the maintainer's per-change OK. Working dirs this project has used:
`~/farmslicer-docker` (Docker build context), `~/farmslicer-wasm` (engine
build with its own OrcaSlicer copy), `~/wasm-ref/wasm-deps` (Emscripten
toolchain + deps). Dev containers run on **port 9338**; 9337 is production.

## Deploying

Never from this repo. CI pushes `ghcr.io/cinderblock/farmslicer:<sha>`; the
ops repo (`OWNER/ops`, `servers/buildhost/stacks/farmslicer/`) pins the
digest and deploys. The old SSH `deploy.sh` skill is gone on purpose.

## Project Structure

- `src/main.rs` — entry point: db, progress sink, slicer, profile store, server
- `src/server.rs` — HTTP router, API handlers, job pipeline (`run_slice` in
  `spawn_blocking`, one slice at a time behind the slicer mutex), browser-job
  endpoints, COOP/COEP headers
- `src/db.rs` — SQLite (printers, jobs, slices, custom_profiles), WAL, additive migrations
- `src/profiles.rs` — OrcaSlicer profile loading, `inherits` resolution, merge
- `src/progress.rs` — process-wide progress sink + cancellation flags (libslic3r
  calls back without user data, so jobs are looked up by id)
- `src/slicer.rs` — cxx bridge: `Slicer::slice(job_id, model, config_json, out)`;
  `extern "Rust"` `slice_progress` / `slice_cancelled`
- `src/discovery.rs` — Bambu SSDP listener
- `cxx/slice_core.{hpp,cpp}` — **the** slicing pipeline (Model::read_from_file →
  config from JSON via temp file on top of `FullPrintConfig::defaults()` →
  place on bed → Print::apply/validate/process/export_gcode → stats). Shared by
  the cxx bridge and the wasm bridge; no Rust or Emscripten includes allowed.
- `cxx/slicer_bridge.{h,cpp}` — thin cxx glue around slice_core
- `cxx/nanosvg_impl.cpp` — NanoSVG implementation shim (lives in GUI code upstream)
- `wasm/` — Emscripten superbuild (`CMakeLists.txt`), C bridge
  (`bridge/farmslicer_wasm.cpp`: `fs_version`, `fs_slice`, `fs_slice_start` (mt),
  `fs_cancel`, `fs_free`), vendored find-modules/shims/patch, `build.sh`, tests
- `web/src/engine/` — browser engine: `client.ts` (main thread API),
  `worker.ts` (Web Worker hosting the module), `types.ts`
- `web/src/pages/Slice.tsx` — upload, profile cascade, overrides, **Compute**
  selector (Auto / Server / This browser), browser-slice progress + upload
- `build.rs` — compiles the bridge + slice_core, links ~50 static libs
- `Dockerfile`, `.dockerignore`, `docker/cmake-stubs/` — the image
- `.github/workflows/build.yml` — check → wasm → image (registry build cache)
- `extern/OrcaSlicer/` — submodule @ v2.4.2 (libslic3r + 11k vendor profiles)
- `data/` — runtime (gitignored): SQLite db, models, G-code
- `plans/` — living plans; `plans/get-online.md` is the current one

## Architecture

- Rust handles HTTP, job queue, database, profile resolution; libslic3r does
  the slicing. `SlicerHandle(UniquePtr<Slicer>)` with `unsafe impl Send + Sync`,
  behind a `Mutex` → one slice at a time; queued jobs wait on the mutex.
- Profile system merges machine + process + filament JSON (child keys win) into
  one config object; per-job overrides are merged on top; stored on the job as
  `config_json`. Both engines consume exactly that JSON.
- Browser slicing: `POST /api/jobs` with `source=browser` creates the job and
  returns `config_json`; the worker slices; progress ticks go to
  `/api/jobs/{id}/progress` (409 = cancelled, stop); the G-code and stats go to
  `/api/jobs/{id}/result`, which files them like a server slice.
- SPA fallback serves `dist/web/index.html`; every response carries
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.

## Known Issues

- `issues/eigen-2d-3d-matrix-mismatch.md` — Eigen 5.x debug assertion, worked
  around with the `NDEBUG` define in build.rs.
- The `mt` engine works in Chrome (verified end to end) but `fs_slice_start`
  never completes under Node 22 (`wasm/test/smoke.mjs --variant mt` times out)
  and the synchronous path aborts there; Node's pthread/worker semantics
  differ from the browser's. CI smoke-tests `st` only.
- libslic3r's GCodeProcessor logs `Invalid T command (T1000)` for Bambu start
  G-code on every slice; harmless.
- Thumbnails are not embedded in G-code yet (Bambu printers show a blank preview).
- Jobs tagged `printer_id` are not sent to printers; "routing" is bookkeeping only.

## Key Conventions

- Rust 2024 edition; `NDEBUG` must be defined for the C++ (Eigen 5.x).
- JS/TS uses **Bun** (`bun.lock`; no `package-lock.json`).
- Keep `cxx/slice_core.cpp` engine-agnostic; anything Rust- or Emscripten-specific
  goes in the respective bridge.
- The submodule is pinned to an OrcaSlicer release tag; bumping it means
  rebuilding the deps image layer and re-checking `wasm/patches/orca-wasm.patch`
  applies (`git -C extern/OrcaSlicer apply --check wasm/patches/orca-wasm.patch`).
