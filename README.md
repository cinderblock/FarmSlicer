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
  isolated). Browser slicing uploads only the resulting G-code, unless the
  job's group is set to keep models.
- **Printers:** five kinds, each on the LAN (see [Printers](#printers)):
  Bambu Lab, Klipper (Moonraker), OctoPrint, Prusa (PrusaLink) and Elegoo
  Centauri Carbon (SDCP). Discovery, live status (state, progress,
  temperatures, errors; AMS trays on Bambu printers), sending prints and
  following them to the end, pause/resume/stop, speed, pre-heating, cameras
  and pictures of prints started elsewhere, as far as each protocol allows.
  Server slices for Bambu printers come out as a `.gcode.3mf` with a rendered
  thumbnail, for the others as plain G-code with the thumbnails their
  firmware wants; sliced files from other slicers (`.gcode.3mf` or `.gcode`)
  can be uploaded and sent too.
- **Farm floor:** a Guide page (how to slice or export, send, and look after
  plates, plus the farm's own notes); filament cost estimates (site price table); printer areas; print rules per group (max time, allowed
  materials; inherited, with a site default) whose violations wait for an
  admin or group manager to approve; equipment problem reports; pre-heating
  an idle printer for a loaded filament.
- **Cameras:** live view on demand, one upstream feed per printer however
  many watch; Bambu X1/H2-class (RTSPS) passed through as H.264 for the
  browser to decode, A1/P1 (JPEG over TLS), Klipper and OctoPrint webcams
  and the Centauri Carbon (MJPEG, or snapshots) as JPEG frames. No ffmpeg,
  and printer credentials never leave the server process.
- **Thumbnails:** rendered in software (no GPU), optionally with a group's
  label (e.g. a team number, from the `thumbnail_label` group setting) and
  logo.
- **People:** passkey accounts, nested groups with shared libraries and
  seasons, quotas, self-service joining through links, guest accounts.

License: AGPL-3.0-or-later (inherited from libslic3r). See `LICENSE`.

## Printers

| Protocol | Printers | Connection | Status | Control | Camera |
| --- | --- | --- | --- | --- | --- |
| Bambu Lab (LAN) | X1, P1, A1, H2, P2S, X2D | IP, serial number, LAN access code (LAN mode and Developer Mode on) | MQTT push, AMS trays | pause/resume/stop, speed levels, heat, AMS mapping, plate options | RTSPS (X1/H2), JPEG (A1/P1) |
| Klipper (Moonraker) | Voron, RatRig, Sovol, Qidi, Creality K1/K2, Elegoo Neptune 4, Snapmaker U1, ... | address (`host`, `host:port`, default 7125, or the web page's URL); API key only if Moonraker doesn't trust FarmSlicer | WebSocket push | pause/resume/stop, speed %, heat | Moonraker's webcam (MJPEG or snapshots) |
| OctoPrint | any printer behind OctoPrint 1.x or 2.0 | address (port 80 as on OctoPi, `:5000`, or a URL), API key | push socket | pause/resume/stop, speed %, heat | OctoPrint's webcam |
| Prusa (PrusaLink) | MK4/MK4S, MK3.5/3.9, MINI, XL, CORE One | address, PrusaLink password | polled | pause/resume/stop (no speed, heat or G-code over PrusaLink) | none |
| Elegoo Centauri Carbon (SDCP) | Centauri Carbon, Centauri | address (no password) | WebSocket push and polling | pause/resume/stop, speed presets, heat, levelling and timelapse options | MJPEG on 3031 |

- Discovery: Bambu printers over SSDP, Klipper/OctoPrint/PrusaLink over mDNS
  (Moonraker only with `[zeroconf]`), Centauri Carbons over SDCP's UDP
  broadcast. Multicast doesn't cross routers or Docker bridges: run the
  container with host networking to see printers; others are added by
  address.
- Non-Bambu printers print what they're sent: FarmSlicer lists the plate's
  filaments to load instead of mapping them to trays, and checks the
  sliced-for model and nozzle against the printer.
- Prusa printers check the file's model, nozzle and filament themselves and
  ask on their screen when unsure; such a print waits "at the printer" until
  someone answers there.
- The Elegoo Centauri Carbon 2 speaks another protocol (MQTT) and isn't
  supported yet.
- `tests/fake-*` hold a fake printer per protocol (and a Dockerfile for real
  OctoPrint with its Virtual Printer); `tests/*-e2e.mjs` drive them.

## Running it

The supported deployment is the container image built by CI
(`ghcr.io/cinderblock/farmslicer`), run by the ops repo on `buildhost` and
reached at `https://farm.example.com` (LAN only).

```bash
docker run -d --name farmslicer -p 9337:9337 \
  -e FARMSLICER_ORIGINS=https://farm.example.com \
  -v farmslicer_data:/app/data \
  ghcr.io/cinderblock/farmslicer:latest
```

| Env var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `9337` | HTTP port |
| `HOST` | `0.0.0.0` | Listen address (`127.0.0.1` for a local-only test server) |
| `ORCA_RESOURCES_DIR` | `extern/OrcaSlicer/resources` | OrcaSlicer `resources/` tree (profiles, nozzle/flush tables) |
| `FARMSLICER_ORIGINS` | `http://localhost:9337,http://localhost:5173` | Comma-separated origins the UI is served from. The first one is canonical: its host is the WebAuthn relying-party ID (never change it once users have enrolled) and it is used in invite links. Must be HTTPS except for `localhost`. |
| `FARMSLICER_NO_AUTH` | unset | Development only: skip accounts, every request runs as the owner |
| `RUST_LOG` | — | Log level |

Data (SQLite db, uploaded models, G-code) lives in `/app/data`.

### Accounts: passkeys only

There are no passwords and no secrets to configure.

- **First run**: the web UI asks whoever opens it to create the **owner**
  account by registering a passkey (Windows Hello, Touch ID, a phone, a
  security key). Do that promptly after deploying.
- **Adding users**: the owner or an admin creates the account on the Users
  page and gets a single-use **invite link** (valid 72 h); the invitee opens it
  and enrols their own passkey. Roles: `owner` (fixed), `admin` (manage users
  and printers), `user` (slice, view, manage own passkeys and API keys).
- **Signing in**: "Sign in with a passkey" (any passkey for this site), or by
  username to narrow it to that account's passkeys. Sessions are 30-day
  cookies.
- **More devices**: add passkeys on the Account page; the last one cannot be
  removed.
- **Lost everything**: every enrolment hands out a one-time **recovery code**
  (shown once, stored hashed). `/recover` takes username + code and enrols a
  new passkey. Without the code, an admin issues a new invite link for the
  account (the owner can only be re-enrolled by the owner).

Passkeys need a secure context: HTTPS, or `localhost` for development. The
relying-party ID is the host of the first `FARMSLICER_ORIGINS` entry.

Scripts and other machines authenticate with an **API key** created on the
Account page (shown once), sent as `Authorization: Bearer fsk_…`. A key has the
permissions of the account that created it; revoke it there.
`tests/passkey-e2e.mjs` drives all of the above against a running server with
a software authenticator.

### Groups, quotas and joining

All of this is configured at runtime in the web UI (Groups and Settings
pages); nothing is set through environment variables.

- **Groups** form a tree; a user can be in any number of them, as `member`
  or `manager`. Managers run their group and everything below it (members,
  join links, settings, subgroups); admins run everything.
- **Jobs belong to a group** when the slicer picks one (the Slice page offers
  the groups you're an active member of), otherwise they are personal.
  A job is visible to its creator, to the group's members when the group's
  library is shared, to anyone managing the group, and to admins. A group's
  library splits its jobs by **season** (the `season_start` setting, e.g.
  `09-01` for a season that runs September to August).
- **Settings** are inherited down the tree unless a group sets its own:
  `season_start`, `shared_library` (default on), `keep_models` (browser-sliced
  jobs upload their model too), `allow_registration` (the join flow may create
  passkey accounts), `allow_guests`, `join_policy` (`open`, or `approval` by a
  manager). Per group only: `listed` (a button on the sign-in page; admins
  only) and `subgroups` (how joiners pick a child: from a list, or
  self-service by typing an identifier that must match a pattern; the child
  is created from a name template if it doesn't exist yet, optionally with
  its creator as manager).
- **Joining**: `/join/<code>` links (secret ones skip approval by default;
  public ones have a chosen, guessable code) or the sign-in page's buttons.
  The joiner walks down through subgroups if the group asks for it, then
  joins as their signed-in self, a new passkey account, or a **guest**.
- **Guest accounts** have no credential: a long-lived session cookie plus a
  one-time sign-in code for another device (each use hands out the next one).
  They can't create API keys, change printers or profiles, or create groups.
  Adding a passkey turns a guest into a full account.
- **Quotas** are optional rules `{metric, period, limit}`: `slices`,
  `filament_g`, `print_hours` (slicer estimates), `storage_mb`; per `day`,
  `week`, `month`, `season` or `total`. A new job must fit the user's own
  rules (per-user override, else the site default for their account kind),
  and for its group and every group above it, the per-member rules (a
  member's override, else the group's member or guest rules) and the shared
  pool. Group quotas are set by admins or managers of a parent group, never
  by the group's own managers.

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
`FARMSLICER_SKIP_CXX=1` builds the server without libslic3r: a stub slicer
fails every server-side slice, and everything else (accounts, the API, browser
slicing) works. `FARMSLICER_SKIP_CXX=1 cargo check` typechecks.

### Tests

`cargo test` (with `FARMSLICER_SKIP_CXX=1` off the build box) runs the unit
tests. `tests/run-e2e.sh` (Linux: cargo, Node 22, curl) builds the stub server,
starts a throwaway instance per test on `localhost:9339` and runs every
`tests/*-e2e.mjs` against it; each test drives the HTTP API with a software
passkey authenticator (`tests/lib.mjs`).

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
| `GET /api/auth/status`, `POST /api/auth/{setup,login,recover}/{start,finish}`, `GET /api/auth/invite/{token}`, `POST /api/auth/invite/{token}/{start,finish}`, `POST /api/auth/logout` | passkey ceremonies and sessions (see Accounts) |
| `GET /api/me`, `GET/POST /api/me/passkeys…`, `GET/POST/DELETE /api/me/api-keys…`, `POST /api/me/recovery-code` | own account |
| `GET/POST /api/users`, `PUT/DELETE /api/users/{id}`, `POST /api/users/{id}/invite` | user admin |
| `GET /api/profiles/machine-models`, `/machines`, `/processes?machine=`, `/filaments?machine=` | OrcaSlicer profile catalogue |
| `GET /api/profiles/resolve?machine=&process=&filament=` | merged config JSON (what the engines slice with) |
| `GET /api/profiles/resolve-single?name=` | one profile with inheritance resolved |
| `GET/POST /api/printers`, `PATCH/DELETE /api/printers/{id}` | printers (changes: admins). The access code is write-only: responses carry `access_code_set` |
| `GET /api/printers/status`, `GET /api/printers/events` | live status of connected printers; the same as server-sent `status` events |
| `GET /api/printer-protocols` | the protocols FarmSlicer speaks, what each can do (`capabilities`) and its connection fields |
| `GET /api/printers/{id}/report` | the driver's raw view of the printer: Bambu's merged MQTT report, Klipper's objects, ... (admins) |
| `GET /api/printers/{id}/camera` (WebSocket) | live camera: H.264 access units for X1/H2-class printers (decoded in the browser with WebCodecs), JPEG frames for the rest; `{"type":"error"}` says why when there is none |
| `POST /api/printers/{id}/control` | `{action: pause\|resume\|stop\|speed, level \| percent}` on whatever the printer runs (admins) |
| `GET/PUT/DELETE /api/groups/{id}/logo`, `GET /api/groups/{id}/overlay`, `GET /api/groups/{id}/overlay/logo` | a group's thumbnail logo (managers set it; PNG/JPEG, stored ≤ 256 px); the label and logo its jobs get |
| `POST /api/uploads` (multipart `file`, optional `group_id`) | a sliced `.gcode.3mf` or `.gcode` becomes a finished, sendable job (what it needs is read from the slicer's comments) |
| `GET /api/jobs/{id}/thumbnail?plate=`, `GET /api/jobs/{id}/targets?plate=` | plate preview; every printer with fit, availability, its capabilities and (Bambu) a suggested AMS mapping |
| `POST /api/jobs/{id}/print` | `{printer_id, plate, ams_mapping, options, ignore_mapping_problems}`: upload and start |
| `GET /api/prints?printer=&active=1&pending=1`, `GET /api/prints/{id}`, `POST /api/prints/{id}/control` | print history and status; pause/resume/stop/speed as the printer allows (sender, group managers, admins) |
| `POST /api/prints/{id}/approve`, `POST /api/prints/{id}/reject` | decide a print that broke the print rules (admins, the group's managers; the requester may withdraw) |
| `POST /api/printers/{id}/reports`, `GET /api/printer-reports?open=1`, `POST /api/printer-reports/{id}/resolve` | equipment problem reports (anyone reports; admins see all and resolve) |
| `POST /api/printers/{id}/preheat` (`{slot}` or `{material}`), `POST /api/printers/{id}/cooldown` | heat an idle printer for a tray's filament or a material, or cool it |
| `GET /api/printers/{id}/thumbnail` | picture of the job the printer runs or ran (fetched from the printer for prints started elsewhere) |
| `GET /api/guide` | the Guide page's farm notes (site setting `guide_notes`) and default print rules |
| `GET /api/prices` | currency and filament price per kg; jobs, prints and targets carry `estimated_cost` |
| `GET /api/discovery` | printers seen on the LAN, each with the protocol and address to add it with |
| `GET/POST/PUT/DELETE /api/custom-profiles[/{id}]` | saved setting overrides |
| `GET /api/jobs?group=&mine=1` | visible jobs with status, progress, step message, warnings, `source`, creator, group |
| `POST /api/jobs` (multipart) | `source=server`: upload `model` + profile names, slice here. `source=browser`: `model_name` + profile names, slice in the browser (the response's `keep_model` says whether to upload the model with the result). Optional `group_id`; 429 when a quota is used up |
| `PUT /api/jobs/{id}` | move a job to another group (`group_id`, null = personal) |
| `GET /api/jobs/{id}/model` | the job's source model, when kept |
| `POST /api/jobs/{id}/progress` | browser engine progress tick |
| `POST /api/jobs/{id}/result` (multipart `gcode`, stats, optional `model`, optional `package`) | browser engine result upload (the `.gcode.3mf` makes the job sendable) |
| `POST /api/jobs/{id}/fail`, `POST /api/jobs/{id}/cancel` | browser failure / cancel either kind |
| `GET /api/slices?group=&mine=1`, `GET /api/slices/{id}/download` | slice library, G-code download |
| `GET/POST /api/groups`, `GET/PUT/DELETE /api/groups/{id}` | groups (settings, quotas, moving) |
| `GET/POST /api/groups/{id}/members`, `PUT/DELETE /api/groups/{id}/members/{user}` | members, approval, per-member quotas, leaving |
| `GET /api/groups/{id}/library`, `GET /api/groups/{id}/usage` | the group's jobs by season; quota usage |
| `GET/POST /api/groups/{id}/links`, `PUT/DELETE /api/groups/{id}/links/{link}` | join links |
| `POST /api/join/resolve`, `/api/join/finish`, `/api/join/register/{start,finish}`, `/api/join/guest` | the join flow |
| `POST /api/auth/guest/signin` | guest sign-in with a one-time code |
| `GET /api/me/usage`, `GET/PUT /api/settings` | own quota usage; site-wide settings (admins) |

## Repository layout

```
src/            Rust server: main.rs, server.rs (HTTP + jobs), db.rs (SQLite),
                auth.rs + auth_api.rs (passkeys, sessions, users),
                groups.rs + groups_api.rs (groups, visibility, settings),
                join_api.rs (join links, guests), quota.rs,
                profiles.rs (OrcaSlicer profile inheritance), progress.rs,
                slicer.rs (cxx bridge declaration + stub),
                printer/ (protocols, capabilities, status, the link hub),
                bambu/, moonraker/, octoprint/, prusalink/, sdcp/ (drivers),
                printing.rs + prints_api.rs (sending, tracking),
                package/ (.gcode.3mf and G-code readers), camera/,
                discovery/ (SSDP, mDNS, SDCP)
cxx/            slice_core.{hpp,cpp}: the libslic3r pipeline shared by both
                engines; slicer_bridge.cpp: cxx glue; nanosvg_impl.cpp
wasm/           Emscripten superbuild + C bridge for the browser engine
web/            React frontend (Vite, Bun); web/src/engine/ = browser engine client + worker
extern/OrcaSlicer   git submodule, pinned to a release tag (v2.4.2)
docker/         CMake stubs used only by the headless image build
tests/          API end-to-end tests (run-e2e.sh), their shared helpers, and a
                fake printer per protocol (fake-printer = Bambu, fake-moonraker,
                fake-octoprint, fake-prusalink, fake-sdcp)
plans/          living plan documents
```
