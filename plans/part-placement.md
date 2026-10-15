# Part placement: orientation and position that reach the slicer

## Goal

A user reported that they can load and move a part on the Slice page but can't
rotate it to change its print orientation. Requests in this thread:

1. Rotating a part must change how it's sliced. Moving it must too.
2. A Bambu Studio-style gizmo: drag handles for moving and rotating along
   orthogonal axes, with snap points.
3. No inertia in the 3D view. Orbiting follows the pointer directly, like a CAD
   program. No drift, no easing.
4. A part moved off the build plate turns an error colour. It doesn't disappear.

## Root cause (request 1)

`web/src/components/ModelViewer.tsx` only ever changed the three.js object.
Nothing about the placement went into the job. `cxx/slice_core.cpp`
`place_on_bed()` centres every model on the bed in its file orientation, so
rotating in the viewer had no effect and moving only *looked* like it worked.
The viewer was also Y-up, with STL/3MF Z (the slicer's up) lying horizontal.
What you saw wasn't the slicing orientation either.

## Environment / context

- Viewer: React Three Fiber 9, drei 10, three 0.184 (`web/`).
- Engines: native libslic3r through the cxx bridge (`src/slicer.rs`,
  `cxx/slicer_bridge.cpp`) and WebAssembly (`wasm/bridge/farmslicer_wasm.cpp`).
  Both go through `cxx/slice_core.cpp`.
- The bed comes from the resolved profile: `printable_area` (strings like
  `"0x0"`, absolute coordinates) and `printable_height`.
- The C++ can't be built on this Windows box. Use buildhost (Docker) or CI.

## Decisions already made (don't re-ask)

- **Placement = rotation + XY offset, not an absolute matrix.** The job carries
  `placement = {"rotation": [9 numbers, row-major 3x3], "offset": [dx, dy]}`.
  The rotation applies to the model as loaded. `offset` is where the rotated
  model's bounding-box centre sits relative to the bed centre, in mm. The slicer
  rotates, re-centres on `bed centre + offset` and drops onto Z=0. This is
  robust to differences in origin between three's loaders and libslic3r's
  (rotation about any pivot plus re-centring gives the same result). With no
  placement, the slicer keeps today's behaviour (centred).
- The viewer works in slicer coordinates: Z up, X right, Y back. The scene
  origin is the bed centre.
- The part always rests on the plate. There is no Z move, matching the slicer,
  which drops every object onto the bed.
- Server-side bounds check in slice_core (libslic3r `BuildVolume` +
  `Model::update_print_volume_state`). A part partly or fully outside the
  printable volume fails the slice with a clear error. Previously an oversized
  part was sliced beyond the bed.
- Placement is stored on the job (`jobs.placement_json`) so the record is
  complete.
- The browser engine advertises `"placement": true` in `fs_version`. If the
  engine is older, a rotated or moved part refuses to slice in the browser
  rather than silently ignoring the placement.
- Bambu's tool keys: M move, R rotate, F lay on face, Esc no tool.
- Snapping: rotation 15° (ticks every 5° and 15°), translation 1 mm plus a
  magnet to the bed's centre lines. Hold Shift for free movement.
- Lay on face (F) is included. It's the fastest way to orient a part for
  printing, and Bambu has it.

## Plan / steps

1. [x] Plan doc.
2. [x] slice_core: `Placement` in `Options`, apply it, bounds check.
3. [x] Native bridge: `SliceOptions.placement_rotation/offset` (cxx + stub).
4. [x] wasm bridge: `placement` in `fs_set_options` JSON, `fs_version` feature flag.
5. [x] Server: parse/validate the `placement` multipart field, store
   `placement_json`, pass it to `run_slice` and the browser `slice_options`.
6. [x] Web engine: `SliceOptions.placement`, version feature check.
7. [x] Viewer rewrite: Z-up, profile bed, no damping, gizmo (move/rotate/
   lay-flat), snapping, error colour, numeric panel, report placement.
8. [x] Slice page: pass the bed, receive the placement, block slicing when the
   part is off the bed, send the placement.
9. [x] e2e test `tests/placement-e2e.mjs`.
10. [x] Verify: tsc, `bun run build`, eslint (no new findings), unit tests
    and the full e2e run on buildhost, the UI driven headless with
    Playwright, real native slices of placed parts (image built on buildhost
    from `farmslicer:libslic3r`), and the wasm bridge and slice_core
    compiled with em++ using the st build's own command lines. The full
    wasm engine link is left to CI.
11. [x] README/CLAUDE.md updates.

## Findings / gotchas

- `ModelInstance::print_volume_state` defaults to Inside, and `Print::apply`
  only skips instances that aren't printable. Nothing in our pipeline checked
  the bed before, so the slicer happily produced G-code outside it.
- three's `3MFLoader` does no Z-up conversion (its doc comment tells callers to
  rotate). Neither does `STLLoader`, so a Z-up scene shows files as the slicer
  sees them.
- drei `OrbitControls` enables damping by default. That was the inertia.
- three's `ConvexHull` takes ~0.3 s per 100k points on a curved surface
  (1M: 3.8 s, 3M: 14 s, measured with bun). The hull input is therefore the
  unique vertices (typed-array hash: STL repeats each ~6x), subsampled to
  one real vertex per grid cell above 120k.
- R3F primitives nest fine (`<primitive object={root}><primitive
  object={content} onPointerDown/></primitive>`), and handlers register in
  `internal.interaction`. One check in the T3 preview showed an empty list
  after Vite hot reloads. A fresh headless load was fine. Use a fresh load
  when checking.
- `pkill -f` over ssh matches its own command line and kills the session
  (exit 127). Use `pgrep -fa "[d]ocker build"`.
- Bambu G-code coordinates are nozzle coordinates: subtract
  `extruder_offset` (X1C: `0x2`) before comparing with plate positions.
- The Docker build's `orca-deps` stage didn't hit the cache from a copied
  context (a full deps rebuild). `farmslicer:libslic3r` on buildhost is a
  v2.4.2 libslic3r stage; building `server`+`runtime` from it takes minutes.
- `Slice.tsx` already had 2 eslint errors (`set-state-in-effect`) before this
  work. `web` lint fails on main for other files too; new files lint clean.

## Progress log

- [x] Root cause found (above).
- [x] Server, engines and web implemented; e2e 18/18; all other suites pass.
- [x] UI checks (Playwright, headless Chromium, stub server on buildhost
  :9342 through an ssh tunnel to local :9337, `vite` on :5173): arrow drag
  (+40.5 mm, whole-mm snap), dragging the part off the bed (red, warning,
  "Move to center" recovers), Z ring +45° snapped, X ring −45°, lay-on-face
  on the front face (→ Rx 90°, size 60×40×20), the bed reframes when the
  printer model changes.
- [x] Real slices (X1 Carbon profiles, 60x20x40 L-bracket), measured from
  the G-code's top layer:
  - as loaded: Z 40, centred;
  - Rx 90° with offset (−40, +12): Z 20, top-layer centre (88, 140) in plate
    coordinates;
  - 45° about Z: sliced, still centred;
  - offset (200, 0): fails with "the model is off the bed: move it onto the
    build plate";
  - offset (110, 0): fails with "the model doesn't fit in the printable
    volume ...".
  The G-code's Y reads 2 mm less than plate Y. That's the X1C profile's
  `extruder_offset` of `0x2` (same without a placement; Bambu Studio does
  the same).

## Open questions for the user

(none yet)

## Things not to do

- Don't bake the rotation into a re-exported STL client-side. It loses 3MF
  metadata (multiple objects, colours, per-object settings).
- Don't put the placement in `config_json`. libslic3r would warn about an
  unknown key, and the config is what the profile cascade produced.
