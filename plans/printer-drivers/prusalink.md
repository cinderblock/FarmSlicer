# PrusaLink driver reference

`plans/printer-drivers/prusalink.md`. Research for step 5 of `plans/printer-drivers.md`.

This is a reference for the engineer implementing the PrusaLink driver: auth, API surface, the
state machine, upload and start, control, camera, thumbnails, discovery, slicer output, and a fake
printer for tests.

**Confidence markers:**
- **[src]**: read in source. Buddy firmware is `prusa3d/Prusa-Firmware-Buddy` master
  `1ce23f3` (2026-08-27, `version.txt` 6.10.1; the latest tag is v6.10.3). The Python Prusa-Link
  is master as of 2026-10. Prusa-Link-Web is `spec/openapi.yaml`. pyprusalink is master.
  OrcaSlicer is the v2.4.2 submodule.
- **[doc]**: Prusa help articles, Home Assistant docs, or a GitHub PR.
- **[community]**: forum or user reports.
- **[unverified]**: reasoned from the above but not tested.

Paths are relative to each repository: `lib/WUI/...` is Buddy, `prusa/link/...` is Python.

## 0. Two different products behind one name

| | **Buddy PrusaLink** (built into firmware) | **Python Prusa-Link** (Raspberry Pi) |
|---|---|---|
| Printers | MINI/MINI+, MK3.5(S), MK3.9(S), MK4(S), XL, CORE One / One L (all "Buddy"/"xBuddy" boards, firmware 4.x–6.x) | MK2.5(S), MK3(S)(+) over serial from a Pi |
| Server | lwIP + custom `nhttp` server on the printer MCU (port 80, 3 active connections) | poorwsgi app, port 8080 (images iptables-forward 80→8080) |
| Status | Current, actively developed | Last release 0.8.2 (2024-12-18). Effectively maintenance-only |
| Storage | One: `usb` (USB stick), path `/usb/` | `local` (Pi disk, writable) + `sdcard` (printer SD, read-only/no upload) |
| Auth | Digest (`maker` / password) **or** `X-Api-Key: <same password>` | Digest (user-chosen username/password) **or** `X-Api-Key` (a separate key) |
| Control beyond pause/resume/stop | **None** | OctoPrint-style temps / speed / flow / jog |
| Camera | None on LAN | `/api/v1/cameras/...` for Pi-attached cameras (JPEG snapshots) |
| mDNS | `_prusalink._tcp`, port 80, empty TXT | `_prusalink._tcp`, `_http._tcp`, `_octoprint._tcp`, TXT `path=/` |
| `.bgcode` | Yes | No (MK3 firmware can't print it) [unverified for Prusa-Link itself] |

The rest of this document is about Buddy unless it says Python. Treat the Python variant as a
second-tier sub-mode: same v1 endpoints, plus extra capabilities.

## 1. Auth

### Buddy (all current firmware) [src]
- **Realm:** `"Printer API"` (`nhttp/status_page.h`). **Username:** hardcoded `maker`
  (`wui_api.h` `PRUSA_LINK_USERNAME`).
- **Password:** stored in config_store `prusalink_password`. It is randomly generated on first
  enable, and shown and editable at the printer under *Settings > Network > PrusaLink*. An empty
  password means login is disabled and every authenticated request fails.
- **Two schemes are accepted on every protected route** (`/api/*`, `/api/v1/*`, `/thumb/*`,
  `/usb/*`):
  1. `X-Api-Key: <password>`. The parser compares the header byte by byte against the **same
     password** (`req_parser.cpp`, `Names::XApiKey`). The firmware's own integration tests use
     exactly this (`tests/integration/test_prusa_link.py`: `{'X-Api-Key': PRUSALINK_PASSWORD}`).
     On failure the server answers `401` with `WWW-Authenticate: ApiKey realm="Printer API"`.
  2. HTTP Digest. This is the default when no `X-Api-Key` header is present. The challenge is
     `WWW-Authenticate: Digest realm="Printer API", nonce="<16 hex>", stale=false|true`.
- **Recommendation:** use `X-Api-Key: <password>`. It is stateless, needs no challenge round
  trip, and works for upload `PUT` without replaying a body. Fall back to Digest only if a firmware
  ever rejects the key; none in the current tree does. The UI should ask for the password and
  call it "PrusaLink password" (older firmware/UI called the same value "API key").

### Digest quirks (Buddy) [src]
The implementation is RFC 2069 style, not full RFC 2617/7616:
- **No `qop`, `cnonce`, `nc`, `opaque` or `algorithm` in the challenge.** The expected response
  is `MD5(HA1:nonce:HA2)` with `HA1 = MD5("maker:Printer API:<password>")` and
  `HA2 = MD5("<METHOD>:<request-target>")`. A client that adds `qop=auth` fields produces a
  different hash and fails.
- **Only `nonce` and `response` are parsed** from `Authorization` (`utils/gen-automata/http.py`).
  `username`, `realm` and `uri` are ignored. HA2 uses the **actual request-line URI**
  (`parser.uri()`), so the `uri=` parameter must equal the request target byte for byte,
  including any percent-encoding.
- **The nonce** is `(32-bit boot-random << 32) | uptime_seconds`, rendered as 16 hex digits. It
  is **valid for 300 s** (`http::valid_nonce_period`) and invalidated by a reboot. With an
  expired nonce and a correct hash, the server returns 401 with `stale=true`. Recompute with the
  new nonce. A good client caches the nonce and reuses it until a 401 arrives.
- **Older firmware (before ~5.2, PR prusa3d/Prusa-Firmware-Buddy#3665, merged 2024-01-15)** had
  two parser bugs [doc]:
  - An unquoted `algorithm=MD5` returned 400.
  - The `Digest` scheme token was not consumed separately, so a header with `nonce` as the first
    parameter broke.

  To work on every version, send exactly
  `Digest username="maker", realm="Printer API", nonce="…", uri="…", response="…"`: all values
  quoted, `username` first, no `algorithm`/`qop`. pyprusalink's `DigestAuthWorkaround` does this.
  Most Rust digest crates add `algorithm=MD5` and `qop`, so write the roughly 20-line computation
  by hand.

### Firmware history [doc/community]
- The 4.x MINI firmware had an "API key" in the menu, and `X-Api-Key` was the only scheme.
- Around 4.6/4.7–5.0, Digest with `maker` + password became the documented method. The same
  secret still works as `X-Api-Key`; forum reports conflict, but the current source and tests
  settle it.
- The v1 API requires **firmware ≥ 4.7.0** (Home Assistant docs). The MINI skipped 4.7/5.0 and
  went 4.4 → 5.1+.
- **Minimum to support:** Buddy ≥ 5.1 (MINI) or ≥ 5.0 (MK4/XL). Practically, anything 6.x.
- **Python Prusa-Link [src]** (`prusa/link/web/lib/auth.py`): `check_api_digest` uses
  `X-Api-Key` if the header is present (compared to a separate stored `api_key`), otherwise Digest
  via poorwsgi with the username set in the wizard (not fixed to `maker`). The realm comes from the
  config. Support both a username field and an API-key field for this variant.

## 2. API versions

| Endpoint | Buddy 6.x | Notes |
|---|---|---|
| `GET /api/version` | yes | Legacy/OctoPrint-shaped. Used for identification (below) |
| `GET /api/printer` | yes | Legacy telemetry + `state.flags` (incl. Prusa extension `link_state`) |
| `GET /api/job`, `POST /api/job` | yes | Legacy. POST `{"command":"cancel"}` / `{"command":"pause","action":"pause|resume|toggle"}` |
| `POST /api/files/...` multipart | **410 Gone** | Legacy OctoPrint multipart upload removed |
| `GET /api/v1/info` | yes | |
| `GET /api/v1/status` | yes | **The main poll target** |
| `GET /api/v1/job` | yes | 204 when no active job |
| `PUT /api/v1/job/{id}/pause\|resume`, `DELETE /api/v1/job/{id}` | yes | `/continue` is **not** implemented on Buddy (400). It exists only in Python/spec |
| `GET /api/v1/storage` | yes | Always exactly one storage: `usb` |
| `GET /api/v1/transfer`, `DELETE /api/v1/transfer/{id}` | GET yes | DELETE is not routed on Buddy (only `/api/v1/transfer` GET) [src] |
| `GET/HEAD/PUT/POST/DELETE /api/v1/files/usb/<path>` | yes | Upload, start, info, delete. PUT with header `Create-Folder: ?1` makes a folder |
| `GET /thumb/s/usb/<path>`, `GET /thumb/l/usb/<path>` | yes | PNG previews |
| `GET /usb/<path>` | yes | Raw file download (`Content-Disposition: attachment`, no caching) |
| `/api/v1/cameras*`, `/api/v1/update/*`, `/api/printer/{tool,bed,printhead}` | **no** | Python only |

Use v1 for everything except identification.

### Identification
`GET /api/version` example (Buddy 6.10) [src `basic_gets.cpp` `get_version`]:
```json
{"api":"2.0.0","server":"2.1.2","nozzle_diameter":0.40,"text":"PrusaLink","hostname":"prusa-mk4",
 "firmware":"6.10.1+12345","printer":"1.4.1","capabilities":{"upload-by-put":true}}
```
- `printer` is `"<type>.<version>.<subversion>"` of the printer model. Per pyprusalink notes,
  `firmware` and `printer` only appeared in **6.5.1+** (Core One L), 6.5.3 (MK4/Core One family),
  and not yet on the XL 6.4 / MINI 6.4 tracks. **Treat them as optional.**

| `printer` | Model | M862.3 id |
|---|---|---|
| 1.3.0 | MK3 | MK3 |
| 1.3.1 | MK3S | MK3S |
| 1.3.5 | MK3.5 | MK3.5 |
| 1.3.6 | MK3.5S | MK3.5S |
| 1.3.9 | MK3.9 | MK3.9 |
| 1.3.10 | MK3.9S | MK3.9S |
| 1.4.0 | MK4 | MK4 |
| 1.4.1 | MK4S | MK4S |
| 2.1.0 | MINI | MINI |
| 3.1.0 | XL | XL |
| 3.1.1 | XL (XLS) | XLP |
| 4.1.0 | iX | iX |
| 7.1.0 | CORE One | COREONE |
| 7.2.0 | CORE One (OAK) | COREONEOAK |
| 7.10.0 | CORE One INDX | COREONEINDX |
| 8.1.0 | CORE One L | COREONEL |
| 8.10.0 | CORE One L INDX | COREONEL-INDX |

The table comes from `include/common/printer_model_data.hpp`.

**Fallbacks when `printer` is absent:**
- Default hostnames from `src/common/config.h`: `prusa-mk4`, `prusa-mk3-5`, `prusa-xl`,
  `prusa-mini`, `prusa-core-one`, `prusa-core-one-l` (users can rename them).
- Otherwise ask the user to pick the model.
- The Python variant returns `text` like `"PrusaLink 0.8.2"` plus `version`/`sdk` and
  `printer: "1.3.1"`-style values.

`GET /api/v1/info` on Buddy returns only these fields [src]:
```json
{"nozzle_diameter":0.40,"mmu":false,"serial":"CZPX4720X004XC34242","hostname":"prusa-mk4","min_extrusion_temp":170}
```
`serial` is the stable identity. Use it to dedupe discovery and to detect a swapped printer behind
a reused IP. The spec's `name`/`location`/`farm_mode`/`sd_ready`/`active_camera` fields are
Python-only.

## 3. Status

### `GET /api/v1/status` (Buddy) [src `nhttp/status_renderer.cpp`]
```json
{
  "job": {"id": 312, "progress": 42.00, "time_remaining": 1840, "filament_change_in": 600, "time_printing": 1311},
  "storage": {"path": "/usb/", "name": "usb", "read_only": false},
  "transfer": {"id": 72855542, "time_transferring": 30, "progress": 65.82, "transferred": 123084800},
  "printer": {
    "state": "PRINTING",
    "temp_bed": 59.9, "target_bed": 60.0,
    "temp_nozzle": 214.8, "target_nozzle": 215.0,
    "axis_z": 1.2,
    "flow": 100, "speed": 100,
    "fan_hotend": 5600, "fan_print": 3900
  }
}
```

**Field behaviour:**
- `job` is present only when `printer_state::has_job()`: state PRINTING or PAUSED, or ATTENTION
  while a print or print-preview is active.
- **`job` is absent in FINISHED / STOPPED / IDLE.** The finished job's id is not re-reported
  anywhere.
- `time_remaining` and `filament_change_in` are omitted when the value is unknown.
- `transfer` is present only while an upload is running.
- `axis_x`/`axis_y` are present only when not printing.
- `flow` and `speed` are integer percentages (M221/M220).
- Fans are in RPM.
- Temperatures are for the **active** hotend only. The XL shows the active tool and no per-tool
  breakdown.
- There is no chamber temperature, no filament/MMU slot info, and no error code/text. Errors and
  dialogs are visible only via Prusa Connect.

**`printer.state` on Buddy** [src `src/state/printer_state.cpp`]. PrusaLink calls
`get_state(ready=false)`, so `READY` never appears and `ERROR` is effectively unreachable: a red
screen halts the networking task.

| state | When | Driver meaning |
|---|---|---|
| `IDLE` | Idle, print preview init/image, PrintInit, Exit | Available |
| `BUSY` | Crash recovery, power-panic recovery, selftests/calibrations, load/unload filament (not during a print), preheat menu, Wait FSM, network setup | Not available, not printing |
| `PRINTING` | Printing, **Aborting\_\***, **Finishing\_\***, PrintPreviewConfirmed, serial print init | Printing. Note that aborting/finishing still show PRINTING |
| `PAUSED` | Pausing\_\*, Paused, Resuming\_\*, power-panic awaiting resume, QuickPause | Paused |
| `ATTENTION` | Print-preview questions (wrong filament, **G-code/printer model mismatch**, tool mapping, newer FW hint), crash-recovery failures, filament runout/stuck during a print, nozzle-cleaning failure, nozzle mismatch, warnings needing a click | Needs a human at the printer |
| `FINISHED` | `State::Finished`: print done, finish screen still up | Last job finished OK |
| `STOPPED` | `State::Aborted`: print cancelled, finish screen still up | Last job stopped |
| `UNKNOWN` | Defensive default | Treat as offline/unknown |

FINISHED and STOPPED persist until someone closes the finish screen (`print_exit()`, which goes to
IDLE) or the **next print starts**. A remote start is allowed from IDLE, FINISHED or STOPPED
(`remote_print_ready`). Unlike Connect's "Set ready" flow, no bed-clear confirmation is needed.

**Python Prusa-Link** additionally emits `READY` (the user toggled "Set ready" in the LCD menu)
and `ERROR` (serial link lost, etc.). Its status also carries `storage` as a list and
`camera: {"id": ...}`.

### `GET /api/v1/job` (Buddy) [src `basic_gets.cpp` `get_job_v1`]
Returns `204 No Content` unless `has_job()` (same rule as above).
```json
{
  "id": 312,
  "state": "PRINTING",
  "progress": 42.00,
  "time_remaining": 1840,
  "time_printing": 1311,
  "file": {
    "refs": {
      "icon": "/thumb/s/usb/BENCHY~1.BGC",
      "thumbnail": "/thumb/l/usb/BENCHY~1.BGC",
      "download": "/usb/BENCHY~1.BGC"
    },
    "name": "BENCHY~1.BGC",
    "display_name": "benchy_0.4n_0.2mm_PLA_MK4S_1h2m.bgcode",
    "path": "/usb",
    "size": 1234567,
    "m_timestamp": 1760000000
  }
}
```
- `state` here is PRINTING, PAUSED, or `PAUSED` for ATTENTION. FINISHED/STOPPED are coded but
  unreachable because of the 204 rule.
- `file.name`/`path` are the **8.3 short name** (FAT SFN). `display_name` is the long name.
  **Match uploads by `display_name`** (LFN, max 167 chars).
- `refs` are absolute server paths without the `/api/v1/files` prefix. `size`/`m_timestamp` may
  be missing if `stat` fails.
- There is no `meta` (Buddy doesn't parse file metadata for the API). Get estimates, filament,
  etc. from our own slice stats.
- `inaccurate_estimates` and `serial_print` are spec/Python-only.

### No push channel
Buddy has HTTP only: no WebSocket, SSE or MQTT on the LAN. Python has `/sockjs/websocket` for its
own UI; don't rely on it. Prusa Connect is the only push path, and it's cloud.

**Polling recommendation:**
- `/api/v1/status` every **2 s** while PRINTING/PAUSED/ATTENTION/BUSY or during an upload or
  start handshake, every **5 s** when IDLE/FINISHED/STOPPED, and every **15–30 s** for printers
  unreachable/offline (with backoff).
- `/api/v1/job` only when `status.job.id` changes (or first seen), and at most every 30 s while
  printing.
- `/api/version` + `/api/v1/info` on connect and every ~10 min.
- Home Assistant polls at 5 s "fast" / 30 s "slow" with a 5 s request timeout
  (`homeassistant/components/prusalink/coordinator.py`).
- **Server limits** [src `nhttp/server.h`]: 3 active connection slots, an active connection is
  dropped after **10 s** without progress, and idle keep-alive connections after 60 s. The
  printer's own web UI and Connect compete for those slots. Keep **one in-flight request per
  printer** (plus the upload on its own connection), use keep-alive (responses are
  `Transfer-Encoding: chunked`), and set a 5–8 s timeout on polls.

## 4. Upload + start

### Upload [src `nhttp/gcode_upload.cpp`, `link_content/prusa_link_api_v1.cpp`]
```
PUT /api/v1/files/usb/<url-encoded path>
X-Api-Key: <password>
Content-Length: 1234567              (required; 411 without it; chunked bodies are not supported)
Content-Type: application/octet-stream   (ignored; PrusaSlicer/Orca send text/x.gcode)
Print-After-Upload: ?1               (accepted truthy values: "?1", "1", "true"; omit header for no)
Overwrite: ?1                        (only "?1" is recognised)
<body>
```

**Responses:**

| Status | Meaning |
|---|---|
| `201 Created` | Success. If Print-After-Upload was set, also means **the print started** |
| `409 Conflict` | "Another transfer in progress" (only one transfer at a time, including Connect downloads); "File already exists" (no Overwrite); "File is busy" (overwriting the file being printed); "Can't print right now" (upload succeeded and the file **stays**, but the start was refused) |
| `415` | "Not a GCODE" (extension) |
| `422` | Invalid characters in the file name |
| `404` | Destination directory missing (folders are **not** auto-created; create with `PUT …/dir` + `Create-Folder: ?1`, 201 or 409 "Already exists") |
| `507 Insufficient Storage` | No space; the file is preallocated at Content-Length up front |
| `501` | Zero-length body |
| `503` | Stopped from Connect |
| `408` / `400` | Timeout or truncated body |
| `401` | Auth |

- **Accepted extensions** [src `src/common/filename_type.cpp`]: `.g`, `.gc`, `.gco`, `.gcode`,
  `.bgcode`, `.bgc`. Firmware updates use `.bbf` (never upload these).
- Path rules: everything is under `/usb/`, `..` is rejected, duplicate slashes are collapsed, and
  the URI is percent-decoded. Keep names short and ASCII (`[A-Za-z0-9._-]`). The full path is
  limited to 103 chars of SFN path; the LFN is ≤ 167 chars.
- **Speed** [community, a Prusa developer quoted]: the target is ~200–300 KB/s, bottlenecked by
  network → USB.
  - Reports: 85 MB over Ethernet in 3m52s (~370 KB/s).
  - 24 MB over MK4 Wi-Fi in 6m40s (~60 KB/s), 4m15s over Ethernet.
  - MINI Wi-Fi: 9.5 MB in 91 s (~100 KB/s).

  A multi-hour plain G-code (20–80 MB) can take **minutes to tens of minutes**. Implications:
  - Use a long upload timeout scaled by size (e.g. 60 s + size / 30 KB/s).
  - Report progress from bytes written to the socket, or from `status.transfer.progress`.
  - Never retry blindly: check `HEAD`/`GET /api/v1/files/usb/<path>` (size) after a failure.
  - Prefer `.bgcode` (typically 3–5× smaller) if we can produce it (section 9).
- **The firmware writes as it receives.** There is no checksum; the 10 s inactivity timeout
  applies, so stream steadily.

### Start
- **Option A (one step):** `PUT` with `Print-After-Upload: ?1`. The 201 arrives only after the
  whole body is written and `print_start` succeeds. A refused start gives 409 with the file left
  on the USB.
- **Option B (recommended for clearer errors):** `PUT` without Print-After-Upload, then
  `POST /api/v1/files/usb/<path>` (empty body). The POST returns 204 (started), 409 (not in a
  printable state), or 404. The server closes the connection after this response by design.
  - Caveat: an upload without print-after-upload on an idle printer **pops the print-preview
    screen** on the display ("best effort", `wui_start_print(..., false)`). That is harmless; the
    POST then starts from that state.
- Starting is allowed only from **IDLE / FINISHED / STOPPED** (plus the preview screens).
  PRINTING/PAUSED/BUSY/ATTENTION give 409. Check `status.printer.state` first, so the upload isn't
  wasted.
- A remote start skips the preview and tool-mapping screens **only if the file is fully
  compatible** (`PreviewSkipIfAble::all`). Otherwise the printer goes to **ATTENTION** with a
  question on the display, and the print waits for a human. Triggers:
  - wrong printer model (M862.3);
  - nozzle diameter / HF / abrasive (M862.1);
  - G-code level (M862.5);
  - "newer firmware available" (M115 U…);
  - filament type mismatch vs the loaded filament;
  - MMU/tool mapping.

  The default `hw_check_*` severity is **Warning** (asks). Users can set Strict (refuse) or None.
  - **Driver:** surface ATTENTION as "waiting at printer".
  - **Approvals/rules:** check model, nozzle and filament ourselves before sending.

### Matching our print to the printer's reports (tracking)
- **Job ids** are a per-printer monotonic counter persisted in EEPROM [src `marlin_server.cpp`].
  It is incremented when the print-preview phase is **confirmed** (`MarkStarted`), not at upload.
  So:
  1. Before sending, record `last_seen_job_id` (from the last status that had `job`; may be
     unknown).
  2. After 201/204, poll status every 1–2 s. Expect PRINTING with `job.id > last_seen_job_id`,
     then `GET /api/v1/job` and confirm `file.display_name == our_filename`. Store
     `(printer_id, job_id)` on our print.
  3. If the state is **ATTENTION** with a `job` whose `id` equals the *old* id, the print is held
     at the preview questions and has not got a new id yet. Mark it "waiting at printer", keep
     matching by `display_name`, and lock in the id when it becomes PRINTING.
  4. ATTENTION → IDLE without ever PRINTING means the user tapped Abort at the preview: the print
     was **rejected/cancelled before start**, the job id is not consumed, and no STOPPED is shown
     [src: `PrintPreview::Result::Abort` with `did_not_start_print` → `cleanup_print()` → Idle].
- **End detection:** while tracking job `N`:
  - `printer.state == FINISHED` → finished;
  - `STOPPED` → stopped/cancelled (from our DELETE, the display, or Connect);
  - `status.job.id` changes to `M > N` → `N` ended and something else started (outcome unknown;
    mark "ended, outcome unknown" or infer from the last progress);
  - IDLE with no job after having been PRINTING → ended and already acknowledged on the display
    (outcome unknown).
  - The printer exposes **no job history**. Poll fast enough (≤ 5 s) that FINISHED/STOPPED is
    normally caught before someone clears it.
- **Failures:** there is no ERROR state over Link. Attention-class problems (crash, runout, stuck
  filament) show as ATTENTION, then PAUSED/PRINTING again. A red screen or BSOD makes the printer
  stop answering HTTP, which reads as "offline while printing".
- **Outside prints:** any PRINTING job whose id we don't own is an outside print. Fetch
  `/api/v1/job` for `display_name` and the thumbnail ref (section 7).

## 5. Control

| Capability | Buddy | Python | How |
|---|---|---|---|
| Pause | yes | yes | `PUT /api/v1/job/{id}/pause` → 204. 409 unless PRINTING. 404 if `{id}` isn't the current `job_id` |
| Resume | yes | yes | `PUT /api/v1/job/{id}/resume` → 204. 409 unless PAUSED |
| Stop | yes | yes | `DELETE /api/v1/job/{id}` → 204 from PRINTING/PAUSED/ATTENTION, else 409 |
| Speed % | **no** | yes | Python: `POST /api/printer/printhead` `{"command":"feedrate","factor":120}` (M220) |
| Flow % | **no** | yes | Python: `POST /api/printer/tool` `{"command":"flowrate","factor":95}` (M221) |
| Nozzle target (preheat/cooldown) | **no** | yes | Python: `POST /api/printer/tool` `{"command":"target","targets":{"tool0":215}}` (M104) |
| Bed target | **no** | yes | Python: `POST /api/printer/bed` `{"command":"target","target":60}` (M140) |
| Arbitrary G-code | **no** | no | (Python has no raw-gcode endpoint either) |
| Jog/home | no | yes | `/api/printer/printhead` `jog`/`home` |
| Answer on-screen dialogs (ATTENTION) | **no** | n/a | |

- Legacy `POST /api/job` (`cancel`, `pause` + `action`) also works on Buddy but adds nothing.
- On Buddy, the only routes are those listed in `prusa_link_api_v1.cpp` / `prusa_link_api_octo.cpp`
  (verified [src]). There is no temperature, speed, G-code or dialog endpoint.
- **Prusa Connect can do more** [src `src/connect/command.cpp`]: `SET_VALUE` (speed, temps, …),
  raw G-code bodies, `DIALOG_ACTION` (answer ATTENTION), `SET_PRINTER_READY`, `CANCEL_OBJECT`,
  `START_PRINT`, downloads, and more. But it's the printer dialling **out** to
  `connect.prusa3d.com` (configurable host/port/TLS via `prusa_printer_settings.ini`
  `[service::connect]`).
  - A self-hosted Connect-compatible server would give full control. The protocol is
    undocumented, proprietary-adjacent and a big project. **Out of scope.** Note it as a possible
    future driver.
- **Driver decision:** for Buddy, mark `speed`, `preheat/cooldown`, `gcode` and `dialog` as
  **unsupported**. Keep reporting `speed`/`flow`/targets read-only from status.
  - Preheat is still achievable indirectly via start G-code, which we already control.
  - For Python Prusa-Link, enable speed, flow, temperatures and jog.

## 6. Camera

- **Buddy firmware has no camera endpoints.** `/api/v1/cameras*` is not routed (404). MK4/Core
  One have no built-in camera.
- **Buddy3D camera** (Core One accessory, its own Wi-Fi device) [doc: help.prusa3d.com
  "Buddy3D camera"]:
  - Pairs via a QR code from Prusa Connect / Prusa App.
  - Optional **local RTSP**: `rtsp://<camera-ip>/live`, port 554, unencrypted, ~1080p/HD at
    ~25 fps. It must be enabled in the Prusa App or the Connect camera settings (per user
    reports).
  - No local REST/snapshot API; it talks to `connect.prusa3d.com` / `camera-signaling…`.
  - Codec is most likely H.264 [unverified]. This is a **separate IP**, not discoverable through
    PrusaLink.
- Prusa Connect's "Camera API" is a **cloud upload** API (DIY cameras push JPEG snapshots to
  Connect), not LAN.
- **Python Prusa-Link:** Pi-attached cameras are available on the LAN:
  - `GET /api/v1/cameras` lists them;
  - `GET /api/v1/cameras/snap` returns the default camera's latest snapshot (`image/jpeg` in
    practice, though the spec says png; 204 if none yet);
  - `GET /api/v1/cameras/{id}/snap`. Snapshot cadence is the camera's `trigger_scheme` (10/30/60 s
    or per layer).
- **Driver decision:**
  - Buddy: `camera: none` by default, plus an **optional user-supplied RTSP URL** per printer.
    Reuse the existing `retina` RTSP pipeline from `src/bambu/camera.rs`, without the TLS proxy:
    plain `rtsp://`.
  - Python: snapshot polling (JPEG).

## 7. Thumbnails (pictures of jobs, including outside prints) [src]

- `GET /thumb/s/<path>` returns a PNG thumbnail that is **exactly 16×16**. `GET /thumb/l/<path>`
  returns the **first PNG thumbnail larger than 16×16 in file order**.
  - Both are **PNG only**: QOI thumbnails are never served.
  - Both need auth, support `If-None-Match` ETags, and return 404 "File doesn't contain preview"
    otherwise.
  - Paths are SFN, taken from `refs.icon` / `refs.thumbnail` (e.g.
    `/thumb/l/usb/BENCHY~1.BGC`).
- Plain G-code: the scanner looks for `; thumbnail begin WxH LEN` (PNG) or
  `; thumbnail_QOI begin WxH LEN` (QOI) within the **first 2048 lines** only
  (`PlainGcodeReader::stream_thumbnail_start`, `MAX_SEARCH_LINES`).
- `.bgcode`: it iterates thumbnail blocks until the first G-code block, with no line limit.
- Prusa's own profiles (and Orca's Prusa profiles) contain **no 16×16 PNG**, so **`refs.icon`
  normally 404s**. Use `refs.thumbnail`. With the standard list (section 9) `/thumb/l` serves the
  **640×480 PNG**.
- **Risk:** in plain-text G-code, the 640×480 PNG comes after four QOI thumbnails (16×16,
  313×173, 440×240, 480×240) at 78 base64 chars per line. If those QOIs are large (an opaque
  background compresses badly), the PNG `begin` line can land beyond line 2048, and `/thumb/l`
  returns 404.
  - **Verify on our own output** by counting lines before `; thumbnail begin 640x480`.
  - Options if it is too late: move the PNG first, or shrink it to e.g. 300×300. The display also
    searches QOI within 2048 lines, so keep the QOIs small too.
- **Fallback for outside prints without a servable PNG:** stream `GET /usb/<SFN path>` (raw file,
  auth required) and stop after the thumbnail header region. Parse `; thumbnail[_QOI] begin`
  blocks (plain) or bgcode thumbnail blocks (type 5; format PNG=0, JPG=1, QOI=2), then decode QOI
  ourselves (the `qoi` crate).
  - `pyprusalink.file_metadata` has a reference bgcode block walker.
  - Downloads run at ~100–400 KB/s, so cap at ~2 MB.
- **Python Prusa-Link:** `refs.thumbnail` is `/api/thumbnails/<path>.orig.png`, the largest
  embedded PNG; `icon` is null.
- For **our own** jobs, show our own rendered picture and never fetch from the printer. The
  printer only matters for outside prints.

## 8. Discovery

- **Buddy** [src `lib/WUI/mdns/mdns.c`, `wui.cpp`]:
  - The lwIP mDNS responder advertises **`_prusalink._tcp.local`**, port **80**, instance name =
    the printer's **hostname** (default `prusa-mk4`, `prusa-core-one`, …), with an **empty TXT**.
  - It also answers A queries for `<hostname>.local`.
  - It is registered only when PrusaLink is enabled in the printer menu. With PrusaLink off,
    there is no web server and no mDNS service.
  - No SSDP, no `_octoprint._tcp`, no `_http._tcp`.
- **Python Prusa-Link** [src `prusa/link/service_discovery.py`]: registers `_prusalink._tcp`,
  `_http._tcp` and `_octoprint._tcp`, all with instance name `PrusaLink at <hostname>[:port]`,
  server `<hostname>.local`, and TXT `path=/`.
- **PrusaSlicer/OrcaSlicer "Browse"** in the physical-printer dialog uses **only
  `_octoprint._tcp`** (TXT keys `version`, `model`) (PrusaSlicer `BonjourDialog.cpp`; Orca
  `BonjourDialog.cpp` `Bonjour("octoprint")`). So it finds Python Prusa-Link and OctoPrint, **but
  not Buddy printers**.
- **Driver:**
  - Browse `_prusalink._tcp` (mdns-sd crate) on the same cadence as the Bambu SSDP listener. TXT
    carries nothing, so after discovery do an **unauthenticated** `GET /api/version`. The expected
    response is `401` with `WWW-Authenticate: Digest realm="Printer API"`, which identifies
    Buddy PrusaLink.
  - Model and serial need the password: once the admin enters it, call `/api/version` +
    `/api/v1/info`. The hostname default gives a model hint before that.
  - Dedupe by IP, then by `serial`. Ignore `_octoprint._tcp` hits that are Python Prusa-Link (the
    same host also advertises `_prusalink`) in the OctoPrint driver, or let the OctoPrint driver
    detect `text: "PrusaLink …"` and hand the host over.
  - mDNS doesn't cross VLANs/subnets: always offer **manual IP/hostname** entry.

## 9. Slicer specifics (OrcaSlicer v2.4.2 Prusa profiles)

Read from `extern/OrcaSlicer/resources/profiles/Prusa/machine/*.json` with inheritance resolved.

| Profile (0.4) | `thumbnails` | flavor | `M862.3 P` | `M115 U` |
|---|---|---|---|---|
| MK4, MK4S, MK4S HF, MK3.5, XL, XL 5T, CORE One, One HF, One L, One L HF | `16x16/QOI, 313x173/QOI, 440x240/QOI, 480x240/QOI, 640x480/PNG` | marlin2 | MK4 / MK4S / MK3.5 / XL / COREONE / COREONEL | 5.0.0-RC+11963 … 6.4.0+11974 |
| MINI, MINI IS | `16x16/QOI, 220x124/QOI, 200x240/QOI, 640x480/PNG` | marlin2 | MINI | MINI IS: 6.4.0+11974 |
| MK3S | `160x120` (PNG) | marlin | MK3S | 3.13.0 |

- `thumbnails_format` is not set (the format is per entry). `host_type` is `prusalink` on most
  printers.
- **What the display uses** [src `include/guiconfig/GuiDefaults.hpp`]:
  - 480×320 screens (MK4/MK3.5/XL/Core One): **313×173** preview and **480×240** progress
    (legacy 440×240 still accepted);
  - 240×320 MINI: **220×124** preview and **240×240** progress (legacy 200×240);
  - **16×16** list icon.

  All are **QOI**. The 640×480 PNG is for PrusaLink/Connect web previews (`/thumb/l`).
- **Orca output format** (`GCode/Thumbnails.hpp`): `; THUMBNAIL_BLOCK_START` /
  `; thumbnail_QOI begin 313x173 <len>` / base64 lines / `; thumbnail_QOI end`. The PNG variant
  uses the tag `thumbnail`. This matches what the Buddy parser expects. Our `slice_core` already
  passes a thumbnail callback to `export_gcode`, so the profile's list is honoured **if** the
  merged config's `thumbnails` reaches libslic3r as the comma string.
  - [unverified] The profile JSON stores an array, and the option is `coString`. Check that the
    temp-file config load turns `["16x16/QOI", …]` into `"16x16/QOI, …"` rather than failing or
    taking element 0.
- **Binary G-code:** OrcaSlicer v2.4.2 has **no bgcode support at all**: no `binary_gcode`
  option, no libbgcode in `src/` or `deps/` (grep-verified). We can only ship `.gcode`. To get
  `.bgcode` (3–5× smaller, so faster uploads), we'd have to post-convert with Prusa's
  **libbgcode** (`prusa3d/libbgcode`, AGPL-3.0, so licence-compatible; `convert` API ascii →
  binary with heatshrink/deflate + meatpack). That would be a C++ dependency in `cxx/` and the
  wasm build. Worth it later for big jobs over Wi-Fi; not needed for v1.
- **`M862.x` checks in Prusa start G-code** [src `src/common/gcode/gcode_info.cpp`
  `parse_m862`]:
  - `M862.3 P "<id>"`: printer model. Ids are in the table in section 2. A mismatch or an unknown
    id sets `Check::printer_model`. Compatible-but-not-identical models (e.g. MK4 G-code on MK4S)
    may pass in "compatibility mode" with a warning.
  - `M862.1 P<diam> [A<abrasive>] [F<highflow>]`: nozzle diameter, hardened and high-flow
    nozzle.
  - `M862.5 P2`: G-code level.
  - `M862.6 P"Input shaper"` / `"MMU3"`: required firmware feature.
  - `M862.4`: minimum firmware.
  - `M115 U<ver>`: "newer firmware available" hint.

  The firmware scans these from the file **before printing**. With the default severity
  (**Warning**) a failure produces an on-screen question (ATTENTION). With Strict it refuses. So
  G-code sliced for the wrong model, nozzle or filament **will not start unattended**. The farm
  should check model, nozzle and filament compatibility server-side (from `/api/version` `printer`
  and `/api/v1/info` `nozzle_diameter`, `mmu`) before sending.
- Metadata the firmware reads from comments: `estimated printing time (normal mode)`,
  `filament_type`, `filament used [mm]`/`[g]`, `extruder_colour`, `printer_model`. Orca's
  `printer_model` value is `"Prusa MK4S"` vs PrusaSlicer's `"MK4S"`. The model check uses
  `M862.3`, not this. M555 is the print area for bed preheat. M486 is cancel-object labels.
- Plain G-code validity check: the file must be complete. The firmware checks the head 1 MB and
  the tail 75 KB (`valid_for_print`).

## 10. Fake printer for tests

**Existing options:**
- **No official emulator of PrusaLink.**
- Python Prusa-Link needs a real serial Marlin printer. Its dev docs only show socat'ing a real
  printer's UART, and there is no virtual printer mode.
- The **Buddy firmware does run under QEMU** (`MINI404` by vintagepc; the firmware repo's
  `utils/simulator` and `tests/integration/` drive it with `MachineType` `prusa-mini`,
  `prusa-mk4-027c`, `prusa-xl-050`; port 80 forwarded with
  `-netdev user,hostfwd=tcp::<port>-:80`). Its `test_prusa_link.py` exercises the real web server.
  - This is the highest-fidelity option. But it needs a firmware build (noboot variant) plus the
    MINI404 binary, and runs slowly (icount). It is good for a one-off manual conformance run on
    buildhost; **too heavy for CI**.

**Recommendation:** a hand-written fake (Node, alongside `tests/fake-printer/`, or a small axum
binary), driven from the e2e tests. Minimal surface:

1. **Auth** on every route below.
   - Accept `X-Api-Key: <pw>`.
   - Otherwise require Digest exactly as in section 1. Issue the 401
     `Digest realm="Printer API", nonce="<16hex>", stale=false`, and verify
     `MD5(MD5("maker:Printer API:pw"):nonce:MD5(METHOD:request-target))`, reading only
     `nonce`/`response`.
   - Add a test hook to expire nonces (`stale=true` path).
2. `GET /api/version` returns
   `{"api":"2.0.0","text":"PrusaLink","hostname":"prusa-mk4s","firmware":"6.10.1+0","printer":"1.4.1","capabilities":{"upload-by-put":true}}`.
   Make `printer`/`firmware` omittable.
3. `GET /api/v1/info` returns `{"nozzle_diameter":0.40,"mmu":false,"serial":"FAKE0001","hostname":"prusa-mk4s","min_extrusion_temp":170}`.
4. `GET /api/v1/storage` returns
   `{"storage_list":[{"path":"/usb/","name":"usb","type":"USB","read_only":false,"available":true}]}`.
5. `GET /api/v1/status`: as in section 3, with the `job` object only for
   PRINTING/PAUSED/ATTENTION-with-job, and `transfer` during an upload.
6. `GET /api/v1/job`: 204 or the job JSON (SFN `name`, LFN `display_name`, refs).
7. `PUT /api/v1/files/usb/<path>`:
   - require Content-Length (411);
   - honour `Overwrite: ?1` and `Print-After-Upload: ?1|1|true`;
   - check the extension (415);
   - allow one transfer at a time (409);
   - read the whole body, then 201;
   - if print-after-upload and the state isn't IDLE/FINISHED/STOPPED, return 409 and keep the
     file.
8. `POST /api/v1/files/usb/<path>` returns 204, 404 or 409.
   `HEAD`/`GET /api/v1/files/usb/<path>` return the size. `DELETE` returns 204 or 409 (busy).
9. `PUT /api/v1/job/{id}/pause|resume` and `DELETE /api/v1/job/{id}`, with the exact state rules
   from section 5 (404 for a wrong id, 409 for a wrong state).
10. `GET /thumb/l/<path>` serves the first PNG > 16×16 from the stored file (within 2048 lines),
    else 404. `GET /usb/<path>` serves raw bytes.
11. **Simulation:** a tick that advances `progress`/`time_printing` and `job.id` (incremented
    on start, persisted across "reboots").
    - Control endpoints only for the test harness (e.g. `/__fake/...`): force ATTENTION (preview
      question) before start, user Abort-at-preview (ATTENTION → IDLE), finish (FINISHED), stop
      from the display (STOPPED), clear the finish screen (→ IDLE), BUSY, go offline, reboot
      (new nonce random).
    - Model it on `printer_state.cpp`: ATTENTION-before-start keeps the *old* job id.
12. Optional: an mDNS advertisement `_prusalink._tcp` with an empty TXT (the `bonjour-service` npm
    package or avahi in Docker) to test discovery.
13. Optional **Python mode**: `/api/printer/{tool,bed,printhead}` (204 + a recorded M-code), the
    READY state, and `/api/v1/cameras/snap` (JPEG), behind a flag.

## Main risks (summary)

1. **Buddy has no LAN controls for speed, temperature or G-code.** Parity with Bambu is
   impossible for preheat, cooldown and speed. Mark them unsupported (or support them only on
   Python Prusa-Link). The only workaround is a self-hosted Connect server: big and undocumented.
2. **ATTENTION gates unattended starts.** Model, nozzle or filament mismatches, a newer-firmware
   hint, or tool mapping hold the print at an on-screen question that we can't answer over
   PrusaLink. Pre-validate compatibility server-side.
3. **Finished/stopped detection is a snapshot race.** `job` disappears from status at
   FINISHED/STOPPED, and those states clear when someone taps the screen or the next print starts.
   There is no job history API. Poll every ≤ 5 s and keep the per-printer job id state.
4. **Slow uploads** (~60–370 KB/s) of plain G-code (Orca can't emit `.bgcode`). Multi-minute
   transfers need long timeouts, progress, and no blind retries. libbgcode conversion is the
   long-term fix.
5. **Thumbnail serving:** `/thumb/s` 404s for Prusa thumbnail lists (no 16×16 PNG), and `/thumb/l`
   may 404 for plain G-code if the PNG starts after line 2048. Verify our output, and have a
   raw-download + parse fallback for outside prints.
6. **Firmware variance:** digest-parser bugs before ~5.2, `/api/version` `printer`/`firmware`
   only on 6.5.x+, and the XL/MINI on older 6.x tracks. Use `X-Api-Key`, treat fields as
   optional, and require 6.x in docs.
7. **3 connection slots, 10 s inactivity drop:** serialize requests per printer, and don't let a
   stalled upload body starve polls.
8. **Camera:** none on Buddy. The Buddy3D's RTSP is a separate device, needs Prusa-App pairing,
   and is unencrypted.

## Sources

- Buddy firmware sources:
  - [Prusa-Firmware-Buddy](https://github.com/prusa3d/Prusa-Firmware-Buddy) `lib/WUI/link_content/{prusa_link_api_v1,prusa_link_api_octo,basic_gets,previews,usb_files,prusa_api_helpers}.cpp`;
  - `lib/WUI/nhttp/{req_parser,status_page,status_renderer,gcode_upload,file_info,server.h}`;
  - `lib/WUI/mdns/mdns.c`, `lib/WUI/wui.cpp`, `lib/WUI/wui_api.cpp`;
  - `utils/gen-automata/{http,http_server}.py`;
  - `src/state/printer_state.cpp`, `src/common/marlin_server.cpp`,
    `src/common/gcode/{gcode_info,gcode_reader_plaintext,gcode_reader_binary}.cpp`;
  - `src/common/filename_type.cpp`, `include/common/printer_model_data.hpp`,
    `include/guiconfig/GuiDefaults.hpp`, `src/connect/command.cpp`;
  - `doc/prusa_printer_settings.ini`, `tests/integration/test_prusa_link.py`, `utils/simulator/`.
- [Prusa-Link-Web spec/openapi.yaml](https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml)
  (v1) and `spec/openapi-legacy.yaml`.
- [Prusa-Link](https://github.com/prusa3d/Prusa-Link) `prusa/link/{service_discovery.py,web/controls.py,web/main.py,web/lib/auth.py,web/lib/files.py,web/cameras.py,config.py}`.
- [pyprusalink](https://github.com/home-assistant-libs/pyprusalink) `client.py` (DigestAuthWorkaround),
  `types.py` (version-field history), `file_metadata.py`.
- [Home Assistant prusalink coordinator](https://github.com/home-assistant/core/blob/dev/homeassistant/components/prusalink/coordinator.py)
  and [integration docs](https://www.home-assistant.io/integrations/prusalink).
- [Buddy PR #3665 (digest parser fix)](https://github.com/prusa3d/Prusa-Firmware-Buddy/pull/3665).
- [Buddy3D camera help article](https://help.prusa3d.com/article/buddy3d-camera_821264).
- Forum upload-speed threads:
  [wifi vs ethernet speeds](https://forum.prusa3d.com/forum/english-forum-original-prusa-i3-mk4-hardware-firmware-and-software-help/wifi-vs-ethernet-speeds),
  [it is very long to transfer a file](https://forum.prusa3d.com/forum/general-discussion-user-experience-ideas/it-is-very-long-to-tranfer-a-file),
  [Ethernet Speed (XL)](https://forum.prusa3d.com/forum/original-prusa-xl-tool-changer-hardware-firmware-and-software-help/ethernet-speed/).
- [PrusaSlicer BonjourDialog.cpp](https://github.com/prusa3d/PrusaSlicer/blob/master/src/slic3r/GUI/BonjourDialog.cpp).
- OrcaSlicer v2.4.2: `resources/profiles/Prusa/machine/*.json`,
  `src/libslic3r/GCode/Thumbnails.{hpp,cpp}`, `src/libslic3r/GCode.cpp`,
  `src/slic3r/Utils/OctoPrint.cpp` (PrusaLink upload client).
