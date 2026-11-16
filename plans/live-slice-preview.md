# Live slice preview

## Goal

Show the slice taking shape while it's being sliced, not just a progress bar.
Each libslic3r step's geometry goes to the page as soon as that step
finishes for an object: layer outlines after slicing, then walls, infill,
and supports. The finished G-code preview replaces it at the end. It works
for both engines (server and browser).

## Environment / context

- Pipeline: `cxx/slice_core.cpp` `slice_models` → per plate `print.process()`
  then `print.export_gcode()`. Callbacks in `core::Callbacks`.
- libslic3r @ OrcaSlicer v2.4.2: `Print::process` (Print.cpp ~2290) runs each
  step over every object in turn on the calling thread: `make_perimeters`
  (does `slice` first), `estimate_curled_extrusions`, `infill` (does
  `prepare_infill` first), `ironing`, `contour_z`, then
  `generate_support_material` in a `tbb::parallel_for` over objects,
  `detect_overhangs_for_lift`. Each step parallelises over layers inside.
- `set_status` calls (the status callback) happen at each step's start,
  after `set_started` and before its parallel work (PrintObject.cpp 461, 564,
  705, 822, 888, 919...), plus from inside tree support and G-code export
  (per layer: "Generating G-code: layer N").
- Geometry: `Layer::lslices` (ExPolygons, outlines), `LayerRegion::perimeters`
  / `fills` (ExtrusionEntityCollection), `SupportLayer::support_fills`.
  `ExtrusionPath::polyline` is a `Polyline3` (scaled coords, with z for z
  contouring), plus `width`, `height`, `role()`. Object coordinates; G-code
  XY = unscale(point + `PrintInstance::shift`) (plate origin is 0 in
  slice_core). Objects that share geometry (`get_shared_object()`) get their
  layers copied only at the end of `process()`: read the shared object's.
- Feature names: `ExtrusionEntity::role_to_string` gives the names the
  preview already knows (`web/src/components/preview/features.ts`).
- Preview renderer: `web/src/components/preview/scene.ts` `Toolpaths` takes a
  `ParsedGcode` (types.ts). The live view builds one from the frames.

## Decisions already made (don't re-ask)

- Option B (geometry per step during `process()`), chosen by the user
  2026-11-15 over streaming the G-code file as it's written.
- The literal G-code stream during export is **not** built: by then every
  step's geometry is on screen, and the file adds only travel, skirt, and the
  prime tower. Instead, export progress ("Generating G-code: layer N") sweeps
  up the live view: layers up to N in full, the rest faint (`ViewRange.ghost`).
- Snapshot rule: at every status callback (and once after `process()`
  returns), copy each object step that has newly reached DONE (by its
  timestamp). The first callback after a step finishes is the next step's
  start, before its parallel work, so nothing is writing what we read.
  Steps that rewrite data later (curled extrusions, simplify paths) run
  after the copy. The copy is a deep copy into our own format; libslic3r
  data is never kept.
- A point budget per slice (`LIVE_POINT_BUDGET`): outlines always, the
  extrusion steps while they fit. A step over the budget is marked
  "skipped" so the page can say so.
- Server: frames are kept in memory per job (`src/live.rs`) while it
  slices, plus a minute after; `GET /api/jobs/{id}/live` streams them
  (length-prefixed frames), to whoever can see the job.
- Browser: the engine hands frames to the worker (`Module.fsLive`), which
  posts them to the page; nothing goes to the server.

## Wire format (little-endian), one frame per object step

```
"FSL1"            magic
u32 plate         1-based
u32 object        index in the plate's Print
u8  step          0 outlines, 1 walls, 2 infill, 3 supports
u8  flags         bit 0: skipped (over budget; no layers follow)
u16 reserved
u32 instances     then instances x (f32 x, f32 y): shift in mm
u16 names         then per name: u16 length + UTF-8 (feature names)
u32 layers
per layer: f32 print_z, f32 height, u32 paths
  per path: u8 name index, u8 tool (0-based), u16 width µm, u16 height µm,
            u16 reserved, u32 points, then points x (f32 x, f32 y)
```

A later frame for the same (plate, object, step) replaces the earlier one
(a re-slice inside one job: `fit_wipe_tower`, `move_unreachable_filaments`).
A frame of a later step replaces nothing; outlines are hidden for an object
once its walls are in.

## Plan / steps

1. [x] Plan doc (this).
2. [x] C++: `cxx/live_geometry.{hpp,cpp}` (tracker + encoder), `Callbacks::geometry`,
       slice_core polls it. Engine-agnostic.
3. [x] Bridges: cxx `extern "Rust" slice_geometry`; wasm `Module.fsLive`
       (proxied to the main runtime thread on mt), `fs_version` `live: true`.
4. [x] Rust: `src/live.rs` registry + `GET /api/jobs/{id}/live`; `run_slice`
       starts/finishes it. Unit tests.
5. [x] Web: `preview/liveSlice.ts` (decode, merge, build ParsedGcode, pure,
       unit-tested), `preview/LiveSlice.tsx` (view), engine worker/client
       `onLive`, Slice page (browser slices switch to Preview at once),
       SliceResult's waiting state, Job page while slicing.
6. [x] Tests: `web/test/live-slice.test.ts`, Rust unit tests, e2e for the
       endpoint, `wasm/test/smoke.mjs --live`.
7. [x] Build and check on buildhost: wasm engine + smoke, Docker image +
       a real server slice streaming frames, the page in a headless browser.
8. [x] Docs: CLAUDE.md, README, changelog.

## Findings / gotchas

- `PrintObjectBaseWithState::set_done` calls the status callback (warnings)
  outside the state mutex, so `step_state_with_timestamp` (which locks it)
  is safe to call from the callback.
- Tree support calls `set_status` from TBB workers while other objects'
  supports run. Reading an object's finished walls/infill then is read-only
  alongside support generation, which reads them too.

- G-code XY is the object's point + instance shift **less the nozzle's
  `extruder_offset`** (`GCode::point_to_gcode`; the filament's nozzle is
  `filament_map[t] - 1`). The X1C profile has `extruder_offset = 0x2`: the
  first live frames came out 2 mm off in Y against the G-code until
  live_geometry.cpp subtracted it.
- Sending sources from Windows: `git archive` converts line endings
  (`* text=auto` + Windows' native eol) even with `core.autocrlf=false`;
  OrcaSlicer's tree came out CRLF and orca-wasm.patch failed every hunk.
  Use `git -c core.autocrlf=false -c core.eol=lf archive`. A 300 MB archive
  piped straight into `ssh` stalled once: write it to a file and `scp` it.

## Progress log

- [x] 2026-11-15: design, plan written.
- [x] 2026-11-15: everything written; web typecheck, lint (no new findings)
      and `bun test` pass (live-slice.test.ts: 12).
- [x] 2026-11-15: st engine built on buildhost (`~/farmslicer-liveslice-wasm`);
      smoke `--live` and `--plate --live` pass (outlines, walls, infill per
      object); the frames, decoded by liveSlice.ts, match the G-code's layer
      count and bounds (after the extruder offset fix).
- [x] 2026-11-15: Docker image `farmslicer:liveslice` built
      (`~/farmslicer-liveslice-docker`); a real server slice (a 25,600-triangle
      torus with tree supports, X1C) streamed 2 MB of frames over its 2.3 s
      and they match its G-code (120 layers, bounds within 0.02 mm). Stub
      `cargo test` and all 31 e2e suites pass (`tests/live-e2e.mjs` too).
- [x] 2026-11-15: headless Chromium (Playwright, swiftshader) against the
      image on port 9340: server and browser (mt engine) slices show the
      live view, tick Outlines/Walls/Infill/Supports, and hand over to the
      G-code preview; no console errors or warnings. Test container removed.

## Open questions for the user

(none yet)

- Once (1 run of 3), the G-code preview's first frame after a browser
  slice was blank under headless swiftshader while the CPU was loaded; it
  drew on the first drag, and two later runs drew at once. Logged in
  ISSUES.md ("G-code preview sometimes blank until the first drag").

## Things not to do

- Don't read libslic3r data outside the status callback / after
  `process()`: the steps run in parallel and later steps mutate paths.
- Don't stream through `progress::report` / SQLite: frames are megabytes.
