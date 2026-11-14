# Sliced view everywhere, live with the printer

## Goal

Wherever the app shows a sliced plate (a job, a print, a queue entry, a
project's plate, a printer's current print), one click opens its G-code
preview at that plate. A print that is running opens the preview following
the printer: everything printed so far, the current layer, and as much
progress inside the layer as the printer tells us.

Asked for on 2026-11-13: "being able to jump to the sliced view from any
model. ideally even live synced to a printer as much as possible/reasonable.
per layer would be great. more granularity wouldn't be bad... should also be
able to get to sliced versions from jobs... and prints".

## Environment / context

- The preview is `web/src/components/preview/GcodePreview.tsx` (plan:
  `plans/gcode-preview.md`); the job page `/jobs/:id` (`pages/Job.tsx`) is
  the only full-page host today, with plate tabs held in component state.
- Printer statuses reach the browser through `GET /api/printers/events`
  (SSE) and `/api/printers/status`. `PrinterStatus.layer` /
  `total_layers` come from Bambu (`layer_num`), Moonraker
  (`print_stats.info`) and SDCP (`CurrentLayer`); OctoPrint and PrusaLink
  give only a percentage.
- What a printer is sent is the plate's G-code byte for byte
  (`package::plate_gcode`), the same bytes `GET /api/jobs/{id}/gcode?plate=N`
  serves, so a printer's file position maps straight onto the preview's file.

## Decisions already made (don't re-ask)

- "From any model" read as: every place that shows a sliced plate (name or
  thumbnail) links to its preview. Plain model files (Library downloads, the
  Slice page's unsliced plate) are not sliced views. Revisit if the user
  meant something else.
- Deep links: `/jobs/:id?plate=N&layer=K` (1-based, as the UI shows them).
- A running print gets its own page, `/prints/:id`: the preview following
  the printer, with the printer's status, camera and controls beside it.
  The job page links to it while the job prints.

## Plan / steps

1. **Links** (done)
   - Job page: plate and layer in the URL (`?plate=&layer=`), kept in sync.
   - `GcodePreview`: `initialLayer` prop.
   - Prints rows, printer cards (current print), queue entries, project
     plates, Jobs thumbnails, Library seasons: link to the job's plate.
2. **Live by layer** (done)
   - `/prints/:id` page; print record + its printer's status over SSE.
   - `GcodePreview` `live` prop: shows layers up to the printer's, the
     current one partly; dragging the slider leaves live mode, "Back to
     live" returns. Layers above dimmed/ghosted as "still to print".
   - Map printer layers to parsed layers (check `total_layers` against the
     file's count; say so when they differ).
   - Percent-only printers (OctoPrint, PrusaLink): position from the
     percentage (OctoPrint's is by file bytes → phase 3 makes it exact).
3. **Finer than a layer** (current step)
   - `PrinterStatus.file_position` (bytes): Moonraker
     `virtual_sdcard.file_position`, OctoPrint `progress.filepos`.
   - Parser: byte offset per layer start and a line/byte per extrusion
     segment (or per-layer line index) to turn a byte position into a
     segment index.
   - Bambu and SDCP (layer only): estimate inside the layer from the time
     since the layer changed and the layer's move times; shown as an
     estimate.
4. Docs (README, CLAUDE.md), changelog entry, e2e where server changes.

## Findings / gotchas

- Browser check setup (2026-11-13): stub server from this tree on the build
  host (`~/farmslicer-live`, target `~/farmslicer-live-target` seeded from
  the spool thread's), run dir `~/farmslicer-live-run` (PIDs in
  `server.pid`, `fake.pid`), `FARMSLICER_NO_AUTH=1` on 127.0.0.1:9351, the
  Moonraker fake on :9352 (`--print-seconds 900`), sample
  `~/fs-preview-samples/mushroom-voron.gcode` uploaded and sent. Locally:
  `ssh -L 9351`, `FARMSLICER_DEV_API=http://localhost:9351 bunx vite --port
  5181`, Playwright scripts in the session scratchpad (headless Chrome,
  ANGLE D3D11). Dismiss What's new (Escape) before clicking.
- `react-hooks` lint forbids syncing the followed layer into state in an
  effect: the view derives `range`/`upTo` from the live position while
  following, and copies them into its own state when the viewer takes over.

- Parsed layers put the start sequence into layer 1, like the desktop
  slicers; Bambu's `layer_num` is 0 during the start sequence.

## Progress log

- [x] 1. Links: jobs, prints, printer cards, queue, projects, library;
  `?plate=&layer=` on `/jobs/:id` (verified in headless Chrome: opens at
  the layer, URL follows the slider)
- [x] 2. Live by layer: `/prints/:id`, `GcodePreview` `live` prop,
  `preview/live.ts` (unit tests in `web/test/preview-live.test.ts`); the
  Moonraker fake reports `current_layer`/`total_layer`. Verified against the
  fake with a real Voron file: follows layer and move, leaves follow mode on
  slider/keys, "Follow the printer" returns
- [ ] 3. Finer than a layer
- [ ] 4. Docs, changelog, tests

## Open questions for the user

1. Is "any model" the sliced plates listed above, or did you also mean the
   Slice page / model files (e.g. slicing a library model on demand to
   preview it)? Recommendation: sliced plates only, for now.

## Things not to do

- Don't restructure `pages/Slice.tsx` for this.
