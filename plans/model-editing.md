# Model editing: multi-colour, painting, and editing tools

## Goal

Bring the Slice page's plate up to what desktop slicers offer
(asked for on 2026-11-14: "Do it all! Boil the ocean."):

1. **Multi-colour.** Several filaments per job. Each object, or each part of
   an object, prints in a chosen filament.
2. **Painting** on the model's surface:
   - colour (which filament);
   - supports (enforce or block);
   - seams (enforce or block);
   - fuzzy skin.
3. **Basic editing tools:**
   - undo and redo;
   - select several parts, copy, paste, delete;
   - scale, by factor or to a size, per axis or uniform;
   - mirror;
   - numeric move and rotate;
   - split into objects or into parts, and merge;
   - an object list with names;
   - per-object settings;
   - modifiers and negative volumes;
   - primitives.
4. **Advanced tools:**
   - cut a part on a plane, and lay both cut faces down;
   - cut a part into pieces that fit the build volume;
   - connectors between the pieces so they lock or mesh together: plug and
     socket, dowel, dovetail, snap fit, with a glue gap.
5. Later: colour changes and pauses at a layer height.

## Environment / context

- Web: React 19, three 0.187, R3F 9, drei 10, Bun (`web/`). Unit tests are
  `bun test` (`web/test/`, plus `*.test.ts` next to the source).
- Engines: native libslic3r (cxx bridge) and WebAssembly. Both go through
  `cxx/slice_core.cpp` `build_plates`, which calls `Model::read_from_file`
  on each model file.
- OrcaSlicer v2.4.2 submodule:
  - `src/libslic3r/Format/bbs_3mf.cpp` is the 3MF reader and writer.
  - `src/libslic3r/TriangleSelector.cpp` handles painting.
  - `src/libslic3r/CutUtils.cpp` is the desktop app's cut code, for reference.
- The C++ can't be built on this Windows box. Use buildhost (Docker) or CI.

## Decisions already made (don't re-ask)

- **Interchange format: Bambu/Orca-dialect 3MF.** libslic3r's 3MF reader
  already understands everything the editor needs:
  - triangle painting: `paint_color`, `paint_supports`, `paint_seam`,
    `paint_fuzzy_skin`, as TriangleSelector hex strings, one per triangle,
    in file order;
  - several volumes per object, with their types: part, modifier, negative
    volume, support enforcer, support blocker;
  - the filament of each object and each volume (`extruder` in
    `Metadata/model_settings.config`);
  - per-object settings (the same file).

  The browser reads and writes this dialect itself, in `web/src/model/`. An
  edited object goes to the job as a 3MF the browser wrote. Both engines read
  it with no new bridge API, and the file opens in OrcaSlicer and Bambu
  Studio too.
- **Why the browser writes the file, and not a list of edits applied in
  C++:** painting indexes triangles, and the indices only line up when the
  mesh and its paint travel together. libslic3r repairs STL files on import
  (`trianglemesh_repair_on_import`), which can drop or renumber facets.
  Paint keyed to the browser's copy of an STL would land on the wrong
  triangles.
- **One editor object = one model file of the job**, with every copy of it
  an instance (a part with a placement). The job's plates
  (`src/placement.rs`) don't change: one file still places as one rigid
  group. Splitting into objects makes new models.
- **An unedited STL is uploaded as it is** (smaller than a re-encoded 3MF).
  Every 3MF, and every edited model, goes as a 3MF the browser wrote, so
  the slicer sees exactly what the editor showed: a Prusa project's
  triangle-range volumes, core 3MF colours, components across files all
  arrive in one dialect.
- **Scale and mirror are per copy**, in the placement's matrix
  (`src/placement.rs`: any linear transform with every axis scaled
  between 0.001 and 1000 and not flat), as instances are in the desktop
  app. A volume's matrix (inside its object) holds where the volume sits.
  slice_core already applied the matrix as a general linear map.
- **The painting data format is TriangleSelector's own**, so painting
  matches the desktop app triangle for triangle: a split tree per original
  triangle, the same split rule, and the same bitstream as hex nibbles.
  It's ported to TypeScript in `web/src/model/paint.ts`.
- **Connectors are volumes, not booleans.** The desktop app models a plug as
  a part volume on one half and the socket as a negative volume (enlarged by
  the tolerance) on the other. libslic3r slices both natively, so the
  browser needs no CSG library.
- Zip: `fflate` (MIT, small, sync and async). XML: a small hand-written
  tokenizer in `web/src/model/xml.ts`. DOMParser is too slow on 100 MB
  meshes and isn't in Bun or Workers.

## Plan / steps

### Phase 1: model library (`web/src/model/`, pure TS, unit-tested)
1. [x] `mesh.ts`: indexed triangle sets, bounds, transforms (4x4,
   row-major like libslic3r's when serialized), connected components, welding.
2. [x] `xml.ts` + `zip` (fflate): read and write.
3. [x] `stl.ts`: binary and ASCII STL reader.
4. [x] `threemf.ts`: read the core spec, the production extension
   (components in other model files), and Bambu/Orca metadata; write the
   Orca dialect.
5. [x] `paint.ts`: TriangleSelector port: deserialize and serialize
   (compatible), splitting, brushes (circle and sphere), smart fill, bucket
   fill, height range, the leaf triangles for display.
6. [x] `document.ts`: ModelObject → volumes (mesh, type, extruder,
   transform, paint per kind), object settings. (Edit operations and the
   undo stack belong to Phase 4.)

### Phase 2: slicer side
1. [x] **Verify `read_from_file` loads 3MF objects at all.** Confirmed
   broken, fixed (`LoadModel | AddDefaultInstances`). slice_core calls
   it with the default `LoadStrategy::AddDefaultInstances`, which lacks
   `LoadModel`. `_BBS_3MF_Importer` skips every object without it
   (`bbs_3mf.cpp` `_handle_end_object`). If confirmed, pass
   `LoadModel | AddDefaultInstances` and add a 3MF slice to the tests.
2. [x] slice_core: refuse a model whose volume or paint names filament N
   beyond the job's filament count, with a clear message. Don't let
   libslic3r crash or silently skip it.
3. [x] Server: check uploaded model 3MFs (`src/model_check.rs`): zipcheck;
   keys in `model_settings.config` / `Slic3r_PE_model.config` against
   `config_policy`.
4. [x] Nozzle plan (`src/nozzles.rs`): no change needed. Filaments that
   aren't support filaments already count as part filaments.
5. [ ] (current) Tests: e2e `tests/model-3mf-e2e.mjs` (policy, scaled and
   mirrored copies) with fixtures from `tests/fixtures/models/make.ts`; a
   real slice of `painted.3mf` on buildhost (image `farmslicer:model-edit`,
   `~/farmslicer-model-edit-docker`, libslic3r stage from
   `farmslicer:openssl-test-libslic3r`). Still to do: a 3MF the TS writer made (painted, two volumes on two
   filaments) sliced by both engines, with the tool changes checked in the
   G-code.

### Phase 3: filament slots on the Slice page
- Filaments become a list of slots (profile and colour each), like the
  desktop app. Objects, volumes and paint pick slots. Supports pick slots.
  Colours come from the target printer's AMS where known.

### Phase 4: editor
- New editor on the document: object list, multi-select, undo and redo,
  clipboard, transform tools (move, rotate, scale, mirror, numeric, uniform,
  per axis, to size), lay on face, drop, centre, arrange, auto-orient, split
  and merge, primitives, modifiers and negative volumes, per-object
  settings, measure.

### Phase 5: painting UI
- Colour, supports, seam, and fuzzy skin tools.
- Brush (circle or sphere, size), smart fill (angle), bucket, triangle mode,
  height range, erase, and clear.
- The paint overlay.

### Phase 6: cut
- Plane gizmo; keep the upper, lower, or both halves; lay the cut faces
  down.
- Connectors (plug, dowel, dovetail, snap; shape, size, depth, tolerance for
  glue).

### Phase 7: cut to fit
- Propose cut planes so every piece fits the bed, add connectors, lay the
  pieces down, and arrange them over plates.

### Phase 8: layer-height colour change and pause

## Findings / gotchas

- `read_from_file(path)` used `LoadStrategy::AddDefaultInstances` only; the
  BBS 3MF importer creates no objects without `LoadStrategy::LoadModel`.
  Proved on 2026-11-14 with the production image: an STL cube sliced, the
  same cube as a 3MF failed with "The supplied file couldn't be read
  because it's empty". Fixed in Phase 2.
- The 3MF reader sends every unrecognised object or part metadata key to
  `config.set_deserialize`: model settings are config. Hence
  `src/model_check.rs`.
- Without a project config loaded, the reader doesn't clamp filament
  numbers (`max_filament_id` = INT_MAX), so slice_core checks them.
- The reader needs `Application` = `OrcaSlicer-…`/`BambuStudio-…` to treat
  a file as its own (`m_is_bbl_3mf`). FarmSlicer writes
  `FarmSlicer-<version>` instead. The difference for one object with one
  build item is the object's name (set from metadata anyway). Verify that
  volumes, paint and filaments load in the real slice (Phase 2.5).
- quick-xml 0.42 compares names and keys as `&str` (`e.name().as_ref() ==
  "metadata"`); `unescape_value` is deprecated, use
  `quick_xml::escape::unescape(&a.value)`.
- TriangleSelector serialization: per painted original triangle, a nibble
  stream, written as hex with the **last nibble first** (`get_triangle_as_string`
  inserts each digit at the front). Nibble = `xxyy`: `yy` = split sides
  (0 = leaf); leaf `xx` = state 0-2, or `0b11` followed by a nibble of
  state-3 (states 3-16). Split triangles store the special side in `xx`, then
  children in reverse order.
- `paint_color` states: 0 = unpainted (the volume's own filament),
  1..N = filament N. Supports: 1 = enforcer, 2 = blocker. Seam: 1 = enforcer,
  2 = blocker.
- The 3MF reader flips a volume whose signed volume is negative. Triangle
  order is kept, so paint still lines up.
- Guide page (`web/src/pages/Guide.tsx:94`) says Slice takes OBJ and STEP,
  but the picker takes STL and 3MF only.

## Progress log

- [x] Plan written (2026-11-14).
- [x] Phase 1 committed (`6547b0e`): model library, 18 unit tests.
- [x] Phase 2 code: LoadModel fix, filament check, scale and mirror per
  copy, model_check. `cargo test` 189 passed on buildhost.

## Open questions for the user

(none)

## Things not to do

- Don't key paint to triangle indices of a mesh libslic3r loads from STL
  (repair renumbers). Paint only travels inside a 3MF with its mesh.
- Don't write per-object settings the member's role isn't allowed
  (`config_policy`); the server checks the 3MF too.
