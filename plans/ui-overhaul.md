# UI overhaul

## Goal

Make the web app look and work like a polished product ("11/10"), across
every page: a real design system (tokens, components), better navigation,
clearer page layouts, richer printer cards, good empty states, light and
dark themes, and keyboard-driven navigation. Asked for 2026-11-13 with
"go ham, boil the ocean": broad scope is wanted.

## Environment / context

- Dev backend: a throwaway container `farmslicer-uidev` on buildhost,
  `127.0.0.1:9338` (latest production image, `FARMSLICER_NO_AUTH=1`,
  volume `farmslicer-uidev-data`). Never touch the production container.
- Fake printers for it run on buildhost from `~/farmslicer-uidev`
  (`fakes.mjs`, pid in `fakes.pid`): two Moonraker (17125, 17126),
  OctoPrint (17080), PrusaLink (17081), bound to the docker bridge
  gateway so the container reaches them. A Bambu printer with no fake
  shows the "not connected" state.
- Local: `ssh -N -L 9338:127.0.0.1:9338 buildhost`, then
  `FARMSLICER_DEV_API=http://localhost:9338 bun run dev` in `web/`
  (the env var is new in this work).
- Screenshots: headless Playwright (scratch script, desktop 1440×900 and
  phone 390×844), never a visible browser.

## Decisions already made (don't re-ask)

- Broad scope is wanted; work in committed phases.
- No external fonts or CDNs: COEP `require-corp` and the offline PWA
  would break them. System font stack, inline SVG icons.
- No new npm dependencies for UI (icons are hand-written SVG paths), so
  THIRD-PARTY-NOTICES stays unchanged.

## Plan / steps

1. Design tokens: palette (dark + light, `prefers-color-scheme` plus a
   manual choice), radii, shadows, spacing, type scale, focus rings;
   replace hard-coded colours in `index.css`.
2. Buttons, inputs, selects, cards, tables, badges, modals restyled on
   the tokens.
3. Sidebar: icons, grouped sections, brand mark, user block; topbar on
   phones.
4. Page header pattern (title, description, actions) used by every page.
5. Printers page: farm summary, status-coloured cards, temperature
   chips, progress, card actions tidied (Remove into Edit/overflow).
6. Empty states with icon + call to action.
7. Command palette (Ctrl/Cmd+K) for navigation and actions.
8. Page-by-page polish: Slice, Jobs, Job, Queue, Prints, Projects,
   Profiles, Library, Groups, Guide, admin pages, Account, sign-in.
9. Changelog entry, README/CLAUDE.md touch-ups.

## Findings / gotchas

- `index.css` is ~4200 lines and already mostly on `--` tokens (86
  hard-coded colours), so a light theme is a token job, not a rewrite.
- The 3D views, camera and their overlays stay dark in both themes: a
  token override on their containers (`.model-viewer`, `.gp-viewport`,
  `.cmp-pane`, `.slice-result-waiting`, `.camera-view`).
- `.page h3` (border, margins) also hits headings inside dialogs and the
  Slice settings card, which live inside `.page`: both now reset it.
- An SVG gradient `id` shared by two copies of the brand mark blanks both
  when one copy is `display: none` (the phone top bar): `useId` per copy.
- Bash heredocs in this harness choke on an apostrophe in the body even
  with a quoted delimiter; write scripts to files instead.
- `waitUntil: "networkidle"` never settles on pages with live SSE (the
  Printers page); screenshots use `load` + a delay.
- Lint: the only errors left are the pre-existing ones in ISSUES.md.
- The bundle is one 1.7 MB chunk (three.js); code-splitting the 3D pages
  would cut first load, but lazy chunks break stale tabs after a deploy
  unless appUpdate.ts handles a failed chunk load. Not done; a candidate.

## Progress log

- [x] 1 tokens + themes (dark refined, light, system/manual choice)
- [x] 2 base components (buttons, inputs, selects, tables, badges,
  modals, progress, segmented control, list toolbar, skeletons)
- [x] 3 sidebar (sections, icons, search, account block, theme toggle;
  phone drawer)
- [x] 4 page headers (PageHeader on every list/settings page)
- [x] 5 printers page (summary filter, state stripe, temp chips, big
  percentage + finish time, icon actions)
- [x] 6 empty states (EmptyState with next steps)
- [x] 7 command palette (Ctrl/Cmd+K, /)
- [x] 8 page polish: Jobs (search, status filter, drop to upload), Queue
  (lanes, next plate picture), Slice (segmented tabs, settings card,
  sticky Slice button), sign-in cards, Account (Appearance), Projects
  (search + switch), Feedback, send dialog, tab titles
- [x] 9 changelog entry, README, CLAUDE.md
- [x] Pushed to origin/master (`396cbe1`, 2026-11-13); dev container,
  its volume and the fake printers removed from buildhost
- [ ] Possible next round: code-splitting (see above), Group page tabs,
  Profiles browser, Integrations and Settings as setting cards

## Open questions for the user

None.

## Things not to do

- Don't restart or kill anything by name on buildhost (production runs
  as the same uid). Stop the dev container by name `farmslicer-uidev`
  only, and the fakes by their pid file.
