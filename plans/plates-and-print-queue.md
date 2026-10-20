# Plates and print queues: demand (projects) and supply (printers)

Status: step 1 built and pushed (`e5868a7`); steps 2-7 being built (user: "keep going, boil the ocean", 2026-10-20). Started 2026-10-20.

## Goal

Two views of one set of records:

- **Demand** (the user / client): "I need these parts, this many of each."
  They track how close the project is to done, see failures, and see the
  reprints those failures caused, without having to understand printers.
- **Supply** (the operator): "What's next on this printer / on my printers /
  on the whole farm?" They send plates, clear beds, record outcomes.

These have to work at every scale:

- **Solo:** one person is both the client and the operator. Two views would
  be overhead, so the demand view has to collapse into "send next".
- **Small paid farm:** one operator runs queues for paying clients. Clients
  follow their orders; the operator sees one combined farm queue.
- **Big farm:** many printers, with each operator in charge of a subset.

Software also needs a way in on both sides:

- **Ordering:** a client's storefront or ordering tool creates projects
  through the API and follows their progress.
- **Fulfillment:** the farm's shipping or ERP software hears when an order
  is complete (webhook) and can mark it shipped.

Several plates per job is part of this work. Plates are where demand turns
into supply: "40 of part A" becomes N plates, and a plate is what a printer
prints.

## Environment / context

What exists today (2026-10-20, master `22c7a71`):

- **Plates:** one plate per job (`PlateLayout`: models × copies, Duplicate,
  Add, Fill and Arrange in the viewer). The package reader and sending
  already handle several plates (`package::Package.plates`,
  `prints.plate`, `/api/jobs/{id}/gcode?plate=N`); only uploaded Bambu
  Studio projects use that today.
- **Prints** (`prints` table): one row per send of a job plate to a
  printer, with status, progress, error and timestamps. `printing::track()`
  moves the row along from printer statuses. `pending_approval` comes from
  print rules.
- **Printers** are site-wide and admin-managed. No ownership, groups or
  operator assignment.
- **Groups / quotas / API keys** exist (`src/groups.rs`, `src/quota.rs`,
  API keys in `auth`). Jobs are charged to a group. API keys are for full
  accounts, LAN only.
- No webhooks or outbound integrations anywhere.

## Model sketch (draft, for discussion)

One chain, each layer pointing at the one above it:

```
Project (demand)              owner: user or group; opaque client_ref + external_ref
  └─ Item                     a part (model + settings/material) × quantity wanted
       └─ Unit counts         wanted / good / failed / in flight, computed (not stored per copy)
Plate (bridge)                a sliced job plate holding k copies of one or more items
  └─ Queue entry (supply)     the plate waiting for a printer: priority, eligible printers, assignee
       └─ Print (exists)      one attempt on one printer → outcome per item: good n / bad m
```

- **Items are the unit of progress.** An item's state comes from its prints'
  outcomes: `good >= wanted` means done. When copies fail, the item's
  remaining count goes back up, and the system proposes a reprint plate
  (maybe a smaller one: only the copies that are missing).
- **Outcomes are per item, per print, and recorded by a person.** The
  printer can only report "finished" or "failed". A finished plate of 6 can
  still have 1 copy that's spaghetti, so the operator records 5 good and
  1 bad, with a reason. A printer-reported failure defaults to all copies
  bad.
- **The queue is just a view.** It holds entries that aren't printed yet,
  ordered by priority, project due date and age, and filtered by printer
  compatibility (`printing.rs` already decides that), loaded material and
  operator scope.
- **Operator scope:** a printer belongs to zero or more *printer pools*. An
  operator is assigned pools. Solo and small farms have one implicit pool
  that every admin works.
- **Solo collapse:** a job sliced with no project is an implicit
  one-item project. Today's flow (slice → send) keeps working unchanged.

## Integration surface (draft)

- REST under `/api/projects` (create with items and quantities, read
  progress, cancel). Authenticated with API keys, scoped to one group (and
  optionally one `client_ref`), so ordering software can only see its own projects.
  `external_ref` + `Idempotency-Key` stop retries from creating duplicate
  orders.
- Webhooks (per group / site): `project.completed`, `item.failed`,
  `print.finished`, and so on. Signed with HMAC and retried with backoff,
  with a delivery log in the UI.
- Fulfillment states after "printed": `ready` → `shipped` (or picked up),
  set by an operator or through the API.
- Usage: `GET /api/usage?client_ref=&project=&from=&to=` (grams per
  filament incl. failures, printer hours, good/failed copies, estimates).
- Remote access: API keys are LAN-only today (`auth::authenticate`).
  Outside ordering software needs a separate, scoped kind of credential;
  that's a security decision for later, not a default.

## Decisions already made (don't re-ask)

- Demand and supply are two views of the same database, not two systems.
- It has to scale from a solo printer up to a multi-operator farm, and
  allow paid client work.
- It needs an integration option on both the ordering and fulfillment
  sides.
- **Mixing projects on one plate is a setting**, not hard-coded (runtime
  configuration: pool, with a site default). Default: mixing within a
  group allowed, across clients off.
- **Plates are made both ways**: the system proposes plates from items
  (auto-plate), and the operator can open, edit or build them by hand
  (plate tabs).
- **Sending modes, per printer**: manual "send next" (default); auto-send
  to an idle printer after someone confirms the bed is clear; and an opt-in
  **YOLO** mode that sends the next plate as soon as the printer is idle,
  with no confirmation (for auto-ejecting/belt printers or an operator who
  accepts the risk). YOLO must be explicit and visible on the printer card.
- **No customer accounts or client records.** FarmSlicer doesn't manage the
  farm's customers. A project carries an opaque client reference
  (`client_ref`) and the ordering tool's own order id (`external_ref`),
  set by whoever creates it. Customer identity, quotes and billing live in
  external tools.
- **Usage APIs make billing easy for external tools**: per project /
  `client_ref` / period, report material used (grams per filament,
  including failed attempts), printer time, good and failed copies, and
  cost estimates (`cost.rs`). FarmSlicer reports usage; it never invoices.

## Open questions for the user

(1–5 answered 2026-10-20; folded into the decisions above.)

## Plan / steps (draft order, revise once questions are answered)

1. Multi-plate jobs: slicer core loops over plates into one package. The
   viewer gets plate tabs, and Arrange/Fill spill over to new plates.
   Both engines.
2. Print outcomes: record good/bad copies per print (operator UI + API),
   with failure reasons.
3. Projects and items: create from the Slice page or the API; progress
   rollup; reprint proposals.
4. Queue view: farm / pool / printer views, priority, "send next".
5. Printer pools and operator assignment.
6. Integration: scoped API keys, webhooks, fulfillment states, usage API
   for external billing, API docs.
7. Auto-plating; auto-send (bed-clear confirmation) and YOLO send modes.

## Step 1 design: several plates per job (built 2026-10-20)

Mapped 2026-10-20 (every single-plate assumption, file:line, was surveyed;
the summary is here).

- **Shape:** `jobs.plate_json` = `{"plates":[{"objects":[...]}, ...]}`.
  Reading accepts the old `{objects}` (one plate) and `placement_json`.
  Validation per plate (≥1 part; placements when several parts) and per
  job (every model used somewhere, `MAX_PLATES`). The API returns `plates`,
  and `plate` (= plate 1) only for single-plate jobs so older pages and
  engines keep working; a multi-plate job is refused by an engine without
  `plates` in `fs_version`.
- **Slicing:** one `slice_models` call loops over plates (upstream does
  the same: one `Print` per plate on one shared `Model`, `Print::apply`
  takes only `printable` instances; CLI `OrcaSlicer.cpp` ~5681-6040). Per
  plate: mark that plate's instances printable, build-volume check naming
  the plate, copy of the config (wipe tower position and filament map are
  per plate), fresh `ZeroedPrint`, export `{out}.plate{N}.gcode`, fill its
  `PlateData` + thumbnail while the Print lives, free the Print (wasm
  memory). Then one `store_bbs_3mf` with every plate (`thumbnail_data[i]`
  must line up with `plate_data_list[i]`). Progress scaled per plate,
  warnings prefixed "plate N:".
- **Totals:** `jobs.print_time_sec` / `filament_used_g` become sums over
  plates (fix `safety.rs:32`, `prints_api.rs:123`, `cost.rs:102`, browser
  upload); per-plate numbers live in `package_json.plates[]`. Quotas read
  the totals.
- **Plain G-code printers:** a multi-plate job is still one package file,
  the `.gcode.3mf` container `store_bbs_3mf` writes. *Changed while
  building:* no new package format. `PackageFormat::Bambu3mf` is the
  container; a plate is "for other firmware" when the project's
  `printer_model` (read from project_settings) isn't Bambu's and it has no
  model id (`Plate::for_other_firmware`). Plain-G-code printers accept
  such plates and get `plate_N.gcode` extracted (`package::plate_gcode`,
  file named `.gcode` via `printing::sent_as`); Bambu printers refuse
  them; the check runs as other firmware. Bonus: OrcaSlicer projects
  uploaded for Klipper/Prusa/etc. are now sendable too. Single-plate plain
  jobs and uploaded `.gcode` stay `Gcode`.
- **Browser engine:** `fs_set_options` takes `plates`; the report gains
  `plates: [{index, stats}]`; the browser uploads the package (plus plate
  1's G-code for the instant preview).
- **Viewer:** parts carry a plate index; plate tabs (add, delete, move part
  to plate N); Duplicate/Fill/Arrange act on the active plate; Arrange can
  spill onto new plates. `SliceResult` gets the Job page's plate tabs.
- **Tests:** placement/job-history e2e for the new shape and old shapes;
  `wasm/test/smoke.mjs --plates`; preview e2e (plain multi-plate now has
  plate 2); unit tests for the shape and per-plate validation.

## Steps 2-7 design (2026-10-20, chosen while building; revise in place)

Decisions here are mine unless marked; the user can overrule any of them.

### Step 2: print outcomes

- **Lines.** What a print holds, one line per kind of part: FarmSlicer
  jobs group the plate's parts by model (`plate_json`, names from
  `job_models`); uploaded projects group the plate's objects by name
  (`slice_info.config` `<object name skipped>`, new `Plate.objects`);
  anything else is one line, "the plate", 1 copy. Lines carry an
  `item_id` once projects exist (step 3).
- **Storage.** `print_outcomes(print_id, line, item_id, model_idx, name,
  planned, good, failed, reason, note)`; on `prints`: `outcome` (NULL =
  not recorded, `good` | `partial` | `failed`), `outcome_by`,
  `outcome_at`, `outcome_note`.
- **Automatic.** A print the printer ends as failed or cancelled gets
  every copy recorded failed (by "printer", reason `printer_error` /
  `cancelled`). A finished print stays unrecorded ("unchecked") unless the
  site setting `finished_outcome` is `good` (solo farms). People can
  always correct a record.
- **Reasons** (`src/outcomes.rs`): spaghetti, adhesion, warping,
  layer_shift, under_extrusion, stringing, surface, dimensions, supports,
  filament (runout/tangle), clog, cancelled, printer_error, other.
- **Who.** Whoever may control the print (sender, the group's managers,
  admins), plus operators of the printer's pools (step 5).
- **API.** `POST /api/prints/{id}/outcome` (`{all: "good"|"failed",
  reason, note}` or `{lines: [{line, good, failed, reason}], note}`);
  `GET /api/prints/{id}` and the list carry `outcome` and `lines`;
  `GET /api/prints?unchecked=1`; `GET /api/outcome-reasons`.

### Step 3: projects and items

- `projects(id, name, group_id, user_id, client_ref, external_ref,
  status, priority, due_at, notes, created/updated/completed/shipped)`.
  Status: `open` → `printed` (automatic, when every item has enough good
  copies) → `ready` → `shipped`; also `on_hold` (its queue entries wait)
  and `cancelled`. `external_ref` is unique per group: creating again with
  the same one returns the existing project (idempotent ordering).
- `project_items(id, project_id, name, quantity, job_id, model_idx,
  notes)`: the part, how many, and the *recipe*: a job and one of its
  models (the model, the profiles, the overrides, its rotation).
- `job_items(job_id, plate, item_id, copies)`: which items a job's plates
  carry. Written when a job is made for a project (the Slice page's
  Project field, the API, the auto-plater); a print's outcome lines take
  their `item_id` from it.
- **Progress per item** (computed, never stored per copy): wanted, good,
  failed, unchecked (finished prints without a record), printing (active
  prints), queued (entries not sent), missing = wanted - good -
  unchecked - printing - queued (>= 0). Done = good >= wanted.
- **Visibility:** creator, admins, the group's managers, its active
  members. Editing: creator, managers, admins.
- **Reprints:** an item with missing copies gets a proposal: queue an
  existing plate that carries it again (enough times), or (step 7) a new
  plate with only the missing copies.
- *While building:* a part on a job plate counts for at most one item
  (`job_items` keyed by job, plate, part = `model:N` | `object:<name>`),
  or one print would count for two projects. An item made from a job
  whose part already counts elsewhere is a recipe only (`linked: false`);
  its copies need plates of their own (re-slice, or step 7).

### Step 4: the queue

- `queue_entries(id, job_id, plate, status, priority, printer_id (pin),
  pool_id, print_id, created_by, created/updated/sent)`. Status `queued` →
  `sent` → `printed` | `failed`; `cancelled`. One entry = the plate
  printed once; "print this plate 5 times" = 5 entries.
- Order: entry priority, then project priority, project due date, age.
  Entries of `on_hold` projects are skipped.
- Eligibility per printer: `printing::incompatibility`, the pin, the
  pool, the G-code check (blocked/review), print rules (entries that
  need approval are sent as requests); filament mismatches are shown,
  not refused (the operator swaps spools).
- `GET /api/queue?printer=&pool=`, `POST /api/queue` (job, plate, count,
  priority, pin), `PATCH`/`DELETE /api/queue/{id}`,
  `POST /api/queue/{id}/send` (printer), `POST /api/printers/{id}/send-next`.
  Sending goes through the same code as `POST /api/jobs/{id}/print`
  (refactored into `prints_api::send_plate`). A direct send of a plate
  claims a queued entry of that plate.
- A failed print's entry ends `failed`; the item shows missing copies.
  Site setting `requeue_failed` (default off) puts the plate straight back.

### Step 5: pools and operators

- `pools(id, name, settings)`, `pool_printers(pool_id, printer_id)`,
  `pool_operators(pool_id, user_id)`. Admins manage them.
- An operator may, for printers in their pools: see the queue, send
  entries, record outcomes, control prints, confirm the bed is clear.
  With no pools at all, admins work everything (the implicit pool).
- Pool setting `mixing`: `none` | `group` | `any` (site default
  `group`): which projects may share a plate (the auto-plater, and a
  warning when a hand-made job mixes them).

### Step 6: integration

- **Scoped API keys** (`api_keys.scope`: group, optional `client_ref`,
  permissions `projects:read`, `projects:write`, `usage:read`), made by
  admins and the group's managers. A scoped key reaches only
  `/api/projects*`, `/api/usage/*` and `/api/outcome-reasons`, and only
  that group's (and client_ref's) projects. Still LAN-only, like every
  API key (remote use is an open question).
- **Webhooks** (admins): url, events, a secret; deliveries signed
  `X-FarmSlicer-Signature: sha256=<hex HMAC of the body>`, retried with
  backoff (1 min, 5 min, 30 min, 2 h, 12 h), logged
  (`webhook_deliveries`), shown on the Integrations page. Events:
  `print.started`, `print.finished`, `print.failed`, `print.outcome`,
  `item.completed`, `project.printed`, `project.status`.
- **Fulfillment:** `POST /api/projects/{id}/status` (`ready`, `shipped`,
  `on_hold`, `cancelled`, `open`), with an optional tracking note.
- **Usage:** `GET /api/usage/prints?group=&client_ref=&project=&from=&to=`:
  per project (and totals): prints, printer hours, grams by material
  (failed prints count by how far they got), good/failed copies,
  estimated cost. FarmSlicer reports; it never invoices.

### Step 7: auto-plating and send modes

- **Send modes** (`printers.send_mode`): `manual` (default), `confirm`
  (when the printer is free and someone has confirmed the bed is clear,
  the next eligible entry goes out), `yolo` (next entry as soon as the
  printer is idle and its last print ended, no confirmation). A
  dispatcher task does it; YOLO shows on the printer card.
- **Auto-plate:** for missing copies, a new job from the item's recipe
  whose plates hold only those copies, arranged by libslic3r's own
  arrange (a bridge call, so the server packs real shapes), queued.
  Items of other projects with the same recipe settings share plates when
  `mixing` allows.


## Findings / gotchas

- Uploaded multi-plate projects now count every plate in the job's totals
  (quota, cost), like FarmSlicer's own multi-plate jobs; before, only
  plate 1 counted. A job = all its plates.
- The viewer drops an empty plate when you leave it (or move its last part
  away), so the tabs number plates the way the job will; empty plates are
  never sent.
- Verified 2026-10-20: native two-plate slices (X1C and Voron 2.4) through
  the API in a `farmslicer:plates` image: package with both plates, right
  objects per plate, per-plate thumbnails and stats, totals summed; wasm
  `st` `smoke.mjs --plates` passes (`--plate` and single too); 146 Rust
  tests, 14 e2e suites; the viewer checked in a browser (tabs, move to
  plate, Arrange spilling onto a new plate).


## Progress log

- [x] Surveyed what exists (2026-10-20).
- [x] User answers to the open questions (2026-10-20).
- [x] Step 1: several plates per job: slicer core, both engines, server,
  sending plates of projects to other firmware, viewer tabs, Slice result
  tabs, tests (e2e, `smoke.mjs --plates` in CI), docs.
- [ ] Not on hardware yet: a real print of plate 2 of a multi-plate job
  (Bambu and a Klipper printer).
- [x] Step 2: print outcomes: lines per print (plate_json by model,
  uploads' slice_info objects), `POST /api/prints/{id}/outcome`,
  automatic failed records for prints that started, `finished_outcome`
  setting, Prints page dialog, `tests/outcomes-e2e.mjs` (25 checks);
  full e2e suite green. Plain uploaded G-code is one line of one copy
  (its objects aren't read).
- [x] Step 3: projects and items: `src/projects.rs` (+ db/projects.rs,
  projects_api.rs), idempotent creation by `external_ref`, items from a
  job's parts (`GET /api/jobs/{id}/parts`), progress rollup, open ⇄
  printed by itself, fulfillment statuses, `project` field on
  `POST /api/jobs`, Projects pages, Job page panel, Slice page field;
  `tests/projects-e2e.mjs`; full e2e suite green. UI not yet checked in
  a browser (do it with step 4).
- [ ] Step 4: the queue (current).

## Things not to do

- Don't name a real deployment's clients or teams in the code or docs (the
  repo is public; see CLAUDE.md, "Nothing deployment-specific").
- Don't build customer accounts, client records or invoicing; report
  usage and let external tools bill.
- Don't put plate layout in `config_json` (`plans/part-placement.md`).
