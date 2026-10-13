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

## The G-code check knows only Bambu's G-code: every other make's print needs review

**in progress — gcode-safety thread (master)**

`src/gcode/` reads lines in Bambu's firmware syntax and allows what
OrcaSlicer's and BambuStudio's **BBL** profiles do. Plain G-code (Klipper,
OctoPrint, PrusaLink, SDCP printers) goes through the same check with
`Declared::other_firmware` set: a line the lexer can't read needs review
instead of blocking. So every non-Bambu print by a member waits for an
admin, and admins tick the acknowledgement on every send. FarmSlicer's own
slices for a Voron 2.4, Prusa MK4S and Centauri Carbon (2026-10-13) all came
out `review`: `unknown_model` ("is for printer model Voron 2.4 350, which
FarmSlicer has no data for"), `unreadable` for Klipper commands
(`PRINT_START EXTRUDER=220 BED=35`, `SET_VELOCITY_LIMIT`,
`EXCLUDE_OBJECT_DEFINE`), Prusa's `M862.3 P "MK4S"` and `M115 U6.1.3+7898`,
and `unknown_command` for `M862.1`, `M555`, `M84`, `M729`, ...

Lexing every non-BBL vendor template in OrcaSlicer v2.4.2's profiles with
the current lexer: 58 of 64 vendors have unreadable lines (~4,700 of
38,637): ~4,000 Klipper extended commands (`NAME KEY=VALUE`), ~260 bare
macros (`TIMELAPSE_TAKE_FRAME`, `MOVE_TO_TRASH`), ~275 free-text or quoted
arguments (`M117 Homing`, `M862.3 P "MK4S"`, RepRapFirmware `M98
P"start_print.g"`), 59 version strings (`M115 U6.1.3+7898`), a few
lowercase words (`G1 E-5 f2000`).

Why it matters: it fails safe, but makes the non-Bambu drivers
(`plans/printer-drivers.md`) a chore to use. The fix: firmware dialects in
the lexer (Klipper extended commands, quoted/text arguments, Marlin/Prusa
`M117`/`M115`), and harvesting the other vendors' profiles too (models keyed
by `printer_model`, envelopes from their bed shapes); see
`plans/gcode-safety.md`.
