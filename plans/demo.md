# Public demo at demo.farmslicer.com

`plans/demo.md`

## Goal

A FarmSlicer anyone can try from farmslicer.com's "Try the demo" button,
without installing anything or owning a printer: slice a model (in the
browser or on the server), send it to a printer, watch it print, record how
it came out. Asked by the maintainer on 2026-10-26, with the project site.

## Environment / context

- The project site is a separate repo, `farmslicer.com` (Cloudflare Pages,
  configured in the ops repo). Its demo button turns on with
  `SITE.demoLive` in `app/site.ts`.
- FarmSlicer accounts are passkey-only, but the join flow already makes
  **guest accounts**: a join link on a group with `allow_guests` and an open
  `join_policy` gives each visitor a guest with the group's quotas, no
  passkey (`src/join_api.rs`). Guests can't manage printers, profiles, API
  keys or groups (`auth::require_full`).
- `tests/fake-{moonraker,octoprint,prusalink,sdcp}/` are Node fake printers
  that accept uploads and "print" in a few seconds; `tests/fake-printer/` is
  a Docker fake Bambu printer (MQTT + FTPS).
- The deployment itself (stack, host, proxy or tunnel, DNS) lives in the
  ops repo; every infrastructure change needs the maintainer's per-change OK.

## Design (proposed; nothing built yet)

1. **Its own instance**, its own data volume, never sharing a database or
   network with a real farm. **Bridge networking, not host**: with host
   networking, discovery would find whatever real printers share the
   host's LAN, and anyone on the internet could then print on them.
2. **Fake printers as sidecars** in the same stack: a Klipper, an OctoPrint,
   a PrusaLink, an Elegoo and the fake Bambu printer, added by address at
   seed time. Prints take seconds; cameras show nothing (or a test image).
3. **Visitors are guests**: the seed creates a "Demo" group (guests allowed,
   open), with quotas (slices per day, upload size) and print rules, and
   the landing page links straight to its join link. No passkey needed; a
   visitor who wants one can add it.
4. **Slicing mostly in the browser**: the demo's default compute is the
   browser (the server slices one job at a time for everyone); the server
   path stays available within the quotas.
5. **Reset on a schedule** (nightly): stop, wipe the volume, re-seed. Uploads
   are anyone's files, so nothing lives long. The page says so.
6. **Seed script** (in this repo, e.g. `demo/seed.mjs`, built on
   `tests/lib.mjs`): set up the owner with a software passkey kept only in
   the stack's secret storage, then the group, quotas, join link, printers,
   a sample project and a few finished prints so pages aren't empty.
7. **A "Source code" link in the app first** (blocker): AGPL §13 says an
   instance people use over a network must offer them its source. Link
   the exact commit the build came from (`web/src/build.ts`), with the URL
   configurable so a modified deployment points at its own source. See
   `plans/monetization-and-licensing.md`.
8. **Hardening checks** before going public: setup is done before the
   first request from outside; no notifications to strangers' devices
   beyond their own; upload limits; the feedback inbox doesn't fill with
   noise (maybe its own label); the G-code check stays strict.

## Open questions for the user

1. Where does it run: a stack on buildhost behind the existing proxy or a
   tunnel, or a small separate VPS? (Recommendation: a separate small VPS,
   so a public, anonymous service shares nothing with the farm's LAN.)
2. Which fake printers to show? (Recommendation: one of each protocol.)
3. Reset nightly, or more often?

## Progress log

- [x] Plan written (2026-10-26)
- [ ] Questions answered
- [x] "Source code" link in the app (AGPL §13): sidebar + sign-in pages, `FARMSLICER_SOURCE_URL`
- [ ] Seed script + demo compose file (in this repo, generic)
- [ ] Ops stack (staged for approval)
- [ ] DNS for demo.farmslicer.com (staged for approval)
- [ ] Turn on `SITE.demoLive` on the site

## Things not to do

- Don't run the demo with host networking or on a network with real
  printers.
- Don't put the demo's owner credential in this repo.
