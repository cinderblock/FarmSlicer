# Get FarmSlicer online: working server slicing, browser slicing, buildhost deploy

`plans/get-online.md`

## Goal

Three things Cameron asked for on 2026-10-11, in one push ("boil the ocean"):

1. **Make the online slicer actually work.** The Rust server links libslic3r but a
   slice has never completed end to end (no G-code was ever produced on the old
   buildhost deployment; CLAUDE.md still says "End-to-end slicing with real STL not
   yet tested").
2. **Browser-side slicing option.** Same OrcaSlicer engine compiled to WebAssembly,
   running in a Web Worker, so a user with a fast machine can slice locally, keep
   source models off the server, or bypass an overloaded backend. Result G-code is
   uploaded to the server so the job/slice library still works.
3. **Deploy to buildhost on the LAN.** `https://farm.example.com` (proxyhost
   Caddy → `buildhost.lan:9337`, LAN only) has served a "FarmSlicer backend is down"
   placeholder since buildhost's 2026-06-18 reinstall.

## Environment / context

- Repo: `C:\Users\me\git\Personal Projects\Farm Slicer` (GitHub
  `cinderblock/FarmSlicer`, private, branch `master`). Rust 2024 + axum, cxx bridge
  to libslic3r, React/Vite frontend in `web/`.
- OrcaSlicer submodule `extern/OrcaSlicer` @ `a167702` = upstream main 2026-05-12,
  `version.inc` says 2.4.0-dev (`v2.3.1-beta-3510-ga167702`). **Not checked out
  locally** at session start (clone started in background, log
  `/tmp/farmslicer-submodule.log`).
- Local Windows machine has never built libslic3r (no `extern/OrcaSlicer/deps/build`,
  no `target/debug/farmslicer`). All native work happens on buildhost.
- **buildhost** (`ssh user@buildhost`): Ubuntu 26.04, Ryzen 7900X3D 24 threads,
  122 GiB RAM, 1.5 TB free, gcc 15.2, cmake 4.2.3, node 22, Docker 29. Shared with
  another tenant; Secure Boot on. cameron has passwordless sudo, but **no sudo/apt without
  Cameron's per-change yes** (global CLAUDE.md infra rule). User-level work in
  `~` is fine.
- Old buildhost disk is NFS-mounted at `/mnt/old-root`. The old FarmSlicer tree
  (`/mnt/old-root/opt/farmslicer`, HEAD `f3c9d1c` = current master, same
  submodule sha) with **fully built OrcaSlicer deps (4 GB) and libslic3r .a files**
  was rsynced to `~/farmslicer-dev` on buildhost (excluding `target/`, `data/`,
  `node_modules`). Its deps were built with the old 24.04 toolchain.
- Dev server port on buildhost for testing: **9338** (9337 is the production port
  the Caddy site expects; keep it free for the real deploy).
- WASM reference repos cloned to `~/wasm-ref/` on buildhost:
  `JoshTheDerf/orcaslicer-wasm` (emsdk 6.0.10, `toolchain/build-deps.sh`,
  `wasm/cmake/` find-modules, `wasm/wasm_shims/` serial TBB, `patches/orca-wasm.patch`,
  bridge `cs_*` ABI, MT build with real oneTBB) and `Hiosdra/OrcaWasm` (emscripten
  3.1.74, one-slicer-api 0.7.0, `-fwasm-exceptions`, OCCT included). Both target
  OrcaSlicer **v2.4.2**. `Noisyfox/OrcaSlicerNeo` also compiles libslic3r to wasm64
  (threaded + serial variants). All AGPL-3.0.
- ops repo: `~/git/Personal Projects/ops`. Conventions (ops `CLAUDE.md`, `add-app`
  skill): app repo CI builds `ghcr.io/cinderblock/<app>:<sha>` with label
  `org.opencontainers.image.revision`; ops owns `servers/buildhost/stacks/<app>/`
  (`compose.yml`, `pin.json` by **digest**, `env.json`). Never commit/push ops
  without explicit permission. Never add a stack whose image doesn't exist yet
  (stage under ops `plans/`). ops plan for this:
  `ops/plans/farm-slicer-redeploy.md`. Caddy site:
  `ops/servers/proxyhost/sites.d/farm.example.com.caddy`.
- Deploy skill `.claude/skills/deploy/` (SSH deploy.sh → `/opt/farmslicer`,
  systemd) is the **old, now-forbidden** model per ops; it is to be retired once
  the container path works.

## Decisions already made (don't re-ask)

- **Deploy via container + ops pin**, not the repo's SSH `deploy.sh`. Reason: ops
  `CLAUDE.md` "an app repo never deploys itself"; buildhost is shared and was
  compromised once. Published on buildhost LAN port 9337 (not loopback) because the
  reverse proxy for `farm.example.com` lives on proxyhost, not buildhost.
- **Browser slicing uses libslic3r compiled to WASM from the same OrcaSlicer
  version the server uses**, so profiles/config JSON are identical for both paths
  and the UI offers one "where to compute" switch. Not CuraEngine (different
  profiles, unmaintained wasm build).
- **Browser mode never uploads the model.** Only the resulting G-code (plus stats)
  is posted back, as a job with `source=browser`.
- Threaded WASM needs COOP/COEP headers (SharedArrayBuffer); the server sends
  them on the SPA. Serial fallback build if cross-origin isolation is unavailable.
- Build on buildhost's 24 cores for development; GitHub-hosted runners for the
  release image (registry build cache so the deps stage is built once per
  submodule commit).

## Plan / steps

1. [x] Survey state, write this plan.
2. [ ] **Native proof on buildhost** (`~/farmslicer-dev`): install rustup (user),
   fetch/checkout master, `vite build`, `cargo build --release`, run on :9338, add a
   printer, POST a test STL to `/api/jobs`, get a G-code file. Fix whatever breaks
   in `cxx/slicer_bridge.cpp` (config loading, validate, export). ← **current**
3. [ ] Fix `print_time_sec` (read from `GCodeProcessorResult`), surface slicer
   errors/progress properly (status callback → DB progress).
4. [ ] Decide submodule pin: stay on `a167702` or move to tag `v2.4.2` (which the
   wasm ports patch against). See Findings.
5. [ ] **WASM engine**: `wasm/` dir in repo: emscripten CMake superbuild of
   libslic3r + a tiny `fs_slice(model, config_json) -> gcode` bridge sharing the
   C++ with `cxx/slicer_bridge.cpp`. Reuse orcaslicer-wasm's deps script,
   find-modules, shims and patch. Threaded + serial variants. Build on buildhost.
6. [ ] **Frontend**: "Compute" selector (Server / This browser / Auto), Web Worker
   wrapper for the engine, progress UI, upload result to server, remember choice.
7. [ ] **Backend**: `POST /api/jobs` with `source=browser` (no model), `POST
   /api/jobs/{id}/result` (G-code upload), `GET /api/status` (queue depth, for Auto),
   COOP/COEP headers, serve `/wasm/*` with long cache.
8. [ ] **Container + CI**: multi-stage `Dockerfile` (deps → libslic3r → cargo →
   runtime), `.github/workflows/build.yml` (wasm job + image job), LICENSE
   (AGPL-3.0, forced by libslic3r), `pin.json` in step summary.
9. [ ] **ops**: stage `plans/farmslicer-stack/` in ops; once a digest exists move
   to `servers/buildhost/stacks/farmslicer/` + port registry row + README; Caddy
   placeholder comment update. Needs Cameron's explicit yes to commit/push ops.
10. [ ] Retire `.claude/skills/deploy/` (replace with a dev-on-buildhost note),
    update `CLAUDE.md`/README, close `issues/slicer-runtime-crash.md` if resolved.

## Findings / gotchas

- buildhost was reinstalled 2026-06-18; `/opt/farmslicer` and `farmslicer.service`
  do not exist. `deploy.sh status` → "Unit farmslicer.service could not be found."
- Old deployment never produced G-code: `/mnt/old-root/opt/farmslicer/data/`
  has only the SQLite db, no `gcode/` or `models/`.
- No `LICENSE` file in the repo. libslic3r is AGPL-3.0, so FarmSlicer must be too
  (both the server binary and a wasm bundle served to browsers).
- OrcaSlicer wasm ports all pin **v2.4.2**; our submodule predates it (2.4.0-dev).
- The old `.claude/skills/deploy/.env` stores `ADMIN_PASSPHRASE=<redacted>`.
- **Host-native build on the new buildhost is a dead end.** The copied deps were
  built with GCC 13 `-flto`; GCC 15 refuses them (`lto1: fatal error: bytecode
  stream ... generated with LTO version 13.1 instead of the expected 15.1`).
  Rebuilding deps on the host fails at configure (`Could NOT find OpenGL`, no
  `libglu1-mesa-dev`, and no `m4`), and apt is off-limits without a yes. So all
  native builds go through **Docker on buildhost** (`~/farmslicer-docker`, context
  = repo files + `extern/OrcaSlicer` copied from `~/orca-242`), log
  `~/farmslicer-docker-build.log`, image `farmslicer:dev`.
- Native link needs fontconfig but the new box has only the runtime `.so.1`;
  `build.rs` now links it by soname (`-l:libfontconfig.so.1`) outside the static
  group.
- The cxx bridge called `DynamicPrintConfig::load_from_json(config_str, ...)`
  with the JSON **text** where libslic3r expects a **file path**, so the first
  real slice would have failed before this session. The wasm bridge
  (`cs_bridge.cpp`) does it right: `config.apply(FullPrintConfig::defaults())`,
  write JSON to a file, `load_from_json(path, ...)`, `normalize_fdm()`,
  `set_resources_dir`, status callback, then apply/process/export.
- m4 1.4.19 does not build with GCC 15 (C23 default breaks gnulib's
  `_GL_ATTRIBUTE_NODISCARD`); built it with `CFLAGS=-std=gnu17` for the wasm
  toolchain (`~/wasm-ref/wasm-deps/tools/bin/m4`).

## Progress log

- [x] 2026-10-11: surveyed repo, buildhost, ops. Started submodule clone locally and
  rsync of old built tree to `~/farmslicer-dev` on buildhost.
- [x] 2026-10-11: host-native build on buildhost abandoned (LTO mismatch, see
  Findings). Switched to Docker. Submodule moved to **v2.4.2** locally
  (`8500fcd`), matching the wasm ports' patch (`git apply --check` clean).
- [x] 2026-10-11: rewrote the slicing pipeline as `cxx/slice_core.{hpp,cpp}`
  (shared by the cxx bridge and the wasm bridge): config via temp file on top of
  `FullPrintConfig::defaults()`, bed centring, status/cancel callbacks, stats
  from `GCodeProcessorResult`. Rust side: `src/progress.rs` registry, jobs get
  `progress_message`/`warnings`/`source` columns, browser-job endpoints
  (`/api/jobs/{id}/progress|result|fail`), `/api/status`, COOP/COEP headers.
  `cargo check` passes locally with `FARMSLICER_SKIP_CXX=1` (build.rs escape
  hatch that skips the C++ so Windows can typecheck).
- [x] 2026-10-11: `Dockerfile` + `.dockerignore` written; web stage uses Bun
  (`package-lock.json` deleted, `bun.lock` refreshed). Deps stage building on
  buildhost (`docker build --target orca-deps`, log `~/farmslicer-docker-build.log`).
- [x] 2026-10-11: wasm toolchain ready on buildhost (`~/wasm-ref/wasm-deps`:
  emsdk 6.0.10, both `install/` and `install-mt/` dep prefixes built). Vendored
  orcaslicer-wasm's cmake find-modules, shims, toolchain scripts and patch into
  `wasm/` (AGPL-3.0, attribution in `wasm/LICENSE.orcaslicer-wasm`). Wrote
  `wasm/CMakeLists.txt`, `wasm/bridge/farmslicer_wasm.cpp` (C ABI: `fs_version`,
  `fs_slice`, `fs_slice_start` (mt), `fs_cancel`, `fs_free`; progress via
  `Module.fsProgress`), `wasm/build.sh`. ST build running on buildhost in
  `~/farmslicer-wasm` (log `~/farmslicer-wasm-build.log`, output `~/farmslicer-wasm/out`).
- [x] 2026-10-11: Docker `orca-deps` stage built on buildhost (`farmslicer:deps`,
  2.7 GB, ~20 min at 12 jobs; 21 dep targets). libslic3r stage needed
  `libdbus-1-dev` (OrcaSlicer's top-level CMake requires DBus on Linux even
  with the GUI off) — installed in that stage only to keep the deps cache.
- [x] 2026-10-11: **wasm ST engine built** (`~/farmslicer-wasm/out/st`:
  `farmslicer-engine.wasm` 9.6 MB + `.mjs` 78 KB + `.data` 17 KB). Needed
  `wasm/LICENSE.txt` (OrcaSlicer's CMake CPack wants
  `${CMAKE_SOURCE_DIR}/LICENSE.txt`) and `#include <libslic3r/Layer.hpp>`.
  Root `LICENSE` added (AGPL-3.0, copied from OrcaSlicer).
- [x] 2026-10-11: frontend: `web/src/engine/{types,worker,client}.ts`, Slice
  page "Compute" selector (Auto/Server/This browser) with engine status line,
  progress bar, cancel; Jobs page shows source badge, step message, warnings.
  `bun run build` (tsc + vite) passes (needed lib ES2024 for
  `Atomics.waitAsync`, and an unused prop in ProfileEditor removed).
  `.github/workflows/build.yml` written (check → wasm → image, registry build
  cache). ops stack staged at `ops/plans/farmslicer-stack/` (not committed).
- [x] 2026-10-11: **Full Docker image builds** (`farmslicer:dev`, 356 MB).
  Fixes on the way: `libdbus-1-dev` (libslic3r stage), stub `glfw3Config.cmake`
  (`docker/cmake-stubs/`), copy OrcaSlicer `LICENSE.txt` (CPack), stop
  excluding `src/slic3r` from the context (libslic3r includes
  `slic3r/Utils/ColorSpaceConvert.hpp`). build.rs linked v2.4.2 unchanged.
- [x] 2026-10-11: **Server e2e slice works** (`~/farmslicer-e2e.sh` against the
  container on :9338): A1 mini 0.4 / 0.20mm Standard / Bambu PLA Basic, 20 mm
  cube → 100 layers, 614 KB G-code, 20m19s, 4.25 g, ~1 s. `/api/status` reports
  the browser engine; COOP/COEP headers present. Log noise: libslic3r's
  GCodeProcessor logs `Invalid T command (T1000)` for Bambu start G-code.
- [x] 2026-10-11: **wasm MT engine built** (10.3 MB). `node wasm/test/smoke.mjs`
  passes for `st` with a real A1 mini config (100 layers in 0.24 s). `mt` in
  Node: pthread start never reports, `--sync` aborts at "Slicing mesh" —
  suspected Node-specific (pool/worker semantics); verify in Chrome.
- [x] 2026-10-11: **Profile resolver bug fixed**: 31 base profile names
  (`fdm_process_common`, `fdm_filament_pla`, …) exist in up to 61 vendor dirs;
  the flat `by_name` map resolved `inherits` to whichever vendor loaded last.
  Now `by_name: name → [(vendor, path)]` and a chain resolves parents within
  the vendor it started in. Same fix in `wasm/test/resolve-profile.mjs`.
- [x] 2026-10-11: blank SPA in the container: `useNavigate() may be used only
  in the context of a <Router>` — Slice.tsx imported from `react-router-dom`
  while the app used `react-router`, and the refreshed lockfile gave the two
  different versions (two React contexts). Unified on `react-router`, dropped
  `react-router-dom`.
- [ ] Browser slice e2e in Chrome via `ssh -L 9338:127.0.0.1:9338 buildhost`
  (localhost = secure context, so `mt` can run; `crossOriginIsolated` confirmed
  true, manifest served). ← **current** (waiting on image rebuild)
- [ ] CI workflow, LICENSE, ops stack staging, README/CLAUDE.md updates, commit.

## Open questions for Cameron

1. Keep `ADMIN_PASSPHRASE` auth as-is for the first deploy (secret via ops
   `env.json` → GitHub secret `BUILDHOST_FARMSLICER_ADMIN_PASSPHRASE`)? My plan:
   yes; `plans/auth.md` (real users) stays a later task.
2. OK to publish the GHCR image **public**? libslic3r is AGPL so the image is
   redistributable; public avoids the private-package grant step. Recommendation:
   public.

## Things not to do

- Don't run apt/sudo/systemd/Caddy changes on buildhost; stage in ops and ask.
- Don't build on Windows; the native toolchain only exists on buildhost.
- Don't use port 9337 for dev testing on buildhost.
- Don't `git stash` in the shared Windows working tree.
