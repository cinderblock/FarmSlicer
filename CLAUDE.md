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
  From Windows, run it on buildhost: tar `Cargo.* build.rs .cargo src tests
  web/src/data` (src includes a JSON from there) to a home dir there and run
  with `CARGO_TARGET_DIR` set (and `~/.cargo/bin` on PATH: a plain `ssh`
  command doesn't have it). CI runs it too. A test can ask for extra
  server environment with a `// e2e-env: K=V` line. Web unit tests:
  `cd web && bun test` (`web/test/`, outside `src` so `tsc -b` skips them).
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
slices a cube (`--plate`: three parts from two models; `--package`: a
`.gcode.3mf` too; CI runs the first two); `wasm/test/resolve-profile.mjs`
produces such a config from the profiles dir without a server (one
filament; a multi-filament config comes from `POST /api/jobs` with
`source=browser`, its `config_json`). An empty config fails libslic3r's
validation ("Relative extruder addressing requires ... G92 E0"). The `mt` variant needs cross-origin isolation
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
- `src/db.rs` — SQLite (printers, jobs, slices, custom_profiles), WAL, additive
  migrations. A job's source models are `job_models` (several, in order;
  `path` '' = kept in the user's browser, found again by `sha256`); what
  it was made from is `jobs.inputs_json` (`server::JobInputs`: machine,
  process, filaments, plate type, printer, routing, group, source), what
  the Slice page proposed `proposed_json`, its parts `plate_json`.
  `delete_job` returns the files to remove (slices rows go too; prints and
  incidents keep their history)
- `src/profiles.rs` — OrcaSlicer profile loading, `inherits` resolution,
  merge. `resolve_config(machine, process, &[filaments])` is
  `PresetBundle::full_fff_config` without applied extruders: filament list
  keys concatenate per filament, `FILAMENT_VARIANT_KEYS` (libslic3r's
  `filament_options_with_variant`) get one entry per nozzle variant,
  `filament_self_index` says whose, missing flags take libslic3r's default
  (never a neighbour's `filament_is_support`), several filaments get a
  colour each. `filament_info` (cached): material, support, soluble, the
  printers' name ("PLA-S")
- `src/reports_api.rs` — `GET /api/reports/defaults` (admins): proposed vs
  made-with per setting (`web/src/pages/Reports.tsx`)
- `src/nozzles.rs` — each filament's nozzle on dual-nozzle printers (pure,
  unit-tested): `filament_printable`, then what the target printers have
  loaded per side (`Tray.nozzle`), then the printer's `nozzle_priority`,
  keeping parts and supports apart. `server::job_config` builds every job's
  config (profiles, overrides, plate type, then the plan as a Manual
  `filament_map` unless the overrides name one; `jobs.nozzle_plan_json`);
  `POST /api/nozzle-plan` is the Slice page's preview of the same
  (`components/NozzlePlanView.tsx`). Plan: `plans/nozzle-choice.md`
- `src/progress.rs` — process-wide progress sink + cancellation flags (libslic3r
  calls back without user data, so jobs are looked up by id)
- `src/slicer.rs` — cxx bridge: `Slicer::slice(job_id, &models, config_json,
  out, options)` (`ModelInput`: path, name, per copy a rotation and offset);
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
    (`project_file`, AMS mapping fields), `models.rs`, `hms.rs` (HMS
    codes' and `print_error`'s texts per device type = serial prefix, from
    `data/hms.json`; regenerate with `node src/bambu/data/harvest-hms.mjs`)
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
- `src/gcode/` — the G-code check: `lex.rs` (lines read like firmware;
  `lex_other` for other makes' dialects: Klipper extended commands and
  macros, text arguments), `check.rs` (simulation, findings, time planner;
  `Declared::other_firmware` = universal checks without Bambu's allowlist),
  `data.rs` + `data/*.json` (Bambu's allowlist: `orca.json`/`bambustudio.json`
  generated by `harvest.rs` from vendor profiles, `slicer.json`
  hand-written; `printers.json`: every other vendor's printers by
  `printer_model` and their materials), `template.rs`;
  `src/safety.rs` runs it on every package, stores `Plate.check`, re-checks
  stale results (fingerprint = checker + data + limits). Regenerate data:
  `FARMSLICER_REGEN_GCODE_DATA=1 cargo test gcode::harvest` (Orca; add
  `BAMBUSTUDIO_PROFILES=<release>=<dir>:...` for BambuStudio). Plan:
  `plans/gcode-safety.md`
- `src/incidents.rs` — the G-code incident log (`gcode_incidents`): custom
  G-code (uploads, overrides beyond the settings schema, anything the check
  held) that fails its check (`safety::check_job`), fails a print or makes
  the printer raise an error (`printing.rs`: send, `apply`, the sweep);
  deduplicated by key; `GET /api/gcode-incidents`, Users page
- `src/feedback.rs` — feedback policy: kinds, statuses, size caps,
  per-account token buckets (a static, not in `AppState`), the fingerprint
  (source + normalised message + normalised first stack frame; unit-tested),
  and `slice_failed` (the one-line hook in `run_slice` and `fail_job`).
  `src/feedback_api.rs` — `/api/feedback*` (manual reports, error batches,
  list/counts/detail, admin triage). `src/db/feedback.rs` — storage, a
  submodule of db.rs: one `feedback` table for manual and automatic
  reports (automatic: one row per fingerprint with a count) plus
  `feedback_occurrences` (a row per account and app version, 25 kept).
  Non-admins see their own reports and only their own occurrences of
  errors. Plan: `plans/feedback.md`
- `web/src/errorReporting.ts` — automatic error reports (window errors,
  rejections, `console.error`, error boundaries, `/api` 5xx and network
  failures), batched and deduplicated, queued in localStorage until signed
  in (`setSignedIn` from main.tsx); the console wrappers always call the
  original first (never filter console output). Also the ring buffer of
  recent console messages that manual feedback attaches.
  `components/ErrorBoundary.tsx`, `components/FeedbackDialog.tsx` (the
  sidebar's "Send feedback"), `pages/Feedback.tsx` (admin triage / "My
  feedback"), `feedback.ts` (types, labels)
- `src/config_policy.rs` — overrides/custom profiles: members get the
  settings-schema keys only (no G-code keys), nobody gets `post_process`
- `src/package/zipcheck.rs` — refuses ambiguous zips (duplicate names,
  hidden local entries) before anything reads a package
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
- `src/preview_api.rs` — `GET /api/jobs/{id}/gcode?plate=N` for the preview:
  the plain G-code, else plate N of the `.gcode.3mf` (zipcheck first),
  streamed from a blocking task through a channel; with gzip accepted, a
  deflated plate goes out as the archive's own deflate stream in a gzip
  frame (CRC and size from the zip directory), plain files are gzipped on
  the fly; `X-Gcode-Bytes` = uncompressed size
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
- `cxx/slice_core.{hpp,cpp}` — **the** slicing pipeline, `slice_models`:
  config from JSON via temp file on top of `FullPrintConfig::defaults()`,
  then `Preset::normalize` (every filament key an entry per filament, as
  the desktop app loads presets) and, for several filaments, purge volumes
  from their colours (`complete_flush_volumes`, the CLI's method) → the
  plate (`build_plate`: each model file once, each copy an instance of its
  objects, rotated, centred on its offset and dropped onto the bed by
  itself) → a `BuildVolume` check naming the part that doesn't fit →
  Print::apply/validate/process/export_gcode → stats, the package (with
  libslic3r's filament-to-nozzle map). On multi-nozzle printers the prime
  tower goes where the desktop app puts it (x 165, y 250, then inside the
  area every nozzle reaches: `place_wipe_tower`, `fit_wipe_tower`). With a Manual map, a filament the
  export's G-code check says its nozzle can't reach moves to the other
  nozzle and the plate is sliced again (layers kept); G-code a nozzle can't
  reach is refused (`check_nozzle_reach`, any mode). The `Print` lives in zeroed memory
  (`ZeroedPrint`; `issues/libslic3r-fake-wipe-tower.md`). Shared by the
  cxx bridge and the wasm bridge; no Rust or Emscripten includes allowed.
- `src/placement.rs` — `Placement` (a row-major rotation applied to the
  model as loaded, plus the XY offset of its bounding-box centre from the
  bed centre) and `PlateLayout` (the job's `plate`: parts by model index,
  copies allowed; a lone part may be unplaced = centred). Checked on
  `POST /api/jobs`, stored as `jobs.plate_json` (`placement_json` on older
  jobs; `server::job_plate` reads either) and handed to both engines. The
  wasm engine stages models 1.. with `fs_stage_model` and takes the plate in
  `fs_set_options`; `fs_version` reports `placement` and `plate`, and the
  worker refuses what an older engine would ignore
- `web/src/components/viewer/` — the Slice page's 3D view, Z-up in slicer
  coordinates with the origin at the bed centre: `part.ts` (`PartShape`: a
  loaded model, its convex hull (capped input, see the file) and overhang
  cache, shared by copies; `Part`: one copy's placement, fit against the
  bed, look), `layout.ts` (footprints = 2D hulls, overlap by separating
  axes, free spots for Duplicate/Add/Fill, shelf-packing Arrange),
  `overhangs.ts` (faces under the support threshold off the plate, points
  that start in mid-air; the amber/red overlay), `Bed.tsx`, `drag.ts`
  (pointer rays, snapping, dragging a part), `Gizmo.tsx` (move arrows,
  rotate rings, lay on face, for the selected part). `ModelViewer.tsx`
  reports `PlateState` (files in plate order, the plate, fit, overlaps) and
  the support check. No camera damping on purpose (CAD-style direct
  control)
- `web/src/components/preview/` — the G-code preview. `GcodePreview.tsx`
  (`source={{url}}` or `{{data}}`: text, bytes or a Blob already in memory;
  optional `bed`, `filamentColors`): layer range slider (`LayerSlider.tsx`),
  move scrubber, colour modes + legend (`colors.ts`, `features.ts`:
  feature names folded onto OrcaSlicer's), summary. `parser.ts` (pure, no
  DOM; `web/test/`) runs in `worker.ts`, started by `load.ts`; output
  (`types.ts`): extrusions as a point chain with gap segments, 16-bit
  sizes/speeds, travels, retractions, per-layer offsets. `scene.ts`:
  instanced beads drawn straight from those arrays in 256k chunks (layer
  range = instance count + a shader lower bound), lines above
  `BEAD_BUDGET`, lines while the camera moves above `MOVING_LINES`. Same
  scene convention as `viewer/` (bed centre at the origin), damping off
- `web/src/pages/Job.tsx` — `/jobs/:id`: facts, slicer warnings (support
  ones in red), progress, the preview per plate, G-code check, Print…
- `cxx/thumbnail.{hpp,cpp}` — software rasteriser for plate thumbnails (no
  GL anywhere) and the label/logo overlay (stb_truetype from libslic3r's
  Emboss.cpp; logo arrives as RGBA). slice_core passes it to
  `export_gcode` as the thumbnail callback and writes the Bambu
  `.gcode.3mf` with libslic3r's `store_bbs_3mf` (Options::package_path)
- `cxx/slicer_bridge.{h,cpp}` — thin cxx glue around slice_core
- `cxx/nanosvg_impl.cpp`, `cxx/color_space_shim.cpp` — NanoSVG and
  `RGB2HSV` (libslic3r's flush model needs it): upstream keeps both in GUI
  code
- `wasm/` — Emscripten superbuild (`CMakeLists.txt`), C bridge
  (`bridge/farmslicer_wasm.cpp`: `fs_version`, `fs_slice`, `fs_slice_start` (mt),
  `fs_set_options` (package + thumbnail overlay for the next slice; the
  package lands in MEMFS at the report's `package` path), `fs_cancel`,
  `fs_free`), vendored find-modules/shims/patch, `build.sh`, tests
- `web/src/engine/` — browser engine: `client.ts` (main thread API),
  `worker.ts` (Web Worker hosting the module), `types.ts`
- `web/src/pages/Slice.tsx` — the plate (Prepare) and the last slice
  (Preview, `components/SliceResult.tsx`: progress, layers, warnings,
  Send), profile cascade, Supports (`components/SupportsPanel.tsx`; the
  choice of materials is `web/src/supports.ts`, unit-tested), overrides,
  **Compute** selector (Auto / Server / This browser), re-slicing
  (`?from=<job>`), what it proposed (`proposed`), models kept in the
  browser (`web/src/localModels.ts`, IndexedDB)
- `web/src/slicerWarnings.ts` — sorting a job's warnings: support ones,
  others, technical notes (older jobs; the server now only logs those)
- `build.rs` — compiles the bridge + slice_core, links ~50 static libs
- `Dockerfile`, `.dockerignore`, `docker/cmake-stubs/` — the image
- `.github/workflows/build.yml` — check → wasm → image (registry build cache)
- `extern/OrcaSlicer/` — submodule @ v2.4.2 (libslic3r + 11k vendor profiles)
- `data/` — runtime (gitignored): SQLite db, models, G-code
- `tests/` — API end-to-end tests (`run-e2e.sh`, `lib.mjs`, `*-e2e.mjs`:
  one per printer protocol, plus job history (models, plates, delete, the
  defaults report), G-code preview, feedback, placement, ...). `run-e2e.sh` prints no summary of its own:
  check its exit code, not the last suite's "ALL PASSED". `{ROOT}` in an
  `e2e-env` value is the repo root; `tests/fixtures/profiles/` is a tiny
  profile tree (H2D, X1C) for tests that need profiles
  (`ORCA_RESOURCES_DIR={ROOT}/tests/fixtures`)
- `plans/` — living plans

## Architecture

- Rust handles HTTP, job queue, database, profile resolution; libslic3r does
  the slicing. `SlicerHandle(slicer::SlicerBox)` with `unsafe impl Send + Sync`,
  behind a `Mutex` → one slice at a time; queued jobs wait on the mutex.
- Profile system merges machine + process + the job's filaments (child keys
  win; several filaments as OrcaSlicer combines them) into one config
  object; per-job overrides are merged on top; stored on the job as
  `config_json`. Both engines consume exactly that JSON.
- Every job keeps its source models (uploaded with the job, browser slices
  too, unless kept on the device), its inputs and its plate, so it can be
  sliced again (`/slice?from=<job>`) or deleted with its files.
- Supports: the Slice page sends `enable_support` (on by default),
  `support_filament` / `support_interface_filament` and the filaments they
  point at (1 = the part's, 2 = the interface's, 3 = a separate base).
  On dual-nozzle printers libslic3r picks each filament's nozzle; the
  package records it and the AMS mapping keeps each filament on an AMS that
  feeds its nozzle (`AmsUnit.nozzle` from the unit's `info` flags).
- Browser slicing: `POST /api/jobs` with `source=browser` creates the job and
  returns `config_json`; the worker slices; progress ticks go to
  `/api/jobs/{id}/progress` (409 = cancelled, stop); the G-code and stats go to
  `/api/jobs/{id}/result`, which files them like a server slice.
- SPA fallback serves `dist/web/index.html`; every response carries
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`; pages (`text/html`) also
  `Cache-Control: no-cache, no-transform`, which keeps a proxy from
  injecting scripts (Cloudflare's Web Analytics beacon, which COEP blocks).
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
- Remote access (`plans/remote-access.md`): `FARMSLICER_LAN_HEADER` names
  the header the reverse proxy sets to `1` on LAN requests; anything else is
  "remote" (fail closed). `auth::remote_gate` limits the public routes to
  health, status, passkey login/logout and invites; `auth::authenticate`
  accepts from the internet only `sessions.method = 'passkey'` sessions of
  full accounts with `users.remote_access`, never API keys. Every
  `start_session` call names its method (`auth::VIA_*`). The proxy (ops
  Caddy) must be updated only after an app that knows the header is live.
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
- The G-code check's time estimate leaves out start-sequence calibrations:
  5-20 min prints read 0.5-0.9x of Bambu Studio's estimate (long prints
  ~1.0x). Multi-material H2D files haven't been through it yet.
- Jobs tagged `printer_id` at slicing time are not sent automatically;
  sending is an explicit `POST /api/jobs/{id}/print`.
- Printer drivers and what proved them (`plans/printer-drivers.md`): Bambu
  on real printers; Klipper against real Klipper + Moonraker (simulavr,
  `mainsail-crew/virtual-klipper-printer` built locally); OctoPrint against
  real OctoPrint 1.11.8 and 2.0.0rc6 (Virtual Printer); PrusaLink and the
  Elegoo Centauri Carbon (SDCP) against the Node fakes only: no hardware,
  no emulator. Tracked per model in `issues/untested-printers.md` (update
  it when a printer is tried). The Centauri Carbon 2 (MQTT) isn't supported.
- `console.error`/`console.warn` are wrapped (web/src/errorReporting.ts),
  so DevTools links those messages to the wrapper; expand the message's
  stack for the real caller. Every report from a no-libslic3r build's
  server slice is a "server slice failed" error report (the stub fails
  them all).
- `issues/libslic3r-fake-wipe-tower.md` — libslic3r reads an uninitialised
  stand-in prime tower when a multi-filament config prints one filament;
  worked around in slice_core (`ZeroedPrint`).
- Dual-nozzle (H2D) AMS mapping by nozzle is unverified on hardware (the
  `info` bits follow Bambu's own device code), and so is the nozzle choice
  (`src/nozzles.rs`) and the external spool holders' sides (`vir_slot` 255
  right, 254 left); see `issues/untested-printers.md`.
- A support base in another filament than the part's changes filament on
  every layer with supports (a small PLA-CF part: 43 min with its own base,
  3 h with a PLA one on an X1C); the Slice page defaults to the part's.
- Models kept in a browser (IndexedDB) are never pruned there, even when
  their jobs are deleted.
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
- Phones (`plans/mobile.md`): below 800 px the sidebar is a drawer behind
  `.topbar` (components/Layout.tsx). A list table is `data-table cards`, its
  cells labelled with `data-label` (`cell-title`, `cell-select`,
  `cell-actions` for those); other tables stay tables. Touch rules go under
  `(max-width: 800px), (pointer: coarse)` (fields stay >= 16 px: iOS zooms
  into smaller ones) or `(hover: none)`. Check a new page at 360 px wide.
- Keep `cxx/slice_core.cpp` engine-agnostic; anything Rust- or Emscripten-specific
  goes in the respective bridge.
- The submodule is pinned to an OrcaSlicer release tag; bumping it means
  rebuilding the deps image layer and re-checking `wasm/patches/orca-wasm.patch`
  applies (`git -C extern/OrcaSlicer apply --check wasm/patches/orca-wasm.patch`).
