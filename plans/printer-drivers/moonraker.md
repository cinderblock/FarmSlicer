# Moonraker (Klipper) driver reference

Research for `plans/printer-drivers.md` step 3. It is written for whoever
implements the Moonraker driver in the Rust server (axum + tokio). It was
researched on 2026-10-12 against Moonraker `master` (API_VERSION 1.5.0),
Klipper `master`, and OrcaSlicer v2.4.2, the submodule.

Confidence markers:
- **[doc]** is stated in the Moonraker or Klipper docs.
- **[src]** was read in the upstream source.
- **[orca]** was read in the local OrcaSlicer v2.4.2 tree.
- **[practice]** comes from Mainsail, Fluidd or community practice.
- **[unverified]** is believed true but not confirmed. Check it before you rely on it.

---

## 0. TL;DR for the implementer

- Use **one WebSocket per printer** at `ws://host:7125/websocket` (JSON-RPC 2.0). It carries
  `server.connection.identify`, then `printer.objects.subscribe`, then
  `notify_status_update` deltas, `notify_history_changed`, and the `notify_klippy_*` notifications.
- Use **HTTP for the rest**, in particular for upload (`POST /server/files/upload`, which is
  multipart and HTTP-only) and for file and thumbnail downloads.
- **Auth:** send `X-Api-Key` on every HTTP request and on the WebSocket upgrade request. With
  no key, the request either succeeds (the client IP is in `trusted_clients`) or returns 401.
  `GET /access/info` never needs auth, so it is a good probe.
- **State machine:** `print_stats.state` ∈ `standby | printing | paused | complete | cancelled | error`.
  Klipper host state comes from `webhooks.state` ∈ `ready | startup | shutdown | error`.
- **Tracking:** upload under a unique filename. Start the print with `printer.print.start` and
  do not pass `print=true`. Bind to the history job: `notify_history_changed` with
  `action: "added"` carries a `job_id` and `filename`. The final status arrives on
  `action: "finished"` (`completed | cancelled | error | klippy_shutdown | klippy_disconnect | server_exit | interrupted`).
- **Neither Moonraker nor Klipper refuses a start while a print is paused.** Gate it in our driver.
- **Discovery:** mDNS `_moonraker._tcp` only works when `[zeroconf]` is configured, which is
  off by default. Plan on manual IP entry plus a probe of port 7125 (and port 80, through
  nginx).
- **Fake printer:** CI uses a hand-written Node fake. For conformance testing on buildhost,
  use `ghcr.io/mainsail-crew/virtual-klipper-printer` (Klipper + simulavr + Moonraker + a
  dummy MJPEG camera, in one container).

---

## 1. Transport and auth

### Transports [doc]
| Transport | Endpoint | Notes |
|---|---|---|
| WebSocket JSON-RPC 2.0 | `ws://host:7125/websocket` | Full API except file transfer. Carries notifications. |
| HTTP | `http://host:7125/<path>` | REST-ish. Success is wrapped in `{"result": ...}`. Args go in the query string or the JSON/form body (body wins). |
| HTTP JSON-RPC | `POST /server/jsonrpc` | Any JSON-RPC method over HTTP. **Errors come back as HTTP 200** with an `error` object. |
| Bridge WS | `/klippysocket` | Raw pass-through to Klipper. Don't use it. |
| Unix socket / MQTT | — | Not relevant for us. |

- The default port is **7125** [src `server.py`]. The `route_prefix` option can prefix every
  route [src `application.py`]. Rare, but if it is set, the zeroconf TXT advertises it.
- **TLS:** `ssl_port` defaults to 7130. HTTPS starts only if `<data_path>/certs/moonraker.cert`
  and `.key` exist [doc]. When present it is almost always self-signed. Plain HTTP is the LAN
  norm. Support `https://` and `wss://` with "accept any cert" behind a per-printer option, as
  for Bambu, but default to HTTP.
- **nginx front door [practice]:** MainsailOS, FluiddPi and KIAUH installs put nginx on port 80.
  It serves the UI and proxies `/websocket`, `/printer`, `/api`, `/access`, `/machine` and
  `/server` to 7125. Users often paste the UI URL, so accept `http://host` (port 80) as the
  base URL as well as `http://host:7125`. Probe both (§7).
- **Body limits [src `application.py`]:** ordinary requests are limited to 50 MiB. Uploads use
  `max_upload_size` (default **1024 MiB**) and are streamed to disk while hashed with SHA-256.

### JSON-RPC envelopes [doc]
```json
{"jsonrpc": "2.0", "method": "printer.objects.query", "params": {"objects": {"print_stats": null}}, "id": 42}
{"jsonrpc": "2.0", "result": {"eventtime": 578243.57, "status": {"print_stats": {"state": "standby"}}}, "id": 42}
{"jsonrpc": "2.0", "error": {"code": 400, "message": "Must home axis first: 10.000 10.000 0.200 [0.000]"}, "id": 43}
```
Notifications have no `id`. `params` is a positional array:
```json
{"jsonrpc": "2.0", "method": "notify_status_update", "params": [{"extruder": {"temperature": 201.37}}, 578245.12]}
```
Error codes are the HTTP status numbers [src `klippy_connection.py`]:
- **503** `"Klippy Host not connected"` / `"Klippy Disconnected"`: Klipper is down or restarting.
- **400**: a G-code or Klipper error, with Klipper's message text. Examples are
  `Must home axis first`, `SD busy`, `Move out of range`, and `Unknown command`.
- **401**: unauthorized.
- **403**: `"File is loaded, upload not permitted"` (§3).
- **404**: file or job not found.
- **422**: upload checksum mismatch.
- **500**: an internal error, for example `"Klippy request timed out"` on subscribe after 20 s.

HTTP errors return the same code as the status, with a JSON body roughly like
`{"error": {"code": 400, "message": "...", "traceback": "..."}}` [unverified exact shape].

### Authentication [doc + src `authorization.py`]
`[authorization]` has been a **core component** since 2023 [src `server.py` CORE_COMPONENTS],
so it is always loaded. The decision order for each request, where the first match wins, is:

1. `OPTIONS`: allowed.
2. JWT: `Authorization: Bearer <jwt>`, then the `X-Access-Token` header, then the
   `access_token` query argument. A bad JWT gives 401.
3. Oneshot token in the `?token=` query arg. It is bound to the requesting IP, lasts 5 s, and
   works once.
4. API key in the **`X-Api-Key` header only**. It is never accepted from the query string.
   Moonraker compares it with `hmac.compare_digest`.
5. With `force_logins: True` and at least one user, the request gets 401 here. Trusted
   clients do not bypass this step.
6. **Trusted client:** the source IP falls in a `trusted_clients` CIDR, or a domain entry
   matches after reverse DNS.
7. Otherwise, the request is allowed if the endpoint has `auth_required=False`, and gets 401
   if not.

Further details:
- **Defaults [src]:** `trusted_clients` is empty, so **no client is trusted, loopback
  included**. `enable_api_key` defaults to `True` and `force_logins` to `False`. Distro and
  KIAUH `moonraker.conf` templates normally trust the RFC1918 ranges
  (`10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, FE80::/10, ::1/128`)
  [practice]. **Most LAN printers therefore need no credentials from a LAN server**, but some
  will, and vendor firmware varies. The API key field must be optional.
- **Exempt endpoints:** `/access/login`, `/access/refresh_jwt`, `/access/info`.
  `GET /access/info` returns
  `{"default_source": "moonraker", "available_sources": ["moonraker"], "login_required": false, "trusted": true}`.
  - `trusted` says whether *our* IP is trusted.
  - `login_required` means `force_logins` is on.
  - Use it in "Test connection" to tell the user whether they need a key.
- **Image GETs skip auth:** the file handler serves `.png` and `.jpg` GETs without auth
  (`AUTHORIZED_EXTS`) [src `application.py`], so thumbnails are fetchable even when untrusted.
  Send the key anyway.
- **API key lifecycle:** `GET /access/api_key` returns the key and `POST /access/api_key`
  regenerates it. The user copies the key from Mainsail or Fluidd (Settings → Security / API
  key) or reads it as a trusted client. Regenerating it does not drop WebSockets that are
  already authenticated [doc].
- **JWT login** (`POST /access/login` → `token` (1 h) + `refresh_token`) applies only when the
  user runs `force_logins` with users. We should **support only the API key**; JWT means
  storing a password. Document "use the API key" instead.

#### WebSocket auth
There are three equivalent ways:
- **(a)** Put `X-Api-Key: <key>` on the HTTP upgrade request. tokio-tungstenite allows custom
  request headers.
- **(b)** Call `GET /access/oneshot_token` (with the key), then connect to `/websocket?token=<t>`.
  This is what browsers do.
- **(c)** Connect, then call `server.connection.identify` with `"api_key": "<key>"`.

Prefer (a) and also pass the key in identify; that costs nothing.

### Connection setup
```json
{"jsonrpc": "2.0", "id": 1, "method": "server.connection.identify",
 "params": {"client_name": "FarmSlicer", "version": "0.x", "type": "other",
            "url": "https://github.com/OWNER/farmslicer", "api_key": "<optional>"}}
→ {"jsonrpc": "2.0", "result": {"connection_id": 1730367696}, "id": 1}
```
- `type` ∈ `web | mobile | desktop | display | bot | agent | other`.
- Avoid `agent`: a second agent connection with the same `client_name` is rejected. OrcaSlicer
  uses `agent` [orca].
- Identifying twice on the same socket is an error [doc].

---

## 2. Status

### Startup sequence (what Mainsail and Orca do) [practice/orca]
1. `server.info`: check `klippy_connected` and `klippy_state` (`disconnected | startup | ready | error | shutdown`).
   Sample result (abridged):
   ```json
   {"klippy_connected": true, "klippy_state": "ready",
    "components": ["klippy_connection","application","websockets","database","file_manager","authorization","history","webcam","job_state", "..."],
    "failed_components": [], "registered_directories": ["config","logs","gcodes","config_examples","docs"],
    "warnings": [], "websocket_count": 3, "moonraker_version": "v0.9.3-...", "api_version": [1,5,0], "api_version_string": "1.5.0"}
   ```
2. If not `ready`, wait for `notify_klippy_ready`. Keep polling `server.info` every 2 s as a
   fallback. `printer.*` calls return 503 or fail while Klipper is not ready.
3. `printer.info` returns `state`, `state_message`, `hostname`, `software_version` (Klipper
   version) and `cpu_info`. Good for the printer card ("Klipper v0.12.0-...").
4. `printer.objects.list` returns `{"objects": ["webhooks","configfile","mcu","gcode_move","print_stats","virtual_sdcard","pause_resume","display_status","heaters","heater_bed","extruder","extruder1","fan","temperature_sensor chamber", "...]}`.
   Build the subscription from what exists. Missing objects are silently omitted from
   query and subscribe results, not errors.
5. `printer.objects.subscribe`. The response is the **full current state** in the same shape
   as a query, so no separate query is needed. Later changes arrive as
   `notify_status_update` **deltas**: only changed fields, merged into our cache.
   - A new subscribe **replaces** the previous one. `{"objects": {}}` unsubscribes.
   - Klipper pushes updates at a bounded rate (≈250 ms batches) [unverified exact rate].
6. On `notify_klippy_disconnected`: mark the printer "host offline". The print is not
   necessarily dead, because the MCU stops. Moonraker records history status
   `klippy_disconnect`.
   On `notify_klippy_shutdown`: an emergency stop or MCU error. `webhooks.state` becomes
   `shutdown` and `webhooks.state_message` holds the reason.
   On `notify_klippy_ready`: **re-run steps 3–5.** Objects can change after a config change
   and restart, and subscribe is idempotent.
7. WebSocket drop: reconnect with backoff (1 s → 30 s), then do the whole sequence again.
   Also send our own WS ping every ~30 s with a read timeout [unverified whether Moonraker
   pings]. Orca uses a 2 s read timeout plus a periodic re-emit [orca].

Recommended subscription (request with `null` = all fields, or list fields to cut traffic):
```json
{"jsonrpc": "2.0", "id": 2, "method": "printer.objects.subscribe", "params": {"objects": {
  "webhooks": ["state", "state_message"],
  "print_stats": null,
  "virtual_sdcard": ["progress", "is_active", "file_position", "file_size", "file_path"],
  "display_status": ["progress", "message"],
  "pause_resume": ["is_paused"],
  "idle_timeout": ["state", "printing_time"],
  "gcode_move": ["speed_factor", "extrude_factor"],
  "toolhead": ["homed_axes", "extruder", "print_time", "estimated_print_time"],
  "extruder": ["temperature", "target", "power"],
  "heater_bed": ["temperature", "target", "power"],
  "fan": ["speed"],
  "heaters": ["available_heaters", "available_sensors"],
  "exclude_object": ["objects", "excluded_objects", "current_object"]
}}}
```
Add `extruder1..N`, `temperature_sensor <name>`, `temperature_fan <name>`,
`heater_generic <name>` (often the chamber), `mmu`, and `AFC` when they appear in
`objects.list`. Object names containing spaces are valid keys.

### Field reference [doc Klipper Status_Reference + src]
| Object.field | Meaning |
|---|---|
| `webhooks.state` | `ready`, `startup`, `shutdown` (e-stop or runtime error; needs `FIRMWARE_RESTART`), `error` (config or startup error). `state_message` is human text. |
| `print_stats.state` | `standby` (nothing loaded; also after SDCARD_RESET_FILE), `printing`, `paused`, `complete`, `cancelled`, `error`. `complete`, `cancelled` and `error` **persist** until the next print or a reset. |
| `print_stats.filename` | Path **relative to the gcodes root**, e.g. `"farmslicer/job-42.gcode"`. It is empty in standby. |
| `print_stats.message` | Error text when `state == "error"`, e.g. `"Move out of range: ..."`. |
| `print_stats.print_duration` | Seconds of actual printing. It excludes pauses **and** the time before the first extrusion (heating and homing). |
| `print_stats.total_duration` | Wall-clock seconds since start, including pauses. It freezes on finish. |
| `print_stats.filament_used` | mm of filament since start, compensated for M221. |
| `print_stats.info.current_layer` / `.total_layer` | Set **only** by `SET_PRINT_STATS_INFO` in the G-code; otherwise `null`. OrcaSlicer emits it only where the vendor's layer-change template does: Creality, Elegoo, FlyingBear, InfiMech, OpenEYE, Qidi, Snapmaker and Sovol in v2.4.2 [orca grep]. |
| `virtual_sdcard.progress` | `file_position / file_size`, which is byte-based and nonlinear in time. `is_active` is true while the file is being read (false when paused). |
| `display_status.progress` | Last `M73 P` / 100 if received within 5 s while printing, otherwise `virtual_sdcard.progress` [src]. OrcaSlicer emits `M73 P.. R..` by default (`disable_m73=false`) [orca], so for Orca files this is **time-based progress**. Klipper ignores `R`. |
| `display_status.message` | Last M117 text. |
| `pause_resume.is_paused` | True after PAUSE until RESUME or CLEAR_PAUSE. |
| `idle_timeout.state` | `Printing` (toolhead busy with **any** G-code, not necessarily a print), `Ready`, `Idle`. **Don't** use it for job state. See the preheat gotcha in §4. |
| `gcode_move.speed_factor` | M220 / 100 (1.0 = 100 %). `extrude_factor` is M221 / 100. |
| `extruder*.temperature/target/power` | °C, °C, 0–1 PWM. `can_extrude` is also available. `toolhead.extruder` is the active extruder name. |
| `heater_bed.*` | Same fields as the extruder. |
| `temperature_sensor <n>.temperature` | Chamber and MCU sensors (`measured_min_temp`/`measured_max_temp` too). |
| `fan.speed` | Part-cooling fan, 0–1. It exists only if `[fan]` is configured. |
| `exclude_object.*` | Objects from `EXCLUDE_OBJECT_DEFINE` (Orca emits it with `gcode_flavor=klipper` and label objects on) [orca]. Enables "skip object" later through `EXCLUDE_OBJECT NAME=...`. |

Required printer.cfg sections: Moonraker needs `[virtual_sdcard]`, `[pause_resume]` and
`[display_status]` in printer.cfg [doc install guide; practice]. Any working
Mainsail/Fluidd printer has them. A missing `display_status` should fall back to
`virtual_sdcard.progress`.

### Normalized state mapping (suggested)
| Inputs | Our state |
|---|---|
| WS down, or `server.info` failing | offline |
| `klippy_connected=false` or `webhooks.state ∈ {startup}` | connecting / host restarting |
| `webhooks.state ∈ {shutdown, error}` | error (show `state_message`; offer "Firmware restart") |
| `print_stats.state=printing` | printing |
| `print_stats.state=paused` | paused |
| `print_stats.state=complete` | finished (idle) |
| `print_stats.state=cancelled` | cancelled (idle) |
| `print_stats.state=error` | failed (show `print_stats.message`) |
| `print_stats.state=standby` | idle |

Orca maps these as `printing→RUNNING`, `paused→PAUSE`, `complete→FINISH`,
`error|cancelled→FAILED`, and everything else `→IDLE` [orca `map_moonraker_state`].

### Remaining time
Klipper itself has no remaining-time estimate. The options are:
1. **Slicer estimate:** `metadata.estimated_time − print_duration`. `estimated_time` comes from
   `server.files.metadata` (§3). It is good early in the print but ignores speed-factor changes
   and pauses.
2. **Progress-based:** `print_duration / p − print_duration`, where `p` is
   `display_status.progress` (time-based with Orca's M73) or `virtual_sdcard.progress`
   (byte-based). It is noisy early on.
3. **Filament-based:** `print_duration / (filament_used / metadata.filament_total) − print_duration`.
   This is Mainsail's "filament" estimate [practice].

Mainsail offers file, filament, slicer, and an average of file and filament
[practice/unverified exact defaults]. Recommendation:
- Use (1) scaled by `1 / speed_factor` until `p ≥ 0.05`.
- After that, blend toward (2), using `display_status.progress`.

**Don't copy Orca's** `total_duration − print_duration`. That number is time spent paused or
heating, not time remaining [orca].

---

## 3. Upload and file metadata

### `POST /server/files/upload` (multipart/form-data, HTTP only) [doc + src]
| Field | Notes |
|---|---|
| `file` | Required. **The part's `filename=` is the stored name.** The upload fails with "No file name specified in upload form" without it. |
| `root` | `gcodes` (default) or `config`. |
| `path` | Subdirectory under the root, created if missing, e.g. `farmslicer`. |
| `checksum` | Optional SHA-256 hex. A mismatch gives 422. **Send it.** It's cheap and catches truncated uploads. |
| `print` | `"true"` starts the print after upload (string compare). **Don't use it** (see below). |

- Valid G-code extensions: `.gcode .g .gco .ufp .nc` [src].
- Success is **HTTP 201**, with `Location` set to the file path:
  ```json
  {"result": {"item": {"path": "farmslicer/job-42-benchy.gcode", "root": "gcodes", "modified": 1676984527.63, "size": 71973, "permissions": "rw"},
              "print_started": false, "print_queued": false, "action": "create_file"}}
  ```
  The docs show the body without `result`, while Orca parses `result.item.path`. Accept both
  [unverified wrapping].
- **Metadata is parsed before the response returns** [src `file_manager.py`: `await
  ...parse_metadata(...).wait()`], so `server.files.metadata` is ready immediately after a 201.
- Why not `print=true`:
  - It silently doesn't start when the printer is printing or paused (`print_started: false`,
    no error).
  - It queues instead if the owner set `queue_gcode_uploads: True`.
  - Start failures are swallowed [src].

  Orca also uploads then calls `/printer/print/start` explicitly [orca `Moonraker.cpp`].
- Overwriting the currently loaded (printing or paused) file gives **403** `"File is loaded, upload not permitted"`.
  Use unique names: `farmslicer/<jobid>-<slug>.gcode`. ASCII only, no spaces or quotes.
  Moonraker does escape `"` in `SDCARD_PRINT_FILE FILENAME="..."` [src].
- Emits `notify_filelist_changed`:
  `{"action": "create_file", "item": {"path": "...", "root": "gcodes", "size": ..., "modified": ..., "permissions": "rw"}}`.
  Copying over an existing file gives `modify_file`.
- Housekeeping: delete our files after the job finishes, as an optional site setting, with
  `DELETE /server/files/gcodes/<path>` or `server.files.delete_file {"path": "gcodes/<path>"}`.
  Disk space is in `server.files.get_directory` → `disk_usage.{total,used,free}`.

### `server.files.metadata` / `GET /server/files/metadata?filename=<path>` [doc]
```json
{"size": 1629418, "modified": 1706359465.49, "uuid": "473a41d2-...", "file_processors": [],
 "slicer": "OrcaSlicer", "slicer_version": "2.4.2", "gcode_start_byte": 87410, "gcode_end_byte": 1618468,
 "object_height": 8, "estimated_time": 5947, "nozzle_diameter": 0.4, "layer_height": 0.2,
 "first_layer_height": 0.2, "first_layer_extr_temp": 215, "first_layer_bed_temp": 60, "chamber_temp": 0,
 "filament_name": "Generic PLA @System", "filament_type": "PLA", "filament_total": 9159.55,
 "filament_weight_total": 27.32, "filament_colors": ["#FF8000"], "referenced_tools": [0], "layer_count": 40,
 "thumbnails": [
   {"width": 32, "height": 32, "size": 1078, "relative_path": ".thumbs/job-42-benchy-32x32.png"},
   {"width": 300, "height": 300, "size": 31819, "relative_path": ".thumbs/job-42-benchy-300x300.png"}],
 "print_start_time": 1706359466.72, "job_id": "0000BF", "filename": "farmslicer/job-42-benchy.gcode"}
```
- Fields are **omitted** when the slicer didn't provide them.
- `print_start_time` and `job_id` record the **last** time the file was printed.
- `filament_name`, `filament_type` and the colour fields can be JSON lists for multi-material.
- `server.files.metascan` forces a rescan.
- `server.files.thumbnails` returns `[{width, height, size, thumbnail_path}]`, where
  `thumbnail_path` is relative to the **gcodes root**. In metadata, `relative_path` is
  relative to the **G-code file's directory**.

### What Moonraker parses from OrcaSlicer output [src `metadata.py`, cross-checked with orca `GCode.cpp`]
There's no OrcaSlicer-specific class. The file is identified by the PrusaSlicer parser via
`; generated by (.+?) on \d{4}-\d{2}-\d{2} at \d{2}:\d{2}:\d{2}`. Orca writes
`; generated by OrcaSlicer <ver> on <date> at <time>` inside `; HEADER_BLOCK_START`.

Only the **first 1 MiB (header) and last 1 MiB (footer)** are scanned. Config values are read
from the footer. For non-Bambu printers, Orca writes the footer block (`; CONFIG_BLOCK_START`
plus compat keys) at the end [orca `GCode.cpp` ~3533]:

| Metadata | Regex (abridged) | Orca writes |
|---|---|---|
| `estimated_time` | `;\sestimated\sprinting\stime.*` then `\d+d/h/m/s` | `; estimated printing time (normal mode) = 1h 2m 3s` (GCodeProcessor replaces the placeholder) |
| `filament_total` | `filament\sused\s\[mm\]\s=\s(...)` (sum) | `; filament used [mm] = ...` |
| `filament_weight_total` | `total\sfilament\sused\s\[g\]\s=\s(...)` | `; total filament used [g] = 12.34` |
| `layer_count` | `; total layers count = (\d+)` | yes |
| `filament_type`, `filament_name` | `; filament_type = `, `; filament_settings_id = ` | yes, in the config block |
| `first_layer_extr_temp`/`_bed_temp`, `first_layer_height` | `; first_layer_temperature = ` etc. | Orca writes these "compat" keys explicitly |
| `nozzle_diameter`, `layer_height`, `chamber_temp`, `filament_colour`, `extruder_colour`, `referenced_tools` | `; key = value` | config block |
| `object_height` | `;BEFORE_LAYER_CHANGE\n;Z` max, or the `G1 Z.. F` max | yes |

**FarmSlicer action item:** when step 2 ("plain G-code jobs") lands, run our `.gcode` through
a real Moonraker. Moonraker alone in Docker is enough (§10, option C). Assert that
`slicer == "OrcaSlicer"`, that `estimated_time` and `filament_weight_total` are present, and
that the thumbnails are parsed. The `thumbnails_format = BTT_TFT` setting suppresses Orca's
`HEADER_BLOCK` (`if(!has_BTT_thumbnail)`) [orca], which drops the `; generated by` line, so
slicer identification would likely fail. Avoid BTT_TFT for Moonraker targets.

---

## 4. Start and control

| Action | JSON-RPC | HTTP | Notes |
|---|---|---|---|
| Start | `printer.print.start {"filename": "farmslicer/job-42.gcode"}` | `POST /printer/print/start?filename=...` | Runs `SDCARD_PRINT_FILE FILENAME="<f>"`. Moonraker does **no** busy or exists check [src `klippy_apis.py`]. |
| Pause | `printer.print.pause` | `POST /printer/print/pause` | Klipper endpoint `pause_resume/pause` → `PAUSE` (the macro if the user overrode it, as Mainsail/Fluidd `client.cfg` do: park, retract). |
| Resume | `printer.print.resume` | `POST /printer/print/resume` | → `RESUME`. |
| Cancel | `printer.print.cancel` | `POST /printer/print/cancel` | → `CANCEL_PRINT` (usually a macro: heaters off, park, then `CANCEL_PRINT_BASE`). |
| G-code | `printer.gcode.script {"script": "M104 S200\nM140 S60"}` | `POST /printer/gcode/script` | Returns `"ok"` **when the commands finish**, or an error at the first failing line (400 + Klipper message). **No timeout**, so a blocking command (`M109`, `G28`, `M190`) holds the request. Set our own client timeout. |
| E-stop | `printer.emergency_stop` | `POST /printer/emergency_stop` | Immediate halt → `webhooks.state = shutdown`. **Don't** send M112 through gcode.script: it is queued behind pending G-code [doc]. |
| Recover | `printer.firmware_restart` (MCU + host) / `printer.restart` (host only) | `POST /printer/firmware_restart` | Needed after an e-stop or shutdown. |

Responses are `{"result": "ok"}` over HTTP and `"result": "ok"` over JSON-RPC.

**State gating our driver must do** [src `virtual_sdcard.py`, `pause_resume.py`]:
- **Start:**
  - Klipper raises `SD busy` (400) only while a print is *actively* running.
  - **While paused, `SDCARD_PRINT_FILE` succeeds and replaces the paused job.** Moonraker
    history then marks the old one `cancelled`.
  - So: allow a start only when `print_stats.state ∈ {standby, complete, cancelled, error}`
    and `webhooks.state == ready`.
- **Pause:** pausing an already-paused print just responds "Print already paused" (`ok`).
  Plain `PAUSE` while idle **sets `is_paused` anyway**. Allow it only in `printing`.
- **Resume:** when not paused it responds "Print is not paused, resume aborted" (`ok`, no
  error). Allow it only in `paused`.
- **Cancel:** allowed in `printing` or `paused`. With no file it responds `action:cancel`.

**Speed** [doc Klipper G-codes]:
- `M220 S<percent>` sets `gcode_move.speed_factor`.
- Map our Bambu-style levels (silent 50 / standard 100 / sport 124 / ludicrous 166) to
  `M220 S50|100|124|166`.
- Show the current value from `speed_factor × 100`. Free-form percent is also possible.
- `SET_VELOCITY_LIMIT VELOCITY= ACCEL=` changes machine limits. Don't use it for "speed";
  it isn't restored after the print.
- [unverified] `speed_factor` persists across prints until changed or Klipper restarts. Many
  start macros send `M220 S100`.

**Preheat / cooldown:**
- Preheat: `SET_HEATER_TEMPERATURE HEATER=extruder TARGET=215` and
  `SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=60`, or `M104 S215` and `M140 S60`. These
  are non-blocking and return at once.
  - Use `M104 T1 S..` or `HEATER=extruder1` for other tools.
  - Orca uses `SET_HEATER_TEMPERATURE` [orca].
  - Chamber: `heater_generic <name>` via `SET_HEATER_TEMPERATURE HEATER=<name>`.
- Cooldown: `TURN_OFF_HEATERS` plus `M107` (or `M106 S0`).
- Fan: `M106 S0-255`. It needs `[fan]`.
- **Gotcha: `[idle_timeout]` (default 600 s) runs `TURN_OFF_HEATERS` + `M84` when the printer
  is idle.** A preheat with no print starting will switch itself off after 10 minutes.
  - Surface this in the UI ("preheat holds for ~10 min").
  - Or re-send the targets while the user keeps "preheat" on.
  - Read the timeout from `idle_timeout.idle_timeout` (it is in `get_status`) [src].
- Max temps: `configfile.settings.extruder.max_temp`, `configfile.settings.heater_bed.max_temp`
  (query `configfile: ["settings"]` once). Clamp the UI to these. Klipper rejects
  out-of-range targets with a 400 error.

**How errors surface:**
- 400 on the request (bad G-code, not homed, SD busy).
- `notify_gcode_response` lines starting with `!! ` (errors) or `// ` (info):
  `{"method": "notify_gcode_response", "params": ["!! Move out of range: 235.000 10.000 0.300 [12.345]"]}`.
- A print error gives `print_stats.state=error` plus `print_stats.message`.
- A host or MCU failure gives `webhooks.state=shutdown|error` plus `state_message`, followed
  by `notify_klippy_shutdown`.

Keep the last ~50 `notify_gcode_response` lines per printer for the UI. `server.gcode_store`
gives the backlog on connect.

---

## 5. History and print tracking

The history component is **core** (always loaded) [src `server.py`].

- `server.history.list`: `GET /server/history/list?limit=50&start=0&since=<unix>&before=<unix>&order=desc`
  returns `{"count": N, "jobs": [job...]}`.
- `server.history.get_job {"uid": "0000BF"}` returns `{"job": {...}}`.
- `server.history.totals`: lifetime stats.

Job object [doc]:
```json
{"job_id": "0000BF", "exists": true, "filename": "farmslicer/job-42-benchy.gcode",
 "status": "completed", "start_time": 1706359466.72, "end_time": 1706365413.11,
 "print_duration": 5800.2, "total_duration": 5946.4, "filament_used": 9100.3,
 "metadata": {"...": "file metadata snapshot"}, "user": "_API_KEY_USER_",
 "auxiliary_data": [{"provider": "spoolman", "name": "spool_ids", "value": [1], "description": "Spool IDs used", "units": null}]}
```
`job_id` is the SQLite row id as 6-digit uppercase hex [src]. `user` is `null` for jobs started from the printer's screen.

Status values [doc + src]:
| Status | Meaning |
|---|---|
| `in_progress` | Running or paused |
| `completed` | `print_stats` → `complete` |
| `cancelled` | `print_stats` → `cancelled`, **or** → `standby` mid-job (SDCARD_RESET_FILE / CLEAR_PAUSE), **or** a new start replaced it |
| `error` | `print_stats` → `error` |
| `klippy_shutdown` | Klipper shut down mid-job (e-stop, MCU error) |
| `klippy_disconnect` | Moonraker lost Klipper mid-job |
| `server_exit` | Moonraker exited cleanly mid-job [src] |
| `interrupted` | Moonraker died uncleanly; set at the next startup on rows still `in_progress` [src] |

`notify_history_changed` [doc + src] is emitted when a job starts (`added`, `status: "in_progress"`, `end_time: null`) and when it finishes (`finished`):
```json
{"method": "notify_history_changed", "params": [{"action": "added", "job": {"job_id": "0000C0", "filename": "farmslicer/job-42-benchy.gcode", "status": "in_progress", "start_time": 1706400000.1, "end_time": null, "...": "..."}}]}
{"method": "notify_history_changed", "params": [{"action": "finished", "job": {"job_id": "0000C0", "status": "cancelled", "end_time": 1706400360.9, "...": "..."}}]}
```

How Moonraker decides (job_state) [src `job_state.py`]: it watches `print_stats.state` transitions.
- idle (`standby/complete/cancelled/error`) → `printing` = **started**.
- `paused` → `printing` = **resumed**, but only with the same filename and growing
  `total_duration`. Otherwise it counts as started.
- `printing` → `standby` = cancelled.

**Matching our print (recommended algorithm):**
1. Upload as `farmslicer/<printJobId>-<slug>.gcode`. The name is unique, so it is the
   correlation key. Record `{printer, remote_path, sent_at}`.
2. `printer.print.start`. A 400 response means the send failed, so surface the message.
3. Bind on whichever comes first:
   - `notify_history_changed` `added` with `job.filename == remote_path`. Store `job_id`.
   - `print_stats` with `filename == remote_path` and `state ∈ {printing, paused}`.
   - Timeout (e.g. 60 s with no sighting): the start didn't take, so mark it failed. This is
     the same "not yet seen running can only start" rule as Bambu (commit 03221ad).
4. Final status: `finished` for our `job_id`, or the `print_stats.state` terminal values for
   our filename. Map `completed` → finished. Map `cancelled` → cancelled. Map `error`,
   `klippy_shutdown`, `klippy_disconnect`, `interrupted` and `server_exit` → failed, and keep
   the raw status as the reason.
5. **Reconnect reconciliation:** after any WS reconnect or our own restart, for each print in
   `sending/printing/paused`, call `server.history.list?since=<sent_at-60>&order=asc`. Find
   the job by `job_id` or filename and apply its status. History survives Moonraker restarts.
   The `print_stats` snapshot covers the live state.
6. Outside prints: `print_stats.filename` not in our records gives an "outside print" card.

---

## 6. Camera

- `server.webcams.list` / `GET /server/webcams/list` returns `{"webcams": [entry...]}`.
  `notify_webcams_changed` pushes the full list on changes.
  ```json
  {"name": "Printer cam", "location": "printer", "service": "mjpegstreamer-adaptive", "enabled": true,
   "icon": "mdiWebcam", "target_fps": 15, "target_fps_idle": 5,
   "stream_url": "/webcam/?action=stream", "snapshot_url": "/webcam/?action=snapshot",
   "flip_horizontal": false, "flip_vertical": false, "rotation": 0, "aspect_ratio": "4:3",
   "extra_data": {}, "source": "database", "uid": "55d3686c-..."}
  ```
  - `source` is `config` (from a moonraker.conf `[webcam x]`) or `database` (added in the
    Mainsail/Fluidd UI).
  - Services: `mjpegstreamer`, `mjpegstreamer-adaptive` (snapshot polling), `uv4l-mjpeg`,
    `ipstream`, `webrtc-camerastreamer`, `webrtc-go2rtc`, `webrtc-mediamtx`, `webrtc-janus`,
    `hlsstream`, `jmuxer-stream`, `iframe`.
- **URL resolution:**
  - `stream_url` and `snapshot_url` may be absolute or **relative to the printer host on
    port 80**, not 7125.
  - Moonraker resolves relative URLs against `http://<host-ip>` with no port [src `webcam.py`
    `_default_host`].
  - Relative `/webcam/...` paths are served by the nginx in front of Mainsail/Fluidd, which
    proxies to crowsnest/ustreamer on `:8080` (`/webcam2/` → `:8081`, ...)
    [doc crowsnest].
  - So: relative → `http://<printer-host>:80<path>`. Absolute → use as-is, but rewrite
    `localhost`/`127.0.0.1` to the printer host.
  - Allow a per-printer override URL. Some vendor UIs sit on 4408/4409, as with Creality
    helper-script installs [practice].
- `server.webcams.test {"uid": ...}` gives `{name, snapshot_reachable, snapshot_url, stream_url}`
  resolved by Moonraker. Its "reachable" is from the printer's point of view, but it's still
  handy for a "Test camera" button.
- **Server-side proxy design.** We already relay JPEG frames for the A1/P1:
  - **Snapshot polling (universal):** `GET snapshot_url` every 1/target_fps s and push JPEG
    frames to the browser over the existing camera channel. This works for ustreamer,
    mjpg-streamer and camera-streamer (crowsnest exposes a snapshot for all its backends),
    and for go2rtc (`/api/frame.jpeg?src=<name>` on :1984) [practice/unverified for go2rtc
    path].
  - **MJPEG relay:** for `mjpegstreamer*`/`uv4l-mjpeg`/`ipstream` with an MJPEG `stream_url`,
    open the stream (`multipart/x-mixed-replace; boundary=...`), split on the boundary, and
    forward JPEGs. That is one upstream connection per printer, fanned out to N viewers. Close
    it when the last viewer leaves. These are Pi-class devices, so keep at most one upstream
    connection.
  - **WebRTC / HLS:** not worth server-side support at first. Fall back to `snapshot_url` when
    present. Otherwise show "camera not supported".
  - Apply `flip_*`/`rotation` client-side (CSS transform).
  - Webcam endpoints usually need **no auth**, since nginx and ustreamer are open. Don't send
    the Moonraker API key to third-party camera hosts.

---

## 7. Discovery

- **Zeroconf** is an **optional component**. It runs only if `[zeroconf]` is in
  moonraker.conf; the KIAUH and MainsailOS defaults don't include it [doc; practice].
  When on [src `zeroconf.py`]:
  - Service: **`_moonraker._tcp.local.`**, instance `"<Name> @ <host>"`, port = HTTP port.
  - TXT: `uuid`, `https_port` (empty if no TLS), `version`, `route_prefix`.
  - Name: `mdns_hostname` (default = OS hostname).
  - In Rust, the `mdns-sd` crate can browse it.
- **SSDP** is opt-in: `[zeroconf] enable_ssdp: True` (default False). It announces NT
  `urn:arksine.github.io:device:Moonraker:1` to `239.255.255.250:1900` with
  `LOCATION: http://<host>:<port>/server/zeroconf/ssdp`. The description XML has
  `<manufacturer>Arksine</manufacturer><modelName>Moonraker</modelName><friendlyName>...<UDN>uuid:...`
  [src]. Our current listener is bound to Bambu's 2021, so this would need a second socket on
  1900 (send an M-SEARCH for the URN). It is rarely enabled, so it's low value.
- **Mainsail and Fluidd don't discover.** The user types a URL [practice].
  - **OrcaSlicer** v2.4.2 has no Moonraker LAN discovery either: its `MoonrakerPrinterAgent::start_discovery`
    only announces the configured print host [orca].
  - Its "Browse" button uses Bonjour for `octoprint`, plus Creality and Flashforge-specific
    scanners [orca `PhysicalPrinterDialog.cpp`].
- **Realistic plan:**
  1. Manual add by host or IP (optional port, optional API key).
  2. Probe in order:
     - `GET http://h:7125/access/info`. It needs no auth; a JSON body with `login_required`
       and `trusted` means "Moonraker here".
     - Then `GET /server/info` (200, or 401 meaning "needs key").
     - Then the same on port 80 (via nginx).
     - Then `GET /printer/info` for the Klipper version and hostname.
  3. Optional "Scan network" button: browse `_moonraker._tcp`, plus an opt-in /24 sweep of
     TCP 7125 with a short connect timeout, then the `/access/info` probe. Present the hits as
     discovery cards like Bambu's.

  **Identity:** the zeroconf `uuid` when present. Otherwise `printer.info.hostname` plus the
  host. Moonraker also has an `instance_uuid`; `/server/info` doesn't expose it, though
  `machine.system_info` might [unverified].

  **OctoPrint confusion:** with `[octoprint_compat]`, Moonraker also answers OctoPrint's
  `/api/version` [doc]. The OctoPrint driver's probe must check `/server/info` first, or it
  will claim Moonraker printers.

---

## 8. Multi-material

There is no single standard; Klipper core has only `extruder`, `extruder1..N` and
`toolhead.extruder`.

- **Klipper multi-extruder / toolchangers:**
  - Each tool is `extruderN` with its own temperature and target.
  - The active tool is `toolhead.extruder`. Moonraker metadata has `referenced_tools`,
    `filament_type` and `filament_colors` (lists) for the file.
  - klipper-toolchanger adds a `toolchanger` object [unverified fields].
  - IDEX uses `dual_carriage`.
- **Happy Hare** (ERCF, Tradrack, etc.): the `mmu` printer object, with `num_gates`,
  `gate_status[]` (-1 unknown, 0 empty, 1/2 loaded), `gate_material[]`, `gate_color[]`
  (hex without #), `gate_temperature[]`, `gate`, `tool`, and `ttg_map` (tool→gate).
  Orca reads exactly these [orca `fetch_hh_filament_info`].
- **AFC** (Armored Turtle BoxTurtle/NightOwl) and recent Happy Hare publish lanes to the
  **Moonraker database** at `GET /server/database/item?namespace=lane_data`. The response is
  `{"result": {"namespace": "lane_data", "value": {"lane1": {"lane": "0", "color": "#FF0000", "material": "PLA", "bed_temp": 60, "nozzle_temp": 210, "...": "..."}, ...}}}`.
  Orca tries this **first** and falls back to `mmu`, citing the comment "AFC and recent Happy
  Hare as of Feb 15, 2026" [orca]. The full schema is [unverified]; Orca reads only `lane`,
  `color`, `material`, `bed_temp` and `nozzle_temp`.
- **Snapmaker U1:**
  - A 4-head toolchanger on a Snapmaker fork of Klipper and Moonraker
    (`github.com/Snapmaker/u1-klipper`, `u1-moonraker`).
  - Moonraker is reportedly on :7125, though one source says :80 [unverified].
  - It has RFID filament detection exposed as a `filament_detect` object, plus
    `filament_motion_sensor e0..e3` [unverified, community skill docs].
  - Treat it as 4× `extruderN`, with optional filament info if `filament_detect` exists.
- **Creality K-series CFS:** Creality's own protocol (port 9999 WebSocket), not Moonraker
  [unverified].
- **Spoolman** (optional): `server.spoolman.*`, `notify_active_spool_set`. Gives the active
  spool and its material and colour.

**What to show as "filament slots":**
1. If `lane_data` is non-empty, show those lanes.
2. Else, if `mmu.num_gates > 0`, show the HH gates.
3. Else, show one slot per `extruderN`, with material unknown. Material and colour can come
   from the loaded file's metadata while printing, or from a per-printer manual setting
   (like an external spool).

For sending, compatibility checks are advisory: Klipper has no AMS-mapping equivalent and
tool→slot mapping lives in the G-code.

---

## 9. Slicer specifics (OrcaSlicer v2.4.2 profiles)

### Thumbnail format Moonraker parses [src `metadata.py`]
- Regex: `(thumbnail(?:_[A-Za-z0-9]+)?) begin([;/\+=\w\s]+?); \1 end`, run over head and tail
  only (first and last 1 MiB).
  - The first line holds `W`, `H` and the base64 length.
  - Tags: `thumbnail` → PNG, `thumbnail_JPG` → JPG, `thumbnail_QOI` → QOI (converted to PNG).
  - **COLPIC and BTT_TFT are not parsed.**
- Thumbnails are saved as `.thumbs/<basename>-<W>x<H>.<ext>` next to the file. If no 32×32
  exists, Moonraker generates one from the largest.
- Orca's writer [orca `GCode/Thumbnails.hpp`]:
  ```
  ; THUMBNAIL_BLOCK_START
  ;
  ; thumbnail begin 300x300 12345
  ; <base64, 78 chars per line>
  ; thumbnail end
  ; THUMBNAIL_BLOCK_END
  ```
  It is written at the top of the file, so it falls in the scanned header.
- Recommended sizes:
  - Mainsail recommends `32x32/PNG, 400x300/PNG` for Orca [doc Mainsail].
  - KlipperScreen and most vendor screens like ~300×300.
  - Orca's default `thumbnails` is `48x48/PNG,300x300/PNG` and `thumbnails_format` is `PNG`
    [orca `PrintConfig.cpp`].
  - For Moonraker targets, emit at least one PNG of ≥300 px. Keep the vendor's sizes so the
    printer's own screen still works.
  - For COLPIC vendors (Elegoo Neptune 4 family, Qidi X-3 series), the profiles already add a
    PNG alongside (e.g. `160x160/PNG`, `110x110/PNG`).

### How to tell a Klipper/Moonraker printer from the profile
- **`gcode_flavor: "klipper"`**, resolved through `inherits`. It's often set in a
  `fdm_klipper_common` base, as in Voron. This is the reliable signal that the firmware is
  **Klipper**, but **not** that Moonraker exists. These are Klipper-flavoured but are not
  stock Moonraker:
  - Elegoo Centauri/Carbon use SDCP.
  - Flashforge AD5M/AD5X/Creator 5 use their own LAN API unless modded (ZMOD/KlipperMod).
  - Anycubic Kobra 2/3/S1 run GoKlipper, with Moonraker only via the Rinkhals mod.
  - Creality K2 uses `crealityprint`.

  [practice/unverified for each vendor]
- **`host_type`** is set in only a few profiles:
  - `octoprint` (labelled "Octo/Klipper" in Orca) means OctoPrint **or** Moonraker through its
    OctoPrint-compat API.
  - `crealityprint` and `elegoolink` mean the vendor protocols.
  - `moonraker` ("Moonraker (Klipper)") exists in v2.4.2 (`htMoonraker`), but **no bundled
    profile uses it**.
  - So `host_type` alone is not decisive. Use it only as a hint for defaults ("this model
    usually speaks Moonraker on :7125").
- `print_host` is never set in system profiles; it's per physical printer.

### Klipper-flavoured machine models in v2.4.2 (resolved `gcode_flavor`; thumbnails; host_type)
"default" means `thumbnails` is unset, so Orca's default `48x48/PNG,300x300/PNG` applies.

| Vendor | Klipper models | thumbnails (format) | host_type |
|---|---|---|---|
| Voron | 0.1, 2.4 250/300/350, Trident 250/300/350, Switchwire 250 | default | — |
| RatRig | V-Core 3 (200–500), V-Core 4 (300/400/500, HYBRID, IDEX incl. COPY/MIRROR), V-Minion, V-Cast | V-Core 4: `64x64/PNG,400x300/PNG` (+`100x100` on HYBRID/IDEX); others default | — |
| Sovol | SV06 ACE, SV06 Plus ACE, SV07 Plus, SV08, SV08 MAX, Zero | SV08 `300x300,400x300,32x32` PNG; SV08 MAX `32,64,160,256` PNG; Zero `300x300,32x32`; SV06 ACE `96,160` | — |
| Creality | CR-10 SE, Ender-3 V3 / V3 KE / V3 Plus / V4, Ender-5 Max, Hi, K1 / K1C / K1 SE / K1 Max (+ `_CFS-C` variants), K2 / K2 Plus / K2 Pro / K2 SE, SPARKX i7 | mostly `96x96,300x300` PNG; Ender-3 V3 Plus `320x320` | K1 family `octoprint`; K2/K2 Plus/K2 Pro/SPARKX `crealityprint`; K2 SE `octoprint` |
| Elegoo | Neptune 4 / 4 Pro / 4 Plus / 4 Max, OrangeStorm Giga, Centauri / Centauri 2 / Centauri Carbon / Carbon 2 | Neptune: `320x320/COLPIC,160x160/COLPIC,160x160/PNG`; Centauri `144x144` PNG | `elegoolink` (Centauri = SDCP, not Moonraker) |
| Qidi | Q1 Pro, Q2, Q2C, X-Max 3/4, X-Plus 3/4, X-Smart 3 | X-3 series and Q2: `380x380/COLPIC,210x210/COLPIC,110x110/PNG`; Q1 Pro `160x160,112x112`; X-Plus 4 `272x272,96x96` | — |
| Anycubic | Kobra 2 Max/Plus/Pro, Kobra 3, Kobra 3 Max, Kobra S1, S1 Max, Kobra X | `230x110` PNG | `octoprint` |
| Flashforge | Adventurer 5M / 5M Pro, AD5X, Creator 5 / 5 Pro, Guider 3 Ultra, Guider4 / 4 Pro | `140x110` PNG | some `octoprint` |
| Snapmaker | U1 | default or `48x48/PNG, 300x300/PNG` | `octoprint` (one variant) |
| Artillery | M1 Pro, Sidewinder X4 Plus / X4 Pro | `300x300` PNG | X4 `octoprint` |
| Others (all Klipper) | Afinia H+1(HS); BIQU Hurakan; BLOCKS Pro S100/RD50 V2/RF50; Chuanying X1; Co Print ChromaSet; CoLiDo DIY 4.0 (+V2), SR1; Comgrow T300 (`JPG`), T500; Cubicon xCeler-I/Mini/Plus; Custom "Generic Klipper Printer", "Generic ToolChanger Printer"; DeltaMaker 2/2T/2XT; Eryone ER20 Klipper, Thinker X400; FLSun S1, T1, V400; FlyingBear Ghost7, Reborn3, S1; Ginger G1; InfiMech EX, EX+APS, TX; Kingroon KLP1, KP3S PRO V2, KP3S V1; LH Stinger (+MMU); LONGER LK10 (+Plus); MagicMaker BoneKing, hj SK; Mellow M1; OpenEYE Peacock V2; Orca Arena X1 Carbon; Peopoly Magneto X; Phrozen Arco; Positron; RH3D E3NG (`QOI` + PNG); Rolohaun Delta Flyer Refit, Rook MK1 LDO; SecKit SK-Tank, Go3; Tiertime UP300 HS/UP310 Pro/UP400 Pro/UP600 HS; TwoTrees SK1, SP-5 Klipper; Vivedino Troodon 2.0 Klipper; Volumic EXO42/EXO65/SH65/VS30 (12 variants, `octoprint`); Vzbot 235/330 AWD; Wanhao France D12 SMARTPAD (9); WonderMaker ZR / Ultra / Ultra S; Z-Bolt S300–S1000 (+Dual); re3D Gigabot 4 (+XLT), GigabotX 2 (+XLT), Terabot 4, TerabotX 2 | mostly default or `48x48/PNG,300x300/PNG` | mixed |

That is 47 vendors with at least one instantiable Klipper-flavoured model. The list was reproduced with a resolver over
`resources/profiles/<vendor>/machine/*.json`, following `inherits` within each vendor and
printing instantiated presets' `printer_model`, `gcode_flavor`, `thumbnails`,
`thumbnails_format` and `host_type`.

**Ships with Moonraker stock** [practice, verify per model]:
- Sovol SV08/Zero (Mainsail).
- Elegoo Neptune 4 family (Fluidd).
- Qidi X-3/Q1/Q2/X-4 (Fluidd + Moonraker; Qidi Link uses it).
- Creality K1 family (Moonraker on 7125 on recent firmware; Fluidd/Mainsail via the community
  helper script) and K2 (Moonraker on 7125 per Printago).
- Snapmaker U1.
- Every DIY Voron/RatRig (RatOS, MainsailOS).

---

## 10. Fake printer for tests

### A. `virtual-klipper-printer` (mainsail-crew): **recommended for conformance on buildhost**
- Repo: `github.com/mainsail-crew/virtual-klipper-printer` (GPL-3.0). It is maintained;
  the latest commits are from 2026-01 and CI publishes the image.
- Image: **`ghcr.io/mainsail-crew/virtual-klipper-printer:latest`**. One container runs
  supervisord with:
  - `simulavr` (atmega644p @ 20 MHz running real Klipper firmware) →
    `klippy.py printer.cfg -a ~/printer_data/comms/klippy.sock`;
  - Moonraker (`master`, with `[history]`, `[job_queue]` and `[octoprint_compat]`);
  - mjpg-streamer `input_file.so` cycling the JPEGs in `printer_data/webcam_images` every
    0.8 s (`output_http` on :8080).
- Compose (from the repo):
  ```yaml
  services:
    printer:
      image: ghcr.io/mainsail-crew/virtual-klipper-printer:latest
      volumes: ["./printer_data:/home/printer/printer_data:delegated"]
      ports: ["7125:7125", "8110:8080"]
      tmpfs: ["/tmp:noexec", "/home/printer/printer_data/comms:noexec"]
  ```
  Run `docker compose up -d`. If `printer_data/config` is empty, the example configs are
  copied in. Dev convention: map the ports to free ones on buildhost (9338/9339 are ours; pick
  e.g. 17125 and 18110).
- Default `moonraker.conf`: `trusted_clients: 0.0.0.0/0`, `cors_domains: *`,
  `enable_object_processing: True`. **No auth is exercised by default.** To test API keys:
  - Set `trusted_clients: 127.0.0.1/32` in the mounted config.
  - Read the key with `docker exec <c> curl -s localhost:7125/access/api_key`.
  - Our server then connects from the Docker bridge as an untrusted client.
- No `[webcam]` is configured. Add one with an **absolute** URL. A relative `/webcam/` would
  resolve to :80, which nothing serves in this container.
  ```ini
  [webcam fake]
  service: mjpegstreamer
  stream_url: http://<buildhost>:18110/?action=stream
  snapshot_url: http://<buildhost>:18110/?action=snapshot
  ```
- printer.cfg (`example-configs`):
  - It includes `[pause_resume]`, `[display_status]`, `[exclude_object]`, `[virtual_sdcard]`,
    `[bed_mesh]`, `[firmware_retraction]`, a cartesian kinematics addon, a single extruder
    (`max_temp 250`, `min_extrude_temp 50`) and a heater_bed (`max_temp 130`).
  - Its macros wrap `PAUSE`/`RESUME`/`CANCEL_PRINT` with `rename_existing` (like Mainsail's
    client macros).
  - **`M140`/`M190` are overridden to no-op `M117` messages**, so bed targets never change.
- **Limitations:**
  - **Temperatures are not physically simulated.** simulavr's ADC pins are not driven by
    Klipper's `avrsim.py`, so the reported temperature stays static and heaters never reach
    target [src avrsim.py has no ADC code; Klipper Discourse "temperature of the simulated
    printer is not correct"; exact behaviour unverified].
    - `M109`/`M190`/`TEMPERATURE_WAIT` in a test file **will hang**.
    - Test G-code must not wait on heat: strip the Orca start G-code, or override `M109` with
      a macro in the mounted config.
    - `SET_HEATER_TEMPERATURE` still updates `target`, so preheat/cooldown commands can be
      asserted on `target`.
  - Motion runs in **real time**: a print takes as long as its moves. Use a tiny test file
    (a few hundred mm of moves, ~30–60 s) to see `printing` → `complete` with advancing
    `virtual_sdcard.progress`, `print_duration` and history.
  - Pause, resume and cancel work through the real `pause_resume` and `virtual_sdcard` code.
  - simulavr is CPU-hungry and single-threaded. Debug builds can give "Timer too close"/MCU
    shutdowns on fast moves. Keep feedrates modest. prind notes `CXXFLAGS=-O2` helps.
  - `G28` works: the endstops are simulated as already triggered or never-triggered depending
    on config [unverified]. Insert `G28` only if needed; the example `START_PRINT` macro runs it.
- Test G-code sketch (no heat waits):
  ```gcode
  ; generated by OrcaSlicer 2.4.2 on 2026-10-12 at 12:00:00
  ; thumbnail begin 32x32 <len>
  ; <base64 png>
  ; thumbnail end
  G28
  G90
  M73 P0
  G1 X50 Y50 Z5 F3000
  ; ... ~40 short G1 moves with M73 P.. every few lines ...
  M73 P100
  ; estimated printing time (normal mode) = 1m 0s
  ; total filament used [g] = 0.10
  ; total layers count = 1
  ```

### B. prind (mkuf/prind): full stack, simulavr built locally
- `github.com/mkuf/prind`, with images `mkuf/klipper`, `mkuf/moonraker` and others (built
  daily; tags `latest` plus git-describe).
- **The simulavr target is not published**; it is built from `docker/klipper` target
  `build-simulavr`:
  ```sh
  docker compose --profile mainsail -f docker-compose.yaml -f docker-compose.extra.simulavr.yaml up -d
  ```
- It is more realistic in topology (separate containers, nginx-fronted Mainsail, so relative
  `/webcam/` URLs and port-80 proxying can be tested) but heavier. It has the same
  temperature and real-time limits as A. Use it only if we need the nginx front door.

### C. Moonraker alone (no Klipper)
- Moonraker starts fine without Klipper. `server.info` reports `klippy_connected: false`,
  and all `printer.*` calls return 503.
- Files, metadata, thumbnails, history (read), webcams, database and auth all work.
- **Best use:** a CI-friendly check that **our generated G-code** parses correctly (§3 action
  item): upload, then assert on `server.files.metadata` and fetch the `.thumbs/*.png`.
- Use the `mkuf/moonraker` image from prind or the Moonraker image built for A; a
  `python:3.12-slim` + `pip install -r scripts/moonraker-requirements.txt` + `moonraker.py -d /data`
  also works.

### D. Hand-written fake (Node, in `tests/`): **recommended for e2e in CI**
This is deterministic, needs no Docker, and runs fast. Implement only the subset we use, with
the real shapes from this document.
- HTTP:
  - `/access/info`, `/server/info`, `/printer/info`, `/printer/objects/list`
  - `/printer/objects/query`
  - `POST /server/files/upload` (multipart; store the file; compute metadata by running a mini
    version of the regexes from §3; extract thumbnails)
  - `/server/files/metadata`, `GET /server/files/gcodes/*`, `DELETE /server/files/gcodes/*`
  - `/printer/print/{start,pause,resume,cancel}`, `/printer/gcode/script` (parse M104/M140/
    `SET_HEATER_TEMPERATURE`/`TURN_OFF_HEATERS`/M106/M107/M220, answer 400 on anything else),
    `/printer/emergency_stop`, `/printer/firmware_restart`
  - `/server/history/list`, `/server/history/job`, `/server/webcams/list`
  - a `/webcam/?action=snapshot|stream` serving a static JPEG and a multipart MJPEG
- WS `/websocket`: identify, subscribe (full snapshot, then deltas every 250 ms),
  `notify_status_update`, `notify_history_changed` (`added`/`finished`),
  `notify_klippy_disconnected`/`ready`/`shutdown` (with a test hook to trigger them),
  `notify_gcode_response`.
- Simulation: temperatures ramp toward their targets (e.g. 2 °C/s). `print_stats` advances
  with a configurable time scale. `display_status.progress` follows. Model the gating quirks
  for realism: start while paused replaces the job, and `SD busy` while printing.
- Auth modes via env: `trusted` (no key), `apikey` (401 without `X-Api-Key`), `force_logins`.
- Test hooks: `POST /__fake/fail` (→ `error` state with a message), `/__fake/shutdown`, and
  `/__fake/outside-print` (start a print of a file we didn't upload, with thumbnails).
- Keep it beside the Bambu fake (`tests/fake-printer/`), e.g. `tests/fake-moonraker/`, so
  it's started by `tests/run-e2e.sh`.

Use **D in CI** and **A on buildhost** as a periodic real-stack conformance check, with C
inside the D test run if we want metadata parsing verified against real Moonraker.

---

## 11. Risks and open points

1. **Auth variance.** Most LAN installs trust RFC1918 and need no key. Some vendor firmware
   and hardened installs need `X-Api-Key`. `force_logins` installs need JWT, which we
   deliberately don't support. Use `/access/info` to tell the user which case applies.
2. **No reliable discovery.** Zeroconf is off by default, so expect manual entry. A subnet
   sweep of 7125 is the only broad option. Keep it opt-in.
3. **Klipper accepts a start while paused** and Moonraker doesn't block it. Our driver must
   gate on `print_stats.state`.
4. **`printer.gcode.script` has no timeout** and blocks on M109/G28. Only send non-blocking
   commands from the UI, and put a client-side timeout on every request.
5. **The preheat is undone by `idle_timeout`** (default 10 min).
6. **User macros change behaviour.** PAUSE/CANCEL/START_PRINT are user-defined. Cancel may
   park, cool or home, and some vendor macros fail if a print wasn't started the way they
   expect. We can only send the standard commands.
7. **Remaining time** is our own estimate (slicer estimate + progress). It won't match the
   printer screen exactly.
8. **Camera URLs** are often relative to nginx on :80 and the services vary (WebRTC/HLS). Only
   snapshot/MJPEG is realistically proxyable. A per-printer camera URL override is needed.
9. **Vendor forks** (Creality K1/K2, Qidi, Elegoo Neptune, Snapmaker U1) run old or modified
   Moonraker. Endpoints like `server.webcams.*`, `history` and `/access/info` may be older or
   missing. Probe and degrade gracefully, using `failed_components`/`components` from
   `/server/info`.
10. **Multi-material** has no standard. Lane data comes from `lane_data` (AFC/HH), then
    `mmu` (HH), then per-extruder. Material compatibility checks can only be advisory.
11. **The fake printer can't heat.** simulavr temperatures are static, so heat-wait paths are
    only testable in the hand-written fake.
12. **[unverified] items to confirm on real Moonraker (option A):**
    - the upload response wrapping (`result` or bare);
    - the HTTP error body shape;
    - `speed_factor` persistence across prints;
    - whether Moonraker pings the WebSocket;
    - the go2rtc snapshot path;
    - Snapmaker U1's port and objects.

## Sources
- Moonraker docs: https://moonraker.readthedocs.io/en/latest/ ([external_api/introduction](https://moonraker.readthedocs.io/en/latest/external_api/introduction/), [authorization](https://moonraker.readthedocs.io/en/latest/external_api/authorization/), [printer](https://moonraker.readthedocs.io/en/latest/external_api/printer/), [server](https://moonraker.readthedocs.io/en/latest/external_api/server/), [file_manager](https://moonraker.readthedocs.io/en/latest/external_api/file_manager/), [history](https://moonraker.readthedocs.io/en/latest/external_api/history/), [webcams](https://moonraker.readthedocs.io/en/latest/external_api/webcams/), [jsonrpc_notifications](https://moonraker.readthedocs.io/en/latest/external_api/jsonrpc_notifications/), [configuration](https://moonraker.readthedocs.io/en/latest/configuration/))
- Moonraker source (`master`): `moonraker/server.py`, `components/{authorization,application,zeroconf,webcam,klippy_apis,klippy_connection,history,job_state}.py`, `components/file_manager/{file_manager,metadata}.py`
- Klipper: [Status_Reference](https://www.klipper3d.org/Status_Reference.html), [Debugging](https://www.klipper3d.org/Debugging.html), `klippy/extras/{print_stats,virtual_sdcard,pause_resume,display_status,idle_timeout}.py`, `scripts/avrsim.py`
- OrcaSlicer v2.4.2 (local submodule): `src/slic3r/Utils/{Moonraker,MoonrakerPrinterAgent,OctoPrint}.cpp`, `src/slic3r/GUI/PhysicalPrinterDialog.cpp`, `src/libslic3r/{PrintConfig,GCode}.cpp`, `src/libslic3r/GCode/Thumbnails.hpp`, `resources/profiles/*`
- Mainsail: [OrcaSlicer settings](https://docs.mainsail.xyz/slicers/orcaslicer/), [crowsnest cam section](https://docs.mainsail.xyz/crowsnest/configuration/cam-section/)
- Fakes: [mainsail-crew/virtual-klipper-printer](https://github.com/mainsail-crew/virtual-klipper-printer), [mkuf/prind](https://github.com/mkuf/prind)
- Snapmaker U1: [Printago setup](https://docs.printago.io/docs/connecting-printers/snapmaker), [Snapmaker firmware on GitHub](https://snapmaker.com/blog/snapmaker-u1-firmware-now-on-github)
- Creality: [Printago Creality](https://docs.printago.io/docs/connecting-printers/creality), [SimplyPrint K1 guide](https://simplyprint.io/setup-guide/creality/k1.md)
