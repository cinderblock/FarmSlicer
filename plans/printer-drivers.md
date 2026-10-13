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

## Plan / steps

- [ ] **0. Research** (background agents): one reference per protocol in
      `plans/printer-drivers/<protocol>.md` — API, auth, status fields and
      state machine, upload/start/control, camera, discovery, fake-printer
      approach, slicer specifics (thumbnail formats, file type, OrcaSlicer
      vendor/profile names).
- [ ] **1. Driver abstraction** ← current
      - Design from a full read of the Bambu code paths.
      - Refactor Bambu onto it; unit + e2e tests (`tests/printers-e2e.mjs`)
        still pass on buildhost; fake Bambu printer still works.
- [ ] **2. Plain-G-code jobs**: non-Bambu printers get `.gcode` with the
      thumbnails their firmware wants; "plate" info (time, filament) from slice
      stats instead of a `.gcode.3mf`.
- [ ] **3. Moonraker driver** + fake.
- [ ] **4. OctoPrint driver** + fake (OctoPrint's Virtual Printer).
- [ ] **5. PrusaLink driver** + fake.
- [ ] **6. Elegoo SDCP driver** + fake.
- [ ] **7. UI**: protocol-specific connection fields, capability-gated
      controls, discovery cards per vendor; docs (README, CLAUDE.md).

## Findings / gotchas

(none yet)

## Progress log

- [x] Scoped with the maintainer; worktree created.

## Open questions for the user

None.

## Things not to do

- Don't change Bambu behaviour while refactoring (it runs a real farm).
- Don't put real host names, IPs, domains or league names in this repo.
- Don't start a print on a real printer without the user's per-print OK.
