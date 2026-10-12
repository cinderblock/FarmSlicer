# Groups, quotas, self-registration, guest accounts

`plans/groups-quotas-registration.md`

## Goal

Asked 2026-10-12. More management features on top of the passkey account
system (`plans/auth.md`):

1. **Groups**: nested (a group may have a parent), users may belong to many.
2. **Quotas**: per user, per group (pooled), and a per-member default on a
   group; resolved sensibly across nesting and multiple memberships.
3. **Runtime config** (database + admin UI, not env vars) for:
   - enabling self-registration into a particular group;
   - passwordless ("guest") accounts with limited access, per group.
4. Generic features that let the maintainer's own deployment serve a
   league of numbered teams **without any reference to that league in the
   code** (the deployment specifics stay out of this public repo):
   - a top-level group (the league) whose entry point is a secret URL, a
     public link, or a button on the sign-in/home page;
   - after identifying as a member, the person picks a team number and the
     team's group is created if it does not exist;
   - the team's group sees every model the team has uploaded/sliced/printed,
     with past seasons' parts in a separate section.

## Environment / context

- Code: `src/auth.rs` (policy, WebAuthn RP, tokens, `require_auth`,
  `require_admin`), `src/auth_api.rs` (handlers), `src/db.rs` (SQLite; tables
  created with `CREATE TABLE IF NOT EXISTS` + additive `ALTER TABLE`
  migrations in `Db::open`), `src/server.rs` (jobs/slices/printers/profiles
  handlers + router). Frontend: `web/src/auth.tsx`, `web/src/main.tsx`
  (Gate: setup → login → app), pages in `web/src/pages/`.
- `jobs.user_id` exists (who created the job) but nothing filters on it;
  today every signed-in user sees every job, slice, printer, profile.
- Browser-sliced jobs never upload the model (only G-code + stats).
- Printing is not wired: `printer_id` on a job is bookkeeping only, so "used"
  today means "sliced" (estimated filament grams / print time from the slicer).
- Local Windows box cannot link libslic3r; `FARMSLICER_SKIP_CXX=1 cargo check`
  typechecks. Real runs happen in the Docker image on buildhost (dev port
  9338). `tests/passkey-e2e.mjs` drives the account API with a software
  authenticator.

## Design (settled 2026-10-12)

### Schema

- `groups(id, parent_id NULL → groups ON DELETE RESTRICT, name, description,
  settings JSON, quotas JSON, self_key NULL, created_by, created_at)`.
  `self_key` = the identifier a self-service subgroup was created under
  (e.g. a team number), unique per parent.
- `group_members(group_id, user_id, role member|manager, status
  active|pending, quotas JSON NULL, joined_at)`, PK (group_id, user_id).
  Direct membership only; ancestors supply inherited settings and rules.
- `join_links(id, group_id, code UNIQUE NOCASE, public 0|1, bypass_approval,
  label, max_uses, uses, expires_at, disabled, created_by, created_at)`.
  Codes are stored in plain text on purpose: a join link is meant to be
  shared again and again (like a chat-server invite), managers can view it.
  Secret = 22 random chars; public = a human slug (3-40 `[a-z0-9-]`).
- `settings(key, value JSON)`: site-wide runtime config.
- `users.kind full|guest`, `users.quotas JSON NULL` (per-user override).
- `jobs.group_id NULL → groups ON DELETE SET NULL`, `jobs.stored_bytes`
  (model + G-code bytes, for the storage metric).

### Group settings (`groups.settings`, every key optional)

Inherited down the tree, nearest explicit value wins:
`season_start` "MM-DD", `shared_library`, `keep_models`, `allow_guests`,
`allow_registration`, `join_policy` open|approval.
Not inherited: `listed` (button on the sign-in page; admins only),
`subgroups` {mode none|choose|self_service, required, label, pattern,
name_template "… {value} …", creator_becomes_manager}.

### Permissions

- `can_manage(G)`: admin, or active manager of G or of an ancestor.
- Create top-level groups: admins. Subgroups of G: can_manage(G).
- Settings/name/description of G: can_manage(G); `listed`: admins.
- Quotas of G and members' quota overrides: admins or managers of a
  *strict* ancestor (a team manager cannot raise their own team's pool).
- Delete G: admins or strict-ancestor managers; only when it has no children.
- Members of G may see G's member list; can_manage(G) edits it.
- Guests: no API keys, no printer or custom-profile changes, no group
  creation; they join groups only through the join flow.

### Visibility (replaces "everyone sees everything")

A job (and its slice, G-code, model) is visible to: its creator; active
members of its group when the group's effective `shared_library` is on;
can_manage(group); admins. Personal (group-less) jobs: creator + admins.
Progress/result/fail of browser jobs: creator only. Cancel: creator,
can_manage, admins. Re-assign a job's group: creator (to a group they're an
active member of) or admins. Printers and profiles stay global.

### Seasons

Effective `season_start` of the library's group (site default
`settings.season_start`, else 01-01). Label `2026` for a Jan 1 start,
`2026–27` otherwise. The group library returns each job's season; the UI
shows the current season first and earlier ones collapsed.

### Quotas

Rule `{metric, period, limit}`: metric slices | filament_g | print_hours |
storage_mb; period day | week | month | season | total (storage ignores the
period: it is a running total). Periods are UTC calendar boundaries; week
starts Monday. Group quotas JSON: `{pool:[…], member:[…], guest:[…]}`
(`guest` replaces `member` for guest accounts when present).

For a job by U charged to G (path G → root), all must have headroom:
1. U's own rules: `users.quotas`, else `settings.default_user_quotas` /
   `default_guest_quotas`; counts all of U's jobs.
2. For each group on the path: U's membership override, else the group's
   member (or guest) rules; counts U's jobs in that group's subtree.
3. For each group on the path: pool rules; counts every job in the subtree.

Counted jobs: everything not failed/cancelled. Checked before a job starts
(refuse when a counter is already at/over its limit; the job that crosses
it finishes). Usage endpoints feed the Account and group pages.

### API

- Groups: `GET/POST /api/groups`, `GET/PUT/DELETE /api/groups/{id}`,
  `GET/POST /api/groups/{id}/members`,
  `PUT/DELETE /api/groups/{id}/members/{user_id}` (self may leave),
  `GET /api/groups/{id}/library`, `GET /api/groups/{id}/usage`,
  `GET/POST /api/groups/{id}/links`, `PUT/DELETE /api/groups/{id}/links/{lid}`.
- Join (public): `POST /api/join/resolve {entry, selection}` → current step,
  options, target preview; `POST /api/join/finish` (signed in);
  `POST /api/join/register/start|finish` (new passkey account);
  `POST /api/join/guest` (guest account). `entry` = `{code}` or `{group}`
  (listed groups only). `selection` = steps `{group: id}` (choose) or
  `{key: "254"}` (self-service). Approval bypass applies only when the link's
  own group is the target.
- Guests: `POST /api/auth/guest/signin {username, code}` (one-time code,
  a fresh one is returned). Adding a passkey upgrades a guest to full.
- `/api/auth/status` gains `join_groups` (listed groups).
- Me: `GET /api/me` adds kind + groups; `GET /api/me/usage`.
- Admin: `GET/PUT /api/settings`; `PUT /api/users/{id}` gains `quotas`.
- Jobs: `GET /api/jobs?group=&mine=1`, `PUT /api/jobs/{id} {group_id}`,
  `GET /api/jobs/{id}/model`; `POST /api/jobs` gains `group_id` and
  returns `keep_model` for browser jobs (then the result upload carries the
  model too).

### The maintainer's league deployment (not in code)

Configured at runtime on the maintainer's instance: a league group (listed on
sign-in, public link, guests allowed), optionally one child per program, each
with self-service subgroups {label "Team number", pattern `^[0-9]{1,5}$`,
name "<program> {value}"}, `season_start` per program, `shared_library`
and `keep_models` on the teams. Exact names live outside this repo.

## Decisions already made (don't re-ask)

- Runtime configuration lives in the database and the admin UI.
- No league-specific code, strings or defaults.
- Passkeys remain the only credential for full accounts (plans/auth.md).
- **Guest accounts** = no credential at all: long-lived session cookie plus a
  one-time personal sign-in code; limited access; allowed per group; can
  upgrade by adding a passkey. (Q1, 2026-10-12)
- **Quota metrics: all of them, each optional**: slice count, estimated
  filament g, estimated print hours (per period), stored bytes (running
  total). A rule only applies where configured. (Q2)
- **Joining an existing team is a per-group setting** (`join_policy`: open /
  approval by the group's managers), inherited down the tree like other
  settings, so a parent can set it for every self-service subgroup. (Q3)
- **Keeping source models is a per-group setting** (`keep_models`): browser
  jobs charged to such a group upload the model with the result; personal
  jobs stay local. (Q4)
- The deployment-specific setup (league/team names) stays out of this public
  repo, including this plan; it is configured at runtime on the instance.

## Plan / steps

1. ~~Settle the open questions~~ (answered 2026-10-12, see Decisions).
2. ~~Stub slicer + e2e harness~~ so the API can be tested without libslic3r.
3. ~~Backend~~: schema, groups/members/links/library/usage/settings API, join
   flow, guests, quotas, visibility, kept models; `tests/groups-e2e.mjs`.
4. ~~Frontend~~: Groups list + group page (library by season,
   members/approval, subgroups, links, settings, quotas + usage), group
   picker on Slice (+ model upload when the group keeps models), Jobs and
   Library show creator/group (jobs can be moved between groups), Join page
   (`/join/:code`, `/join/group/:id`), sign-in page buttons + guest sign-in,
   Account (groups, usage, guest sign-in code), Users (kind, groups, limits),
   Settings.
5. ~~UI check in a browser~~ against the stub server on the build box
   (tunnelled to localhost:9339, seeded by a script).
6. **[current]** Deploy and configure the league on the real instance:
   push → CI image → ops pin (needs the maintainer's go-ahead for the push
   and the ops change), then create the groups in the UI.

## Findings / gotchas

- Browser-sliced jobs keep the model on the user's machine unless the job's
  group has `keep_models` (decided Q4); a job moved into such a group later
  still has no model.
- Quotas on "printed" usage cannot exist until printing is wired; slicing
  estimates are what we count today (jobs not failed/cancelled).
- This Windows box can't build the server: the vendored OpenSSL needs
  Strawberry Perl (MSYS perl fails: `IPC/Cmd.pm` compilation error), and WSL
  Ubuntu has cargo but no `make`/`pkg-config`/libssl-dev (sudo needs a
  password). The build box works: cargo in `~/.cargo`, make, node 22.
  Working dir there: `~/farmslicer-groups`, target
  `~/farmslicer-groups-target`.
- The stub server logs `Discovery: failed to create multicast socket:
  Address already in use` on the build box (the dev/prod container holds the
  SSDP port). Harmless.
- Bash heredocs containing Rust lifetimes (`'de`, `'_`) broke the tool's
  quoting; edit scripts went through files in a scratch dir instead.
- Join link codes are stored in plain text on purpose (re-shareable, like a
  chat invite); session/API/invite/recovery secrets stay hashed.
- `tests/run-e2e.sh` on a port another server already uses tested that
  server instead (every check failed with "setup already completed"); it
  now refuses to start when the port answers.
- Possible follow-ups, not built: rate limiting guest/account creation on
  public links; per-member usage table in the UI beyond the usage endpoint;
  re-slicing a kept model from the library.

## Progress log

- [x] Open questions answered (2026-10-12)
- [x] Stub slicer, `HOST`, `tests/run-e2e.sh`, CI runs unit + e2e tests (`6f6a58c`)
- [x] Backend: groups, members, links, join flow, guests, quotas, settings,
      visibility, seasons, kept models; `tests/groups-e2e.mjs` 80 checks pass
- [x] Frontend (pages above); `tsc` + build pass; the touched pages are
      lint-clean (pre-existing lint errors logged in `ISSUES.md`)
- [x] UI walked through in a browser: sign-in page join button, join wizard
      (choose program → bad/good team number → guest → sign-in code →
      pending), owner's group page (library, members + approve, inherited
      settings with sources, quotas + members' usage), Slice group picker,
      Users, Settings, Account (full and guest), Jobs, Library
- [ ] Not exercised in a real browser: passkey registration through the
      join page (covered by the API test with a software authenticator) and
      a browser-engine slice uploading its model (the stub build has no
      engine; the upload itself is covered by the API test)
- [ ] Pushed / deployed (waiting for the maintainer)
- [ ] League configured on the deployed instance

## Open questions for the user

None open.

## Things not to do

- Don't put the league's name or wording anywhere in code, defaults or docs
  other than this plan's deployment section (which stays generic).
- Don't change the RP ID or the passkey flows while adding guest accounts.
- Don't try to build the server natively on this Windows box or in WSL (see
  Findings); use the build box.
