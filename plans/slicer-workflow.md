# Slicer workflow: supports, preview, plates, job history, feedback

## Goal

A batch of user-reported gaps in the slicing workflow (one request, numbered as
the user gave them):

1. **Support checks**: warn when a part would print in the air (overhangs,
   floating islands) before and after slicing.
2. **Layer viewer**: preview the sliced G-code layer by layer.
3. **Quick Settings not scrollable** (seen on an H2D), and **support options
   unreachable** without zooming the browser out.
4. **Built-in feedback**: users report problems with printers, the slicer, the
   app, bugs, anything. Errors (including console errors) are reported
   automatically.
5. **Job history**: delete old jobs. Jobs keep the original model so they can
   be re-sliced with the same or slightly changed settings.
6. **Support material**: choose the support base and interface filaments.
   Defaults: interface = a support material, base = the cheapest suitable
   filament, unless the user prints supports in a single material.
7. **Several parts on one plate**: duplicate a part (as many as fit) or import
   other parts.
8. **Supports on by default** (they're only generated where needed).

## Environment / context

- Code map: `CLAUDE.md` (project structure). The C++ can't build on this
  Windows box: use buildhost (Docker, `farmslicer:libslic3r` image holds a
  v2.4.2 libslic3r stage) or CI.
- Test setup used in this thread: stub server (`FARMSLICER_SKIP_CXX=1`,
  `FARMSLICER_NO_AUTH=1`, `ORCA_RESOURCES_DIR=~/orca-242/resources`) built in
  `~/farmslicer-slicer-ux` on buildhost (target dir
  `~/farmslicer-slicer-ux-target`), running on buildhost `127.0.0.1:9342`,
  tunnelled to local `:9337`; `vite` on local `:5174` proxies `/api` there.
  Sync sources with `tar cf - Cargo.toml Cargo.lock build.rs .cargo src tests
  web/src/data | ssh buildhost 'cd ~/farmslicer-slicer-ux && tar xf -'`.
- The T3 preview browser can't resize while hidden. Measure narrow layouts by
  loading the page in a fixed-size same-origin iframe through
  `preview_evaluate`.

### What exists today (from exploring the code)

- **Jobs** (`src/server.rs` `create_job`): one `model` file, stored at
  `data/models/{uuid}.{ext}`. Server-sliced models are never deleted; browser
  slices upload the model only when the job's group has `keep_models`. The
  job stores `config_json`, `overrides_json` and `placement_json`, but **not
  which machine/process/filament were chosen**. No delete endpoint exists.
  `slices.job_id` has no `ON DELETE` (foreign keys are on), `prints` and
  `gcode_incidents` are `ON DELETE SET NULL`. `stored_bytes` per job row feeds
  the storage quota.
- **Profiles** (`src/profiles.rs resolve_config`): one machine + one process
  + one filament, merged by top-level key overwrite. Nothing builds
  OrcaSlicer's per-filament vectors (`PresetBundle::full_config`), so a job
  has exactly one filament.
- **Slicer core** (`cxx/slice_core.cpp`): one model file, one placement for
  the whole model. Thumbnails and `slice_info` objects already loop over every
  object and instance. `ModelObject::ensure_on_bed` drops all instances by
  the object-wide minimum Z, so per-instance tilt needs a per-instance drop.
- **Warnings**: libslic3r already warns "It seems object %s has floating
  regions/cantilever. Please re-orient the object or enable support
  generation." when supports are off (`PrintObject::generate_support_material`),
  and slice_core collects it into `jobs.warnings`. It only shows in a
  collapsed list on the Jobs page.
- **Viewer** (`web/src/components/ModelViewer.tsx`, `viewer/part.ts`): a
  single `Part` (self-contained: hull, placement, fit). The gizmos already
  take a `part` prop.
- **No G-code preview** anywhere; no G-code parsing in the web app.
- **AMS**: live tray contents (material, colour, which nozzle on H2D) are
  known from printer status. `suggest_mapping` matches materials exactly
  ("PLA-S" support vs a tray's material). Sending ignores which nozzle an AMS
  feeds.
- **Cost**: `filament_prices` site setting, priced per material type
  (`cost.rs`).

## Decisions already made (don't re-ask)

- Item 3 root cause: `.settings-panel` is a scrolling flex column; its items
  shrank, and Quick Settings (`overflow: hidden`, so min-height 0) collapsed
  to ~2 px. Fixed with `flex-shrink: 0` on the items, plus a stacked layout
  below 1000 px wide (`928afc0`).

- **Every job keeps its original model(s)** (user, Q1). The per-group
  `keep_models` setting goes away. If a user chooses not to upload the model
  (browser slice, "keep on this device"), the model is kept in the browser
  (IndexedDB) and the job shows a **local** tag; re-slicing it works from that
  browser only.
- **Support material defaults** (user, Q2, "let's try"): interface = the
  vendor support material matching the part's polymer (Support for PLA,
  Support For PA PET, ...); base = the cheapest plain filament of the part's
  polymer by the farm's `filament_prices` (PLA-CF part → PLA Basic base).
  Single-material supports remain a choice.
- **Track how often users change defaults** (user, Q2): each job records
  what the Slice page proposed next to what was used, so an admin report can
  show which defaults (support materials and every other setting) get
  changed, how often and to what.
- **Feedback visibility** (user, Q3): admins see everything; users see their
  own reports. Errors before sign-in queue in the browser and are sent after
  sign-in; there is no anonymous endpoint.
- **After slicing, the Slice page stays** (user, Q4) and shows progress, then
  a Preview with the layer viewer, warnings and "Send to printer". Old jobs
  get the same preview on a job page.

## Plan / steps

Order chosen so shared foundations land first. Items 2 (layer viewer) and 4
(feedback) are independent of the rest.

1. [x] Item 3: settings scroll / narrow layout (`928afc0`).
2. [ ] **Job inputs foundation (items 5, 7)**: `job_models` table (several
   model files per job, `ON DELETE CASCADE`), `jobs.inputs_json` (machine,
   process, filaments, bed type, printer, routing, support choices),
   `jobs.plate_json` (objects: model index + placement, several per model),
   `jobs.proposed_json` (what the page defaulted to, for the change report).
   Always upload models unless the user picks "keep on this device"
   (IndexedDB, **local** tag). Remove `keep_models`. Old jobs keep working.
   Admin report: how often each default is changed, and to what.
3. [ ] **Delete jobs (item 5)**: `DELETE /api/jobs/{id}` (creator, group
   manager, admin): cancel if running, refuse while a print needs the
   package, delete slices rows + files. Bulk delete on the Jobs page.
4. [ ] **Re-slice (item 5)**: `/slice?from=<job>` loads the job's models,
   plate and inputs into the Slice page; slicing makes a new job.
5. [ ] **Supports section (items 1, 6, 8)**: a dedicated Supports block on
   the Slice page (not buried in Quick Settings): on by default, type,
   base/interface filament; the viewer highlights overhangs (threshold from
   the config) and floating islands; slicer support warnings shown
   prominently after slicing.
6. [ ] **Multi-filament configs (item 6)**: `resolve_config` takes a filament
   list and builds per-filament vectors like `PresetBundle::full_config`
   (including H2D extruder variants, `filament_self_index`, `filament_map`);
   `support_filament` / `support_interface_filament`; AMS mapping matches
   support filaments ("PLA-S") and, on H2D, the nozzle each AMS feeds.
7. [ ] **Several parts per plate (item 7)**: viewer with N parts (select,
   add file, duplicate, fill plate, delete, arrange, overlap check);
   slice_core takes model inputs with per-instance placements; cxx and wasm
   bridges; server multipart with several models.
8. [ ] **Layer viewer (item 2)**: `GET /api/jobs/{id}/gcode`; a worker parses
   G-code into per-layer typed arrays (feature types from `;TYPE:`,
   widths/heights from `;WIDTH:`/`;HEIGHT:`); three.js preview with a layer
   slider, feature colours/legend, travel toggle. Shown in a job page
   (`/jobs/:id`) and on the Slice page after slicing.
9. [x] **Feedback (item 4)** (built on its own branch; see
   `plans/feedback.md`): `feedback` table + API; a Feedback button on
   every page (category, message, optional context); automatic reports of
   `window.onerror`, unhandled rejections, `console.error` (wrapped, never
   suppressed), React render errors and failed API calls, deduplicated by
   fingerprint with counts; server-side job failures too; admin triage page.
10. [ ] Tests: e2e per server feature (delete, re-slice inputs, multi-model,
    feedback, gcode endpoint), unit tests (profile vectors, placement list),
    real slices on buildhost (multi-part plate, support filaments on X1C and
    H2D).
11. [ ] Docs: README, CLAUDE.md project structure.

## Findings / gotchas

- Before the fix, `.overrides-panel` measured 2 px tall when expanded
  (content 773 px); after, 775 px, and the settings column scrolls (1794 px in
  832 px).

## Progress log

- [x] Explored jobs/storage, profiles/filaments/AMS, slicer core/viewer.
- [x] Item 3 fixed and checked in the browser (wide and 900x700).

## Open questions for the user

(none open; Q1-Q4 answered, see Decisions)

## Things not to do

- Don't suppress console output when capturing errors for feedback: wrap
  `console.error` and always call the original.
- Don't name real hosts, domains or the deployment's users in this repo
  (it's public).
- Don't put placement or plate layout in `config_json` (libslic3r warns about
  unknown keys; see `plans/part-placement.md`).
