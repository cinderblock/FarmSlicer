# FarmSlicer

Web-first, headless slicing service for a small 3D print farm. Upload a model,
pick a printer and OrcaSlicer profiles, get G-code. The slicer is
[OrcaSlicer](https://github.com/SoftFever/OrcaSlicer)'s `libslic3r`, linked
natively into a Rust server **and** compiled to WebAssembly so the same engine
can run in the user's browser.

- **Backend:** Rust (axum + tokio), SQLite, libslic3r via a `cxx` bridge.
- **Frontend:** React + TypeScript + Three.js (Vite), served by the backend.
- **Profiles:** OrcaSlicer's vendor profiles (machine / process / filament) with
  inheritance resolved server-side; per-job overrides and saved custom profiles.
- **Compute:** each slice runs either on the server or in the browser
  (WebAssembly, Web Worker, multithreaded when the page is cross-origin
  isolated). Browser slicing never uploads the model, only the resulting G-code.
- **Printers:** Bambu Lab SSDP discovery; machine model + nozzle size per printer.

License: AGPL-3.0-or-later (inherited from libslic3r). See `LICENSE`.

## Running it

The supported deployment is the container image built by CI
(`ghcr.io/cinderblock/farmslicer`), run by the ops repo on `buildhost` and
reached at `https://farm.example.com` (LAN only).

```bash
docker run -d --name farmslicer -p 9337:9337 \
  -e ADMIN_PASSPHRASE=change-me \
  -v farmslicer_data:/app/data \
  ghcr.io/cinderblock/farmslicer:latest
```

| Env var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `9337` | HTTP port |
| `ORCA_RESOURCES_DIR` | `extern/OrcaSlicer/resources` | OrcaSlicer `resources/` tree (profiles, nozzle/flush tables) |
| `FARMSLICER_NO_AUTH` | unset | Development only: skip accounts, every request runs as the owner |
| `RUST_LOG` | — | Log level |

Data (SQLite db, uploaded models, G-code) lives in `/app/data`.

### Accounts

There are no secrets to configure. On first run the web UI asks whoever opens
it to create the **owner** account (so do that promptly after deploying). The
owner and admins add further accounts on the Users page; roles are `owner`
(fixed), `admin` (manage users and printers) and `user` (slice, view, own API
keys). Passwords are stored as argon2id hashes; sessions are 30-day cookies.

Scripts and other machines authenticate with an **API key** created on the
Account page (shown once), sent as `Authorization: Bearer fsk_…`. A key has the
permissions of the account that created it; revoke it there.

## Building

Everything heavy is in the `Dockerfile` (five stages: OrcaSlicer deps →
libslic3r → frontend → Rust server → runtime). A cold build is about an hour on
a 24-core machine because OrcaSlicer's third-party deps (Boost, TBB, OCCT,
OpenVDB, CGAL, OpenCV, …) are built from source; the deps stage is cached by
layer, so iterating on FarmSlicer itself costs minutes.

```bash
docker build -t farmslicer .                  # all stages
docker build --target orca-deps -t farmslicer:deps .   # just the slow part, once
```

Native (non-Docker) builds follow the same steps as the Dockerfile; see
`CLAUDE.md` for the toolchain notes, including the Windows layout `build.rs`
expects. On a machine without the OrcaSlicer toolchain,
`FARMSLICER_SKIP_CXX=1 cargo check` typechecks the Rust side alone.

Frontend only:

```bash
cd web && bun install && bun run dev      # Vite dev server, proxies /api and /wasm to :9337
cd web && bun run build                    # tsc + vite → dist/web
```

### Browser engine (WebAssembly)

`wasm/` builds libslic3r with Emscripten into two variants: `st`
(single-threaded, works everywhere) and `mt` (pthreads + oneTBB, needs
`SharedArrayBuffer`, i.e. a cross-origin-isolated page; the server sends the
COOP/COEP headers). The output lands in `web/public/wasm/` with a
`manifest.json` the frontend reads.

```bash
bash wasm/toolchain/bootstrap.sh                  # emsdk + cmake + ninja (once)
bash wasm/toolchain/build-deps.sh all             # cross-compiled deps, single-threaded prefix
WASM_THREADS=1 bash wasm/toolchain/build-deps.sh all-mt   # ... and the pthreads prefix
bash wasm/build.sh                                # st + mt engines → web/public/wasm/
node wasm/test/smoke.mjs --variant st             # slice a test cube in Node
```

`wasm/build.sh` applies `wasm/patches/orca-wasm.patch` to the OrcaSlicer tree in
place (idempotent); point `ORCA_SRC_DIR` at a separate copy if the same
checkout also feeds a native build. The dependency handling under `wasm/`
(find-modules, sequential-TBB shims, patch, toolchain scripts) is adapted from
[JoshTheDerf/orcaslicer-wasm](https://github.com/JoshTheDerf/orcaslicer-wasm)
(AGPL-3.0); the engine bridge (`wasm/bridge/`) and the slicing pipeline it
shares with the server (`cxx/slice_core.cpp`) are FarmSlicer's.

## Deploying

CI (`.github/workflows/build.yml`) typechecks, builds the WebAssembly engine,
builds the image and pushes `ghcr.io/cinderblock/farmslicer:<sha>`. It does
**not** deploy. What runs on buildhost is pinned by digest in
`OWNER/ops` (`servers/buildhost/stacks/farmslicer/pin.json`); the run
summary prints the `pin.json` to paste there.

## API

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | liveness |
| `GET /api/status` | server load + whether a browser engine is deployed |
| `GET /api/auth/status`, `POST /api/auth/login`, `POST /api/auth/logout` | passphrase session |
| `GET /api/profiles/machine-models`, `/machines`, `/processes?machine=`, `/filaments?machine=` | OrcaSlicer profile catalogue |
| `GET /api/profiles/resolve?machine=&process=&filament=` | merged config JSON (what the engines slice with) |
| `GET /api/profiles/resolve-single?name=` | one profile with inheritance resolved |
| `GET/POST /api/printers`, `DELETE /api/printers/{id}` | printer CRUD |
| `GET /api/discovery` | Bambu printers seen on the LAN |
| `GET/POST/PUT/DELETE /api/custom-profiles[/{id}]` | saved setting overrides |
| `GET /api/jobs` | jobs with status, progress, step message, warnings, `source` |
| `POST /api/jobs` (multipart) | `source=server`: upload `model` + profile names, slice here. `source=browser`: `model_name` + profile names, slice in the browser |
| `POST /api/jobs/{id}/progress` | browser engine progress tick |
| `POST /api/jobs/{id}/result` (multipart `gcode`, stats) | browser engine result upload |
| `POST /api/jobs/{id}/fail`, `POST /api/jobs/{id}/cancel` | browser failure / cancel either kind |
| `GET /api/slices`, `GET /api/slices/{id}/download` | slice library, G-code download |

## Repository layout

```
src/            Rust server: main.rs, server.rs (HTTP + jobs), db.rs (SQLite),
                profiles.rs (OrcaSlicer profile inheritance), progress.rs,
                slicer.rs (cxx bridge declaration), discovery.rs (SSDP)
cxx/            slice_core.{hpp,cpp}: the libslic3r pipeline shared by both
                engines; slicer_bridge.cpp: cxx glue; nanosvg_impl.cpp
wasm/           Emscripten superbuild + C bridge for the browser engine
web/            React frontend (Vite, Bun); web/src/engine/ = browser engine client + worker
extern/OrcaSlicer   git submodule, pinned to a release tag (v2.4.2)
docker/         CMake stubs used only by the headless image build
plans/          living plan documents (see plans/get-online.md)
```
