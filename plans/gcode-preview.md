# G-code preview (layer viewer)

Step 8 of `plans/slicer-workflow.md` (item 2, "Layer viewer").

## Goal

After slicing, users see the G-code layer by layer, like Bambu Studio's /
OrcaSlicer's Preview: feature colours, a layer range slider, a move scrubber,
travel moves, times and filament per tool. Old jobs get the same preview on a
job page (`/jobs/:id`). The Slice page will embed the same component later
(another thread), with G-code it already holds in memory.

## Environment / context

- Branch `gcode-preview` (worktree `.claude/worktrees/agent-ac857d2a38cf7aa17`),
  replayed onto master `130413a` (job history, plates, re-slice, feedback)
  once those landed.
- Rust checks run on buildhost: sources in `~/farmslicer-preview`, target dir
  `~/farmslicer-preview-target` (seeded from the placement target). e2e on a
  free port (9346 here) with `PATH=$HOME/.cargo/bin:$PATH`.
- Real G-code: a throwaway container of the production image on
  `127.0.0.1:9345` (`fs-preview-test`, removed afterwards); samples and the
  STL generator in `~/fs-preview-samples` on buildhost (cube on an A1 mini,
  a mushroom with and without supports on an X1C, on a Voron 2.4 and an
  MK4S, a 140 mm sphere at 0.12 mm (86 MB) and 0.08 mm (291 MB) on an X1C).
- Browser check: stub server on buildhost `127.0.0.1:9344` (scratch dir
  `~/fs-preview-run`) with the samples uploaded, tunnelled to local `9348`;
  `bunx vite --port 5176` with a temporary config under
  `web/node_modules/.preview/` proxying `/api` there; Playwright
  (`playwright-core`, installed Chrome, headless, real Intel UHD GPU via
  ANGLE D3D11) from a scratch dir.

## Decisions already made (don't re-ask)

- Job page fetches `GET /api/jobs/{id}` (master's handler). The temporary
  stand-in commit was dropped when the branch moved onto master, which has
  it; the page names profiles from its `inputs` and offers Re-slice.
- `GET /api/jobs/{id}/gcode` is ours: `src/preview_api.rs`, one `.merge` line
  in `src/server.rs`; `prints_api::visible_job` made `pub(crate)` instead of a
  third copy.
- Don't restructure `web/src/pages/Slice.tsx`; Jobs.tsx only links the model
  name to the job page.

## Component API (for the Slice page)

```tsx
import GcodePreview from "../components/preview/GcodePreview";
<GcodePreview
  source={{ data: output.gcode }}   // Uint8Array / ArrayBuffer / string / Blob; or { url }
  bed={bed}                          // BedShape from the resolved profile (fallback when
                                     // the G-code has no printable_area)
  filamentColors={["#f2754e"]}       // optional, by slot, when the header has none
  onLoaded={(info) => ...}           // optional: GcodeInfo (times, filament, layers)
/>
```

The source is keyed by the URL string or the data object's identity: pass
the same object to avoid reloading. The caller's bytes are copied into a
Blob, never detached. Size the parent (the component fills it; min 480 px).
`loadGcode(source, { onProgress, signal })` (load.ts) is the same parse
without the UI.

## Plan / steps

1. [x] Real samples from the production image.
2. [x] Server endpoint + e2e test (`9114169`).
3. [x] Parser in a worker + `bun test` unit tests (`38b1a1f`).
4. [x] Renderer + controls (`cb3bd8e`).
5. [x] Job page `/jobs/:id`, link from Jobs (`4728cb6`, `8d71c0f`).
6. [x] Browser check with real files, performance numbers.
7. [x] Docs (README, CLAUDE.md), plan updates.

## Findings / gotchas

- OrcaSlicer's Bambu-flavour G-code uses `; CHANGE_LAYER`, `; Z_HEIGHT:`,
  `; LAYER_HEIGHT:`, `; FEATURE:`, `; LINE_WIDTH:` and puts the config block
  at the start; its generic flavour (Voron, Prusa) uses `;LAYER_CHANGE`,
  `;Z:`, `;HEIGHT:`, `;TYPE:`, `;WIDTH:` and puts the config at the end.
  Width comments are only written when the width changes (not on every
  `;TYPE:`), so the width in force carries over; custom G-code (start
  sequence, purges) gets widths estimated from E.
- No `; LAYER_TIME` in OrcaSlicer 2.4.2 output; M73 R is in whole minutes.
  Times are a kinematic estimate scaled to the header's total
  (`total estimated time` / `estimated printing time (normal mode)`); Cura's
  `;TIME_ELAPSED:` gives exact layer times.
- Arc fitting multiplies segments: the 86 MB sphere has 1.46 M `G2/G3`
  (gyroid infill, radius 1-5 mm). A 0.01 mm chord tolerance gave 8.7 M
  segments (27 M for 291 MB, 1.7 GB heap in Bun); 0.05 mm (a tenth of a
  line width, invisible) and a point chain instead of start+end pairs gave
  4.9 M / 17.2 M segments, 153 MB / 512 MB heap.
- Parse speed: Bun 2.5 s (86 MB) / 8.0 s (291 MB); Chrome worker incl.
  download through the gzip passthrough: 2.0-2.3 s / 8.0 s.
- Rendering on integrated graphics (Intel UHD, headless Chrome, ANGLE
  D3D11), continuous rendering: small files ~53 fps (vsync-ish); 4.9 M
  segments as beads 3-4 fps, 9 fps with half the layers; as lines 17-20
  fps; 17.2 M segments as lines 6-7 fps. The cost is the vertex shader per
  bead vertex, not triangles or pixels: resolution made no difference, and
  camera-facing ribbons (4 vertices, 2 triangles) were no faster and
  z-fought on flat tops, so they were dropped. Hence: lines stand in for
  beads while the camera moves above 1 M segments; above 6 M only lines.
  The canvas renders on demand, so a still view costs nothing.
- three r184 GLSL3 ShaderMaterial no longer defines `gl_FragColor`:
  declare `out highp vec4`.
- WebGL line strips with `flat` varyings take the last vertex's value
  (checked in Chrome/ANGLE D3D11): the line renderer relies on it to colour
  and hide each segment from the point chain without duplicating vertices.
- The page's only console error is `/favicon.ico` 404 (pre-existing).

## Progress log

- [x] Endpoint, e2e (33 checks), cargo unit tests.
- [x] Parser + 18 unit tests (`bun test`).
- [x] Renderer, sliders, legend, summary; job page.
- [x] Checked in Chrome on all samples: bed alignment (A1 mini 180 mm,
  X1C 256 mm, Voron 350 mm, MK4S 250x210), supports, travel/retractions,
  colour modes, feature hiding, lines, narrow layout, missing job, in-memory
  sources (text, bytes, view, Blob) and abort.
- [x] Full `cargo test` (126 passed, 1 ignored) and all 13 e2e suites
  (exit 0) on the branch replayed onto master; the browser checks re-run
  there too.

## Open questions for the user

(none)

## Things not to do

- Don't write the build box's real name, IPs or domain into the repo.
- Don't touch the `farmslicer` container or ports 9337/9338 on buildhost.
- Don't tighten the arc tolerance again without measuring memory on the
  291 MB sample.
