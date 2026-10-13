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
      vendor/profile names). Done: `moonraker.md`, `prusalink.md`,
      `sdcp.md`. Pending: `octoprint.md`.
- [x] **1. Driver abstraction**: `src/printer/` (`Protocol`,
      `Capabilities`, `Command`, normalized `PrinterStatus`, generic
      `PrinterHub` with enum-dispatched driver handles); Bambu moved onto it
      (`bambu/link.rs` replaces `bambu/hub.rs`, `bambu/send.rs` holds the
      FTPS + `project_file` send). Web UI reads `job_key`/`job_file` and
      gates controls on `capabilities`. Verified: unit tests (36), all e2e,
      fake Bambu printer (status, send → finished, busy refusal, pause,
      speed level, refused percent speed, resume, stop, preheat, cooldown).
- [ ] **2. Plain-G-code jobs** ← current: non-Bambu printers get `.gcode`
      with the thumbnails their firmware wants; "plate" info (time,
      filament, model, nozzle, bed type, thumbnail) read from the G-code's
      comments, so `.gcode` uploads from any slicer work too.
- [ ] **3. Moonraker driver** + fake.
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

## Progress log

- [x] Scoped with the maintainer; worktree created.
- [x] Baseline on buildhost before the refactor: 35 unit tests, all e2e pass.
- [x] Phase 1 committed (driver layer + Bambu driver + UI field renames).
- Test scaffolding on buildhost: `~/farmslicer-printer-drivers` (sources
  synced with `tar`), target dir `~/farmslicer-printer-drivers-target`,
  `check.sh` (build, unit, e2e on port 9342 → `check.log`),
  `pd-bambu-test.sh` (stub dev server on 127.0.0.1:9343 + `fake-bambu`
  container; needs `/tmp/Test_Bracket.gcode.3mf` there).

## Open questions for the user

1. **Elegoo Centauri Carbon 2** speaks MQTT, not SDCP, so it needs its own
   driver. In scope? Recommendation: yes, after the original CC's SDCP
   driver (same fake-first approach); until then CC2 printers are listed as
   unsupported.

## Things not to do

- Don't change Bambu behaviour while refactoring (it runs a real farm).
- Don't put real host names, IPs, domains or league names in this repo.
- Don't start a print on a real printer without the user's per-print OK.
