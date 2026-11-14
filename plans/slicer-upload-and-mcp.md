# Desktop slicers and agents send work to FarmSlicer

## Goal

Let people who slice on their desktop send the result straight to FarmSlicer,
with no export and manual upload. Then let AI agents do the same, and more.

1. **OctoPrint-compatible upload adapter** (this step). OrcaSlicer,
   PrusaSlicer and SuperSlicer can all send to an "OctoPrint" print host.
   FarmSlicer answers the two calls they make, so a sliced plate becomes a
   job, and "Upload and print" also puts it in the print queue.
2. **Server-side MCP endpoint** (next). Tools for agents (Claude Code and
   similar), on the same internal calls, authenticated with API keys.
3. **WebMCP** (`navigator.modelContext`, later). Tools for agents in the
   user's browser. Wait until the spec settles.

## Environment / context

- OrcaSlicer v2.4.2 (our submodule): `extern/OrcaSlicer/src/slic3r/Utils/OctoPrint.cpp`.
  - Test: `GET <host>/api/version`. It needs JSON with `api`, and `text`
    starting with "OctoPrint". Orca runs this before every upload too.
  - Upload: `POST <host>/api/files/local`, multipart: `print` ("true"/"false"),
    `path` (the folder typed in the upload dialog), `plateindex` (1-based,
    sent with `use_3mf`), `file`. Auth header: `X-Api-Key`.
  - Errors are shown as `HTTP <status>: <body>`, so the adapter answers
    errors in plain text.
  - `<host>` may carry a path: Orca appends `api/...` to whatever URL is set.
- Bambu printers in Orca: Printer settings → Basic information → Advanced →
  **Use 3rd-party print host** (`bbl_use_printhost`) and **Use 3MF instead
  of G-code** (`use_3mf`, sends a `.gcode.3mf`).
- Bambu Studio has no equivalent for Bambu printers; its Send goes through
  Bambu's closed network plugin. Not pursued.

## Decisions already made (don't re-ask)

- Do the OctoPrint adapter first, then server MCP, WebMCP later (the user
  agreed 2026-11-13).
- The adapter lives under `/api/octoprint/`, so the host URL in the slicer is
  `https://<farm>/api/octoprint`. Under `/api` it gets `auth::require_auth`,
  the remote-access rules and the body limit for free.
- `X-Api-Key: fsk_...` is accepted everywhere `Authorization: Bearer` is
  (the same key, another header).
- "Upload and print" means "queue it", not "start on some printer": the
  queue and the send modes (`src/dispatch.rs`) decide where it prints.
- The upload goes through the same code as `POST /api/uploads` (zipcheck,
  inspection, upload policy, quotas, G-code check).

## Plan / steps

1. [x] Plan doc.
2. [x] Extract `prints_api::store_upload` from `upload_package`, and
   `queue_api::enqueue` from `add_entries`.
3. [x] `src/print_host.rs`: `GET /api/octoprint/api/version`,
   `POST /api/octoprint/api/files/local`.
4. [x] `auth::bearer_from_request` accepts `X-Api-Key`.
5. [x] `integration::allows`: the two routes for integration keys
   (`projects:write` for the upload; queueing refused for them).
6. [x] e2e test `tests/print-host-e2e.mjs`.
7. [x] Account page: "Send from your slicer" with the host URL and the
   settings to tick; README; changelog.
8. [ ] **(current)** Server MCP endpoint: separate plan section once 1-7 are in.

## Findings / gotchas

- Orca's "All plates" send still uploads with the current plate's
  `plateindex`; the bundle carries every plate. So `plateindex` names a
  plate to queue only when the package actually has that plate.
- A refusal from `auth::require_auth` (e.g. a read-only integration key)
  answers before the multipart body is read, so a client still streaming
  the body gets EPIPE. This is the known `ISSUES.md` entry about
  `printers-e2e.mjs`. The e2e test builds the form in full first, as curl
  does, and the real slicers use curl.
- Not yet tried with a real OrcaSlicer: the e2e test replays the requests
  from `OctoPrint.cpp`.

## Progress log

- 2026-11-13: researched Orca's client; plan written.
- 2026-11-13: adapter done: `src/print_host.rs`, `X-Api-Key`, integration
  allowlist, `tests/print-host-e2e.mjs` (passes on buildhost, with the
  integration and queue suites and `cargo test`), Account page section,
  README, changelog.
- [ ] Try it from a real OrcaSlicer against the dev instance (manual).

## Open questions for the user

1. Should the upload dialog's folder (`path`) pick the group a job is
   charged to (e.g. `Team X/part.gcode.3mf`)? Recommendation: yes, later,
   matching a group the uploader can charge by name; for now jobs are
   personal (or the integration key's group).

## Things not to do

- Don't fake a Bambu printer for Bambu Studio (MQTT/FTPS + their cert and
  authorization checks): fragile, and it breaks with their updates.
- Don't send a "print" upload straight to a printer: the queue decides.
