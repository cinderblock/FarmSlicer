# Mobile support

## Goal

The maintainer's feedback report (2026-10-17, from an iPhone, viewport
402x684): "Mobile needs much better support". The web UI was built for
desktop: `web/src/index.css` (~3000 lines) has two `max-width: 1000px`
queries (Slice layout, G-code preview) and nothing else. Make every page
usable on a phone (~360-430 px wide, touch, no hover), without making the
desktop layout worse.

## Environment / context

- Audit server: the stub server (`FARMSLICER_SKIP_CXX=1`,
  `FARMSLICER_NO_AUTH=1`) built from committed `HEAD` on buildhost in
  `~/farmslicer-mobile` (target `~/farmslicer-mobile-target`, seeded from
  `~/farmslicer-feedback-target`), fresh data dir, port 9346, reached through
  `ssh -L 9346:127.0.0.1:9346 buildhost`. `dist/web` built locally and
  copied over.
- Browser: T3 preview tab, `preview_resize` preset `iphone-12-pro`
  (390x844) and freeform 402x684 (the reporter's viewport). Desktop user
  agent: hover/touch media features are those of the desktop browser.
- Another thread is working on master in the same tree (nozzle choice:
  `src/*.rs`, `cxx/`): stage only this work's files.

## Decisions already made (don't re-ask)

- Phone support covers every page; nothing is hidden on mobile.

## Plan / steps

1. [x] Audit each page at 360/402 px; list what breaks (below).
2. [x] App shell: sidebar → top bar + drawer below 800 px (`8a12ca7`).
3. [x] Page-by-page fixes (`8a12ca7`, `41bcf2f`, `aa8673f`, `bbccdc6`):
   list tables as cards, Printers order, Slice viewer, preview overflow,
   tab rows, small tables, dialogs, sign-in pages.
4. [x] Touch: tap-to-select before dragging a part, touch hints, 16 px
   fields, finger-sized buttons (`41bcf2f`). The G-code preview's layer
   slider already handled touch (`touch-action: none`, pointer capture).
5. [x] Verified at 360, 402, 768 and 1280 px; tsc, build, eslint (touched
   files), web tests (35 pass).
6. [x] Docs: README "On a phone", CLAUDE.md conventions.
7. [ ] **Try it on a real phone** (the maintainer; live since 2026-10-17):
   everything above was checked in a desktop browser at phone sizes, which
   reports a mouse, so the touch-only parts are unverified on hardware.

## Findings / gotchas

- The audit server's SSDP discovery sees the real farm's Bambu printers on
  the LAN ("Detected on Network"): never press "Add to Farm" there.
- Seed data: `~/farmslicer-mobile-run/seed.mjs` (uploads G-code jobs, a
  failed server job, a queued browser job, feedback, users, groups) and
  `seed2.mjs` (a Prusa MK3S job sent to the OctoPrint fake: a printing
  print). Uploads must name a `printer_model` the target printer matches.
- Fakes: Moonraker :9350 (outside print running), OctoPrint :9351, PrusaLink
  :9352. `vite dev --port 5199` locally proxies `/api` to local :9337, which
  is an ssh tunnel to the audit server (:9346).
- Git Bash `sed -i` rewrites CRLF files as LF: use Python with
  `newline=''` for edits to CRLF files (`web/index.html`).
- Another thread edits `web/src/index.css`, `Slice.tsx`, `Job.tsx`,
  `Printers.tsx` concurrently (nozzle plan): stage by hunk
  (`git diff file > p; edit p; git apply --cached --recount p`).
- The Jobs table is wider than a 1280 px desktop window too (actions cut
  off); pre-existing.

## Audit

At 402x684 before any change: the sidebar took 220 px of 402 on every page.
After the shell fix, a scripted sweep (elements past the right edge):
Jobs 1113 px, Users 905, Prints 902, Library 804, Settings 446 wide (all
`data-table`); the rest fit. Also seen: Jobs' upload button squeezed to four
lines by its hint; `btn-sm` is 26 px tall (touch targets); inputs below
16 px make iOS zoom on focus.

## What changed (for review on a phone)

- Menu button top left; the drawer closes on navigation, the backdrop or
  Escape; the admin feedback count shows on the button.
- Jobs, Prints, Library, Users: one card per row.
- Printers: the farm's printers first, "Detected on Network" after.
- Slice: tap a part to select it (one finger otherwise turns the view, two
  pan/zoom), then drag it; toolbars scroll sideways; position/rotation
  fields fit; no shortcut-key chips on touch screens.
- Fields never under 16 px (no iOS zoom on focus); small buttons 36 px.
- Bugs found on the way, also on narrow desktop windows: the G-code
  preview spilled over the next section (job page, Slice Preview tab;
  `aa8673f`); card headings had an empty band on top (`257719b`); the
  Profiles manufacturer search was unstyled (`ab0f68e`).

## Progress log

- [x] Shell and cards (`8a12ca7`)
- [x] Card heading margin (`257719b`), preview overflow (`aa8673f`)
- [x] Touch targets, Printers order, Slice viewer (`41bcf2f`)
- [x] Profiles filters (`ab0f68e`)
- [x] Tabs, small tables, dialogs, sign-in pages (`bbccdc6`)
- [x] Deployed: FarmSlicer `3adb338` on sentinel 2026-10-17 (ops `1d4eb49`),
  with the error-report fix (`46bf0d7`) and pages' `Cache-Control:
  no-cache, no-transform` (`e8f7403`): through Cloudflare the page no
  longer carries the analytics beacon. Excluding the host on Cloudflare's
  side failed (one Web Analytics rule per site on this account).
- [ ] Real-phone check (step 7)

## Open questions for the user

None.

## Things not to do

- Don't filter console output (user rule).
- Don't touch the production container or ports 9337/9338 on buildhost.
- Don't make the Slice viewer full-height on phones: the canvas takes
  every swipe (`touch-action: none`), so the page needs a strip outside
  it to scroll by.
- Don't use Python text mode to pipe patches to git on Windows (it writes
  CRLF): `/tmp/stage_hunks.py` sends bytes.
