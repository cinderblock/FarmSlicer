# Organization, sharing, and access control

`plans/organization-and-access.md`

## Goal

Asked 2026-11-14: "We need folders, groups, labels, and sharing options…
general more advanced user account controls, printers/type approvals, etc."

Answers the same day (all options chosen on every question):

- Folders and labels organize **jobs/models, projects, printers, and
  groups**.
- Sharing **per item to people and groups, per folder, public links, and
  whole group libraries shared with other groups**.
- Printer access keyed **per printer, per pool, per printer model, plus
  per-user training sign-off**.
- Account controls: all matter, but **permissions and organization come
  first**.

## What exists today (build on it, not beside it)

- **Groups** (`src/groups.rs`, `plans/groups-quotas-registration.md`): a
  tree, `member | manager` roles, inherited settings, join links, guests,
  quotas, seasons. A job belongs to at most one group (`jobs.group_id`);
  that is also what quotas charge.
- **Sharing** is all-or-nothing per group: `shared_library` lets every
  active member see every job in the group. Otherwise: creator, managers
  of the group or an ancestor, admins (`Viewer::can_see_job`,
  `Viewer::visible_groups` for list queries).
- **Organization**: Jobs list, the group library (by season), projects. No
  folders, no labels.
- **Accounts**: `users.role` = `owner | admin | user`, `kind` =
  `full | guest`, `remote_access`, per-user quotas. `auth::is_admin` is
  the only site-level permission; it's checked about 80 times across 19
  files (`viewer.admin`, `require_admin`). No suspend, no audit log.
- **Printers** are global: any full account may target any printer. Pools
  (`src/pools.rs`) grant *operators* control of a set of printers; they
  don't restrict who sends.
- **Approvals**: group `print_rules` (max minutes, materials) and the
  `uploads` policy put prints in `pending_approval`; group managers or
  admins approve (`prints_api::can_approve_print`), safety-review G-code
  admins only. Nothing keyed to a printer or a printer model.

## Design (draft for review)

### 1. Permissions: capabilities and roles

Replace the single admin bit with **capabilities** granted by **roles**.

- **Site capabilities** (a fixed list in code, `src/permissions.rs`):
  `users.view`, `users.manage` (create, invite, suspend, set roles below
  your own), `roles.manage`, `settings.manage`, `printers.manage` (add,
  edit, delete, pools), `printers.operate` (control any printer, the
  whole queue), `prints.approve` (any approval), `prints.approve_safety`
  (G-code safety review), `certifications.grant`, `profiles.manage`,
  `groups.manage_all`, `library.view_all`, `feedback.triage`,
  `integrations.manage` (webhooks, integration keys), `reports.view`,
  `audit.view`.
- **Group capabilities**, held in a group and inherited down its subtree:
  `group.members` (add, approve, remove), `group.settings`,
  `group.subgroups`, `group.links`, `library.view` (see every job in the
  subtree), `library.edit` (move, rename, label, delete jobs there),
  `prints.approve` (approvals for prints charged there),
  `labels.manage`, `folders.manage`. `quotas.govern` stays "a strict
  ancestor's" capability, so a group can't raise its own limits.
- **Roles**: table `roles(id, name, scope site|group, caps JSON, builtin,
  created_at)`. Built-in, not deletable: site `owner` (everything, one or
  more), `admin` (everything but changing owners), `user` (nothing
  site-wide); group `manager` (every group capability) and `member`
  (`library.view` only when `shared_library` is on, as today). Admins
  with `roles.manage` add custom roles such as a site "Printer admin"
  (`printers.manage`, `printers.operate`, `certifications.grant`) or a
  group "Approver" (`prints.approve`, `library.view`).
- `users.role` and `group_members.role` keep their columns and now hold a
  role id; the existing values are the built-in ids, so no data moves.
- `Viewer::can(Cap)` and `Viewer::can_in(tree, group, GroupCap)` replace
  `viewer.admin` / `can_manage` checks one by one; `require_admin`
  becomes `require(Cap)`. Integration keys stay limited by their scope on
  top (`integration::allows`).
- Nobody can grant a capability they don't hold, nor change an account
  whose site role outranks theirs (owners > everything).

### 2. Account controls (the permission-adjacent part, in slice 1)

- **Suspend**: `users.suspended_at`, `suspended_by`, `suspend_reason`.
  Suspended accounts can't sign in; their sessions and API keys stop
  authenticating (checked in `auth::authenticate`); history stays.
- **Audit log**: `audit_log(id, at, actor_id, action, target_kind,
  target_id, detail JSON)`, written for role, capability, membership,
  suspension, printer-access, certification, sharing and setting changes
  and every approval decision. Page under Admin, filterable.
- Later slice: session/device list per user with revoke and
  "sign out everywhere".

### 3. Printer access and approvals

- **Access rules**: `printer_access(id, target_kind printer|pool|model|site,
  target_id, principal_kind everyone|user|group|role|certified,
  principal_id, effect allow|approve|deny, approver JSON NULL, note,
  created_at)`. For a sender and a printer, the most specific target with
  matching rules wins (printer > pool > model > site); within it, deny >
  approve > allow. No rules anywhere = today's behaviour (allow).
- **Certifications (training sign-off)**: `certifications(id, name,
  description, models JSON)` and `user_certifications(user_id, cert_id,
  granted_by, granted_at, expires_at NULL)`. A rule with principal
  `certified` matches users holding a valid certification that covers the
  printer's model. So "H2D: certified users allow, everyone else
  approve" is two rules.
- **Approval routing**: an `approve` effect names who may approve
  (`approver`: users, groups, roles); default = holders of
  `prints.approve` site-wide plus group approvers of the print's group.
  Holds from access rules join the existing holds (print rules, uploads,
  safety review) on the same `pending_approval` prints, each with its
  reason.
- Enforced at the one choke point every send goes through
  (`printing::incompatibility` / `prints_api::send_plate`), so the queue's
  `fit`, dispatch's YOLO mode, the print host and MCP all follow it. The
  queue shows "needs approval" and "not allowed" per printer; printers a
  user is denied stay visible (status) but can't be targeted.

### 4. Labels

- `labels(id, name, color, scope site|group|user, owner_id, kinds JSON,
  created_at)`, `label_links(label_id, kind job|project|printer|group,
  target_id)`.
- Site labels (`settings.manage` or a site role), group labels (group
  `labels.manage`, visible to the group's members and its subtree),
  personal labels (just you).
- Anyone who can see an item sees the labels on it they can see; anyone
  who can edit an item may apply labels they can see.
- Filters by label on Jobs, Library, Projects, Printers, Queue, Groups,
  and in the command palette (`label:` prefix).

### 5. Folders

- `folders(id, parent_id NULL, library_kind user|group, library_id, name,
  created_by, created_at)`: each user has a personal library and each
  group a library; folders nest inside one library.
- Jobs and projects get `folder_id NULL` (NULL = the library's root). A
  folder in group G's library holds G's jobs only, so the folder never
  disagrees with the charge. Moving an item to another library is the
  existing "move to group" with its rules.
- Printers: **labels plus pools**, no folders (a printer has one place,
  its pool is the folder). Groups: the tree already is their folder
  structure, so labels only. Say so if you want real folders there.
- The Library page becomes a file browser: breadcrumbs, folders first,
  drag to move, seasons as a filter rather than the only grouping.

### 6. Sharing

- `shares(id, target_kind job|project|folder|library, target_id,
  principal_kind user|group|link, principal_id, level view|use|edit,
  created_by, created_at, expires_at NULL)`.
  - `view`: see it, its preview, plates, check results, outcomes.
  - `use`: also download the model, re-slice it (`/slice?from=`) and
    send it to print, charged to the user's own group and held to their
    printer access.
  - `edit`: also rename, label, move within the folder it's shared in.
    Deleting stays with the owner and `library.edit` holders.
- A folder share covers its subfolders and contents; a `library` share
  gives another group (its subtree) access to a whole group library.
- Who may share: the owner of an item, and `library.edit` holders for a
  group's items; never more than your own level.
- **Public links**: `principal_kind link`, a random code shown in the UI
  (stored in plain text like join links, so it can be copied again),
  `view` only, optional expiry, revocable. Off unless the site setting
  `public_shares` allows it (and per group, inherited). Served on
  `/s/<code>` with its own read-only API added to `open_to_remote`.
- Visibility becomes: today's rules ∪ grants. `Viewer::load` gathers the
  viewer's grants (user + their groups, folder subtrees expanded) once per
  request; list queries add `OR id IN (...) OR folder_id IN (...)`.

### Build order (slices, each committed, e2e-tested, documented)

1. Permissions core: capabilities, built-in and custom roles, every admin
   check converted, roles UI (Users page, Roles page, group member roles),
   suspend, audit log. `tests/permissions-e2e.mjs`.
2. Printer access rules, certifications, approval routing.
   `tests/printer-access-e2e.mjs`.
3. Labels on jobs, projects, printers, groups; filters.
4. Folders; Library as a file browser.
5. Sharing: users, groups, folders, cross-group libraries, public links.
6. Sessions and devices per user, sign out everywhere.

## Decisions already made (don't re-ask)

- Build on groups, pools, and `pending_approval`; no parallel systems.
- Everything in scope (all options chosen, 2026-11-14); permissions and
  organization first.
- Nothing deployment-specific in code (league/team names stay runtime).
- Design approved as written, 2026-11-14 ("yes to all"):
  custom roles built from a fixed capability list; printers and groups
  get labels, not folders; public links are view only (facts, preview,
  plate pictures, no downloads); printers with no rules stay open.

## Plan / steps

1. ~~Survey what exists~~ (2026-11-14).
2. ~~Scope questions~~ (answered 2026-11-14).
3. ~~Design review~~ (approved 2026-11-14).
4. ~~Slice 1~~ (2026-11-14).
5. **← current** Slice 2: printer access rules, certifications, approval
   routing. Then slices 3–6.

## Findings / gotchas

- Slice 1 as built (2026-11-14): `src/permissions.rs` (17 site caps, 11
  group caps, built-in roles in code), `src/db/roles.rs` (custom roles,
  suspension columns), `src/audit.rs` + `src/db/audit.rs`,
  `src/roles_api.rs`; `User.caps` filled by `auth::authenticate`;
  `Viewer::{can, caps_in, can_in, held_in, can_govern, can_edit_job,
  unrestricted, can_give_group_role}`. Group role ids live in
  `group_members.role` like `manager`/`member` did, so nothing migrated.
- Suspending deletes the account's sessions (they get 401, not a
  "suspended" message); API keys get 403 `{suspended: true}`, and sign-in
  attempts too (`auth_api::start_session` is every way in).
- `shared_library` defaults to on, so "members can't see the group's jobs"
  needs it set off explicitly (the e2e test does).
- `tests/printers-e2e.mjs` fails on master already (ISSUES.md, group-logo
  EPIPE); every other suite passes with slice 1.
- Shared working tree: other threads stage whole files (`git add file`),
  which can sweep this thread's hunks into their commits; check
  `git diff --cached` before they commit, and build from HEAD + this
  thread's diff in a temporary worktree (scratchpad `snap.sh`).
- Bash heredocs with Rust lifetimes (`'_`, `'de`) break the tool's quoting:
  edit scripts go through files.

- About 80 admin checks across 19 files (`viewer.admin`,
  `require_admin`, `auth::is_admin`); slice 1 must convert every one, or
  a custom role silently can't do what its capabilities say. A grep for
  `admin` after the change is the check.
- Visibility is decided in two places: `Viewer::can_see_job` (one job) and
  `Viewer::visible_groups` (list SQL). Sharing has to extend both, and the
  MCP server and integration keys reuse the same routes, so they follow.
- Remote access: `auth::remote_gate` / `open_to_remote` decide what the
  internet reaches; public share links need their route added there.

## Progress log

- [x] Surveyed what exists (2026-11-14)
- [x] Scope agreed (2026-11-14)
- [x] Design reviewed (approved 2026-11-14)
- [x] Slice 1: permissions core, suspend, audit log (unit + e2e pass;
      `tests/permissions-e2e.mjs`; web Roles, Audit log, Users, group
      Members)
- [ ] Slice 2: printer access, certifications, approvals
- [ ] Slice 3: labels
- [ ] Slice 4: folders
- [ ] Slice 5: sharing and public links
- [ ] Slice 6: sessions and devices

## Open questions for the user

None open.

## Things not to do

- Don't add a second group-like principal for sharing; groups are it.
- Don't leave any `viewer.admin` check behind in slice 1.
- Don't make a share or a label able to grant more than its creator has.
