# Issues

Known problems not being worked on right now. Claim one by marking it
`in progress — <thread/branch>` (and committing that) before starting.

## Frontend lint errors (`cd web && bun run lint`)

20 errors + 1 warning from before the groups work, so `bun run lint` exits 1
(CI doesn't run it; `bun run build` passes). By rule:

- `react-hooks/set-state-in-effect`: `auth.tsx:60`, `components/ProfileEditor.tsx`
  (44, 58), `components/SearchSelect.tsx:62`, `pages/Printers.tsx:53`,
  `pages/Profiles.tsx` (59, 109), `pages/Slice.tsx` (328, 383). The pattern
  `useJson(url, rev)` in `web/src/api.ts` is the lint-clean replacement for
  "load() in useEffect".
- `react-hooks/immutability`: `components/ModelViewer.tsx` (124, 129).
- `@typescript-eslint/no-explicit-any`: `components/ModelViewer.tsx`.
- `react-refresh/only-export-components`: `auth.tsx`, `main.tsx`.
- `no-useless-assignment`: `auth.tsx`.
- `react-hooks/exhaustive-deps` (warning): `pages/Slice.tsx:378`.

Why it matters: lint can't gate CI until it is clean, and the
set-state-in-effect cases cause extra renders.

## "Sign in with a passkey" (no username) fails for non-discoverable credentials

Registration (`auth_api::begin_registration` → webauthn-rs
`start_passkey_registration`) sends `residentKey: "discouraged"`. Authenticators
that honour that (hardware security keys; Chromium's virtual authenticator)
store a non-discoverable credential, so the username-less button fails with
"The passkey prompt was cancelled or timed out"; "Sign in with a username
instead" works. Windows Hello / iCloud / Google Password Manager store
discoverable credentials regardless, so most users won't notice. Reproduce:
Playwright + CDP `WebAuthn.addVirtualAuthenticator` (ctap2, internal,
hasResidentKey), register through setup, invite or join, log out, use the
username-less button. Affects setup, invites and the join flow alike.

## Custom profiles have no owner: any full account can edit or delete any of them

`PUT`/`DELETE /api/custom-profiles/{id}` (`src/server.rs`
`update_custom_profile`, `delete_custom_profile`) only call
`auth::require_full`; the `custom_profiles` table has no creator column. Any
full (non-guest) user can rename, rewrite or delete profiles someone else
made, including the farm's tuned ones. Why it matters: the maintainer keeps
the farm's tuned profiles there (plans/printer-control.md).

## The Slice page doesn't show the prime tower

Multi-filament jobs print a prime tower; the Slice page's 3D view
(`web/src/components/viewer/`) doesn't draw it, and Arrange / Fill /
Duplicate don't keep clear of it. On dual-nozzle printers slice_core now
puts it at x 165, y 250 (back, middle; `place_wipe_tower` in
`cxx/slice_core.cpp`), elsewhere at the profile's x 15, y 220. A part
placed there collides with it: libslic3r only warns ("conflict" in the
job's warnings). Why it matters: Fill plate on an H2D with supports in a
support material can put copies where the tower goes. The tower's size
is only known after slicing (`Print::first_layer_wipe_tower_corners`).

## Models kept in a browser are never removed from it

"Keep the model on this device only" stores browser-sliced models in
IndexedDB (`web/src/localModels.ts`, keyed by SHA-256). Nothing ever deletes
them: deleting the job (Jobs page) leaves the file in that browser. Why it
matters: the store only grows. A model may be shared by several jobs, so a
delete has to check the user's other jobs first (`GET /api/jobs` carries
`local_models`, `GET /api/jobs/{id}` the digests).

## The Jobs table is wider than a desktop window

At 1280 px (sidebar shown) the Jobs table (`web/src/pages/Jobs.tsx`) is
~64 px wider than the content area, so the Actions column is cut off and
the content scrolls sideways; narrower desktop windows (800-1300 px) lose
more. Below 800 px it is a card list (`data-table cards`) and fits. Why it
matters: Print / Re-slice / Delete are the cut-off column. Eleven columns;
it needs fewer (combine some) or the card layout up to a wider breakpoint.

## Bambu's X2D filament-change template has uncommented banner lines

Bambu Studio 02.05.03.62 through 02.08.02.61 (`Bambu Lab X2D 0.4 nozzle
template change_filament_gcode`) starts `change_filament_gcode` with
`======== X2D filament_change gcode ==========` without a `;`, and some
template has a bare `========== record data ==========` line (the harvester
logs both: `FARMSLICER_REGEN_GCODE_DATA=1 BAMBUSTUDIO_PROFILES=...`).
02.08.04.57's X2D template has the `;`. A multi-filament X2D plate from
those releases would be blocked as "unreadable" by the G-code check. Why it
matters: Bambu's own G-code must pass; no X2D in the farm yet.

## The G-code check reads a third of a multi-filament H2D project's filament and time

A Bambu Studio H2D project with 7 filaments (one plate, 6 copies,
3.78M lines; uploaded 2026-10-23 5:14 PM PDT (00:14Z), since deleted)
checked clean, but its stats said 110,463 s and 1,027 g where the
package says 443,074 s and 2,351 g; per filament 0.35-0.5x (filament 1:
212.7 g vs 601.2 g). Single-filament X1C uploads read about 0.83x
(25,689 s vs 31,049 s). Why it matters: print rules (`max_minutes`) use
`gcode::effective_time`, and grams feed costs; CLAUDE.md already notes
multi-material H2D files hadn't been through the check.
