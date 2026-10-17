# Feedback and automatic error reports

Step 9 ("Feedback, item 4") of `plans/slicer-workflow.md`, built on its own
branch.

## Goal

The user's words: "we also need to add a built-in feedback system. for
feedback about printers, about the slicer, app, bugs, errors, anything. any
errors that happen, even in the console, should be reported automagically."

- A Feedback button on every page: category, message, optional printer/job,
  optional diagnostics (recent console messages, URL, version, viewport).
- Automatic reports of browser errors (`window.onerror`, unhandled
  rejections, `console.error`, React render errors, failed API calls) and of
  server-side slice failures, deduplicated by fingerprint with counts.
- An admin triage page; everyone else sees their own reports and status.

## Environment / context

- Build box: buildhost, dirs `~/farmslicer-feedback` (sources) and
  `~/farmslicer-feedback-target` (cargo target, seeded from
  `~/farmslicer-placement-target`). e2e on `PORT=9343`.
- Sync: `tar cf - Cargo.toml Cargo.lock build.rs .cargo src tests web/src/data
  | ssh buildhost 'cd ~/farmslicer-feedback && tar xf -'`.
- Other threads edit `src/server.rs`, `src/db.rs`, the Slice page and the
  Jobs page on master at the same time: keep hooks there to one line.

## Decisions already made (don't re-ask)

- Admins see all feedback and error reports; users see their own (and the
  status). (User, plan Q3.)
- Errors before sign-in queue in the browser (localStorage, capped) and are
  sent after sign-in. No anonymous endpoint. (User.)
- Never suppress or filter console output: the `console.error`/`warn`
  wrappers call the original first, always, with the original arguments.
  (User, firm rule.)

## Design

### Storage: one `feedback` table plus `feedback_occurrences`

One table for manual and automatic reports, because both need the same
triage (kind, status, admin note, printer/job links, timestamps) and the
admin page filters across them; `automatic` tells them apart.

- `feedback`: `automatic`, `kind` (printer | slicer | app | bug | idea |
  other), `source` (`manual`, or where an error was caught: `window`,
  `promise`, `console`, `react`, `api`, `resource`, `server`), `message`,
  `stack`, `fingerprint` (UNIQUE, NULL for manual), `user_id` (no FK, like
  `jobs.user_id`: the no-auth stand-in has no users row), `printer_id`/
  `job_id` (`ON DELETE SET NULL`), `page_url`, `user_agent`, `version`,
  `context` (JSON), `count`, `created_at` (= first seen), `last_seen`,
  `status` (new | acknowledged | resolved | wont_fix), `admin_note`,
  `updated_at`.
- `feedback_occurrences`: one row per (report, user, version) with its own
  count, first/last seen, and the latest URL/user agent/raw message. Keeps
  affected users and versions exact without a row per occurrence; pruned to
  the 25 most recent rows per report.
- An automatic report's row keeps the latest stack, URL and context.
- A resolved error that happens again goes back to `new` (a regression);
  acknowledged and won't-fix stay.

### Fingerprint

`sha256(source \n normalised message \n normalised first stack frame)`,
computed on the server (the client's own dedupe key is only for batching).
Normalising: UUIDs, long hex runs and numbers become placeholders; in the
frame, origin, line/column, query strings and Vite's `-[hash]` in asset names
are dropped.

### Limits

- Body limit 256 KiB on the feedback routes.
- Manual: message 1..5000 characters (400 otherwise); 10 per user, refilling
  one a minute.
- Errors: at most 20 reports per batch (400 otherwise); message 1000 chars,
  stack 8000, URL 1000, version 64, user agent 400 (truncated); context JSON
  32 KiB (manual) / 8 KiB (automatic), dropped with a note when larger.
  Per-user token bucket: 60 reports, refilling one every 10 s; a batch
  takes what is left and the rest is dropped; an empty bucket is a 429.
  At most 2000 distinct automatic reports are stored; new fingerprints past
  that are dropped (existing ones still count).

### What is reported automatically

- Browser (`web/src/errorReporting.ts`): `window` errors, the app's own
  `script`/stylesheet load failures (images aren't: offline printers'
  pictures; nor are other origins' scripts: the first report in production
  was a CDN's injected analytics beacon blocked by our COEP),
  unhandled rejections, `console.error`, React errors (error boundaries,
  with the component stack), `/api` calls answering 5xx or failing on the
  network (not 4xx; not `/api/feedback` itself; not aborts). `console.warn`
  goes to the ring buffer only.
- Server: `run_slice` failures and browser-slice failures posted to
  `/api/jobs/{id}/fail` (`feedback::slice_failed`, one call each),
  kind `slicer`, source `server`.

### Visibility

- `GET /api/feedback`: admins all; others their own manual reports and the
  automatic reports they're among the affected users of (their own
  occurrences only).
- `PUT`/`DELETE /api/feedback/{id}`: admins.
- Remote access: the routes sit behind `require_auth` like the rest of the
  API, so approved remote accounts (full, passkey sessions) can send
  feedback; nothing changes in `remote_gate` (public routes only).

## Plan / steps

1. [x] Server: migration, `src/db/feedback.rs` queries, `src/feedback.rs`
   (normalise, fingerprint, limits, rate limiter, server hook),
   `src/feedback_api.rs`, wiring, unit tests.
2. [x] Server hooks in `run_slice` and `fail_job`.
3. [x] `tests/feedback-e2e.mjs`; run all suites on buildhost.
4. [x] Web: capture module, error boundary, Feedback button + dialog,
   Feedback page (admin triage / my feedback), CSS.
5. [x] tsc, build, eslint on new files; browser check.
6. [x] README, CLAUDE.md, mark step 9 in `plans/slicer-workflow.md`.
7. [ ] Merge to master and deploy (the maintainer's call; not done on this
   branch).

## Findings / gotchas

- Piping `tar cf - ... | ssh buildhost 'tar xf -'` from Git Bash on this
  Windows box fails ("This does not look like a tar archive"): Windows
  OpenSSH mangles binary stdin. `tar cf /tmp/x.tar ...` then `scp` works.
- Starting a server with `nohup ... &` inside `ssh buildhost '...'` kept the
  ssh session open (it had to be moved to the background), though the
  server itself ran fine. Stop it by PID, never `pkill -f`.
- React DevTools (installHook.js) re-wraps `console.error`/`warn` after the
  reporter does; reports still flow (it calls ours, ours calls the
  original).
- React 19 logs an error a boundary caught with `console.error(error)`
  before `componentDidCatch` runs, so the same Error object reaches the
  reporter twice. The reporter keeps a WeakMap of Error objects and
  upgrades the queued `console` report to `react` (with the component
  stack): verified in the browser, one `react` report, no `console` twin.
- The production bundle minifies component names; when poking React
  fibers from DevTools, find components by position, not name.
- The local Chrome window's viewport was 400 px wide (something docked);
  `document.documentElement.style.zoom = 0.36` gave a ~1100 px layout for
  screenshots.

## Verification (2026-10-16)

- `cargo test` (buildhost, `FARMSLICER_SKIP_CXX=1`): 123 passed, 1 ignored
  (13 new: fingerprint normalisation, buckets, truncation, context cap,
  dedup/occurrences/regression/cap/visibility in the DB).
- `PORT=9343 tests/run-e2e.sh`: exit 0, all 11 suites ALL PASSED;
  `feedback-e2e.mjs` has 80 checks.
- `bunx tsc -b`, `bun run build`: pass. `bunx eslint` on the new and
  touched files: clean except `main.tsx`'s three pre-existing
  `react-refresh/only-export-components` errors (ISSUES.md).
- Browser (stub server, `FARMSLICER_NO_AUTH=1`): uncaught error,
  rejection, `console.error` (string and Error), `console.warn` (ring
  buffer only), 404 (not reported), network failure (reported, send
  retried after backoff), localStorage outbox claimed and sent after
  status loads, dialog (categories, pickers, diagnostics preview, success
  state), Feedback page tabs/filters/details/triage save, render crash
  caught by the page boundary with the sidebar intact, live refresh of the
  list and the admin badge after sending.
- Not verified in a browser: the signed-out → sign-in path with a real
  passkey (the outbox claim after `setSignedIn(true)` is the same code
  the reload check exercised); `sendBeacon`-style delivery on page hide
  (it uses `fetch` with `keepalive`).

## Progress log

- [x] Explored auth, db migrations, incidents, server routes, web shell.
- [x] Server + e2e (`e333a13`).
- [x] Web (`2e2f4b3`), plus docs and this plan.

## Open questions for the user

(none)

## Things not to do

- Don't filter or swallow console output.
- Don't let the reporter report its own failures (its requests use the
  unwrapped `fetch`, and `/api/feedback` is never reported).
- Don't add fields to `AppState` (server.rs is edited in parallel): the
  rate limiter is a static in `src/feedback.rs`.
- Don't name real hosts, domains or the deployment's users in this repo.
