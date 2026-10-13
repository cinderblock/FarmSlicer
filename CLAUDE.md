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
- `FARMSLICER_SKIP_CXX=1` skips the C++ bridge (build.rs returns early and
  sets cfg `farmslicer_no_cxx`): `src/slicer.rs` compiles a stub slicer that
  fails every server slice, so the binary links and runs without libslic3r.
  `cargo check`/`cargo test` with it work anywhere OpenSSL can build (not on
  this Windows box without Strawberry Perl; not in WSL without make).
- **Tests**: `tests/run-e2e.sh` builds the stub server and runs every
  `tests/*-e2e.mjs` against a fresh instance (HOST=127.0.0.1, port 9339);
  `tests/lib.mjs` has the software passkey authenticator + cookie client.
  From Windows, run it on buildhost: tar `Cargo.* build.rs .cargo src tests`
  to a home dir there and run with `CARGO_TARGET_DIR` set. CI runs it too.
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
- `src/printer/` — vendor-neutral printers: `mod.rs` (`Protocol` = the
  `printers.protocol` values, `Capabilities` the UI gates controls on,
  connection-field descriptions, `Command`), `status.rs` (`PrinterStatus`
  with the normalized `state` vocabulary: IDLE PREPARE RUNNING PAUSE FINISH
  FAILED CANCELLED SLICING; `job_key`/`job_file` identify the job),
  `hub.rs` (`PrinterHub`: one link per printer, `sync()` after any printer
  change, enum dispatch to driver handles, status board + broadcast),
  `http.rs` (shared reqwest client, base URLs from addresses), `tls.rs`
  (accept printers' self-signed / Bambu-CA certs, ring provider)
- Drivers (each a `link.rs` task + `status.rs` + send/pictures/camera in
  `mod.rs`; references in `plans/printer-drivers/*.md`):
  - `src/bambu/` — MQTT/TLS (`link.rs`: request/response by `sequence_id`,
    delta reports merged in `status.rs`), `ftps.rs` (implicit FTPS; the data
    channel must resume the control channel's TLS session), `send.rs`
    (`project_file`, AMS mapping fields), `models.rs`
  - `src/moonraker/` — Klipper: WebSocket JSON-RPC, objects subscribed and
    merged, HTTP upload then `printer.print.start` (refused while paused:
    Klipper would replace the job)
  - `src/octoprint/` — push socket (passive login) + REST; how a print ended
    comes from events (the file stays selected); select+print, never `start`
  - `src/prusalink/` — polled (no push), remembers the last job (FINISHED/
    STOPPED drop it), ATTENTION = waiting at the printer; no speed/heat/camera
  - `src/sdcp/` — Elegoo Centauri Carbon: WebSocket envelopes by RequestID,
    status asked for when quiet; **only Elegoo's own payloads** (a surprise
    can crash the printer mid-print)
- `src/camera/` — on-demand feeds, one upstream per printer: `bambu.rs`
  (RTSPS via `retina` behind a local TLS proxy → H.264 to the browser's
  WebCodecs; A1/P1 JPEG on port 6000), `mjpeg.rs` (MJPEG or snapshot
  polling: Klipper, OctoPrint, SDCP)
- `src/discovery/` — `ssdp.rs` (Bambu, shared port 2021), `mdns.rs`
  (`_moonraker._tcp`, `_octoprint._tcp`, `_prusalink._tcp`), `sdcp.rs`
  (`M99999` UDP broadcast)
- `src/package/` — what printers are sent: `bambu.rs` (`.gcode.3mf`
  plates, slice_info) and `gcode.rs` (plain G-code: model, nozzle, time,
  filaments, bed type and thumbnails from the slicer's comments)
- `src/printers_api.rs` — printer CRUD (admins), status + SSE events,
  `/api/printer-protocols`, cameras
- `src/farm_api.rs` — equipment reports, preheat/cooldown; print rules are
  `groups::PrintRules` (inherited `print_rules`, site setting default),
  checked in `prints_api::send_job` → `pending_approval` prints
- `src/query.rs` — `flag`: `?x=1` query booleans
- `src/cost.rs` — filament cost estimates (site setting `filament_prices`)
- `src/printer_thumbs.rs` — job pictures for printer cards (the job's
  package, or from the printer: Bambu project over FTPS, Moonraker/OctoPrint
  thumbnails, PrusaLink `/thumb/l`, SDCP history image)
- `src/overlay.rs` — thumbnail label (inherited group setting
  `thumbnail_label`, `{key}`/`{group}` template) and per-group logos
  (`data/logos/<group>.png`); `resources/fonts/` — the label font (OFL)
- `src/printing.rs` — sending: compatibility (package format per protocol,
  model, nozzle), AMS mapping where the protocol maps filaments, dispatch to
  the driver's send, and `track()` moving prints along from printer
  statuses (a print not yet seen running can only start); `src/prints_api.rs`
  — uploads, targets, send, prints, control
- `tests/fake-printer/` — Docker fake Bambu printer (mosquitto TLS + vsftpd
  with `require_ssl_reuse`); `tests/fake-{moonraker,octoprint,prusalink,sdcp}/`
  — Node fakes the e2e tests start in-process (`tests/fake-lib.mjs`: WebSocket
  server, multipart); `tests/fake-octoprint/Dockerfile` — real OctoPrint +
  Virtual Printer for conformance runs
- `src/groups.rs` — group tree, inherited settings, permissions
  (`can_manage`, `can_govern`), job visibility, seasons; `src/groups_api.rs`
  (groups, members, links, library, usage, site settings);
  `src/join_api.rs` (join flow, guest accounts); `src/quota.rs`
  (rules, periods, three-layer check). Plan: `plans/groups-quotas-registration.md`
- `cxx/slice_core.{hpp,cpp}` — **the** slicing pipeline (Model::read_from_file →
  config from JSON via temp file on top of `FullPrintConfig::defaults()` →
  place on bed → Print::apply/validate/process/export_gcode → stats). Shared by
  the cxx bridge and the wasm bridge; no Rust or Emscripten includes allowed.
- `cxx/thumbnail.{hpp,cpp}` — software rasteriser for plate thumbnails (no
  GL anywhere) and the label/logo overlay (stb_truetype from libslic3r's
  Emboss.cpp; logo arrives as RGBA). slice_core passes it to
  `export_gcode` as the thumbnail callback and writes the Bambu
  `.gcode.3mf` with libslic3r's `store_bbs_3mf` (Options::package_path)
- `cxx/slicer_bridge.{h,cpp}` — thin cxx glue around slice_core
- `cxx/nanosvg_impl.cpp` — NanoSVG implementation shim (lives in GUI code upstream)
- `wasm/` — Emscripten superbuild (`CMakeLists.txt`), C bridge
  (`bridge/farmslicer_wasm.cpp`: `fs_version`, `fs_slice`, `fs_slice_start` (mt),
  `fs_set_options` (package + thumbnail overlay for the next slice; the
  package lands in MEMFS at the report's `package` path), `fs_cancel`,
  `fs_free`), vendored find-modules/shims/patch, `build.sh`, tests
- `web/src/engine/` — browser engine: `client.ts` (main thread API),
  `worker.ts` (Web Worker hosting the module), `types.ts`
- `web/src/pages/Slice.tsx` — upload, profile cascade, overrides, **Compute**
  selector (Auto / Server / This browser), browser-slice progress + upload
- `build.rs` — compiles the bridge + slice_core, links ~50 static libs
- `Dockerfile`, `.dockerignore`, `docker/cmake-stubs/` — the image
- `.github/workflows/build.yml` — check → wasm → image (registry build cache)
- `extern/OrcaSlicer/` — submodule @ v2.4.2 (libslic3r + 11k vendor profiles)
- `data/` — runtime (gitignored): SQLite db, models, G-code
- `tests/` — API end-to-end tests (`run-e2e.sh`, `lib.mjs`, `*-e2e.mjs`,
  one per printer protocol). `run-e2e.sh` prints no summary of its own:
  check its exit code, not the last suite's "ALL PASSED"
- `plans/` — living plans

## Architecture

- Rust handles HTTP, job queue, database, profile resolution; libslic3r does
  the slicing. `SlicerHandle(slicer::SlicerBox)` with `unsafe impl Send + Sync`,
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
- Accounts (`src/auth.rs` policy + WebAuthn RP, `src/auth_api.rs` handlers,
  `plans/auth.md`): **passkeys only, no passwords**, no configured secrets.
  Ceremonies are start/finish pairs with a server-held `flow_id` (5 min, in
  memory): `/api/auth/setup/*` (first run, creates the owner),
  `/api/auth/login/*` (by username, or discoverable without one),
  `/api/auth/invite/{token}/*` (enrol through an admin-issued link),
  `/api/auth/recover/*` (username + one-time recovery code),
  `/api/me/passkeys/*` (add more). Credentials (`webauthn_rs::Passkey` JSON),
  session tokens, API keys, invite tokens and recovery codes live in SQLite,
  the secrets as SHA-256 only. RP ID = host of the first `FARMSLICER_ORIGINS`
  entry (changing it orphans every passkey). Every `/api` route except
  health/auth goes through `auth::require_auth` (attaches `CurrentUser`);
  admin handlers call `auth::require_admin`. `FARMSLICER_NO_AUTH=1`
  short-circuits all of it for local dev. `tests/passkey-e2e.mjs` is a
  software-authenticator end-to-end test (webauthn-rs builds OpenSSL from
  source via the `openssl` crate's `vendored` feature, which on Windows needs
  Strawberry Perl; typecheck on Linux if that bites).
- Groups (`src/groups.rs`): a tree; direct memberships (`member`/`manager`,
  `active`/`pending`); settings JSON inherited down the tree (`listed` and
  `subgroups` are per group). `jobs.group_id` charges and shares a job; job
  visibility = creator, active members if `shared_library`, managers of the
  group or an ancestor, admins. Account `kind` `full`|`guest`: guests have no
  credential (long session + one-time sign-in codes stored in
  `recovery_codes`); `auth::require_full` blocks them from API keys,
  printers, profiles, group creation. Quotas are checked in `create_job`
  (429). Nothing deployment-specific (league/team names) belongs in the code.

## Known Issues

- `issues/eigen-2d-3d-matrix-mismatch.md` — Eigen 5.x debug assertion, worked
  around with the `NDEBUG` define in build.rs.
- The `mt` engine works in Chrome (verified end to end) but `fs_slice_start`
  never completes under Node 22 (`wasm/test/smoke.mjs --variant mt` times out)
  and the synchronous path aborts there; Node's pthread/worker semantics
  differ from the browser's. CI smoke-tests `st` only.
- libslic3r's GCodeProcessor logs `Invalid T command (T1000)` for Bambu start
  G-code on every slice; harmless.
- Engines built before `fs_set_options` existed slice without a package;
  their jobs can't be sent until re-sliced (the worker skips the options).
- Jobs tagged `printer_id` at slicing time are not sent automatically;
  sending is an explicit `POST /api/jobs/{id}/print`.
- Printer drivers and what proved them (`plans/printer-drivers.md`): Bambu
  on real printers; Klipper against real Klipper + Moonraker (simulavr,
  `mainsail-crew/virtual-klipper-printer` built locally); OctoPrint against
  real OctoPrint 1.11.8 and 2.0.0rc6 (Virtual Printer); PrusaLink and the
  Elegoo Centauri Carbon (SDCP) against the Node fakes only: no hardware,
  no emulator. Tracked per model in `issues/untested-printers.md` (update
  it when a printer is tried). The Centauri Carbon 2 (MQTT) isn't supported.
- Profiles' `compatible_printers_condition` isn't evaluated (OrcaSlicer runs
  it through its PlaceholderParser); filaments and processes with only a
  condition are offered to every printer of the vendor.

## Key Conventions

- A new printer protocol is a driver module (link task publishing
  `PrinterStatus` through a `StatusSink`, a `Handle` taking `Command`s, a
  send function, pictures, camera) plus a `Protocol` variant (capabilities,
  connection fields) and an arm in `printer/hub.rs`, `printing::send`,
  `printer_thumbs::fetch` and `printers_api::camera_kind`; a fake under
  `tests/fake-<name>/` and a `tests/<name>-e2e.mjs`. The web UI needs no
  change: it renders the protocol's fields and capabilities.
- Rust 2024 edition; `NDEBUG` must be defined for the C++ (Eigen 5.x).
- JS/TS uses **Bun** (`bun.lock`; no `package-lock.json`).
- Keep `cxx/slice_core.cpp` engine-agnostic; anything Rust- or Emscripten-specific
  goes in the respective bridge.
- The submodule is pinned to an OrcaSlicer release tag; bumping it means
  rebuilding the deps image layer and re-checking `wasm/patches/orca-wasm.patch`
  applies (`git -C extern/OrcaSlicer apply --check wasm/patches/orca-wasm.patch`).
