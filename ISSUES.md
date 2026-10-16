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

## Models kept in a browser are never removed from it

"Keep the model on this device only" stores browser-sliced models in
IndexedDB (`web/src/localModels.ts`, keyed by SHA-256). Nothing ever deletes
them: deleting the job (Jobs page) leaves the file in that browser. Why it
matters: the store only grows. A model may be shared by several jobs, so a
delete has to check the user's other jobs first (`GET /api/jobs` carries
`local_models`, `GET /api/jobs/{id}` the digests).

## Automatic error reports catch a beacon script that isn't ours

Minutes after the feedback release went live, a user's browser reported
`Error report (app, resource): script failed to load: /beacon.min.js/v4bc70e...`
(server log). FarmSlicer serves no such script: it looks like an analytics
beacon injected in front of the site, and the page's
`Cross-Origin-Embedder-Policy: require-corp` (or a content blocker) stops
it. Why it matters: it will show up as an error for every visitor and bury
real ones on the Feedback page. Decide whether to stop the injection
upstream (proxy/CDN side, not this repo) or have `web/src/errorReporting.ts`
skip resources the app didn't ask for.

