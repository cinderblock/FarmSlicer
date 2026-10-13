# G-code safety: verify what gets sent to printers

## Goal

Nothing FarmSlicer sends to a printer should be able to hurt the printer, the
plate, or the farm's schedule, whoever produced the file. Today three paths
put arbitrary G-code on a printer:

1. `POST /api/uploads`: any `.gcode.3mf`. `package::inspect` only reads the
   uploader's own metadata (`slice_info.config`), so print time, materials,
   printer model and nozzle, and therefore print rules, quotas and cost, are
   all self-declared.
2. Browser slicing: the client POSTs whatever G-code and package it likes to
   `/api/jobs/{id}/result`.
3. Server slicing: per-job overrides are merged without a key filter, so
   `machine_start_gcode`, `change_filament_gcode`, `filament_start_gcode`, ...
   inject G-code into slices FarmSlicer makes itself (custom profiles too).

The user asked for all of it ("do it all, boil the ocean"): lock down config
overrides, harden package parsing, verify every plate's G-code by simulating
it, use recomputed numbers instead of declared ones, and route findings
through the approval flow.

## Environment / context

- Main checkout, branch `master`, shared with other threads: stage only this
  work's files.
- Rust can't build on the Windows box (vendored OpenSSL needs Strawberry
  Perl). Check/test on buildhost: tar `Cargo.* build.rs .cargo src tests
  resources web/src/data` to `~/farmslicer-gcode-safety` and run with
  `CARGO_TARGET_DIR=~/farmslicer-gcode-safety-target FARMSLICER_SKIP_CXX=1`.
  Web builds locally (`cd web && bun run build`).
- Real Bambu Studio `.gcode.3mf` exports (the maintainer's own, X1 Carbon,
  Bambu Studio 02.01 and 02.05) exist locally; used for calibration only,
  never committed.
- CI's `check` job does not check out the OrcaSlicer submodule, so the server
  under e2e runs without profiles: anything the checker needs must ship in the
  repo (generated data files), not be derived from profiles at runtime.

## Decisions already made (don't re-ask)

- Do all of it (user, 2026-10-12).
- **Allowlist, never a blocklist.** Bambu's own X1 start G-code uses `M500`,
  `M290`, `M201`/`M203`/`M205`, `M221`, `M900`, so "dangerous command" lists
  would block every real print. Allowed = what vendor templates and the slicer
  emit, with parameter ranges.
- **Data is generated, committed, and reviewable**: generated from the
  OrcaSlicer submodule's BBL profiles and BambuStudio's BBL profiles (pinned
  tag), by Rust code that shares the checker's tokenizer. A unit test fails
  when the Orca-derived file is stale (when profiles are present).
- **Severity**: `block` (can't be sent by anyone through FarmSlicer:
  malformed packages, zip tricks, commands that are never legitimate) vs
  `review` (needs an admin's approval) vs `info`.
- Safety findings need an **admin** to approve (it's the farm owner's
  hardware); group managers keep approving print-rule violations only.
- Admins sending directly must acknowledge findings (like
  `ignore_mapping_problems`).
- Every package is checked, server slices included (defense in depth; a
  finding on our own slice is an allowlist bug and is logged loudly).
- Print rules, quotas and cost use the larger of declared and recomputed
  print time, and recomputed filament use.

## Design

(Filled in as phases land.)

## Plan / steps

1. Plan doc. ✅
2. Config policy: allowlist of override keys + value validation for
   non-admins; admins may set more but never `post_process` & co. Custom
   profiles validated the same way. ← **current**
3. Package hardening: duplicate/odd zip entries, size limits, real MD5.
4. G-code tokenizer + template harvester + data generator; data files.
5. Simulator: positions, temperatures, fans, dwell/heater-idle, extrusion
   per tool, time estimate; checks against the data + material table.
6. Integration: checks stored per plate; run on every package; backfill;
   send/approve flow; recomputed stats in rules/quotas/cost.
7. Settings: site safety limits; per-group upload policy.
8. Web UI: findings on Jobs / Send dialog / approvals; settings; guide.
9. E2E tests with crafted packages; README / CLAUDE.md.

## Findings / gotchas

- Bambu Studio 02.05 X1 start G-code is dated 20251031; OrcaSlicer v2.4.2's is
  20250909. Newer Studio releases can use commands Orca's profiles don't, hence
  harvesting BambuStudio's profiles too.
- `slice_core` never runs `post_process` scripts (that's GUI code in
  `BackgroundSlicingProcess`), so no RCE today; still denied in overrides.
- Custom profiles aren't used for slicing yet (stored/edited only), and any
  full user can edit anyone's (see ISSUES.md).
- Real start G-code moves outside the printable area (Y -3..265 on X1, X up to
  255.6 for the cutter/chute) and to Z -1.5 (nozzle wipe); the movement
  envelope must come from the vendor templates.

## Progress log

- [x] Plan
- [ ] Config policy
- [ ] Package hardening
- [ ] Tokenizer, harvester, data
- [ ] Simulator + checks
- [ ] Integration
- [ ] Settings
- [ ] Web UI
- [ ] E2E + docs

## Open questions for the user

(None yet.)

## Things not to do

- Don't hard-block commands just because they sound dangerous (`M500`).
- Don't trust anything inside an uploaded package to describe itself
  (`slice_info`, `project_settings`, `.md5`, CONFIG_BLOCK templates).
- Don't commit the maintainer's sample files or any real host names.
