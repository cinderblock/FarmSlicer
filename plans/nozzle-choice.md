# Choosing each filament's nozzle on dual-nozzle printers (H2D)

## Goal

On printers with two nozzles (Bambu H2D / H2D Pro), FarmSlicer decides which
nozzle prints each filament instead of leaving it to libslic3r's "Auto For
Flush":

1. **Live AMS inventory first**: a filament loaded on only one side's AMS
   (on the target printer, or on most of the printers the job may go to)
   prints from that side's nozzle.
2. **Then a priority**: supports on one nozzle, parts on the other. A
   per-printer setting on printers with two nozzles; default *supports on
   the right, parts on the left*.

Requested by the user on 2026-10-16: "when picking left/right nozzle, first
check live inventory on AMS. Then prefer support on the right head,
material on the right [sic]. Should be an option for printers with
multiple nozzles, to set a priority."

## Environment / context

- libslic3r (OrcaSlicer v2.4.2) numbers nozzles in `filament_map` as
  1 = left, 2 = right (`master_extruder_id` = 2 on the H2D: the right is
  the main nozzle). `filament_map_mode`: "Auto For Flush" (default),
  "Auto For Match" (needs `Print::set_extruder_filament_info`, which only
  the GUI fills), "Manual" (takes `filament_map` as given).
- With "Manual", libslic3r still refuses a filament on a nozzle its
  `filament_printable` bitmask (bit 0 left, bit 1 right) excludes:
  "Grouping error: PET-CF can not be placed in the right nozzle". E.g.
  `Bambu PET-CF @BBL H2D` has `filament_printable` 1 (left only).
- With "Manual", libslic3r does **not** move a filament off a nozzle that
  can't reach part of the plate (H2D: `extruder_printable_area`,
  `extruder_printable_height` differ per nozzle). The auto modes use
  `Print::get_geometric_unprintable_filaments()` (computed in the wipe-tower
  step); slice_core has to check it itself in Manual mode.
- `filament_map` / `filament_map_mode` only invalidate the wipe-tower and
  G-code steps (Print.cpp `invalidate_state_by_config_options`), so a second
  `apply` + `process` after changing the map doesn't slice again.
- Which nozzle an AMS feeds: `AmsUnit.nozzle` (info bits 8-11, 563c852).
  External spools on dual-nozzle printers: `vir_slot` ids 255 = main
  (right), 254 = deputy (left) (OrcaSlicer DevDefs.h).
- Targets: the Slice page's printer, else every printer whose model and
  nozzle give the job's machine profile ("Any available").

## Decisions already made (don't re-ask)

- Inventory beats priority (the user's order).
- The priority is a per-printer setting, offered only on printers with two
  nozzles (`printers.nozzle_priority`: `''` = default, `support-right`,
  `support-left`, `slicer` = leave it to libslic3r as before).
- Default: supports right, parts left. The user's sentence said "right"
  twice; read as "support right, material left" (separating them is the
  point of two nozzles). **To confirm with the user** (open question 1).

## Plan / steps

1. [x] `Tray.nozzle` (AMS unit's, external 254/255 on dual printers); the
   send mapping uses it.
2. [x] Profiles: `FilamentInfo.printable`, `MachineModel.nozzles`,
   `ProfileStore::maps_filaments_to_nozzles(machine)` (BBL, two nozzles).
3. [x] `printers.nozzle_priority` column, API (validated), Printers form
   (only for BBL models with two nozzles).
4. [x] `src/nozzles.rs`: the choice (pure, 6 unit tests): per filament a
   nozzle, the basis and why.
5. [x] `server::job_config` (every job): on a dual-nozzle machine with no
   explicit `filament_map*` override, `filament_map_mode` = Manual +
   `filament_map`; the plan stored as `jobs.nozzle_plan_json`, served as
   the job's `nozzle_plan`. `POST /api/nozzle-plan` for the Slice page.
6. [x] slice_core: after the export, with a Manual map, move a filament
   the G-code check says its nozzle can't reach (`limit_filament_maps`)
   and slice again; refuse G-code a nozzle can't reach
   (`check_nozzle_reach`, any mode).
6b. [x] slice_core: the prime tower where both nozzles reach, as the
   desktop app places it (`place_wipe_tower`: x 165, y 250 on
   multi-nozzle printers; `fit_wipe_tower` after slicing: inside the area
   every nozzle reaches, a margin from the edge). Found by step 9: every
   H2D multi-filament slice so far put the tower at libslic3r's default
   x 15, out of the right nozzle's reach.
7. [x] Web: Slice page shows the plan before slicing (re-asked on changes
   and every 30 s); job page shows the job's (`NozzlePlanView`).
8. [x] Tests: 6 unit tests, `tests/nozzles-e2e.mjs` (fixture profiles in
   `tests/fixtures/profiles`, `{ROOT}` in `e2e-env`); all 14 e2e suites
   and 139 Rust tests (1 ignored) pass; web typecheck, 35 web tests. Docs: README,
   CLAUDE.md, issues/untested-printers.md.
9. [x] Verified against the real slicer image (`farmslicer:nozzles` on
   buildhost, `~/fs-pw/verify_nozzles.mjs`, 10 checks): the package's
   filament-to-nozzle map follows the plan; a part at the left edge
   (x 5-55) moves the right-nozzle filament left, at the right edge
   (x 295-345) the left-nozzle filament right, each with a warning;
   "let the slicer choose" slices (tower at 165,250); PET-CF left,
   support right; one filament; the X1C keeps its tower at 15,220. The
   Printers form and the Slice page's Nozzles box checked in headless
   Chrome (`~/fs-pw/nozzle_ui.mjs`, screenshots `nozzle-*.png`).

## Findings / gotchas

- libslic3r's own reach check (`PrintObject::detect_extruder_geometric_unprintables`,
  run in the wipe-tower step) only looks at **the first instance** of each
  object and only at part regions (not supports). FarmSlicer's copies are
  instances, so a Fill-ed plate's far copies go unchecked there. The G-code
  check that runs with the export (`GCodeProcessor::check_multi_extruder_gcode_valid`)
  covers every extrusion move (bounding boxes per object and filament), so
  slice_core uses its `limit_filament_maps` / `gcode_check_result` instead.
- `filament_printable` bit 0 = left (extruder 0), bit 1 = right; the H2D's
  `Bambu PET-CF @BBL H2D` is 1 (left only). (Misread once as 2 = right:
  the real-slicer check caught it; the G-code's `; filament_printable =`
  line is the ground truth.)
- H2D reach: left nozzle x 0-325, right x 25-350 (bed 350 x 320), heights
  320 / 325 (`extruder_printable_area` / `_height`).
- **The prime tower was out of the H2D's right nozzle's reach** on every
  multi-filament slice: libslic3r's default `wipe_tower_x` is 15 (60 wide
  → x 15-75; the right nozzle reaches x 25-350). The desktop app never
  uses that default: `PartPlateList::set_default_wipe_tower_pos_for_plate`
  starts at x 165, y 250 (x 0 on i3 printers) and clamps into the area all
  nozzles reach. Evidence: `; wipe_tower_x = 15` in the G-code and the
  export check's "the right nozzle can't reach all of filament 1" even in
  Auto For Flush. Production H2D jobs sliced before this fix have the
  tower there.
- Docker plain-progress logs print `#N DONE 1.2s` per step: a wait loop
  that greps for "DONE" ends at once. Grep for a marker of your own.
- The scratch Docker context (`~/farmslicer-docker`) only ever gets files
  added by tar: a stale `src/discovery.rs` (now `src/discovery/mod.rs`)
  broke the build (E0761). Compare it with `git ls-files` before building.
- The e2e server runs in a temp dir, so it has no profiles unless
  `ORCA_RESOURCES_DIR` points somewhere: hence the fixture tree.

## Progress log

- [x] Steps 1-9 (and 6b, the prime tower).
- [ ] An H2D print on hardware with something loaded on one side only
  (needs the user).

## Open questions for the user

1. Default priority: supports on the **right** nozzle, parts on the
   **left**? (The request said "right" for both.) Recommendation: yes;
   it's a per-printer setting either way.
2. Push `master` and pin the new image in the ops repo? (master also
   carries another thread's phone-layout commits.) Until then production
   H2D multi-filament jobs keep the prime tower at x 15, which the right
   nozzle can't reach.
3. When convenient: an H2D print with a filament loaded on one side only,
   to see the choice and the AMS mapping on hardware.

## Things not to do

- Don't use "Auto For Match": it needs the GUI's per-extruder filament
  configs and weighs flush cost against matching; the user wants a fixed
  order (inventory, then priority).
- Don't put a filament on a nozzle `filament_printable` excludes: libslic3r
  throws.
