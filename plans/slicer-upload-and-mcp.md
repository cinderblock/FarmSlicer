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
8. [x] Server MCP endpoint (design below).
   1. [x] `src/mcp.rs`: JSON-RPC over Streamable HTTP at `POST /api/mcp`.
   2. [x] Tools forward to the REST routes (internal `oneshot` on the
      protected router, with the caller's headers).
   3. [x] `integration::allows`: `/api/mcp` for any key; tools/list filtered
      by what the key reaches.
   4. [x] e2e test `tests/mcp-e2e.mjs`; Account page "Connect an agent";
      README; changelog.
9. [ ] **(next, not started)** WebMCP (later, when the spec settles), and
   MCP tools for slicing and uploads if agents need them (see below).

## MCP design (step 8)

- **Transport**: MCP Streamable HTTP, stateless. `POST /api/mcp` takes one
  JSON-RPC message (or a batch) and answers `application/json`; no SSE
  stream, no `Mcp-Session-Id`. `GET`/`DELETE` answer 405, as the spec
  allows for a server without a stream. Notifications and responses from
  the client get 202. Protocol versions: 2025-11-25, 2025-06-18,
  2025-03-26 (the client's if we know it, else the newest).
- **Auth**: an API key only (`Authorization: Bearer fsk_…` or `X-Api-Key`),
  never a session cookie: no cross-site requests riding a browser session.
  The usual `require_auth` applies (remote rules, integration scopes).
  Claude Code: `claude mcp add --transport http farmslicer
  https://<farm>/api/mcp --header "Authorization: Bearer fsk_…"`.
- **Tools are REST calls**: each tool runs one or more requests through the
  protected router itself (`tower::ServiceExt::oneshot`), carrying the
  caller's headers. So a tool can do exactly what the key can do over REST,
  with the same checks, and nothing new to keep in sync. Outputs are
  trimmed for an agent's context (no `config_json`, plates summarised).
- **v1 tools**: whoami, list_printers (merged with live status), list_jobs,
  get_job, list_queue, queue_plates, cancel_queue_entry, list_prints,
  control_print, list_projects, get_project, create_project,
  add_project_item. Annotated read-only / destructive.
- **Not in v1**: slicing (`POST /api/jobs` is multipart with models) and
  uploads (binary): an agent with a file uses `POST /api/uploads` or the
  OctoPrint host with the same key; the server's `instructions` say so.

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
- MCP: `GET /api/jobs/{id}/parts` gives part keys (`model:N`,
  `object:<name>`), but `POST /api/projects/{id}/items` takes `model` (an
  index) or `part` (an object name), not the key. `add_project_item`
  translates the key; passing the key straight through gave "the job has
  no such part".
- MCP: the router's error type is `Infallible`, so `oneshot` can't fail
  (`let Ok(res) = ...`).
- Running a test server by hand on buildhost needs
  `FARMSLICER_ORIGINS=http://localhost:<port>` (passkey setup checks the
  origin) and the test pointed at `localhost`, not `127.0.0.1`.

## Progress log

- 2026-11-13: researched Orca's client; plan written.
- 2026-11-13: adapter done: `src/print_host.rs`, `X-Api-Key`, integration
  allowlist, `tests/print-host-e2e.mjs` (passes on buildhost, with the
  integration and queue suites and `cargo test`), Account page section,
  README, changelog.
- 2026-11-13: MCP endpoint done: `src/mcp.rs`, 13 tools,
  `tests/mcp-e2e.mjs` (passes on buildhost with print-host, integration,
  queue and projects suites, `cargo test` 185), Account page "Connect an
  AI agent", README, CLAUDE.md, changelog.
- 2026-11-14 1:10 AM PST (09:10Z): pushed (`1e4e654`), CI image built;
  Renovate deploys it in its next app window (7-8 AM PST).
- [ ] Try the adapter from a real OrcaSlicer against the dev instance (manual).
- [ ] Try the MCP server from a real Claude Code against the dev instance
  (manual).

## Open questions for the user

1. Should the upload dialog's folder (`path`) pick the group a job is
   charged to (e.g. `Team X/part.gcode.3mf`)? Recommendation: yes, later,
   matching a group the uploader can charge by name; for now jobs are
   personal (or the integration key's group).

## Things not to do

- Don't fake a Bambu printer for Bambu Studio (MQTT/FTPS + their cert and
  authorization checks): fragile, and it breaks with their updates.
- Don't send a "print" upload straight to a printer: the queue decides.
