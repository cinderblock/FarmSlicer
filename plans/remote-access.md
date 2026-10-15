# Remote access: approved people, passkeys only, from the internet

`plans/remote-access.md`

## Goal

FarmSlicer is LAN-only today. The maintainer wants certain people approved
for access from the internet: they get a single registration link, enrol a
passkey through it, and from then on can sign in from anywhere, with a
passkey only (asked 2026-10-15).

## Environment / context

- Public name `https://farm.tomsawyerlabs.com`: Cloudflare-proxied CNAME to
  the office (ops `cloudflare/config/isozilla/tomsawyerlabs.yaml`, `proxies:`)
  → steamboat's Caddy (ops
  `servers/steamboat/sites.d/farm.tomsawyerlabs.com.caddy`) →
  `http://sentinel.tsl:9337` (ops `servers/sentinel/stacks/farmslicer/`,
  host networking). LAN clients reach steamboat directly (split-horizon DNS).
- Today Caddy answers every request that is neither private nor on-link with
  a flat 403 ("only available on the local network"). `client_ip` honours
  `trusted_proxies` (Cloudflare), so the judgement uses the real client IP.
- The app has no notion of "where a request comes from": every `/api`
  route except health/auth/join goes through `auth::require_auth`, which
  accepts a session cookie or an API key.

## Decisions already made (don't re-ask)

- **Caddy decides LAN vs internet and tells the app in a header**; the app
  enforces policy. Caddy already has the only correct notion of "internal"
  (private ranges + on-link IPv6 /60), so it stays the single source of truth.
- **Fail closed.** The app is configured with the header's name
  (`FARMSLICER_LAN_HEADER`); a request counts as LAN only if that header is
  `1`. Caddy sets it on the internal branch and deletes any client-sent copy
  on the external branch. A missing header (Caddy misconfigured, request
  straight to :9337) means "internet". Unset variable = today's behaviour
  (everything is LAN; Caddy keeps blocking).
- **Per-user flag `remote_access`**, off by default for every account,
  including the owner. Admins toggle it on the Users page and can set it when
  creating an account; only the owner can change the owner's.
- **From the internet only these work:** the SPA's static files,
  `/api/health`, `/api/auth/status`, passkey sign-in (`/api/auth/login/*`),
  `/api/auth/logout`, and invite links of remote-approved accounts
  (`/api/auth/invite/*`). Refused: first-run setup, recovery codes, the
  group join flow (self-service sign-up, guests), guest sign-in codes, and
  API keys.
- **Sessions remember how they were made** (`sessions.method`: `passkey` =
  sign-in, setup, invite or join enrolment; `recovery`; `code` = guest).
  From the internet a session counts only if it was made with a passkey, the
  account is full (not a guest) and approved. Revoking approval takes effect
  on the next request (checked every time). Sessions from before this change
  have no method and must sign in again to be used remotely.
- Once in, a remote user has exactly their normal permissions (groups,
  quotas, print rules all still apply).
- Hardening that comes with internet exposure: cap the in-memory ceremony
  store (unauthenticated callers can create entries), mark the session cookie
  `Secure` when the canonical origin is https, log remote sign-ins with the
  client address.
- **Deploy order matters, both ways** (see the rollout below): Caddy must
  send the header to LAN requests *before* the app is told to look for it
  (else every LAN user counts as remote and is locked out), and the app must
  be live with the header configured *before* Caddy stops answering 403 to
  the internet (else an old app treats the internet as LAN).

## Plan / steps

1. ✅ Investigate ops + auth code (this doc).
2. App: `auth::Network` from the header, `authenticate()` with remote rules,
   `sessions.method`, `users.remote_access`, remote gate on public routes,
   handler checks (login finish, invite), admin API, status fields.
3. Frontend: status `remote`/`remote_refused`, Login hides LAN-only paths,
   Users page toggle + create checkbox, Account shows the state.
4. Tests: `tests/remote-access-e2e.mjs` (per-test env in `run-e2e.sh`).
5. Docs: README "Accounts", CLAUDE.md, this plan.
6. Commit; push (maintainer's call) so CI builds the image.
7. ops rollout, each step needing the maintainer's per-change yes:
   - **A. Caddy, LAN header only.** In
     `servers/steamboat/sites.d/farm.tomsawyerlabs.com.caddy`, the LAN
     `handle` gets `request_header X-FarmSlicer-LAN 1`; the external branch
     keeps its 403 (and strips the header, harmless). The running app
     ignores the header, so nothing changes for anyone.
   - **B. App.** `servers/sentinel/stacks/farmslicer/compose.yml` gets
     `FARMSLICER_LAN_HEADER: X-FarmSlicer-LAN`; `pin.json` → the new image's
     digest; deploy. Verify on the LAN: sign-in works, the log says
     "remote access: requests without `x-farmslicer-lan: 1` …". Approve the
     owner (and anyone else) on the Users page.
   - **C. Caddy, open the internet path.** The external `handle` becomes
     `request_header -X-FarmSlicer-LAN` + `reverse_proxy
     http://sentinel.tsl:9337` instead of the 403. Verify from outside
     (phone off Wi-Fi): the sign-in page loads with the "outside the local
     network" notice, an unapproved account is refused, an approved one
     gets in, `/recover` and join links answer 403.

## Findings / gotchas

- `/api/health` is hit by Docker's healthcheck on 127.0.0.1 without the
  header: it's public anyway, so "internet" is fine for it.
- Direct LAN requests to `sentinel:9337` (bypassing Caddy) count as internet
  once the header is configured. Harmless: passkeys don't work there anyway
  (origin ≠ RP ID).

- `/api/join/resolve` etc. answer 403 from the internet before their bodies
  are parsed (the gate is a `route_layer` on the public router), so the
  refusal is the same whatever is sent.
- Header values are compared exactly: `0`, `true`, `11`, `yes` all count as
  remote (tested). Trailing whitespace can't be tested from Node (fetch trims
  it) and HTTP parsers strip it anyway.
- Building on buildhost needs `web/src/data` in the tarball besides
  `Cargo.* build.rs .cargo src tests` (`include_str!` of the settings schema).

## Progress log

- [x] Investigation, design
- [x] App changes (`src/auth.rs`, `auth_api.rs`, `join_api.rs`, `db.rs`,
      `server.rs`, `main.rs`)
- [x] Frontend (Login notice + hides LAN-only paths, Users "Remote" column
      and create option, Account line, setup splash from the internet)
- [x] e2e: `tests/remote-access-e2e.mjs` (38 checks) + the whole suite, on
      buildhost (`~/farmslicer-remote-access`)
- [x] Docs (README "Remote access", CLAUDE.md)
- [x] Commit
- [ ] Push (maintainer's call)
- [ ] ops A: Caddy LAN header (awaiting approval)
- [ ] ops B: compose env + pin + deploy (awaiting approval)
- [ ] ops C: Caddy opens the internet path (awaiting approval)

## Open questions for the user

1. Push FarmSlicer master so CI builds the image? (Recommended: yes.)
2. Approve ops steps A, B, C (one at a time; diffs in the thread).

## Things not to do

- Don't open Caddy before the app that understands the header is deployed.
- Don't decide LAN-ness in the app from `X-Forwarded-For` + CIDRs: it would
  duplicate (and drift from) Caddy's on-link IPv6 logic.
- Don't make the header mean "external": a missing header must be the
  restrictive case.
