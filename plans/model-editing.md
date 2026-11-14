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
- **An unedited model is uploaded as it is** (smaller than a re-encoded
  3MF). A derived 3MF is uploaded only once something changes the model.
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
1. [ ] `mesh.ts`: indexed triangle sets, bounds, transforms (4x4,
   row-major like libslic3r's when serialized), connected components, welding.
2. [ ] `xml.ts` + `zip` (fflate): read and write.
3. [ ] `stl.ts`: binary and ASCII STL reader.
4. [ ] `threemf.ts`: read the core spec, the production extension
   (components in other model files), and Bambu/Orca metadata; write the
   Orca dialect.
5. [ ] `paint.ts`: TriangleSelector port: deserialize and serialize
   (compatible), splitting, brushes (circle and sphere), smart fill, bucket
   fill, height range, the leaf triangles for display.
6. [ ] `document.ts`: ModelObject → volumes (mesh, type, extruder,
   transform, paint per kind), object settings, edit operations, undo stack.

### Phase 2: slicer side
1. [ ] **Verify `read_from_file` loads 3MF objects at all.** slice_core calls
   it with the default `LoadStrategy::AddDefaultInstances`, which lacks
   `LoadModel`. `_BBS_3MF_Importer` skips every object without it
   (`bbs_3mf.cpp` `_handle_end_object`). If confirmed, pass
   `LoadModel | AddDefaultInstances` and add a 3MF slice to the tests.
2. [ ] slice_core: refuse a model whose volume or paint names filament N
   beyond the job's filament count, with a clear message. Don't let
   libslic3r crash or silently skip it.
3. [ ] Server: check uploaded model 3MFs: zipcheck; keys in
   `model_settings.config` against `config_policy`; size caps.
4. [ ] Nozzle plan (`src/nozzles.rs`): filaments the models paint or assign,
   not only part plus supports.
5. [ ] Tests: a 3MF the TS writer made (painted, two volumes on two
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

- `read_from_file(path)` uses `LoadStrategy::AddDefaultInstances` only; the
  BBS 3MF importer creates no objects without `LoadStrategy::LoadModel`.
  Unverified at run time, but from the source the server can't slice a 3MF
  upload today. The viewer accepts them. (Phase 2.1.)
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

## Open questions for the user

(none)

## Things not to do

- Don't key paint to triangle indices of a mesh libslic3r loads from STL
  (repair renumbers). Paint only travels inside a 3MF with its mesh.
- Don't write per-object settings the member's role isn't allowed
  (`config_policy`); the server checks the 3MF too.
