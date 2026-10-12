# Auth & Permissions System

`plans/auth.md`

## Goal

Replace the single shared `ADMIN_PASSPHRASE` with accounts managed at runtime:
first-run owner registration, admins, users, per-user API keys for scripts and
other machines. Done 2026-10-12 (v1); teams/guest scoping are not implemented.

## What exists (v1, 2026-10-12)

- `src/auth.rs`: argon2id password hashes, 256-bit session tokens in the
  `fs_session` cookie (30 days; the database stores only the SHA-256), API keys
  `fsk_…` (SHA-256 stored, prefix kept for display) accepted as
  `Authorization: Bearer`, roles `owner` / `admin` / `user`,
  `FARMSLICER_NO_AUTH=1` escape hatch for local development.
- Tables `users`, `sessions`, `api_keys` (`src/db.rs`); `jobs.user_id` records
  who created a job (not yet used for filtering).
- Endpoints: public `GET /api/auth/status`, `POST /api/auth/setup` (only while
  no users exist), `POST /api/auth/login`, `POST /api/auth/logout`; protected
  `GET /api/me`, `POST /api/me/password`, `GET/POST /api/me/api-keys`,
  `DELETE /api/me/api-keys/{id}`; admin `GET/POST /api/users`,
  `PUT/DELETE /api/users/{id}` (admins cannot modify the owner; the owner
  cannot be deleted; nobody can delete themselves).
- Frontend: `web/src/auth.tsx` (context), pages `Setup`, `Login`, `Users`
  (admin), `Account` (password + API keys); the sidebar shows the user and a
  Log out button.

## Decisions already made (don't re-ask)

- Cookie sessions with server-side storage, not JWT. No OAuth/SSO.
- First-run setup is open to whoever reaches the service first (it is LAN-only
  behind Caddy); the server log says so at startup. Deploy, then create the
  owner right away.
- Every authenticated user can see all jobs/slices/printers for now; only user
  management is role-gated. Guest teams (the original design's team-scoped
  visibility) are deferred until there is a need.

## Next: passkeys + HTTPS for admin access (asked 2026-10-12)

Direction from the maintainer: secure admin access with **passkeys** (WebAuthn)
on an **HTTPS domain** rather than passwords alone.

- WebAuthn requires a secure context and a stable RP ID = the domain the UI is
  served on. The LAN deployment is already HTTPS behind the reverse proxy, so
  the RP ID would be that hostname; `localhost` works for dev. Plain-http LAN
  access would not support passkeys (the server could refuse admin actions
  over http, or redirect).
- Candidate implementation: `webauthn-rs` on the server (registration +
  authentication ceremonies, challenge state in the DB or a short-lived table),
  `navigator.credentials` on the client; `passkeys` table (user_id, credential
  id, public key, sign count, name, created_at).
- Policy sketch: any account may add passkeys on the Account page; admins and
  the owner must have at least one passkey, and admin actions (Users page,
  printer management) require a session that was authenticated with a passkey
  (step-up); password stays as the fallback for non-admin users and for
  recovery with a one-time code printed in the server log.
- Open: whether to drop passwords entirely for admins once a passkey exists;
  whether API keys should be scoped (read-only vs slice vs admin).

## Open questions

1. Should `user` accounts be allowed to add/delete printers? Today: yes
   (only the Users page is admin-only). Tighten if the farm gets guests.
2. Team scoping (see original design below) when non-household users appear.
3. Passkey policy details above (step-up only for admin actions, or always?).

## Original design notes (kept for the team feature)

Guests would belong to teams; everyone in a team sees each other's files;
admins see everything. Schema sketch: `users.team` nullable, jobs/slices filtered
by the team of their `user_id`. Self-registration vs admin-created guests was
never decided.
