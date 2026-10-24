# Slice history in the browser, and comparing slices

## Goal

The user's request (2026-10-24): "store the last N slices in browser.
Changing one setting back and forth to compare slices shouldn't force a full
recompute every time. The slicer visualizer should even have a 'diff' view
for quickly comparing slices."

So, on the Slice page:

1. **Remember** the last N slices in this browser (which job, what it was
   made from, its G-code), across reloads.
2. **Don't slice again** what was already sliced: when the settings, models
   and plates match a remembered slice, Slice shows that one at once (no new
   job, no engine run, no download).
3. **Compare** two slices in the preview: what settings differ, how time,
   filament and layers changed (per feature too), and the toolpaths side by
   side or overlaid, synchronised by height.

## Environment / context

- Code map: `CLAUDE.md`. Web: `web/src/pages/Slice.tsx` (the page; `sliced`
  state + `SliceResult`), `web/src/components/SliceResult.tsx` (Preview tab),
  `web/src/components/preview/` (G-code preview: `GcodePreview.tsx`,
  `load.ts` + `worker.ts` + `parser.ts`, `scene.ts` `Toolpaths`, `colors.ts`).
- Every slice is a server job (server slices and browser slices alike:
  `POST /api/jobs`). A job's G-code never changes (re-slicing makes a new
  job), so a job id is a stable cache handle. `GET /api/jobs/{id}` returns
  `config_json`, `inputs`, status, stats, `package_json`.
- Models kept in the browser already use IndexedDB (`web/src/localModels.ts`,
  DB `farmslicer` v1). The slice cache gets its own DB so neither has to
  version-bump the other.

## Decisions already made (don't re-ask)

Chosen by me (the user asked for the feature, not these details); revisit
only if the user objects:

- **What counts as "the same slice"**: a SHA-256 of everything the job form
  sends that can change the result: machine, process, filaments, bed type,
  colour, overrides (Quick Settings + Supports), printer, routing, group
  (thumbnail label/logo), the plates (placements), the models (by SHA-256),
  plus the resolved part-filament profile (catches an edited custom profile)
  and, on dual-nozzle printers, the nozzle plan (the AMS can change it). The
  project is not in the key but must match too (a remembered job counts for
  the project it was made for); the "new project" choice becomes the created
  project's id, so the next match works.
- **A hit reuses the job** (no new server job). If the job is gone (deleted)
  or failed/cancelled, the entry is dropped and the page slices as usual. A
  "Slice again anyway" link forces a fresh slice.
- **Storage**: IndexedDB `farmslicer-slices`: `slices` (entries) and `gcode`
  (Blob per job + plate). Limits default to 10 slices and 1 GB of G-code,
  least recently used evicted; both adjustable in the history panel
  (localStorage). Browser slices store plate 1's G-code at once; any plate
  read from the server is kept as it is read (the parse worker hands the
  bytes back), so a second look never downloads again.
- **Parsed G-code is kept in memory** too (a small LRU by bytes), so
  switching between two slices, or A/B in the compare view, doesn't parse
  again.
- **Compare view** (Preview tab, "Compare with…"): settings diff (the two
  jobs' merged configs, schema labels first), totals and per-feature time
  deltas, and the toolpaths: **Side by side** (two views, one camera, one
  height slider) or **Overlay** (both in one view: A grey, B blue, B drawn
  second; identical paths draw identical triangles, so A's grey wins the
  depth test where both have the same path and B's blue shows only where B
  differs; Swap flips roles). Heights are matched by Z, not layer index
  (layer height is a common thing to compare).

## Plan / steps

1. [x] Pure helpers + unit tests (`web/src/sliceHistory.ts`,
   `web/test/slice-history.test.ts`): canonical key input, eviction, inputs
   diff (history labels), config diff, Z → layer.
2. [x] IndexedDB store (`web/src/sliceCache.ts`): entries, G-code blobs,
   limits, eviction, change notices (BroadcastChannel across tabs).
3. [x] Parse worker keeps the bytes on request (`keep`); parsed-file memory
   in `load.ts` (640 MB, the two newest always); `preview/useGcode.ts`;
   `GcodePreview` takes `cacheKey` + `onBytes`.
4. [x] Slice page: key, "Show slice" on a match, record new slices,
   "Slice again anyway".
5. [x] SliceResult: history panel, plate G-code via `components/sliceGcode.ts`
   (memory → cache → URL, keeping the bytes), stats recorded when done,
   failed/cancelled slices forgotten.
6. [x] Compare view (`preview/SliceCompare.tsx`): numbers, settings diff,
   overlay (differences / A / B), side by side with a linked camera, swap.
7. [x] Browser check with real slices, README + CLAUDE.md.

## Findings / gotchas

- Verified 2026-10-24 12:40–1:00 PM PDT (19:40–20:00Z) against a throwaway
  container of the deployed image (no auth, its own data, removed after)
  through `vite dev`, in headless Chrome (Playwright) at 1400×900 and
  390×844: slice at 0.20 mm Standard, then Strength, then back to Standard
  → the button reads "Show slice", clicking it shows the first job (no new
  job: the server's job count stayed the same), compare ready in ~0.8–1.2 s
  from the cache, reload keeps the list and switching slices downloads no
  G-code. Overlay of Standard vs Strength at the same height: outer walls
  grey (identical), the inside amber/blue (6 vs 2 walls, 25% vs 15% infill),
  so the equal-depth trick holds in practice (ANGLE D3D11, Intel UHD).
- Different layer heights never coincide: the overlay is all amber/blue
  stripes there, as it should be; side by side reads better for that.
- `THREE.WebGLRenderer: Context Lost.` in the console on every view change
  is react-three-fiber disposing an unmounted canvas (forceContextLoss), not
  a leak.
- The T3 preview browser disconnected repeatedly during the check (host
  side; the page stayed responsive); Playwright was used instead.
- Another thread (plans/updates-and-whats-new.md) moved the `farmslicer`
  IndexedDB into `web/src/idb.ts` (v2, `drafts`) and saves the Slice page's
  draft, including the slice on screen; the separate `farmslicer-slices`
  DB keeps the two independent. Its draft restores the slice's job id, and
  the cache then supplies its G-code without a download.

## Progress log

- [x] Steps 1–7 above.
- [ ] Possible follow-ups (not asked for): keep the compared slice in the
  page's draft (that thread owns `SliceSettings`); compare any two jobs
  from the Jobs/Job pages (SliceCompare only needs job ids); a per-layer
  time chart for the two slices.

## Open questions for the user

1. Defaults: 10 slices / 1 GB of G-code. Recommendation: keep; both are
   adjustable in the panel.

## Things not to do

- Don't bump `farmslicer` IndexedDB's version from here (localModels.ts owns
  it); the slice cache has its own DB.
- Don't key the cache on the server's `config_json`: it only exists after a
  job is created, which is what a hit must avoid.
