# Printer drivers: other vendors

`plans/printer-drivers.md`

## Goal

FarmSlicer drives Bambu Lab printers end to end (`plans/printer-control.md`):
SSDP discovery, live MQTT status, FTPS upload + start, pause/resume/stop,
speed, preheat/cooldown, cameras, pictures of outside prints, print tracking,
approvals. The maintainer asked (2026-10-12) for the same for other vendors.

Everything printer-facing is wired straight to `src/bambu/` today
(`printing.rs`, `printers_api.rs`, `prints_api.rs`, `farm_api.rs`,
`printer_thumbs.rs`, the web UI all test `protocol == "bambu"`). So:

1. Put a **driver abstraction** in front of Bambu (normalized status,
   capabilities, upload/start/control/camera/discovery), Bambu as the first
   driver, no behaviour change.
2. Add drivers one at a time, each with a fake printer to test against.

## Environment / context

- Worktree `C:\Users\camer\.t3\worktrees\Farm Slicer\printer-drivers`,
  branch `printer-drivers`, from origin/master `15c09ff`.
- The worktree has no `extern/OrcaSlicer` checkout; read profiles/libslic3r
  from the main checkout's submodule (v2.4.2).
- Rust checks don't run on the Windows box (vendored OpenSSL needs Strawberry
  Perl). Typecheck/test on buildhost (see CLAUDE.md "Tests").
- No non-Bambu hardware: **fakes only**.

## Decisions already made (don't re-ask)

- Vendors: **Klipper/Moonraker, Prusa (PrusaLink), OctoPrint, Elegoo
  Centauri Carbon (SDCP)**.
- Depth: **full parity per driver**, whatever each protocol allows
  (discovery, status, send + start, pause/resume/stop, preheat, camera,
  tracking, approvals). Ship and commit one vendor at a time.
- Testing against fakes only (Docker on buildhost / in-process test servers).
- Nothing deployment-specific in the repo (public).

## Design

### Where Bambu leaks today

- `PrinterHub` (`bambu/hub.rs`) is the only status source; `LinkConfig`
  drops non-`bambu` printers, so they never get a status at all.
- `PrinterStatus` (`bambu/status.rs`) is Bambu's report vocabulary
  (`gcode_state` strings, `subtask_name`, `print_error`, HMS, AMS,
  `speed_level` 1-4); the UI (`web/src/printers.ts`, `PrinterCard`,
  `PrintControls`) reads it directly.
- Commands are raw Bambu JSON built in `prints_api::control_command` and
  `farm_api::gcode`, sent with `hub.command(id, Value, wait)`.
- Sending (`printing::send`) is FTPS + `project_file`; packages are
  `.gcode.3mf` only (`bambu/package.rs`), and `printing::incompatibility`
  refuses any non-`bambu` printer.
- Cameras (`bambu/camera.rs`) and outside-print pictures
  (`printer_thumbs.rs`, FTPS) assume Bambu; the camera route checks
  `protocol == "bambu"`.
- Discovery (`discovery.rs`) is Bambu SSDP only.

### Target shape

- **`src/printer/`** (new, vendor-neutral):
  - `mod.rs`: `Protocol` (`bambu`, `moonraker`, `octoprint`, `prusalink`,
    `sdcp`; the strings stored in `printers.protocol`), `Capabilities`
    (pause/resume/stop, speed control kind, heat, camera, filament mapping,
    print options, outside pictures, package format), connection settings
    parsed from a `db::Printer`, the `Command` enum and `CommandError`.
  - `status.rs`: the `PrinterStatus` the UI reads, moved out of
    `bambu/status.rs`. **`state` is a normalized vocabulary**, the strings
    the UI already knows: `IDLE`, `PREPARE`, `RUNNING`, `PAUSE`, `FINISH`,
    `FAILED`, plus `CANCELLED` (Bambu: `FAILED` with 0300_400C, mapped by
    the Bambu driver). `job_key` (what the printer calls the job; was
    `subtask_name`) and `job_file` (was `gcode_file`) identify the job;
    `speed_percent` alongside Bambu's `speed_level`; `message` for a
    printer's own error/notice text. AMS/HMS/`print_error` stay (Bambu
    fills them, others leave them empty).
  - `hub.rs`: `PrinterHub` = per-printer links + a shared status board +
    broadcast. Each link is a driver task; the hub holds a cloneable
    driver handle (enum dispatch over the five drivers; no async trait
    objects). `hub.command(id, Command)` → `Ok(Some(reply))` / `Ok(None)`
    (not confirmed) / `Err(NotConfigured | Offline | Refused | Unsupported)`.
- **Commands** are vendor-neutral: `Pause`, `Resume`, `Stop`,
  `Speed(level|percent)`, `Heat { nozzle, bed }` (cooldown = 0/0),
  `Gcode(lines)`. Drivers translate (Bambu: `print`/`gcode_line` JSON).
- **Sending**: `printing.rs` keeps the generic pipeline (checks, records,
  tracker). Upload + start dispatch per protocol (`bambu::send`, ...) and
  report progress through a callback; outcome = confirmed / unconfirmed
  (tracker decides) / refused.
- **Packages** (phase 2): `Package { format: bambu_3mf | gcode, plates }`.
  Plain G-code jobs get one plate whose metadata (time, filaments, model,
  nozzle, bed type, thumbnail) is read from the slicer's comments, so
  pre-sliced `.gcode` uploads from any slicer work too.
- **Connection settings**: `address` may be `host`, `host:port` or a URL
  (OctoPrint behind a path); `serial_number` = device id (Bambu serial,
  SDCP MainboardID); `access_code` = the secret (access code, API key,
  password; write-only as now); new `username` column (PrusaLink digest
  user). The UI labels the fields per protocol from a
  `GET /api/printer-protocols` description.
- **Cameras**: `CameraKind` gains MJPEG-over-HTTP (Moonraker, OctoPrint,
  SDCP); the browser path for JPEG frames already exists.
- **Discovery**: `DiscoveredPrinter` gains `protocol` and a port; sources:
  Bambu SSDP (as now), mDNS (`_moonraker._tcp`, `_octoprint._tcp`, ...),
  SDCP UDP broadcast.

## Plan / steps

- [ ] **0. Research** (background agents): one reference per protocol in
      `plans/printer-drivers/<protocol>.md` — API, auth, status fields and
      state machine, upload/start/control, camera, discovery, fake-printer
      approach, slicer specifics (thumbnail formats, file type, OrcaSlicer
      vendor/profile names). Done: `moonraker.md`, `octoprint.md`,
      `prusalink.md`, `sdcp.md`.
- [x] **1. Driver abstraction**: `src/printer/` (`Protocol`,
      `Capabilities`, `Command`, normalized `PrinterStatus`, generic
      `PrinterHub` with enum-dispatched driver handles); Bambu moved onto it
      (`bambu/link.rs` replaces `bambu/hub.rs`, `bambu/send.rs` holds the
      FTPS + `project_file` send). Web UI reads `job_key`/`job_file` and
      gates controls on `capabilities`. Verified: unit tests (36), all e2e,
      fake Bambu printer (status, send → finished, busy refusal, pause,
      speed level, refused percent speed, resume, stop, preheat, cooldown).
- [x] **2. Plain-G-code jobs**: `src/package/` (`bambu.rs` = the old
      `.gcode.3mf` reader, `gcode.rs` = comments + thumbnails reader);
      packages carry `format`; non-Bambu slices record their G-code as the
      package; `/api/uploads` takes `.gcode`; sending checks the format the
      protocol takes and, for G-code, the sliced-for model. Verified on the
      libslic3r build: Voron 2.4, Prusa MK4S, Elegoo CC, X1C (unchanged).
      Side fix (own commit `05bb1a4`): nested preset folders and the
      OrcaFilamentLibrary were never loaded.
- [ ] **3. Moonraker driver** + fake ← current
      - [x] Backend (`f965d00`): `src/moonraker/` (WebSocket JSON-RPC
            link, status, HTTP upload + start, controls, heat, outside
            pictures); shared `reqwest` client (`printer/http.rs`), LAN TLS
            moved to `printer/tls.rs`; mapping checks only where filaments
            are mapped; pre-heat by material; `klipper` rows → `moonraker`.
      - [x] Fake + e2e: `tests/fake-moonraker/`, `tests/moonraker-e2e.mjs`.
      - [x] Cameras for every make (`f57d737`): `src/camera/` (hub,
            Bambu sources, MJPEG/snapshots); Moonraker webcams resolved.
      - [x] Conformance against real Klipper + Moonraker (simulavr image
            built from `mainsail-crew/virtual-klipper-printer`): connect,
            status, upload → print → completed, picture, pause, refused
            send while paused, resume, speed, cancel, camera (8 frames in
            6 s), heater/speed commands; a Klipper shutdown fails the print
            with Klipper's reason.
      - [ ] UI: connection fields per protocol, speed as percent, pre-heat
            by material, send dialog without AMS mapping (step 7, done
            alongside so each driver is usable).
      - [ ] Discovery (`_moonraker._tcp` mDNS when zeroconf is on; probe).
- [ ] **4. OctoPrint driver** + fake (OctoPrint's Virtual Printer).
- [ ] **5. PrusaLink driver** + fake.
- [ ] **6. Elegoo SDCP driver** + fake.
- [ ] **7. UI**: protocol-specific connection fields, capability-gated
      controls, discovery cards per vendor; docs (README, CLAUDE.md).

## Findings / gotchas

- The fake Bambu printer's responder acks `stop` but carries on to FINISH,
  so a stopped print on the fake ends `finished`, not `cancelled`. Real
  printers report FAILED + 0300_400C (now normalized to `CANCELLED` by the
  Bambu driver; unit-tested in `bambu::status`).
- Research findings that change the design (details in the protocol docs):
  - **Elegoo Centauri Carbon 2 is not SDCP**: MQTT broker on the printer,
    access code, LAN-only mode, its own discovery/upload/camera (8080). The
    original Centauri Carbon (and plain Centauri) is SDCP. SDCP uploads go
    to **port 80** (`/uploadFile/upload`, 1 MiB chunks), not 3030. A
    malformed command can crash the CC's single process mid-print: send
    only the exact payloads Elegoo's clients send. 5 WebSocket clients,
    ~1 camera viewer: one shared connection and feed per printer. Status
    pushes may stop while idle: poll.
  - **PrusaLink (Buddy firmware)**: only pause/resume/stop; no speed,
    temperatures or G-code (the Pi-based Prusa-Link for MK3 has more). No
    LAN camera. `X-Api-Key: <password>` works on current firmware (Digest
    `maker` is the alternative). Upload `PUT /api/v1/files/usb/<path>`
    (`Content-Length` required, one transfer at a time), then `POST` the
    same path to start. FINISHED/STOPPED vanish when someone touches the
    screen: poll ≤ 5 s. M862 checks in Prusa start G-code make a
    mismatched file wait for an on-screen answer. OrcaSlicer 2.4.2 can't
    write `.bgcode`. Discovery `_prusalink._tcp` (no TXT). 3 connections
    max, idle ones dropped after 10 s.
  - **Moonraker**: don't upload with `print=true` (silently doesn't start
    on a busy printer); upload, then `printer.print.start` after checking
    `print_stats.state` (Klipper replaces a *paused* job). Remaining time
    must be computed. Camera URLs are often relative to nginx on :80.
    zeroconf is off by default: manual address + `/access/info` probe.
    Fake: `ghcr.io/mainsail-crew/virtual-klipper-printer` (real Klipper +
    Moonraker; temperatures don't move) plus a hand-written fake for CI.
  - `gcode_flavor = klipper` does **not** imply Moonraker (Elegoo CC,
    Flashforge, Anycubic, Creality K2 use other protocols): the protocol
    stays the admin's choice, not derived from the profile.

- **Profiles were incomplete for most non-Bambu vendors** (fixed in
  `05bb1a4`): 85 nested preset folders unread (no Elegoo printers at all),
  and OrcaFilamentLibrary filaments filtered out as "another vendor's"
  (a Voron had 0 filaments). OrcaSlicer's rule, now ours: library
  filaments with no `compatible_printers` suit every printer unless the
  printer's vendor has a filament with the same alias naming it.
  `compatible_printers_condition` is still not evaluated (OrcaSlicer
  evaluates it with its PlaceholderParser).
- libslic3r writes the profile's thumbnails into plain G-code through our
  callback: Voron 48+300 PNG, Prusa MK4S 4×QOI + 640×480 PNG (line 260,
  inside PrusaLink's 2048-line window), Elegoo CC one 144×144 PNG with
  "; generated by OrcaSlicer" on line 2 (the CC needs it in the first 30).
- JSON-array `thumbnails` in profiles reach libslic3r fine: its
  `load_from_json` joins arrays for `coString` options.

- **My e2e wrapper hid failures until `f965d00`.** `tests/run-e2e.sh`
  prints no summary; the "ALL PASSED" in `check.sh`'s `tail -40` was the
  last suite's (`printers-e2e`), so groups/passkey/moonraker results were
  invisible. `check.sh` now records the runner's exit code and every
  suite's FAIL lines; since then all four suites pass (243 checks).
- **Real Klipper (virtual-klipper-printer)**, findings:
  - `ghcr.io/mainsail-crew/virtual-klipper-printer` is not pullable
    ("denied"); build it from the repo (`~/vkp-src`, image
    `pd-vkp-image`, ~5 min). Container `pd-vkp`, Moonraker on
    127.0.0.1:17125, mjpg-streamer on 127.0.0.1:18110.
  - `server.connection.identify` with `"api_key": null` → "Invalid API
    Key" (fixed: omit it).
  - Fast moves (F3000) shut the simulated MCU down ("Timer too close");
    F600 works. Klipper's messages are multi-line advice (status keeps
    line 1).
  - No extrusion (the sim can't heat; min_extrude_temp) means
    `print_duration` stays 0, so state reads PREPARE throughout.
    Correct Klipper semantics.
  - The sim's `CANCEL_PRINT` macro takes > 25 s; `printer.print.cancel`
    answers only when the macro is done, so stop reports "didn't
    confirm" and the tracker records `cancelled` later.
  - Webcams are added with `POST /server/webcams/item` (not `post_item`).
  - `virtual_sdcard.progress` is byte-based: with large thumbnail headers
    a print starts at ~12-27% until the first `M73`.

## Progress log

- [x] Scoped with the maintainer; worktree created.
- [x] Baseline on buildhost before the refactor: 35 unit tests, all e2e pass.
- [x] Phase 1 committed (driver layer + Bambu driver + UI field renames).
- [x] Phase 2 committed (`8a5866e`), profile fix (`05bb1a4`).
- libslic3r build on buildhost: container `fs-pd-cxx` (image
  `farmslicer:libslic3r`, host network, volumes `fs-cxx-cargo` →
  `/usr/local/cargo`, `fs-pd-target` → `/target`, the work dir → `/app`);
  `pd-cxx.sh build|run|stop` (release build ~40 s; server on
  127.0.0.1:9344, auth off, data in `pd-cxx-data`), `pd-slice-test.sh
  "<machine preset>"...` slices a cube per machine and prints the package.
  `docker exec` there needs `CARGO_HOME`/`RUSTUP_HOME` set (the script
  does it).
- Test scaffolding on buildhost: `~/farmslicer-printer-drivers` (sources
  synced with `tar`), target dir `~/farmslicer-printer-drivers-target`,
  `check.sh` (build, unit, e2e on port 9342 → `check.log`),
  `pd-bambu-test.sh` (stub dev server on 127.0.0.1:9343 + `fake-bambu`
  container; needs `/tmp/Test_Bracket.gcode.3mf` there),
  `pd-klipper-test.sh` (same dev server + `pd-vkp`).

## Open questions for the user

1. **Elegoo Centauri Carbon 2** speaks MQTT, not SDCP, so it needs its own
   driver. In scope? Recommendation: yes, after the original CC's SDCP
   driver (same fake-first approach); until then CC2 printers are listed as
   unsupported.

## Things not to do

- Don't change Bambu behaviour while refactoring (it runs a real farm).
- Don't put real host names, IPs, domains or league names in this repo.
- Don't start a print on a real printer without the user's per-print OK.
