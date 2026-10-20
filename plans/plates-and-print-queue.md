# Plates and print queues: demand (projects) and supply (printers)

Status: **design, nothing built**. Started 2026-10-20.

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

## Findings / gotchas

- (none yet)

## Progress log

- [x] Surveyed what exists (2026-10-20).
- [x] User answers to the open questions (2026-10-20).
- [ ] Step 1 onward.

## Things not to do

- Don't name a real deployment's clients or teams in the code or docs (the
  repo is public; see CLAUDE.md, "Nothing deployment-specific").
- Don't build customer accounts, client records or invoicing; report
  usage and let external tools bill.
- Don't put plate layout in `config_json` (`plans/part-placement.md`).
