# OctoPrint driver reference

Research for `plans/printer-drivers.md`, written for whoever implements the
OctoPrint driver in the Rust server (axum + tokio). Researched 2026-10-12/13
against OctoPrint **1.11.8** (current stable) and **2.0.0rc6** (current
release candidate), the Slicer Thumbnails plugin 1.2.3, and the local
OrcaSlicer v2.4.2 tree.

Confidence markers:
- **[doc]** stated in docs.octoprint.org (the `docs/` tree of the tag).
- **[src]** read in the upstream source at the tag.
- **[verified]** observed on a live instance: OctoPrint 1.11.8 and 2.0.0rc6
  were installed from PyPI into throwaway venvs, seeded as in section 10,
  and driven with curl plus a tornado websocket client against the bundled
  Virtual Printer. Everything marked [verified] was seen on 1.11.8. Anything
  also seen on 2.0.0rc6 says so.
- **[unverified]** believed true but not confirmed. Check it before relying on it.

---

## 0. TL;DR for the implementer

- **Transport**: plain HTTP REST plus one **raw websocket** per printer at
  `ws://host[:port]/sockjs/websocket` (no SockJS framing; one JSON object per
  text frame). Base URL = scheme + host + port + optional path prefix (the
  zeroconf TXT `path`).
- **Auth**: an API key in `X-Api-Key: <key>` (or `Authorization: Bearer <key>`,
  which works on 1.11.8 too [verified]). Get the key with the bundled
  **Application Keys** workflow (a "Connect" button): `POST /plugin/appkeys/request`
  → poll `GET <Location>` **at least every 5 s, or the request expires** →
  user clicks Allow in OctoPrint → `200 {"api_key": ...}`. Keep a manual
  paste-the-key fallback.
- **Websocket auth**: `POST /api/login {"passive": true}` with the key →
  `{name, session}` → send `{"auth": "<name>:<session>"}` on the socket.
  Don't send an `Origin` header (or send one matching the OctoPrint host).
- **Status**: the socket's `current` messages carry state flags, job, progress
  and temperatures. `event` messages give `PrintStarted / PrintDone /
  PrintFailed / PrintCancelled / PrintPaused / PrintResumed /
  PrinterStateChanged / Disconnected / Error`. Use REST `GET /api/printer` and
  `GET /api/job` to resync after a reconnect.
- **Two layers of "offline"**: OctoPrint unreachable (HTTP/socket fails) vs
  OctoPrint up with no serial connection to the printer (`/api/printer` →
  **409** "Printer is not operational", `/api/job` → `"state": "Offline"`,
  `/api/connection` → `current.state: "Closed"`). Show them differently.
- **Send**: `POST /api/files/local` multipart (`file`, `path`, `print=true`,
  `userdata=<json>`) → `201`. **Check `effectivePrint` in the body**: the
  upload succeeds with `effectivePrint: false` when the printer is offline or
  busy [verified]. Better to upload without `print` and start explicitly with
  `POST /api/files/local/<path> {"command":"select","print":true}`, which
  answers **409** if it can't start.
- **Never send `{"command":"start"}` on `/api/job` blindly**: it starts
  *whatever file is still selected*, including the previous job, which stays
  selected after it finishes or is cancelled [verified].
- **Control**: `POST /api/job` `pause` (`action: pause|resume|toggle`) and
  `cancel`. **Speed**: `POST /api/printer/printhead {"command":"feedrate","factor":<int percent>}`.
  **Always send an integer**: a JSON float is read as a fraction and multiplied
  by 100 (`150.0` → `M220 S15000`). There is no upper bound check in 1.11.8
  [src][verified]. **Heat**: `POST /api/printer/tool` / `bed` / `chamber`
  `target` (0 = off).
- **Tracking**: match on `(origin, path)` in event payloads and `job.file`.
  Upload under a FarmSlicer-owned folder with a unique file name per print.
  Cancel produces `PrintCancelling` → `PrintCancelled` → `PrintFailed{reason:"cancelled"}`.
  An error mid-print produces only `PrintFailed{reason:"error"}`. Success
  produces `PrintDone`.
- **Pictures**: OctoPrint **1.x has no core thumbnails**. With the *Slicer
  Thumbnails* plugin, file info gets a top-level `thumbnail` (a relative URL).
  **2.0 has native thumbnails**: `refs.thumbnail` (absolute URL, largest
  image) and `refs.thumbnail_<W>x<H>`. Both need the API key. When neither
  exists, use a camera snapshot or a placeholder.
- **Camera**: `GET /api/settings` → `webcam.webcams[]` (1.9+) /
  `webcam.streamUrl` + `snapshotUrl` (compat). The stream URL is usually
  **relative** (`/webcam/?action=stream`, via haproxy on port 80). The snapshot
  URL is usually `http://127.0.0.1:8080/?action=snapshot`, which is **only
  reachable from the Pi itself**. Proxy it server-side (our COOP/COEP headers
  rule out embedding it directly in the browser).
- **Discovery**: zeroconf `_octoprint._tcp.local.` with TXT
  `path, version, api, uuid[, model, vendor]` [verified]. The bundled
  Discovery plugin is on by default. SSDP exists too but is weaker (section 7).
- **Fake printer**: real OctoPrint + the bundled **Virtual Printer** in a
  `python:3.12-slim` container with a seeded `config.yaml` and `users.yaml`
  (section 10). The virtual printer simulates heating (10 °C/s) and
  moves (10x real time). A 1500-move file takes about 2.5 minutes.

---

## 1. Auth

### API keys [doc + src]

- Header `X-Api-Key: <key>`, or `Authorization: Bearer <key>` (documented
  from 2.0, but works on 1.11.8 [verified]), or `?apikey=` (testing only,
  works [verified]). A missing or invalid key is treated as anonymous, so most
  endpoints return **403** [verified].
- Key kinds: **user keys** (one per user, generated under User Settings > API
  Key), **application keys** (per app + user, from the appkeys plugin), and the
  **global key** (`api.key` in config.yaml). The global key is deprecated: 1.11
  logs "will cease to function with OctoPrint 1.13.0" [src], and the 2.0 docs
  say "removed in 2.1.0" [doc]. Don't support it. A fresh 1.11.8 still
  auto-generates one into config.yaml on first boot [verified].
- Keys inherit the **permissions of their user**. App keys aren't scoped further.

### Application Keys workflow ("Connect" button) [doc + src, verified]

Bundled plugin `appkeys`, on by default since 1.3.10. Endpoints aren't under
`/api`:

1. `GET /plugin/appkeys/probe` → **204** if supported (anything else: fall
   back to paste-a-key). Returns 403 while OctoPrint's first-run setup isn't
   finished (`no_firstrun_access`).
2. `POST /plugin/appkeys/request` with JSON `{"app": "FarmSlicer", "user": "<optional username>"}`
   → **201**:
   ```http
   HTTP/1.1 201 CREATED
   Location: http://octopi.local/plugin/appkeys/request/cjZDiOQWw6A4EbvP_2V9EjbsX7S6wbLCv_rJ4cXLsAE
   {"app_token": "cjZDiOQWw6A4EbvP_2V9EjbsX7S6wbLCv_rJ4cXLsAE",
    "auth_dialog": "http://octopi.local/plugin/appkeys/auth/cjZDiOQ...?user=admin"}
   ```
   - The `app` name is case-insensitive and shown to the user. `user` limits who
     may approve, and the dialog only appears in that user's browser sessions.
   - **Rate limited: `3/minute;5/10 minutes;10/hour`** per client [src]. Don't
     retry in a loop. Surface "try again later" on 429.
   - `Location` and `auth_dialog` are built from the request's `Host` header
     (`_external=True`), so they're right as long as we address OctoPrint by a
     reachable name.
3. The user approves either in an open OctoPrint UI tab (a popup appears for
   logged-in users) or in the light-weight **auth dialog** (1.8.0+). FarmSlicer
   should show the `auth_dialog` URL as a link and button that opens a new tab.
4. Poll `GET <Location>` about once a second: **202** `{"message":"Awaiting decision"}`
   while pending, **200** `{"api_key": "..."}` once approved (that response is
   only delivered once), **404** on denial *or expiry*. **The request is
   deleted if not polled for more than 5 s** [doc][verified: 404 after 7 s
   idle]. Polling has to live server-side in a tokio task, not depend on the
   browser tab staying open.
5. Store the key (encrypted at rest like other printer secrets). Re-running the
   flow for the same app and user returns the existing key [src].

Other endpoints (session or key with the right permission):
- `GET /api/plugin/appkeys` → `{"keys": [...], "pending": {<user_token>: {app_id, user_id, user_token, remote_address}}}`.
  **`pending` is an object keyed by user_token**, not the documented list [verified].
- `POST /api/plugin/appkeys {"command":"generate","app":"X"}` → 200 with
  `{"api_key","app_id","user_id"}`. `revoke` likewise. These need a "fresh
  credentials check". A user API key satisfied it [verified].
- `POST /plugin/appkeys/decision/<user_token> {"decision": true}` → 204. Needs
  `PLUGIN_APPKEYS_GRANT`. **A user API key works here too** [verified], so
  e2e tests can approve the request without a browser (look up `user_token`
  via `GET /api/plugin/appkeys`).

### Permissions needed [src `access/permissions.py`, doc per endpoint]

| Feature | Permission |
|---|---|
| status, `/api/printer`, `/api/job` GET, `/api/version`, `/api/connection` GET, socket messages | `STATUS` |
| connect/disconnect serial | `CONNECTION` |
| camera settings in `/api/settings` | `WEBCAM` |
| list / file info / thumbnails (plugin route) | `FILES_LIST` |
| upload | `FILES_UPLOAD` |
| download (`/downloads/files/...`, 2.0 `/downloads/thumbs/...`) | `FILES_DOWNLOAD` |
| delete | `FILES_DELETE` |
| select file | `FILES_SELECT` |
| start/pause/cancel (`POST /api/job`) | `PRINT` |
| temps, feedrate, G-code, jog (`/api/printer/*` POST) | `CONTROL` |
| printer profiles | `CONNECTION` (read) [unverified] |

A default "users" group member has all of these. The app key of an admin is
simplest. Document "use an account in the Users group" for operators.

---

## 2. Status

### `GET /api/printer` [doc + verified, same on 2.0.0rc6 without the version header]

```json
{
  "sd": {"ready": true},
  "state": {
    "error": "",
    "flags": {"cancelling": false, "closedOrError": false, "error": false,
              "finishing": false, "operational": true, "paused": false,
              "pausing": false, "printing": false, "ready": true,
              "resuming": false, "sdReady": true},
    "text": "Operational"
  },
  "temperature": {
    "bed":   {"actual": 21.3, "offset": 0, "target": 0.0},
    "tool0": {"actual": 21.3, "offset": 0, "target": 0.0}
  }
}
```
- Query params: `history=true&limit=N`, `exclude=temperature,sd,state`.
- Temperature keys are `tool0..toolN`, `bed` (if the profile has a heated bed),
  `chamber` (if the profile has a heated chamber). `target` can be `null`.
- **409 `{"error":"Printer is not operational"}` when no printer is
  connected** [verified]. That's the "OctoPrint up, printer down" signal.
- Flags `finishing` and `resuming` exist (undocumented) [verified].
- **Drive the UI from flags, not `text`**: text strings come through gettext,
  are not exhaustive, and differ per connector in 2.0 (e.g. "Printing from SD",
  "Sending file to SD", "Transferring file to printer").

State text values [src 1.11 `comm.getStateString`; 2.0 `ConnectedPrinterState`]:
`Offline`, `Opening serial connection`, `Detecting serial connection`,
`Connecting`, `Operational`, `Starting`, `Starting print from SD`,
`Starting to send file to SD`, `Printing`, `Printing from SD`,
`Sending file to SD`, `Pausing`, `Paused`, `Resuming`, `Cancelling`,
`Finishing`, `Error`, `Offline after error`, `Transferring file to SD`
(2.0: `Transferring file to printer`), `Unknown State (...)`.
`/api/connection` reports `Closed` when no comm object exists [verified].

Suggested normalized mapping:

| Condition | Normalized |
|---|---|
| HTTP connect fails / socket down + REST fails | `unreachable` |
| `/api/printer` 409, or `closedOrError && !error` | `printer_disconnected` (OctoPrint up) |
| `flags.error` | `error` (text in `state.error` / `GET /api/printer/error`) |
| `printing` (incl. `finishing`) | `printing` |
| `pausing` | `pausing` |
| `paused` | `paused` |
| `resuming` | `printing` |
| `cancelling` | `stopping` |
| `operational && ready` | `idle` |
| `operational && !ready` (streaming to SD) | `busy` |

`GET /api/printer/error` (STATUS) → `{"error","reason","consequence","faq","logs"}`
(`reason`: `firmware|resend|resend_loop|timeout|connection|start_print|autodetect`;
`consequence`: `emergency|disconnect|cancel`) [doc].

### `GET /api/job` [doc + verified]

While printing (1.11.8, real response):
```json
{
  "job": {
    "averagePrintTime": null, "estimatedPrintTime": null, "filament": null,
    "file": {"date": 1791874545, "display": "farm job #12 (test).gcode",
             "name": "farm job #12 (test).gcode", "origin": "local",
             "path": "farmslicer/farm job #12 (test).gcode", "size": 8377},
    "lastPrintTime": null, "user": "admin"
  },
  "progress": {"completion": 18.80, "filepos": 1575, "printTime": 0,
               "printTimeLeft": null, "printTimeLeftOrigin": "linear"},
  "state": "Printing"
}
```
- **`completion` is a percentage 0–100**, despite the doc example showing
  0.229 [verified]. In 1.x it is *bytes read / file size*, so a large
  thumbnail header makes it jump forward at the start.
- **2.0 change**: with the serial connector, **`M73 P.. R..` lines in the
  G-code drive `completion` and `printTimeLeft`** (`printTimeLeftOrigin:
  "printer"`) [verified on 2.0.0rc6: a file with a single `M73 P0 R1` showed
  `completion: 0.0` at 30 % of the bytes and `printTimeLeft: 60`]. OrcaSlicer
  writes `M73 P%s R%s` throughout unless `disable_m73` is set [orca
  `GCodeProcessor.cpp`], so 2.0 progress tracks Orca's estimate.
- `printTimeLeftOrigin`: `linear | analysis | estimate | average |
  mixed-analysis | mixed-average | printer` (`printer` is 2.0) [src].
- `estimatedPrintTime`/`filament` come from OctoPrint's own G-code analysis
  and are **null while printing a fresh upload**: `gcodeAnalysis.runAt: idle`
  (default) pauses and aborts analysis while a print runs [src][verified]. We
  already know Orca's estimate, so use ours and treat OctoPrint's as a fallback
  for outside prints. The analysis estimate is a crude model: 302 s for a file
  the virtual printer ran in 35 s.
- After a print ends (done, cancelled or failed), **the file stays selected**:
  `state` returns to `Operational` with `job.file` still set. After a finish,
  `completion` stays 100. After a cancel, progress fields are null
  [verified]. Use events (or a remembered "we saw it running") to know an
  outcome. `/api/job` alone can't tell "finished" from "selected, never started".
- Printer disconnected: `state: "Offline"` and all job/progress fields null
  [verified].
- 2.0 adds `error` (null), `job.file.upload` and `job.user`, and drops
  `lastPrintTime` / `averagePrintTime` only with `X-OctoPrint-Api-Version: 2.0.0`
  [src `schema/api/job.py`, verified].

### Push channel (SockJS) [doc + src + verified]

- **Raw websocket endpoint: `/sockjs/websocket`** (sockjs-tornado's
  `RawWebSocketTransport`). Frames are plain JSON in both directions. No `o`/`a[...]`/`h` SockJS framing [src][verified].
- **Origin check**: OctoPrint patches tornado's `check_origin` to require the
  Origin's scheme, host and port to equal the request URL's. Tornado only
  checks when an `Origin` header is present, so a server-side client should
  **omit `Origin`** [src].
- Handshake (works on 1.11.8 and 2.0.0rc6 [verified]):
  1. `POST /api/login` with `X-Api-Key`, body `{"passive": true}` → user
     record plus `"session": "<hex>"`, `"name": "admin"`. **POST only**: the
     doc's diagram shows GET. Its rate limit counts only 403 failures [src].
  2. Open the socket, then send (in this order, subscribe *before* auth to avoid
     an initial flood):
     ```json
     {"subscribe": {"state": {"logs": false, "messages": false}, "events": true, "plugins": false}}
     {"auth": "admin:36cc2035c7279460c24a0b7ca5769eb47013701d3854f76c4a3b658231701c87"}
     {"throttle": 4}
     ```
     `throttle` n means at most one `current` per n×500 ms. Without the `auth`
     message the socket receives **nothing** status-related (it needs `STATUS`).
  3. Server → client: `connected` (version, `plugin_hash`, `config_hash`,
     permissions...), `history` (same shape as `current` plus history), then
     `current` and `event` continuously. With throttle 4, about one
     `current` every 2 s idle or printing [verified].
  4. `reauthRequired {"reason": ...}`: the session went stale (e.g. OctoPrint
     restarted, since sessions are in memory). Redo passive login + `auth`, or
     simply reconnect.
- Ignore unknown message types (`timelapse`, `plugin`, `slicingProgress`...).

`current` payload (real 1.11.8 message, trimmed):
```json
{"current": {
  "state": {"text": "Printing", "flags": {"operational": true, "printing": true, "cancelling": false,
            "pausing": false, "resuming": false, "finishing": false, "closedOrError": false,
            "error": false, "paused": false, "ready": false, "sdReady": true}, "error": ""},
  "job": {"file": {"name": "farm job #12 (test).gcode", "path": "farmslicer/farm job #12 (test).gcode",
                   "display": "farm job #12 (test).gcode", "origin": "local", "size": 8377, "date": 1791874545},
          "estimatedPrintTime": null, "averagePrintTime": null, "lastPrintTime": null,
          "filament": null, "user": "admin"},
  "progress": {"completion": 18.80, "filepos": 1575, "printTime": 0, "printTimeLeft": null,
               "printTimeLeftOrigin": "linear"},
  "currentZ": null,
  "temps": [{"time": 1791874546, "tool0": {"actual": 21.3, "target": 210.0},
             "bed": {"actual": 31.3, "target": 60.0}, "chamber": {"actual": null, "target": null}}],
  "offsets": {}, "busyFiles": [], "markings": [], "logs": [], "messages": [], "resends": {...},
  "serverTime": 1791874546.1
}}
```
- `temps` is a list of points since the last message, which **can be empty**.
  Keep the last known temperatures. `chamber` appears with nulls when absent.
- **Shape quirk**: when nothing is selected, `job.filament` is
  `{"length": null, "volume": null}`. Otherwise it is `null` or
  `{"tool0": {"length", "volume"}}` [verified]. Deserialize leniently
  (`serde_json::Value` or `#[serde(default)]` everywhere).
- 2.0 adds `currentTool` and `health` and drops `resends` [verified rc6].

`event` payload: `{"event": {"type": "<Name>", "payload": {...}}}`.

Events that matter [doc events/index.rst; payloads verified]:

| Event | Payload (relevant) | Use |
|---|---|---|
| `PrinterStateChanged` | `state_id` (`OFFLINE, OPENING_SERIAL, DETECT_SERIAL, CONNECTING, OPERATIONAL, STARTING, PRINTING, PAUSING, PAUSED, RESUMING, CANCELLING, FINISHING, ERROR, CLOSED, CLOSED_WITH_ERROR, TRANSFERING_FILE`), `state_string` | state machine |
| `Connected` / `Disconnected` | `port`, `baudrate` (2.0: `connector` + connector params) | serial link |
| `Error` | `error`, `reason`, `consequence` | surface |
| `FileSelected` | `name, path, origin, size(null), owner, user` | |
| `PrintStarted` | `name, path, origin, size, owner, user` | match our print |
| `PrintPaused` | + `position{x,y,z,e,t,f}`, `fileposition`, `progress`, `user` | |
| `PrintResumed` | `name, path, origin, size, owner, user` | |
| `PrintCancelling` | + `user`, `firmwareError` | |
| `PrintCancelled` | + `time`, `fileposition`, `progress`, `position`, `user` | |
| `PrintFailed` | + `time`, `reason`: `cancelled` or `error`, `error` (on error) | terminal |
| `PrintDone` | + `time` (s) | terminal (success) |
| `Upload` | `name, path, target, select, print, effective_select, effective_print, userdata` | |
| `FileAdded` / `FileRemoved` | `storage, path, name, type, operation` | |
| `MetadataAnalysisFinished` | `name, path, origin, result{estimatedPrintTime, filament, dimensions, printingArea...}` | |
| `PositionUpdate`, `Home`, `ChartMarked`, `plugin_*` | noise | ignore |

Observed sequences [verified]:
- Start via upload with `print=true`: `FileAdded`, `UpdatedFiles`,
  `MetadataAnalysisStarted`, `FileSelected`, `PrinterStateChanged(STARTING)`,
  `PrintStarted`, `PrinterStateChanged(PRINTING)`, then `Upload` (*after*
  `PrintStarted`).
- Finish: `PrinterStateChanged(FINISHING)`, `PrintDone{time}`,
  `MetadataStatisticsUpdated`, `PrinterStateChanged(OPERATIONAL)`.
- Pause/resume: `PAUSING` → `PrintPaused` → `PAUSED` → `RESUMING` →
  `PrintResumed` → `PRINTING`.
- Cancel: `PrintCancelling` → `CANCELLING` → `PrintCancelled` →
  `PrintFailed{reason:"cancelled"}` → `OPERATIONAL`. **Treat `PrintFailed`
  with `reason == "cancelled"` as "cancelled", not "failed"**, or key the outcome
  off `PrintCancelled`.
- Error mid-print (serial drop / firmware kill): `PrintFailed{reason:"error", error}`
  without `PrintCancelled`, state goes to `ERROR`/`CLOSED_WITH_ERROR` [src
  `printer/standard.py::on_comm_state_change`].

Events are not replayed. After a socket reconnect, resync from `/api/job` and
`/api/printer`, and reconcile in-flight prints with the file's `prints` history
(section 5).

---

## 3. Upload

### `POST /api/files/{local|sdcard}` (2.0: `local|printer`) [doc + src + verified]

`multipart/form-data`, `Content-Length` required (reqwest's multipart sets it
for known-length parts). Fields:

| Field | Meaning |
|---|---|
| `file` | the file. The filename sets the stored name (RFC 5987 `filename*=` supported) |
| `path` | parent folder within the storage. **Missing folders are created** (`path=farmslicer` worked on a fresh install [verified]) |
| `select` | `true` to select after upload. No effect if not operational |
| `print` | `true` to start. Implies select. No effect if not operational or busy |
| `userdata` | a JSON string stored as file metadata `userdata`, returned on file info [verified] |
| `foldername` | create a folder instead (local only) |

Response **201 Created** + `Location` (the doc examples wrongly say 200) [verified]:
```json
{
  "done": true,
  "effectivePrint": true,
  "effectiveSelect": true,
  "files": {"local": {
    "name": "farm job #12 (test).gcode", "origin": "local",
    "path": "farmslicer/farm job #12 (test).gcode",
    "refs": {"download": "http://127.0.0.1:5077/downloads/files/local/farmslicer/farm%20job%20%2312%20%28test%29.gcode",
             "resource": "http://127.0.0.1:5077/api/files/local/farmslicer/farm%20job%20%2312%20(test).gcode"}}}
}
```
- **Use `files.local.path` from the response as the canonical path**. Names are
  sanitized with `pathvalidate` (spaces, `#` and parentheses survive [verified];
  `/` and `\` are rejected; a leading `.` is stripped). With
  `feature.enforceReallyUniversalFilenames` they are ASCII-fied, spaces become `_`.
- Paths in URLs must be percent-encoded per segment (`#` → `%23`).
- **Re-uploading an existing path overwrites it** (201, `FileAdded` again)
  unless it is the file currently printing → **409** [doc, src]. Upload with a
  unique name (`<jobid>-<slug>.gcode`) to keep tracking unambiguous.
- `print=true` while offline or busy → **still 201** with
  `effectivePrint: false` [verified]. On 2.0.0rc6 a successful `print=true`
  returned `effectivePrint: true, effectiveSelect: false` [verified], so
  read `effectivePrint` only.
- Other codes: 400 (no file, bad userdata JSON), 404 (bad location), 415 (not
  `gcode|gco|g|gc~` or `stl`), 500.
- Size limit: `server.uploads.maxSize`, default **1 GB** [src]. Non-upload
  request bodies are capped at 100 KB.
- Accepted machine-code extensions: `gcode, gco, g, gc~` [src, same in 2.0].
  **No `.bgcode`, no `.3mf` / `.gcode.3mf`**.
- Uploads are buffered to disk by tornado before the API sees them. Big files
  over Wi-Fi to a Pi take a while, so give the request a long timeout and show
  progress client-side.
- Recommended send: upload without `print` → `POST /api/files/local/<path>`
  `{"command":"select","print":true}` → **204**, or **409** if a print is
  active or the printer isn't operational [verified]. That gives a definite
  error instead of a silent `effectivePrint: false`.

### File info `GET /api/files/local/<path>` [doc + verified]

```json
{
  "date": 1791874545, "display": "farm job #12 (test).gcode",
  "gcodeAnalysis": {
    "dimensions": {"depth": 99.0, "height": 0.0, "width": 100.0},
    "estimatedPrintTime": 302.47,
    "filament": {"tool0": {"length": 450.0, "volume": 0.0}},
    "printingArea": {"maxX": 100.0, "maxY": 99.0, "maxZ": 0.0, "minX": 0.0, "minY": 0.0, "minZ": 0.0},
    "travelArea": {...}, "travelDimensions": {...}
  },
  "hash": "3ffd1844bb71d5bc7d4e55f7b855164a97330d72",
  "name": "farm job #12 (test).gcode", "origin": "local",
  "path": "farmslicer/farm job #12 (test).gcode",
  "prints": {"failure": 0, "success": 2,
             "last": {"date": 1791874672.45, "printTime": 27.56, "success": true}},
  "refs": {"download": "...", "resource": "..."},
  "size": 8377,
  "statistics": {"averagePrintTime": {"_default": 31.39}, "lastPrintTime": {"_default": 27.56}},
  "type": "machinecode", "typePath": ["machinecode", "gcode"],
  "user": "admin",
  "userdata": {"farmslicer": {"job": 12}}
}
```
- `hash` is **SHA-1** (40 hex), not MD5 as documented, and it is **null on
  2.0.0rc6** [verified].
- Plugin metadata (e.g. `thumbnail`, `thumbnail_src`, `userdata`) is merged
  at the **top level** of the file object [verified].
- `prints.last.success` + `date` give a post-hoc outcome if we missed the events.
- Analysis queue: runs on upload at high priority, **paused while printing**
  (`gcodeAnalysis.runAt: idle`), restarted after the print (a second
  `MetadataAnalysisStarted` arrives after `PrintDone`) [verified].
- Listing: `GET /api/files?recursive=true` (1.x: `{"files": [...], "free": ...}`;
  2.0 with version header: per-storage objects with `capabilities`).
- Delete: `DELETE /api/files/local/<path>` → 204. **409 "Trying to delete a file
  that is currently in use"** while printing or paused [verified].

---

## 4. Control

### `POST /api/job` (PRINT) [doc + verified]

| Body | Result |
|---|---|
| `{"command":"start"}` | 204; starts the **currently selected** file. 409 if a print is active ("did you mean 'restart'?") |
| `{"command":"pause","action":"pause"}` | 204; no-op if already paused. 409 if no active job |
| `{"command":"pause","action":"resume"}` | 204 |
| `{"command":"pause","action":"toggle"}` (or no action) | toggle |
| `{"command":"cancel"}` | 204; 409 `"Printer is neither printing nor paused, 'cancel' command cannot be performed"` when idle |
| `{"command":"restart"}` | only while paused; cancel + start from line 0 |

204 means "accepted". The state change arrives later via `PrinterStateChanged`
(PAUSING → PAUSED took about 1 s on the virtual printer). Implement
"wait for state X with timeout" the way the Bambu ack/retry does.

### Temperatures (CONTROL) [doc + verified]

- `POST /api/printer/tool` `{"command":"target","targets":{"tool0":210}}` → 204
  (`"tool"` = the current extruder, 1.11+). `0` turns it off.
- `POST /api/printer/bed` `{"command":"target","target":60}` → 204.
- `POST /api/printer/chamber` `{"command":"target","target":40}` → **409
  "Printer does not have a heated chamber"** unless the printer profile says so
  [verified].
- All return **409 "Printer is not operational"** while disconnected [verified].
  They are fine during a print.
- Cooldown = targets 0 for every tool, bed, chamber. Preheat values come from
  our filament profile (OctoPrint also has `temperature.profiles` in settings).
- `POST /api/printer/tool {"command":"flowrate","factor":N}` → `M221` (same
  int/float rule as feedrate).

### Speed [src + verified]

- `POST /api/printer/printhead {"command":"feedrate","factor":150}` → `M220 S150`, 204.
  Allowed while printing (the only printhead command that is: `jog` while
  printing → 409 "Printer is not operational or currently printing" [verified]).
- **Integer = percent; float = fraction ×100** (`_convert_rate_value`). The doc
  says 50–200 / 0.5–2.0, but 1.11.8 only enforces `>= 1` (`250` → 204
  [verified]). Clamp on our side, serialize as an integer (`u16`), never `f64`.
- **Write-only**: OctoPrint doesn't report the current feed rate (no M220 query
  parsing). Remember what we set, reset on `PrintStarted` (firmware keeps
  M220 across prints unless the start G-code resets it, so send `M220 S100`
  ourselves at print start or include it in Orca's start G-code). Map Bambu-style
  levels to percents: silent 50, standard 100, sport 124, ludicrous 166.

### Raw G-code `POST /api/printer/command` (CONTROL) [doc + verified]

`{"command":"M117 hi"}` or `{"commands":["M220 S120","M117 hello"]}` →
204. Also `{"script": "<name>", "context": {...}}`. **409 when not operational**
[verified; the doc lists no 409]. During a print commands are queued
between file lines. They may arrive after a buffered move or two.

### Connection (CONNECTION) [doc + verified]

- `GET /api/connection` → `current {state, port, baudrate, printerProfile}` +
  `options {ports, baudrates, printerProfiles, portPreference, ...}`.
- `POST /api/connection {"command":"connect","port":"VIRTUAL","baudrate":115200,"autoconnect":true}`
  / `{"command":"disconnect"}` → 204 [verified]. A "Reconnect printer" button
  in FarmSlicer is cheap to add.
- 2.0 with `X-OctoPrint-Api-Version: 2.0.0`: `current {connector, parameters{port,baudrate},
  capabilities, profile, state}`. Connect with `{"connector":"serial","parameters":{...}}`.
  The pre-2.0 form still works on 2.0 without the header [verified].

### Printer profile `GET /api/printerprofiles` [verified]

`profiles._default.{model, volume{width,depth,height,formFactor,origin},
heatedBed, heatedChamber, extruder{count, nozzleDiameter, sharedNozzle}}`. Use it for
compatibility checks (bed size, nozzle, extruder count) the way
`printing::incompatibility` checks Bambu models. OctoPrint knows nothing about
filament, so no AMS mapping.

---

## 5. Print tracking

1. Upload as `farmslicer/<job-id>-<name>.gcode` with
   `userdata={"farmslicer":{"print_id":...}}`. Record `(origin, path)`.
2. Start (select+print). Expect `PrintStarted` with that `path` (and `user` =
   the key's user). A `PrintStarted` for another path means someone started
   something else, so treat it as an outside print.
3. Running: `current.progress` / `job.file.path` == ours.
4. Terminal:
   - `PrintDone` (path matches) → success.
   - `PrintCancelled` or `PrintFailed{reason:"cancelled"}` → cancelled.
   - `PrintFailed{reason:"error"}` → failed (`error` text).
5. Missed events (socket down, FarmSlicer restart): if `/api/job` shows
   `Operational` with our file still selected, read `GET /api/files/local/<path>`
   → `prints.last {date, success}`. If `last.date` > our start time, that's
   the outcome (cancel and error both record `success: false` [src
   `log_print(..., False)`], so they can't be told apart from history).
   If `job.file.path` is ours and progress is null while Operational, it was
   cancelled [verified]. If completion is 100, done.
6. The existing "a print not yet seen running can only start" rule fits: until
   `PrintStarted`/`printing` is seen for our path, the print is only "sent".
7. OctoPrint itself never runs two jobs. Don't upload over the running file.

---

## 6. Camera

### Where the URLs come from [src + verified]

`GET /api/settings` (needs `WEBCAM`, or the whole `webcam` key is `{}`):
```json
"webcam": {
  "webcamEnabled": true,
  "streamUrl": "/webcam/?action=stream",
  "snapshotUrl": "http://127.0.0.1:8080/?action=snapshot",
  "defaultWebcam": "classic", "snapshotWebcam": "classic",
  "flipH": false, "flipV": false, "rotate90": false, "streamRatio": "16:9",
  "webcams": [{
    "name": "classic", "displayName": "Classic Webcam", "provider": "classicwebcam",
    "canSnapshot": true, "snapshotDisplay": "http://127.0.0.1:8080/?action=snapshot",
    "flipH": false, "flipV": false, "rotate90": false,
    "compat": {"stream": "/webcam/?action=stream", "snapshot": "http://127.0.0.1:8080/?action=snapshot",
               "streamRatio": "16:9", "streamTimeout": 5, "snapshotTimeout": 5, ...},
    "extras": {"stream": "/webcam/?action=stream", ...}
  }]
}
```
- Since **1.9** webcams come from `WebcamProviderPlugin`s. The bundled
  *Classic Webcam* stores its URLs in `plugins.classicwebcam.{stream,snapshot}`.
  Other providers (e.g. OctoPi's camera-streamer control plugin, multicam
  plugins) add entries to `webcams[]` with `compat` URLs only if they
  choose to. Prefer `webcams[*].compat`, fall back to top-level
  `streamUrl`/`snapshotUrl`. Apply `flipH/flipV/rotate90` in the UI.
- **There is no `/api/webcams` endpoint** (checked 1.11.8 and 2.0.0rc6 routes)
  and **no API to fetch a snapshot through OctoPrint**. The server's snapshot
  capture is internal (timelapse) [src].

### Typical values

| Setup | stream | snapshot |
|---|---|---|
| OctoPi (haproxy :80 → OctoPrint :5000, `/webcam/` → mjpg-streamer 127.0.0.1:8080) [OctoPi repo config.yaml] | `/webcam/?action=stream` | `http://127.0.0.1:8080/?action=snapshot` |
| `octoprint/octoprint` Docker (haproxy :80, same split) [image config.yaml] | `/webcam/?action=stream` | `http://localhost:8080/?action=snapshot` |
| No camera | `""` | `""` (`canSnapshot: false`) |

- **stream** is a *browser* URL, relative to the page that served OctoPrint's
  UI (normally haproxy on port 80). Resolve it against the OctoPrint base URL
  FarmSlicer uses. If the operator gave us `:5000` (OctoPrint direct), `/webcam/`
  will 404. Then try port 80 on the same host.
- **snapshot** is a *server-side* URL that OctoPrint itself fetches, so it
  usually points at `127.0.0.1`/`localhost`. **Don't use it as-is.** On
  OctoPi, mjpg-streamer listens on 127.0.0.1 only. Derive a reachable one:
  if the stream URL looks like mjpg-streamer (`?action=stream`), swap to
  `?action=snapshot` on the same reachable path (`/webcam/?action=snapshot`,
  which the Docker README documents as the external snapshot URL). Otherwise
  rewrite a loopback host to the OctoPrint host, and on failure fall back to
  grabbing the first JPEG from the MJPEG stream.
- `/webcam/` through haproxy is **unauthenticated** on OctoPi and the Docker
  image (haproxy routes it straight to mjpg-streamer). Don't send our API key
  there. Some setups put auth in front (reverse proxies, `snapshotAuth`
  basic/bearer in classicwebcam 1.11), so allow optional camera credentials.

### Proxying [practice]

- FarmSlicer pages send COOP `same-origin` + **COEP `require-corp`**, so the
  browser can't embed `http://octopi/webcam/?action=stream` cross-origin (no
  CORP header from mjpg-streamer). The server must proxy: `GET` the stream
  with reqwest (no timeout on the body), read the `Content-Type:
  multipart/x-mixed-replace;boundary=<b>` (mjpg-streamer uses
  `boundarydonotcross`), and either
  - pass the multipart body through unchanged to an `<img>` on our origin
    (simplest; one upstream connection per viewer, so fan out from one upstream
    per printer with a `tokio::sync::broadcast` of frames), or
  - split frames (`--<b>\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n<jpeg>`)
    and serve the latest JPEG as a snapshot or re-multiplex.
- Don't hold upstream streams open with no viewers: a Pi Zero/3 mjpg-streamer
  handles few clients.
- WebRTC/HLS (camera-streamer, `streamWebrtcIceServers`) is possible but out of
  scope. MJPEG covers the common setups.

---

## 7. Discovery

### Zeroconf (mDNS/DNS-SD) [src + verified]

The bundled **Discovery** plugin is enabled by default and registers two
services per instance:
- `_http._tcp.local.` TXT `{path}` (+ `u`, `p` if HTTP basic auth is configured)
- `_octoprint._tcp.local.` TXT `{path, version, api, uuid}` (+ `model`,
  `vendor` if configured in `plugins.discovery.model`)

Observed (1.11.8):
```
_octoprint._tcp.local.  "OctoPrint instance on octopi"  port 5078
  addresses: every IPv4 of the host (incl. VPN/WSL adapters)
  TXT: {"path": "/", "version": "1.11.8", "api": "0.1", "uuid": "eea05568-d0d1-4b3c-b765-759e9be4a66f"}
```
- Instance name: `OctoPrint instance "<appearance.name>"` or
  `OctoPrint instance on <hostname>`.
- **Port** = the port OctoPrint listens on, unless `plugins.discovery.publicPort`
  is set. **OctoPi sets `publicPort: 80`** (haproxy). The Docker image doesn't,
  so it advertises the internal 5000, which is wrong behind `-p 80:80`.
- Announces **all interface addresses**, even when bound to 127.0.0.1. Pick the
  address on the same subnet as the FarmSlicer host, and verify with `GET /api/version`
  (expect **403** without a key, which is still a positive "this is OctoPrint";
  `/plugin/appkeys/probe` → 204 is a better unauthenticated fingerprint).
- `uuid` is stable (`plugins.discovery.upnpUuid`) and is the printer identity
  for de-dup. `version` lets us pick 1.x vs 2.x behaviour before auth.
- In Rust: the `mdns-sd` crate can browse `_octoprint._tcp.local.`. Multicast
  doesn't cross Docker bridge networks: FarmSlicer in Docker needs
  `network_mode: host` for both this and Bambu SSDP. The production stack already
  handles SSDP somehow; check `discovery.rs` and the ops stack.

### SSDP/UPnP [src]

- NOTIFY `ssdp:alive` to 239.255.255.250:1900 about every 30 s for `NT`
  `upnp:rootdevice`, `uuid:<uuid>`, `urn:schemas-upnp-org:device:basic:1`, with
  `Server: <os>/<ver> UPnP/1.0 OctoPrint/<ver>` and
  `Location: http://<addr>:<port>/plugin/discovery/discovery.xml`. Answers
  M-SEARCH for `upnp:rootdevice`/`ssdp:all`.
- `discovery.xml`: deviceType `Basic:1`, `friendlyName`, `UDN uuid:<uuid>`,
  `presentationURL` (built from the request Host), `modelName` only if
  configured (2.0 always sets it, #5203) [verified fetch].
- Generic device type, so identify OctoPrint by the `Server` header containing
  `OctoPrint/`. The existing Bambu listener uses Bambu's own SSDP port.
  OctoPrint's is the standard 1900, so it needs its own socket (and port 1900
  is often held by the OS's SSDP service on Windows dev boxes). **M-SEARCH got
  no reply on the Windows test box [unverified on Linux]**. Zeroconf alone is
  enough. SSDP is optional.

---

## 8. Multi-tool / filament

OctoPrint has no filament/AMS model. `tool{n}` temperatures and the profile's
`extruder.count` are all there is. Treat it as single-material unless
`extruder.count > 1` (then T-commands are in the G-code; there's no mapping step).

---

## 9. Slicer specifics

- Send **plain `.gcode`** (not `.gcode.3mf`). OctoPrint 1.x and 2.0 accept
  `gcode|gco|g|gc~` only. **Prusa binary G-code (`.bgcode`) is not supported**
  by core (no reference in 1.11.8 or 2.0.0rc6 sources). OrcaSlicer doesn't
  emit bgcode anyway.
- Thumbnails: OctoPrint's serial layer strips comments before sending, so
  `; thumbnail begin ... ; thumbnail end` blocks never reach the printer
  [src `comm.strip_comment`]. Large blocks only cost upload size and skew 1.x
  byte-based progress at the start. A file with 32x32 + 300x300 PNG blocks
  printed fine [verified].
- Thumbnail formats: Orca `thumbnails_format` = `PNG | JPG | QOI | BTT_TFT |
  COLPIC` (default PNG) [orca `PrintConfig.cpp`]; tags `thumbnail`,
  `thumbnail_JPG`, `thumbnail_QOI`. Both the Slicer Thumbnails plugin and
  2.0's `gcode-thumbnail-tool` parse all three generic tags. **Use PNG** for
  OctoPrint targets. Set `thumbnails` to include a large size (e.g.
  `300x300`), since both pick the largest.
- `M73 P R`: keep Orca's `disable_m73 = false`. 2.0 uses it for progress and
  ETA. 1.x ignores it, but the firmware shows it on the LCD.
- Our pipeline emits `.gcode.3mf` for Bambu via `store_bbs_3mf`. The OctoPrint
  driver needs the raw G-code (the same `export_gcode` output before packaging).
- Start G-code for generic Marlin profiles uses `M190`/`M109`. The virtual
  printer honours both and blocks until the target is reached [verified].

---

## 10. Fake printer for tests

Use **real OctoPrint + the bundled Virtual Printer plugin**. It is the actual
server, so API fidelity is exact. The official Docker images are
awkward for this (the full image runs s6 + haproxy + mjpg-streamer and needs
a first-boot dance; the `minimal` variant is built from `python:3-slim-buster`,
its tags look stale — `edge-minimal` last pushed 2025-06 — and there are
**no 2.0 RC images**: `edge` = 1.11.8 as of 2026-10). A tiny custom image is
more predictable and lets CI pin both 1.11.8 and 2.0.x.

### Dockerfile (suggested `tests/fake-octoprint/Dockerfile`)

```dockerfile
FROM python:3.12-slim
ARG OCTOPRINT_VERSION=1.11.8          # or 2.0.0rc6 (pip needs the exact pre-release version)
RUN pip install --no-cache-dir "OctoPrint==${OCTOPRINT_VERSION}" \
 && pip install --no-cache-dir https://github.com/jneilliii/OctoPrint-PrusaSlicerThumbnails/archive/master.zip
COPY config.yaml users.yaml /seed/
RUN mkdir -p /data && cp /seed/* /data/
EXPOSE 5000
CMD ["octoprint", "--basedir", "/data", "serve", "--host", "0.0.0.0", "--port", "5000"]
```
(Drop the thumbnails plugin line for a "plain 1.x, no thumbnails" variant. On
2.0 it is redundant.)

### `config.yaml` seed [verified on 1.11.8 and 2.0.0rc6]

```yaml
server:
  firstRun: false              # skip the setup wizard
  onlineCheck: {enabled: false}
  pluginBlacklist: {enabled: false}
  seenWizards: {corewizard: 4}
plugins:
  virtual_printer:
    _config_version: 1
    enabled: true
    simulated_errors: []       # default injects resends at lines 100/105/110/115; 105 stalls for a comm timeout
  classicwebcam:
    _config_version: 1         # REQUIRED, or first-boot migration wipes stream/snapshot to ""
    stream: /webcam/?action=stream
    snapshot: http://127.0.0.1:8080/?action=snapshot
  tracking: {enabled: false}
  announcements: {_config_version: 1, enabled_channels: []}
serial:
  port: VIRTUAL
  baudrate: 115200
  autoconnect: true            # 1.x key; 2.0.0rc6 also auto-connected with it [verified]
```

### `users.yaml` seed (gives a known API key; the password hash can be junk) [verified]

```yaml
_version: 2
admin:
  active: true
  apikey: FARMSLICERTESTKEY0123456789ABCDEF
  groups: [admins, users]
  password: "x"                # unusable for UI login; API-key auth doesn't care
  permissions: []
  settings: {}
```
Alternative with a real password: `octoprint --basedir /data user add admin
--password testtest --admin`, then set `apikey:` in users.yaml.

### Run / test

```sh
docker build -t farmslicer-fake-octoprint tests/fake-octoprint
docker run --rm -p 5000:5000 farmslicer-fake-octoprint
# ready when this returns 200 (about 5-15 s; first boot writes config):
curl -H 'X-Api-Key: FARMSLICERTESTKEY0123456789ABCDEF' http://127.0.0.1:5000/api/version
```
- The printer auto-connects to `VIRTUAL` and is `Operational` about 3 s after
  the API comes up [verified]. Otherwise connect with
  `POST /api/connection {"command":"connect","port":"VIRTUAL","baudrate":115200}`.
- Approving an app key in tests: start the flow, poll once, read
  `user_token` from `GET /api/plugin/appkeys` with the seeded key, `POST
  /plugin/appkeys/decision/<token> {"decision":true}`, and poll → `api_key` [verified].
- Discovery in tests: zeroconf works from the container only with
  `--network host`. Otherwise test discovery with a fake mDNS responder or skip it.
- Camera in tests: no mjpg-streamer in this image. Run a tiny MJPEG server
  (or a Node `multipart/x-mixed-replace` stub) and point `classicwebcam.stream`/
  `snapshot` at it.

### How the virtual printer behaves [src `virtual.py` + verified]

- **Temperatures**: ambient 21.3 °C, heats/cools toward the target at about **10 °C/s**
  (cooling to ambient about 2 °C/s). `M109`/`M190` block until within 1 °C
  [src `_simulateTemps`, `_waitForHeatup`]. Observed: 21 → 210 °C in about 19 s.
- **Moves**: each `G0/G1/G2/G3` sleeps for
  `max(|Δaxis|) / (F × feedrate%/100) × 60 × 0.1` s, i.e. **10x faster than
  real time**, no acceleration. **`M220` speeds the simulation up**
  (`M220 S1000` → 100x), which is handy for long test prints. `G4` sleeps for real.
- Progress, pause (with position), resume, cancel, `PrintDone` all work.
  300 moves of 50 mm at F3000 ran in 35 s, 1500 moves in about 150 s [verified].
- Useful knobs (`plugins.virtual_printer.*`): `numExtruders`, `hasBed`,
  `hasChamber` (set it and edit the printer profile's `heatedChamber` to test
  chamber 409 vs 204), `pinnedExtruders`, `firmwareName`, `simulateReset`.
  The documented `throttle` (default 0.01) is not read by 1.11.8's
  `virtual.py` [src: no reference].
- Error injection: send `!!DEBUG:<cmd>` via `/api/printer/command`
  (`!!DEBUG:help` lists them) [src `virtual.py` help text, not exercised]:
  `trigger_fatal_error_marlin` (simulated heater failure, which should drive
  `PrintFailed{reason:"error"}` + the Error state), `drop_connection`,
  `go_awol`, `dont_answer`, `trigger_resend_lineno`,
  `trigger_resend_checksum`, `action_pause` / `action_resume` /
  `action_disconnect` (firmware-initiated host actions, i.e. a pause from the
  printer's own screen), `sleep <s>`, `sleep_after <cmd> <s>`, `resend_ratio <pct>`.
- Virtual SD card files live in `<basedir>/virtualSd`.

---

## 11. Versions

- **Current stable: 1.11.8** (2026-06-23). 1.11.x is the last line supporting
  Python 3.7/3.8. **2.0.0 is in release candidates** (rc1 2026-04-27 …
  rc6 2026-10-07). The planned 1.12 became 2.0 (schema names say
  `pre_1_12`/`pre_2_0_0`).
- Notable for us:
  - **1.9 (2023-05)**: webcams moved to `WebcamProviderPlugin`s (classic
    webcam plugin). Settings API keeps compat `streamUrl`/`snapshotUrl` and
    adds `webcam.webcams[]`.
  - **1.10 (2024-04)**: 5-minute re-authentication for sensitive operations
    (granting app keys etc.; API keys count as fresh [verified]).
  - **1.11 (2025-04)**: `tool` = current extruder in target commands; Pydantic 2;
    Python 3.13.
  - **2.0**: printer **connectors** (serial built in; Moonraker and Bambu
    connector plugins exist, so an OctoPrint 2.0 box may front a Klipper or
    Bambu printer through the same API). Printer storage renamed `sdcard` →
    **`printer`** (as a URL location). **Native thumbnails** (`refs.thumbnail*`,
    `/downloads/thumbs/<storage>/<path>[?size=WxH]`, needs `FILES_DOWNLOAD`)
    [verified rc6]. **M73-based progress/ETA**. **API versioning via
    `X-OctoPrint-Api-Version: 2.0.0`**: without the header, responses keep
    pre-2.0 shapes [verified for `/api/connection`, `/api/printer`, `/api/job`,
    upload]. Python 3.9+. The global API key goes away in 2.1.
  - `/api/version` → `{"api":"0.1","server":"1.11.8","text":"OctoPrint 1.11.8"}`.
    With the 2.0 header, the `api` field is dropped [doc].
- **Driver policy**: send **no** version header. One code path works on 1.11 and
  2.0. Opportunistically read 2.0-only extras (`refs.thumbnail`,
  `printTimeLeftOrigin: "printer"`). Branch on `server` version only where
  needed (thumbnails).

---

## 12. Risks and open points

1. **Selected-file trap**: `start` reuses the last selected file. Use
   select+print on an explicit path, never a bare `start`.
2. **Silent non-start**: upload `print=true` returns 201 even when nothing
   starts. Check `effectivePrint`, or better, use the separate select command
   (409 on failure).
3. **Feedrate float bug**: a float factor is ×100. Serialize integers, clamp
   10–300 ourselves. Feedrate isn't readable back.
4. **Thumbnails depend on the install**: 1.x needs the third-party plugin
   (common on OctoPi, not guaranteed). 2.0 has them natively. When neither is
   present, fall back to a camera snapshot at print start, then a placeholder.
5. **Camera URLs are often loopback or relative.** Expect heuristics and an
   operator override field ("camera URL") in printer settings.
6. **Auth surface**: the app-key flow needs the user to be logged into OctoPrint
   and to click Allow within the flow's lifetime. The 5-s poll expiry means
   FarmSlicer's server must own the polling loop. The request endpoint is rate
   limited to 3/minute.
7. **Sessions die on OctoPrint restart**: handle `reauthRequired` and socket
   close with a re-login + resubscribe and a REST resync.
8. **Event loss**: no replay. Reconcile via `/api/job` and file `prints.last`
   (cancel vs error is indistinguishable after the fact).
9. **Discovery port** may be wrong (Docker installs advertise 5000 behind
   port 80). Verify candidates with `/plugin/appkeys/probe`.
10. **2.0 is still RC**: test both versions in CI (two fake images). Watch the
    rc changelog for API changes.
11. **Not verified here**: SSDP replies (blocked on the Windows test box),
    camera-streamer URL variants on new OctoPi images, the `!!DEBUG` error
    injections, behaviour with a real serial printer (resends,
    `Offline after error`).

---

## Sources

- OctoPrint docs (tags 1.11.8 and 2.0.0rc6, `docs/api/*.rst`,
  `docs/events/index.rst`, `docs/bundledplugins/{appkeys,discovery,virtual_printer}.rst`,
  `docs/development/virtual_printer.rst`): https://docs.octoprint.org/en/master/api/
  — job, printer, files, push, connection, general (auth, versioning), datamodel.
- OctoPrint source: https://github.com/OctoPrint/OctoPrint (tags `1.11.8`,
  `2.0.0rc6`): `server/api/{files,printer,job,settings,__init__}.py`,
  `server/util/{sockjs,tornado,flask}.py`, `printer/standard.py`,
  `util/comm.py`, `printer/connection.py`, `plugins/{appkeys,discovery,classicwebcam,virtual_printer}`,
  `filemanager/{analysis.py,storage/local.py}`, `schema/api/job.py`,
  `schema/config/*.py`, `access/permissions.py`.
- Release notes: https://github.com/OctoPrint/OctoPrint/releases (1.9.0,
  1.10.0, 1.11.0, 2.0.0rc1).
- Slicer Thumbnails plugin: https://github.com/jneilliii/OctoPrint-PrusaSlicerThumbnails
  (v1.2.3, `octoprint_prusaslicerthumbnails/__init__.py`).
- gcode-thumbnail-tool (2.0 core thumbnails): https://github.com/OctoPrint/gcode-thumbnail-tool
- Docker image: https://github.com/OctoPrint/octoprint-docker (README,
  Dockerfile, `root/etc/haproxy/haproxy.cfg`, `root/octoprint/octoprint/config.yaml`,
  `minimal/`); tags from hub.docker.com `octoprint/octoprint`.
- OctoPi defaults: https://github.com/guysoft/OctoPi
  (`src/modules/octopi/filesystem/home/pi/.octoprint/config.yaml`).
- Community notes on OctoPi webcam URLs: https://community.octoprint.org/t/octopi-pi-camera-port-8080-does-not-work/31024,
  https://community.octoprint.org/t/new-camera-streamer/52800
- OrcaSlicer v2.4.2 (local submodule): `src/libslic3r/PrintConfig.cpp`
  (`thumbnails_format`, `disable_m73`), `GCode/GCodeProcessor.cpp` (M73),
  `GCode/Thumbnails.cpp`.
