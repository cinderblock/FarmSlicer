# Elegoo Centauri Carbon: SDCP (CC1) and the CC2 MQTT protocol

`plans/printer-drivers/sdcp.md`. This is research notes for the Elegoo driver, written for
the engineer who implements it. The parent plan is `plans/printer-drivers.md`.

Researched 2026-10-12. None of it was tested against hardware, because we don't have any.

## TL;DR

- **Centauri Carbon (CC1)** and **Centauri** (non-Carbon) use **SDCP v3**.
  - Discovery is UDP `M99999` to port 3000.
  - Control is JSON over `ws://<ip>:3030/websocket`, with no auth.
  - Upload is chunked multipart `POST http://<ip>/uploadFile/upload`, on **port 80**, not 3030.
  - The camera is MJPEG at `http://<ip>:3031/video`.
  - Print pictures are at `http://<ip>/board-resource/history_image/<TaskId>.png`.
- **Centauri Carbon 2 (CC2)** and **Centauri 2** are a *different protocol*:
  - JSON-RPC over an **MQTT broker running on the printer** (1883 TCP, 9001 WS).
  - Username `elegoo`, password = the access code (default `123456`).
  - Discovery is UDP JSON `{"id":0,"method":7000}` to port 52700.
  - Upload is `PUT http://<ip>/upload` with `Content-Range`.
  - The camera is MJPEG on `:8080`.
  - It needs "LAN Only" mode turned on.
  - Plan it as **a second driver**, not a variant of SDCP.
- The **sharpest risk** is that CC1's firmware is one process (`/app/app`). It runs the UI, the
  network, *and* the embedded Klipper motion stack. An **unknown Cmd, or a known Cmd with an
  unexpected payload shape**, can crash it and kill a running print. Only send the exact
  payload shapes listed here.

## Sources and confidence tags

Every claim below carries a tag saying where it came from.

| Tag | Source | Trust |
|---|---|---|
| [spec] | [cbd-tech SDCP V3.0.0 spec](https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0/blob/main/SDCP(Smart%20Device%20Control%20Protocol)_V3.0.0_EN.md). Written for resin printers. | Envelope: high. FDM fields: not covered. |
| [SDK] | [ELEGOO-3D/elegoo-link](https://github.com/ELEGOO-3D/elegoo-link), Elegoo's official C++ SDK, used by ElegooSlicer (`src/lan/adapters/elegoo_fdm_cc*`). | High. Some command mappings are commented out. |
| [fw] | [elegooofficial/CentauriCarbon](https://github.com/elegooofficial/CentauriCarbon), the official CC1 firmware source: `core/klippy/gcode_preview.c`, `print_history.*`, `Define_config_path.h`. Also its bundled web UI, `firmware/resources/e100/www/*.js` (Elegoo's own SDCP client). The SDCP/HTTP server itself is **not** in the tree. | High |
| [Orca] | OrcaSlicer v2.4.2: `src/slic3r/Utils/ElegooLink.cpp` (read locally). Also the bundled CC2 device panel `resources/web/elegoolink/lan_service_web/index.html`, which contains Elegoo's own CC1 SDCP client *and* CC2 MQTT client, minified. | High |
| [pyc] | [bjan/pycentauri `docs/PROTOCOL.md`](https://github.com/bjan/pycentauri/blob/main/docs/PROTOCOL.md). Live probes on CC1 V1.1.46 stock and V0.3.0-o (OpenCentauri), and CC2 01.03.02.51 / 02.01.00.00. | Medium-high. Measured, but on a single printer. |
| [HA] | [danielcherubini/elegoo-homeassistant](https://github.com/danielcherubini/elegoo-homeassistant): SDCP/CC2 clients, plus `docs/CC2_PROTOCOL.md`. | Medium. Its CC2 doc has some errors (noted inline). |
| [OC] | [OpenCentauri `docs/software/api.md`](https://github.com/OpenCentauri/OpenCentauri/blob/main/docs/software/api.md), community-written. | Medium. Its examples are partly idealised. |
| **UNCERTAIN** | Inference, or sources that conflict. | Verify on hardware. |

---

## 1. Discovery

### CC1 / Centauri (SDCP)

The client sends the 6 ASCII bytes `M99999` (no JSON, no newline) as a UDP broadcast to
`255.255.255.255:3000`, or as a directed packet to `<ip>:3000`. Each printer unicasts a JSON
reply back to the sender's port. [spec] [SDK] [fw]

```json
{
  "Id": "979d4C788A4a78bC777A870F1A02867A",
  "Data": {
    "Name": "Centauri Carbon",
    "MachineName": "Centauri Carbon",
    "BrandName": "ELEGOO",
    "MainboardIP": "192.168.1.50",
    "MainboardID": "1c7319d30105041800009c0000000000",
    "ProtocolVersion": "V3.0.0",
    "FirmwareVersion": "V1.1.46"
  }
}
```

- **`MainboardID` on CC1 is 32 hex characters.** The examples in [pyc] and [Orca] both show
  this; the spec says 16. Treat it as an opaque string.
  - It is the identity used in topics and requests.
  - **Pin it at configuration time.** In paused or errored states the printer does not push
    Attributes after you connect. [pyc]
- `Id` is a brand identifier. Elegoo's own clients send `Id: ""` (or the mainboard id) in
  requests.
- `FirmwareVersion` carries a `V` prefix (the SDK strips it). `BrandName` varies: OpenCentauri
  shows `"Centauri"`. **UNCERTAIN**: the exact `BrandName` value on stock CC1. Don't filter on it.
- Retransmit the probe 2–3 times within about 3–5 s, because UDP drops on busy LANs. [pyc]
- `Name` is the user-set name. `MachineName` is the model.
- How the SDK parses the reply: it requires `Id` and `Data`, and takes `Data.{Name,
  MachineName, MainboardID, FirmwareVersion}`. Use the UDP sender IP as the host, not
  `MainboardIP`.

**Filtering the replies.** Resin printers (Saturn 3/4, Mars 4/5, and so on) answer `M99999`
too. Older resin printers report `ProtocolVersion: "V1.x"` and use an MQTT variant of SDCP,
where the *client* runs the broker and the printer connects to it. Accept a reply only when:

- `ProtocolVersion` starts with `V3`, **and**
- `MachineName` (case-insensitive) is `Centauri Carbon` or `Centauri`. Don't use a loose
  `starts_with("Centauri")`, because a CC2-firmware machine named "Centauri 2" won't answer
  here anyway.

Neptune 4-series printers are Klipper/Moonraker and belong to the Moonraker driver.

One legacy shape exists, used by an HA test fake and Saturn-era Cassini tools: `Data` nests
`Attributes` and `Status`. Parse `Data.Attributes.*` as a fallback.

### CC2 / Centauri 2

[SDK] `elegoo_fdm_cc2_discovery_strategy.cpp`. Broadcast or directed UDP to port **52700**:

```json
{"id": 0, "method": 7000}
```

Reply:

```json
{"id": 0, "result": {"host_name": "Centauri Carbon 2", "machine_model": "Centauri Carbon 2",
  "sn": "F01ABC...", "token_status": 1, "lan_status": 1}}
```

- `token_status`: 1 means an access code is set; 0 means use the default `123456`. It may
  arrive as an int or a bool.
- `lan_status`: 1 means LAN-only mode; 0 means cloud mode. In cloud mode the local API
  doesn't work.
- `pyc` claims the CC2 has no broadcast discovery. That conflicts with the official SDK.
  Trust the SDK, but support manual IP entry as well.

---

## 2. Transport: CC1 WebSocket

- **Endpoint**: `ws://<ip>:3030/websocket`. There is no auth and no token. [spec] [SDK] [fw]
  - The SDK maps an `https` host to `wss://<ip>:3030/websocket`, but plain `ws` is normal on a LAN.
  - **Network surface: one process (`/app/app`) serves all of these:**
    - `:80` HTTP (web UI, upload, download, history images)
    - `:3030` WebSocket
    - `:3031` MJPEG
    - possibly `:8883` WebRTC signalling (see §6)

    If all three of 80/3030/3031 go dead while UDP discovery still answers, the daemon has
    crashed. [pyc]
- **Frames**: one JSON object per text frame. Some firmware **prefixes a decimal length**,
  for example `123{"Id":...}`, so strip leading digits before the first `{`. [pyc] Don't cap
  the frame size (pycentauri needed `max_size=None`).
- **Heartbeat**: send the text frame `ping`; the printer replies with the text frame `pong`.
  [spec] [fw]
  - The printer's web UI does this periodically.
  - WS-level ping frames also seem to be tolerated (HA uses aiohttp `heartbeat=30`).
  - Use about 10–30 s. Treat a missed `pong` or a socket error as a disconnect and reconnect
    with backoff.

### Request envelope

This is exactly what Elegoo's own web UI sends ([fw] `getMsgBodyString`). The SDK is the same,
except it sets `Id`/`MainboardID` to the mainboard id and `TimeStamp` to a steady-clock ms
value.

```json
{
  "Id": "",
  "Data": {
    "Cmd": 0,
    "Data": {},
    "RequestID": "6f1c0b8e2d4a4b7f9a3e5c1d2b0a9f8e",
    "MainboardID": "",
    "TimeStamp": 1760300000000,
    "From": 1
  },
  "Topic": "sdcp/request/1c7319d30105041800009c0000000000"
}
```

- Elegoo's clients leave `Topic` empty or omit it; the spec includes it. Sending it is harmless.
- `RequestID`: any unique string. The UI uses a UUID without dashes; the SDK uses 16 hex chars.
- `From` values: 0 = PC LAN, 1 = PC via web, 2 = web, 3 = app, 4 = server. Elegoo's own
  clients send **1**. Use 1.
- `TimeStamp`: the spec says seconds; real clients send ms. Nothing validates it. Send epoch ms.

### Incoming topics

The type is decided by `Topic`. The `<id>` suffix is the mainboard id.

| Topic | Shape |
|---|---|
| `sdcp/response/<id>` | `{"Id","Data":{"Cmd","Data":{"Ack":0,...},"RequestID","MainboardID","TimeStamp"},"Topic"}`. Correlate by `Data.RequestID`. `Ack` 0 means ok. |
| `sdcp/status/<id>` | `{"Status":{...},"MainboardID","TimeStamp","Topic"}`. **`Status` sits at the top level** in [fw], [Orca] and [SDK]. One HA test fakes `Data.Data.Status`; parse both. |
| `sdcp/attributes/<id>` | `{"Attributes":{...},"MainboardID","TimeStamp","Topic"}` |
| `sdcp/error/<id>` | `{"Data":{"Data":{"ErrorCode":1},...}}`. 1 = MD5 failed after transfer; 2 = bad file format. |
| `sdcp/notice/<id>` | `{"Data":{"Data":{"Message":"…","Type":1}}}`. Type 1 = history sync done. |

Cmd 0 and Cmd 1 answer twice: an `Ack` on `response`, then the actual frame on
`status`/`attributes`.

### Status freshness

- The printer pushes Status **when it changes**. [spec]
- **Cmd 512 `{"TimePeriod": <ms>}`** subscribes to periodic pushes. [pyc] Older HA MQTT code
  uses it too.
- **On OpenCentauri V0.3.0-o, the periodic pushes die while idle** (512 is ACKed, nothing
  arrives). They resume during a print. [pyc] **UNCERTAIN** whether stock firmware does this.
  Some community libraries refuse to send 512, because the SDK doesn't map it.
- **Recommendation:**
  - Send `Cmd 0` on connect.
  - Send `Cmd 0` again whenever no status has arrived for about 5 s while printing, or about
    15–30 s while idle.
  - Treat pushes as a bonus.
  - Optionally send `512 {"TimePeriod":5000}` after you've verified it on hardware.

### Connection limits

- **CC1 accepts at most 5 concurrent WebSocket clients.** A 6th upgrade gets HTTP 500 with
  the body `too many client`. [pyc, measured] HA's README says "4" and counts the video
  stream as one slot.
  - Slots free immediately on close.
  - OrcaSlicer treats a declined handshake as "too many connections" (Orca upload-and-print
    opens a temporary socket of its own).
- The camera server has very few slots **and leaks them**: closed clients sit in FIN-WAIT-2.
  [pyc] See §6.
- Hold **one** long-lived WebSocket per printer and serialise commands through it. Other
  clients (the touchscreen, the Elegoo app/slicer, Home Assistant) can still drive the printer
  concurrently. That's the same multi-controller situation as Bambu LAN.
- Attributes also include `NumberOfCloudSDCPServicesConnected`/`MaximumCloudSDCPSercicesAllowed`
  (the typo is real). [OC]

---

## 3. CC1 status fields

Here is a real V1.1.x capture during a print [pyc]. Some keys are filled in from [OC] and [fw].

```json
{
  "Status": {
    "CurrentStatus": [1],
    "PreviousStatus": 0,
    "TimeLapseStatus": 0,
    "PlatFormType": 0,
    "TempOfHotbed": 50.04, "TempTargetHotbed": 50,
    "TempOfNozzle": 255.01, "TempTargetNozzle": 255,
    "TempOfBox": 29.2, "TempTargetBox": 0,
    "CurrenCoord": "139.96,123.71,5.33",
    "CurrentFanSpeed": {"ModelFan": 58, "AuxiliaryFan": 0, "BoxFan": 68},
    "ZOffset": 0.415,
    "LightStatus": {"SecondLight": 1, "RgbLight": [0, 0, 0]},
    "PrintInfo": {
      "Status": 13,
      "CurrentLayer": 34, "TotalLayer": 438,
      "CurrentTicks": 364.98, "TotalTicks": 4504,
      "Filename": "ECC_0.4_temperature_tower_PLA0.16_1h15m.gcode",
      "TaskId": "295cb186-daf5-4b84-9668-59a520e4640a",
      "PrintSpeedPct": 100,
      "Progress": 9,
      "ErrorNumber": 0
    }
  },
  "MainboardID": "…", "TimeStamp": 1760300000, "Topic": "sdcp/status/…"
}
```

**Field notes**

- **Typos are part of the protocol**: `CurrenCoord`, `PlatFormType`, `RelaseFilmState`,
  `MaximumCloudSDCPSercicesAllowed`. Accept both spellings on read; never "fix" them on write.
- **Units of `CurrentTicks`/`TotalTicks`**: the spec says ms, but on CC1 they are **seconds**,
  possibly fractional. The SDK, [pyc] and HA all agree (HA multiplies FDM ticks by 1000). The
  remaining time is `TotalTicks − CurrentTicks`; the firmware doesn't compute it.
- `Progress` is 0–100, on newer firmware only. Fall back to `CurrentLayer/TotalLayer`.
- **Temperatures**: current and target are floats.
  - Older firmware sent pairs like `TempOfNozzle: [target, actual]` (CentauriLink era). Accept
    both. [pyc]
- `CurrentFanSpeed` values are percentages, 0–100. The `ModeFan` duplicate key appears on some
  firmware. [OC]
- `PrintSpeedPct` is a percentage. The presets are 50 silent / 100 balanced / 130 sport /
  160 ludicrous. [Orca panel] [SDK]
- `PlatFormType` (status) and `PrintPlatformType` (start) are the build-plate side:
  **0 = textured**, **1 = smooth**. The web UI labels them "texture"/"light"; OrcaSlicer sends
  1 only for `BedType::btPC`. [fw] [Orca]
- `TimeLapseStatus`: 0 off, 1 on.
- `PrintInfo.TotalExtrusion`/`CurrentExtrusion`: on OpenCentauri firmware these keys sometimes
  arrive as **hex-encoded key strings** (`"54 6F 74 61 …"`). [HA] Optional; ignore unless needed.
- `Filename` can be a bare name or `/local/<name>`. Compare basenames.
- `TaskId` is a UUID that the printer generates at print start. It is the key to history and
  thumbnails.
- `ErrorNumber` (file-level): 0 none, 1 MD5, 2 read, 3 resolution, 4 format, 5 model mismatch.

### `CurrentStatus` (machine state)

`CurrentStatus` is an **array**. Normally it has one element; during a transfer it can be
`[1, 2]` or `[2, x]`. The SDK reads `[0]`, and if that is 2 (transferring), it uses `[1]`
instead. [SDK] [fw] [Orca]

| Code | Meaning |
|---|---|
| 0 | Idle |
| 1 | Printing (task active, including paused, preheating and leveling) |
| 2 | File transferring |
| 3 | Exposure test (resin; "Others" on FDM) |
| 4 | Device self-check |
| 5 | Auto-leveling (not inside a print) |
| 6 | Resonance test |
| 7 | Busy (other) |
| 8 | File checking (e.g. right after an upload; Orca waits until 8 clears before starting) |
| 9 | Manual homing |
| 10 | Filament unloading |
| 11 | PID tuning |

### `PrintInfo.Status` (print sub-state; FDM table)

Source: [SDK] `elegoo_fdm_cc_message_adapter.cpp`. **The FDM table differs from the resin
spec table from code 11 on.** The value **sticks after the job ends**: it stays at 9 or 8
until the next job.

| Code | Meaning | Normalised state |
|---|---|---|
| 0 | idle | idle |
| 1 | homing | preparing |
| 2–4 | resin only (dropping/exposing/lifting) | n/a |
| 5 | pausing | pausing |
| 6 | paused | paused |
| 7 | stopping | stopping |
| 8 | stopped | **stopped (terminal)** |
| 9 | complete | **finished (terminal)** |
| 10 | file checking | preparing |
| 11 | printer checking | preparing |
| 12 | resuming | resuming |
| 13 | printing | printing |
| 14 | error (print stopped due to error) | **failed (terminal)** |
| 15 | auto-leveling | preparing |
| 16 | preheating | preparing |
| 17 | resonance testing | preparing |
| 18 | print start | preparing |
| 19 | auto-leveling done | preparing |
| 20 | preheating done (also sits here between prints on some firmware) | preparing |
| 21 | homing done | preparing |
| 22 | resonance test done | preparing |
| 23–26 | resin/LCD auto-feed and unload states | treat as busy |

**Normalising the state**

- Combine the two fields: a code from the `PrintInfo` table only counts as "active" while
  `CurrentStatus` contains 1.
  - Elegoo's panel maps `CurrentStatus` ∉ {0,1} directly to transfer, checking, testing,
    leveling, homing, unloading or PID.
  - Otherwise it uses `PrintInfo.Status`.
- **20 vs paused**: Elegoo's own panel has a special case where `20` after a resume briefly
  means paused (`Paused → Preheating → Preheated` sequence). Don't over-fit to it.
  [Orca panel]

### Attributes (Cmd 1 / push)

```json
{"Attributes": {
  "Name": "Centauri Carbon", "MachineName": "Centauri Carbon", "BrandName": "ELEGOO",
  "ProtocolVersion": "V3.0.0", "FirmwareVersion": "V1.1.46",
  "XYZsize": "256x256x256", "MainboardIP": "192.168.1.50", "MainboardID": "…",
  "MainboardMAC": "00:11:22:33:44:55", "NetworkStatus": "wlan", "UsbDiskStatus": 0,
  "NumberOfVideoStreamConnected": 0, "MaximumVideoStreamAllowed": 1,
  "NumberOfCloudSDCPServicesConnected": 0, "MaximumCloudSDCPSercicesAllowed": 1,
  "Capabilities": ["FILE_TRANSFER", "PRINT_CONTROL", "VIDEO_STREAM"],
  "SupportFileType": ["GCODE"], "CameraStatus": 1, "RemainingMemory": 123455,
  "SDCPStatus": 1,
  "DevicesStatus": {"XMotorStatus": 1, "YMotorStatus": 1, "ZMotorStatus": 1,
                    "ExtruderMotorStatus": 1}
}}
```

- `Capabilities` may include `VIDEO_WEBRTC` (see §6).
- The SDK decides Canvas/multi-filament support from `FirmwareVersion > 1.1.x`.

### Error / failure reasons

- Live status has `PrintInfo.Status == 14` (error) and `ErrorNumber` (file errors only).
- Detailed reasons are in **task history** (§7, `ErrorStatusReason`). This is the FDM
  meaning, per [OC]/HA:

| Code | Reason |
|---|---|
| 0 | ok |
| 1 | over-temperature |
| 3 | filament runout |
| 6 | filament jam |
| 7 | leveling failed |
| 12 | USB removed |
| 13 / 14 / 23 | homing failed X / Z / Y |
| 17 | homing failed |
| 18 | bed adhesion / detached |
| 19 | print exception |
| 20 | motion abnormal |
| 24 | file error |
| 25 | camera |
| 26 | network |
| 27 | server |
| 28 | app disconnected |
| 33 | nozzle thermistor offline |
| 34 | bed thermistor offline |
| 45 | filament about to run out |

**UNCERTAIN**: these codes have no FDM source in the firmware tree.

---

## 4. Upload

### CC1: chunked multipart, `POST http://<ip>/uploadFile/upload` (port 80)

[fw] web UI, [SDK], [Orca] (Orca uses `print_host`, which normally means port 80).

**Port**: the spec says `:3030/uploadFile/upload`, but the printer's own web UI and the
official SDK use **port 80**. Use 80. **UNCERTAIN** whether 3030 also accepts it (HA's proxy
forwards HTTP to 3030 for the web UI).

**How to send it**

- Use one `multipart/form-data` POST per chunk.
- Chunks are **1 MiB (1048576 bytes)**, sent sequentially, and the last one is short.
- Reuse a keep-alive connection.
- Fields, in the web UI's order:

| Field | Value |
|---|---|
| `TotalSize` | whole file size (decimal string) |
| `Uuid` | random UUID, no dashes, **the same for every chunk of a file** |
| `Offset` | byte offset of this chunk |
| `Check` | `"1"` (verify MD5 when the last chunk arrives) |
| `S-File-MD5` | **MD5 of the whole file**, hex. The SDK uses lowercase; Orca uses `bbl_calc_md5`. Send lowercase. |
| `File` | the chunk bytes. `filename=` is the target name on the printer (e.g. `job-123.gcode`); `Content-Type: application/octet-stream` |

**Responses** (per chunk; the HTTP status is 200 in both cases):

```json
{"code": "000000", "messages": null, "data": {}, "success": true}
```

```json
{"code": "111111", "success": false, "data": null,
 "messages": [{"field": "common_field", "message": -2}, {"field": "filename", "message": "Cannot be empty"}]}
```

- `common_field` errors: -1 bad offset, -2 offset doesn't match the file so far, -3 open
  failed, -4 unknown.
- The file lands in internal storage as `/local/<filename>`.
- After the last chunk the printer verifies MD5:
  - `CurrentStatus` shows 2, then 8 (file checking).
  - A failure arrives as `sdcp/error` `ErrorCode` 1.
- Cmd 255 `{"Uuid","FileName"}` aborts an in-progress transfer. Its Acks are: 0 ok,
  1 not transferring, 2 already verifying, 3 not found.

**What OrcaSlicer's `ElegooLink` does for CC** (`loopUpload`, `checkResult`, `print`):

1. `GET http://<host>/` and check that the body contains "ELEGOO" (connection test).
2. Compute the MD5 and a UUID, then loop over 1 MiB parts with the fields above. It treats
   anything other than `code == "000000"` as an error.
3. If "upload and print" is on, it opens `ws://<host>:3030/websocket` and sleeps 1 s. Then it
   sends Cmd 0 and **re-polls every 1 s while `Status.CurrentStatus` contains 8**, for up to
   60 s.
4. It sleeps 1 s, then sends Cmd 128 (§5) with `Filename: "/local/<name>"`. It waits up to
   30 s for the `Cmd 128` response `Ack`.
   - Example response:
     `{"Id":"979d…","Data":{"Cmd":128,"Data":{"Ack":1},"RequestID":"5223…","MainboardID":"1c73…","TimeStamp":1735032553},"Topic":"sdcp/response/1c73…"}`

**Download, for pulling a file back** (e.g. to read the thumbnail of a file we didn't upload):

- The SDK's `doDownload` does `HEAD`, then `GET http://<ip>/downloadFile<remotePath>`,
  e.g. `/downloadFile/local/foo.gcode`. [SDK]
- The printer's own web UI instead fetches `http://<ip>:80<FileList name>`.
- **UNCERTAIN**: which path works on current stock firmware. Try `/downloadFile/local/<name>`
  first.

### CC2: `PUT http://<ip>/upload` (port 80)

[SDK] [Orca] `loopUploadCC2`, [pyc] [HA]

- Send the raw body (`application/octet-stream`) in 1 MiB chunks, sequentially.
- Headers on every chunk:
  - `Content-Range: bytes <start>-<end>/<total>`, where `<end>` is inclusive
  - `X-File-Name: <name>`
  - `X-File-MD5: <whole-file md5, lowercase>`
  - `X-Token: <access code or 123456>`
  - `Accept: application/json`
- The response is `{"error_code": 0, "offset": <last byte>}`. Some firmware returns
  `{"error_code":0,"received":…,"total":…}`.
  - 9000-series codes are upload errors: 9000 offset mismatch, 9004 MD5, 9007 path missing.
- Stock firmware accepts uploads without `X-*` headers too (ElegooLink 1.0.1 didn't send them).
- Orca does **not** auto-start prints on CC2.
- "LAN Only" must be enabled, otherwise port 80 is closed. [pyc]

---

## 5. Start and control

### CC1 commands (SDCP Cmd)

Only send what's listed here, with exactly these payloads.

| Cmd | Purpose | `Data` payload | Status / source |
|---|---|---|---|
| 0 | refresh status | `{}` | verified |
| 1 | refresh attributes | `{}` | verified |
| 128 | **start print** | see below | verified (Orca, web UI, pyc) |
| 129 | pause | `{}` | verified |
| 130 | stop | `{}` | verified |
| 131 | resume | `{}` | verified |
| 132 | stop feeding | `{}` | spec only |
| 133 | skip preheating | `{}` | spec; in web UI enum |
| 134 / 135 | power-loss resume: get state / act `{"action":1\|0}` | | web UI only |
| 192 | rename printer | `{"Name":"…"}` | spec, web UI |
| 255 | abort file transfer | `{"Uuid","FileName"}` | spec |
| 257 | rename file | ? | web UI enum only, **don't send** |
| 258 | file list | `{"Url":"/local"}` (or `/usb`) | verified [pyc]; an **empty or wrong payload crashed the daemon** |
| 259 | delete files | `{"FileList":["/local/a.gcode"]}`. **Full paths.** `FolderList` is optional. | verified [pyc] |
| 260 | file detail | `{"Url":"/local/a.gcode"}`. Returns `FileInfo.{Thumbnail, EstTime (s), EstWeight (g)}` | web UI [fw] |
| 320 | history ids | `{}` returns `HistoryData:[uuid…]`, newest first | verified [pyc] |
| 321 | history details | `{"Id":[uuid…]}` (batch) | verified [pyc] |
| 322 | delete history | `{"Id":[uuid…]}` | web UI, HA fake |
| 323 | export time-lapse | `{"Url":[TimeLapseVideoUrl…]}`. Returns `Data.Data:[url…]`; timeout 180 s | web UI |
| 324 | Canvas status (CC1 + Canvas kit) | `{}` | SDK mapping, **unprobed** |
| 386 | camera on/off | `{"Enable":1}` returns `VideoUrl` | web UI, HA |
| 387 | time-lapse on/off | `{"Enable":1}` | spec, web UI |
| 401 | jog | `{"Axis":"X","Step":10}` (negative step = minus) | web UI |
| 402 | home | `{"Axis":"XYZ"}` (or `X`/`Y`/`Z`) | web UI; SDK sends `toupper(axes)` |
| 403 | change parameters | see below | verified [pyc] |
| 512 | periodic status push | `{"TimePeriod":5000}` | pyc only; see §2 |
| 64 | "disconnect" | ? | web UI enum only, **don't send** |

**Start print (Cmd 128).** This is the full payload shape, copied from Orca/web UI/SDK. Don't
send the spec's minimal `{Filename, StartLayer}` alone: HA's beta that did so coincided with
crashes (HA PR #297, mixed with a bad 258 payload).

```json
{"Filename": "/local/job-123.gcode", "StartLayer": 0,
 "Calibration_switch": 1, "PrintPlatformType": 0, "Tlp_Switch": 0}
```

- `Filename`:
  - Orca sends `/local/<name>`. The web UI sends the FileList `name` (also a full path).
  - The SDK and pyc send the bare name. Both forms work.
  - Use `/usb/<name>` for USB.
- `Calibration_switch`: 1 means auto bed leveling before the print.
- `PrintPlatformType`: 0 textured / 1 smooth.
- `Tlp_Switch`: 1 means time-lapse.
- Canvas only (firmware with Canvas support): add
  `"slot_map":[{"t":0,"canvas_id":0,"tray_id":2},…]` [SDK]. **UNCERTAIN** on CC1.
- Ack codes: 0 ok, 1 busy, 2 file not found, 3 MD5 failed, 4 file read failed, 5 resolution
  mismatch, 6 unknown format, 7 model mismatch.
- **The response has no TaskId.** See §7 for tracking.

**Cmd 403 (dispatch by key; send only the keys you want to change):**

```json
{"PrintSpeedPct": 130}
{"TargetFanSpeed": {"ModelFan": 50, "AuxiliaryFan": 0, "BoxFan": 30}}
{"TempTargetNozzle": 220, "TempTargetHotbed": 60, "TempTargetBox": 0}
{"LightStatus": {"SecondLight": 1, "RgbLight": [0, 0, 0]}}
```

- Fans take 0–100 %. The speed presets are 50/100/130/160 (HA clamps to 0–160).
- Temperature clamps used by clients: nozzle 0–320 (SDK capability says 0–300), bed 0–110.
- **Preheat** = 403 with the targets set. **Cooldown** = 403 with the targets at 0.
- Known firmware issue: **V1.1.29** ignored remote light and temperature control *during a
  print*. [HA README]

**Arbitrary G-code: not available on CC1 stock.**

- SDCP has no G-code command.
- Workaround idea (UNCERTAIN, untested): upload a tiny `.gcode` file and start it. It creates
  a history entry, and the printer must be idle.
- [OpenCentauri](https://github.com/OpenCentauri) "COSMOS" replaces the stock stack with
  Klipper+Moonraker. A CC1 running that is a **Moonraker** printer, not SDCP.

**Pause/resume/stop** don't take `TaskId`. They act on the current job. Expect the print
sub-state to go 5→6, 12→13, 7→8.

### CC2 methods (MQTT JSON-RPC)

**Connection** [SDK] [Orca panel] [pyc] [HA]

- Connect to MQTT 3.1.1 at `tcp://<ip>:1883` (or `ws://<ip>:9001` for the panel).
  - Username `elegoo`. Password = the access code (`123456` when `token_status` is 0).
  - Client id: `1_PC_<4 digits>` (SDK) or `0cli` + 6 hex (panel). Use clean session.
- Register before doing anything else:
  - Subscribe to `elegoo/<sn>/<request_id>/register_response`.
  - Publish to `elegoo/<sn>/api_register` with `{"client_id":"…","request_id":"…"}`.
  - The reply is `{"client_id":…,"error":"ok"|"already registered"|"too many clients"|"fail"}`.
- Then subscribe to `elegoo/<sn>/<client_id>/api_response` and `elegoo/<sn>/api_status`.
- Requests go to `elegoo/<sn>/<client_id>/api_request` as `{"id":<int>,"method":<int>,"params":{…}}`.
- Responses come back as `{"id","method","result":{"error_code":0,…}}`.
- Heartbeat: publish `{"type":"PING"}` every 10–30 s; expect `{"type":"PONG"}`.
  - **This is mandatory.** Without it, registration silently expires after a few minutes. [pyc]
- Rate limit: 3 or more rapid requests cause about 5 s of dropped replies. Space requests
  about 1–2 s apart. [pyc]

**Status pushes**

- Pushes arrive on `api_status` with `method:6000`. They are **deltas**: deep-merge them into
  the cached state.
- If `id` jumps by more than 1, re-fetch with `1002`.
- `6008` is a system/attributes push.

**Methods** (the official enum is in the Orca panel; payloads come from the panel, [pyc], [HA])

| Method | Purpose | Params |
|---|---|---|
| 1001 | system info / attributes | `{}` |
| 1002 | full status | `{}` |
| 1020 | **start print** | `{"filename":"job.gcode","storage_media":"local","config":{"delay_video":false,"printer_check":true,"print_layout":"A","bedlevel_force":false,"slot_map":[{"t":0,"canvas_id":0,"tray_id":1}]}}` |
| 1021 / 1022 / 1023 | pause / **cancel** / resume | `{}` |
| 1007 | urgent stop (emergency) | `{}` |
| 1026 / 1027 | home / move | `{"homed_axes":"xyz"}` / `{"axes":"z","distance":10}` |
| 1028 | temperature | `{"extruder":220,"heater_bed":60}` |
| 1029 | light | `{"power":1}` |
| 1030 | fans, **0–255** | `{"fan":255,"aux_fan":0,"box_fan":64}` |
| 1031 | speed mode | `{"mode":0..3}`. 0 silent, 1 balanced, 2 sport, 3 ludicrous. Returns 1010 when not printing. |
| 1036 / 1037 / 1038 | history list / detail / delete | `{}` / ? / `{"list":[…]}` |
| 1042 | get live video URL | `{}` returns `{"url":"http://<ip>:8080/?action=stream"}`. The panel calls this `GetLivingVideoUrl`; there is also a separate `1054 StartVideoStream`. HA's doc wrongly says `{"enable":true}`. |
| 1044 | file list | `{"storage_media":"local","offset":0,"limit":20}` (USB adds `"dir"`) |
| 1045 | file thumbnail (base64 PNG) | `{"storage_media":"local","file_name":"job.gcode"}`. The panel uses `file_name`; HA's doc says `filename`. |
| 1046 | file detail | `{"storage_media":"local","filename":"job.gcode"}` returns layer, print_time, total_filament_used (g), color_map |
| 1047 | delete file | `{"storage_media":"local","file_path":["a.gcode"]}` |
| 1048 | disk info | `{}` |
| 1052 | heartbeat (RPC form) | |
| 2001 / 2002 | Canvas load / unload | `{"canvas_id":0,"tray_id":1}` |
| 2003 | set tray filament info | object |
| 2004 | Canvas auto-refill | `{"auto_refill":true}` |
| 2005 | Canvas status | `{}` |

- Start-print error **1026** (bed mesh missing): the panel retries with `bedlevel_force:true`.
- Other common errors:
  - 1000 bad token
  - 1003 bad parameter or precondition
  - 1009 busy
  - 1010 not printing
  - 1021 file not found

---

## 6. Camera

### CC1

[fw] [pyc] [OC]

- Send **Cmd 386 `{"Enable":1}`**. It returns `{"Ack":0,"VideoUrl":"192.168.1.50:3031/video"}`.
  - **`VideoUrl` has no scheme**; the web UI prepends `http://`.
  - Ack codes: 1 = too many viewers, 2 = no camera, 3 = error.
- Stream: `GET http://<ip>:3031/video` returns `multipart/x-mixed-replace` MJPEG (each part is
  a full JPEG). It runs at about 10 fps at 640×360.
  - pycentauri reads it *without* sending 386 first. Send 386 anyway, because it's what
    Elegoo's clients do.
  - **Don't send `{"Enable":0}` while others may be watching.** The stream is shared with the
    printer's own clients.
- `MaximumVideoStreamAllowed` is 1 in every sample, and `NumberOfVideoStreamConnected` is
  reported in attributes.
  - The server **leaks slots** on client disconnect. Repeated connect/disconnect starves the
    stream.
  - **Hold one upstream connection per printer and fan it out server-side.** This matches how
    FarmSlicer proxies Bambu cameras: snapshot = first SOI…EOI frame from the shared feed.
- **WebRTC variant**: if `Attributes.Capabilities` includes `VIDEO_WEBRTC`, the printer's own
  web UI connects to `ws://<ip>:8883` instead. That channel uses JSON-RPC 2.0 signalling:
  `{"jsonrpc":"2.0","method":"offer","id":N}`, the printer returns SDP, the client answers with
  `{"method":"answer","params":<sdp>}`, plus a `libpeer` datachannel and `ping` every 30 s.
  [fw] **UNCERTAIN** which firmware advertises it. MJPEG on 3031 is the documented path.

### CC2

- `http://<ip>:8080/?action=stream` is MJPEG with `boundary=frame`. On stock firmware **any
  path** on 8080 returns the stream, with no auth.
- Usually 1 slot (`max_video_connections`).
- Method 1042 returns the URL.

---

## 7. Print tracking and pictures of outside prints

### Matching our print (CC1)

- Upload under a **unique name** (e.g. `<job-or-print-id>-<slug>.gcode`), then send Cmd 128.
- Then watch status. The job is ours when:
  - `CurrentStatus` contains 1, **and**
  - `basename(PrintInfo.Filename) == our name`, **and**
  - `PrintInfo.TaskId` is non-empty and differs from the `TaskId` seen before the start.
- Pin that `TaskId`. This is the same pattern as FarmSlicer's existing rule that "a print not
  yet seen running can only start", from Bambu.

### Terminal states

Note that the sub-state *persists* after the job, so compare against the pinned `TaskId`.

| `PrintInfo.Status` | Normalised |
|---|---|
| 9 | finished |
| 8 | stopped/cancelled |
| 14 | failed |

- `CurrentStatus` returns to `[0]`.
- **Confirm with history**: Cmd 321 `{"Id":[taskId]}` gives `TaskStatus`:
  - 1 completed
  - 2 error/exceptional
  - 3 stopped/cancelled
  - 4 started and 5 paused also exist (firmware record states [fw] `print_history.h`)
- Also from history: `ErrorStatusReason`, `BeginTime`/`EndTime` (epoch s), `AlreadyPrintLayer`.
- The firmware keeps **50** history records (`PRINT_HISTORY_SIZE`). [fw]

Example Cmd 321 item (the `Thumbnail` URL form is **UNCERTAIN**: independent clients build
`http://<ip>/board-resource/history_image/<TaskId>.png`):

```json
{"Thumbnail": "http://192.168.1.50/board-resource/history_image/295cb186-….png",
 "TaskName": "/local/job-123.gcode", "BeginTime": 1760300000, "EndTime": 1760304504,
 "TaskStatus": 1, "SliceInformation": {"total_layer_numbers": 438, "print_time": 4504},
 "AlreadyPrintLayer": 438, "TaskId": "295cb186-…", "MD5": "…",
 "CurrentLayerTalVolume": 0, "TimeLapseVideoStatus": 0, "TimeLapseVideoUrl": "",
 "ErrorStatusReason": 0}
```

### Pictures of prints started elsewhere (CC1)

- `GET http://<ip>/board-resource/history_image/<TaskId>.png` (port 80). This is the PNG the
  firmware extracted from the G-code's embedded thumbnail at print start (`HISTORY_IMAGE_PATH`
  in [fw]).
  - Several independent clients use exactly this URL (LayerLook, CentauriCarbonUI,
    elegoo-mcp-server). Prefer the `Thumbnail` field from Cmd 321 when present.
  - URL-encode the last path segment, as the web UI does.
  - It works for the *current* task too: take `TaskId` from status.
- For files sitting on the printer that haven't been printed: Cmd 260 `{"Url":"/local/x.gcode"}`
  returns `FileInfo.Thumbnail` (a URL). [fw] Alternatively, download the G-code and parse its
  `; thumbnail begin` block (§8).

### CC2 tracking and pictures

- Tracking:
  - Our job is `print_status.filename` + `print_status.uuid`, with `machine_status.status == 2`.
  - Sub-status 2077 = complete, 2504 = stopped, 2505 = interruption (filament runout),
    2502 = paused, 2501 = pausing, 2075 = printing.
  - History (1036) `task_status`: 1 completed, 2 cancelled. [pyc]
- Pictures: method 1045 returns `{"thumbnail":"<base64 png>"}` for a filename. There is no
  HTTP image path.

---

## 8. Slicer specifics (what our G-code must look like)

**Profiles** (OrcaSlicer v2.4.2, `resources/profiles/Elegoo/machine/ECC/`, `ECC2/`):

- `host_type: elegoolink`, `gcode_flavor: klipper`.
- **`thumbnails: ["144x144"]`**, and `thumbnails_format: "PNG"` inherited from
  `fdm_elegoo_3dp_001_common`.
- Build volume 256×256×256, with an excluded corner at 246–256 × 0–20.
- `layer_change_gcode: SET_PRINT_STATS_INFO TOTAL_LAYER=[total_layer_count] CURRENT_LAYER={layer_num+1}`.
  This is what drives `CurrentLayer`/`TotalLayer`. CC2 adds `M73 L…` and `;LAYER:`.
- Start G-code uses Elegoo's own M-codes (`M729` nozzle clean, `M6211` filament/Canvas
  change). It ends with `;LAYER_COUNT:` / `;LAYER:0`.
- `support_multi_filament: 1` on both CC and CC2 (Canvas).
- The sibling models **Elegoo Centauri** (EC, non-Carbon) and **Centauri 2** (EC2) use the
  same transports as CC and CC2 respectively. Orca classifies by name: a trailing `2` means
  CC2.
- **Neptune 4/4 Pro/Plus/Max** are Klipper/Moonraker, and use COLPIC thumbnails. Use the
  Moonraker driver for them.

**What the CC1 firmware parses** ([fw] `core/klippy/gcode_preview.c`):

1. It looks at the **first 30 lines** for one of `PrusaSlicer`, `OrcaSlicer`, `ElegooSlicer`,
   `AnycubicSlicer`, or `Cura_SteamEngine`. **If none matches, there is no preview and no
   metadata at all.**
   - libslic3r writes `; generated by OrcaSlicer <ver> on <date>`, because `SLIC3R_APP_NAME`
     is `OrcaSlicer` in `version.inc`. We're fine **as long as FarmSlicer never rebrands that
     header line**.
2. It reads forward until the first line that starts with `M`/`G`, then reads **backward from
   the end** until it meets another `M`/`G` line. So it reads the header block plus Orca's
   trailing summary and config block.
3. Thumbnails:
   - It decodes every `; thumbnail begin WxH LEN` … `; thumbnail end` block (plain PNG tag
     only; `thumbnail_JPG`/`thumbnail_QOI` are ignored).
   - It strips the leading `; ` from each line. The line limit is 1024 bytes.
   - **The last block wins.** It is written to `/tmp/thumbnail/<file>.png` and becomes the
     history image.
   - Emit exactly one 144×144 PNG, or put the one you want shown last.
4. Metadata keys (as `key = value`, matched by substring):
   - `estimated printing time (normal mode)` (`1d 2h 3m 4s` format)
   - `bed_temperature`, `temperature`
   - `filament_type` or `;initial_filament:`
   - `total layers count` or `total_layers`
   - `total filament used [g]` or `filament used [g]`

   Orca's standard summary comments provide all of these.

**What FarmSlicer needs to do**

- Produce **plain `.gcode`** for Elegoo, not the Bambu `.gcode.3mf` package.
- Keep Orca's header and footer comments intact.
- Our `cxx/thumbnail` rasteriser already feeds `export_gcode` through the thumbnail callback,
  so the `thumbnails` config makes the PNG. The label overlay then appears on the printer's
  screen and in history.
- OrcaSlicer does **no Elegoo-specific post-processing or encoding** for CC/CC2. Only Neptune
  uses COLPIC.

**File names**

- Allowed characters are not documented. The web UI URL-encodes the basename. HA/pycentauri
  upload arbitrary names.
- Stick to `[A-Za-z0-9._-]`, end in `.gcode`, and keep it under about 100 chars
  (**UNCERTAIN** limit).
- The printer's file list filters out non-printable types.
- CC2 replaces a file that has the same name.

---

## 9. Multi-material (CANVAS)

- **CC2** has native Canvas support. **CC1** gets it through an upgrade kit, shipping 2026,
  which reportedly needs firmware ≥ 1.4.44 (**UNCERTAIN**).
- Trays are 0-based. `t` = the G-code tool index (`T0`…), the same as `color_map[].t` in CC2's
  file list/detail.

**CC2: `2005` returns:**

```json
{"canvas_info": {"active_canvas_id": 0, "active_tray_id": 3, "auto_refill": false,
  "canvas_list": [{"canvas_id": 0, "connected": 1, "tray_list": [
    {"tray_id": 0, "brand": "ELEGOO", "filament_type": "PLA", "filament_name": "PLA",
     "filament_code": "0x0000", "filament_color": "#2850DF",
     "min_nozzle_temp": 190, "max_nozzle_temp": 230, "status": 1}]}]}}
```

- Tray `status`: 0 empty, 1 loaded, 2 active.
- `active_tray_id` = -1 means none.
- To map trays at start, use `config.slot_map: [{"t":0,"canvas_id":0,"tray_id":2}]`. An empty
  `slot_map` lets the printer choose.
- This is the analogue of Bambu's `ams_mapping`. The mapping UI can reuse the AMS mapping
  model: tray = (canvas_id, tray_id).

**CC1 + Canvas**

- Cmd **324** returns the same `canvas_list` structure, either at `Data.Data` or under
  `canvas_info`, so parse both. [SDK]
- Start with `slot_map` in Cmd 128.
- CC1 placeholder values for unknown spools: brand `"— — — —"`, type `"?"`. Normalise them to
  empty.
- HA detects Canvas from a status key `AmsConnectStatus`.
- **All of the CC1 Canvas surface is UNCERTAIN.** It is SDK-only, and pyc deliberately refuses
  to send 324. Gate it behind attributes/firmware version and verify on hardware before
  enabling.
- The CC1 panel code in Orca also has `CmdAMS*` 500–505 handlers. They appear to be **mock
  code** (random data). Ignore them.

---

## 10. Fake printer for tests

### Existing emulators (none of them is in Rust or complete)

- HA [`scripts/test_server.py`](https://github.com/danielcherubini/elegoo-homeassistant/blob/main/scripts/test_server.py) (CC1)
  - Has: UDP 3000 discovery; WS 3030 handling Cmd 0/1/128/130/320/321/322/386 and `ping`;
    an HTTP static server for thumbnails.
  - Missing: no upload endpoint, no MJPEG.
  - Its code values are partly wrong: `TaskStatus 9`, sub-state 16 as "complete".
  - Good as a shape reference only.
- HA [`scripts/test_cc2_printer.py`](https://github.com/danielcherubini/elegoo-homeassistant/blob/main/scripts/test_cc2_printer.py)
  (CC2)
  - Has: an amqtt broker plus registration, heartbeat, delta pushes, and the methods.
  - The best starting point for a CC2 fake's behaviour.
- pycentauri `tests/test_client.py`: a minimal in-process SDCP WebSocket fake.

**Recommendation:** write our own fake as an in-process tokio test server (preferred), or
as a small Docker service like `tests/fake-printer/`, which the Bambu side uses.

### Minimal CC1 fake surface

1. **UDP :3000**: on the payload `M99999`, reply with the discovery JSON (§1) to the sender.
   Configurable `MainboardID`/`MachineName`/`ProtocolVersion`. Also emit a resin `V1`/`Saturn`
   responder to test the filter.
2. **WS :3030 `/websocket`**
   - Answer the text `ping` with `pong`.
   - Parse the envelope. Reply on `sdcp/response/<id>` with the echoed `Cmd`/`RequestID`,
     `Data.Ack`.
   - Cmd 0 → Ack plus a `sdcp/status` frame. Cmd 1 → Ack plus a `sdcp/attributes` frame.
   - Cmd 128/129/130/131 drive a state machine:
     - `CurrentStatus [1]`, `PrintInfo.Status` 16 → 13.
     - Advance `CurrentLayer`/`CurrentTicks`/`Progress` on a timer.
     - Pause goes 5 → 6, resume 12 → 13, stop 7 → 8, end 9.
     - Generate a new `TaskId` on start. Ack 2 if the file is missing, 1 if busy.
   - Cmd 403 applies targets and speed.
   - Cmd 258/259/260/320/321/322/386/387 as in §5. 386 returns `VideoUrl` `"<host>:<mjpeg port>/video"`.
   - Push status on change and every N s.
   - **Optional fault modes:**
     - The 6th connection returns HTTP 500 `too many client`.
     - Unknown Cmd → silently drop, then close every socket. This simulates the daemon crash.
     - A length-prefixed frame such as `123{…}`.
     - `CurrentStatus` 8 for about 2 s after an upload completes.
3. **HTTP :80** (the same listener can serve the routes below)
   - `GET /` → HTML containing `ELEGOO`, for Orca-style probes.
   - `POST /uploadFile/upload` → validate the multipart fields. `Offset` must equal the bytes
     received so far for that `Uuid`, else `-2`. On the final chunk, check the MD5 when
     `Check=1`.
     - On success, store the file as `/local/<filename>` and reply `{"code":"000000",…}`.
     - On a mismatch, reply `111111`.
   - `GET /board-resource/history_image/<TaskId>.png` → the PNG extracted from the stored
     G-code's last `; thumbnail begin` block. That doubles as a test of our own G-code.
   - `GET /downloadFile/local/<name>` → the stored file.
4. **HTTP :3031 `/video`**: `multipart/x-mixed-replace; boundary=--foo`, emitting a static JPEG
   at a few fps. Optionally allow only one concurrent connection, to test our fan-out.

### Minimal CC2 fake surface

1. UDP :52700: `{"id":0,"method":7000}` → the discovery reply.
2. An MQTT broker on :1883 with user `elegoo` / pass `<code>`. In Rust, run `rumqttd` in
   process, or mosquitto in Docker, plus a bot client that handles:
   - registration
   - PING → PONG
   - methods 1001/1002/1020–1023/1028–1031/1036/1042/1044–1047/2005
   - 6000 delta pushes
   - `error_code`
3. HTTP :80 `PUT /upload`, with `Content-Range` accounting and an MD5 check on the final chunk.
4. HTTP :8080 MJPEG on any path.

---

## Risks / open questions (verify on real hardware before enabling writes)

1. **The CC1 daemon crash.** A wrong Cmd or payload kills the active print, and only a power
   cycle recovers. Use only the payloads in §5. Never probe while `PrintInfo.Status != 0`.
   Gate experimental commands (324, 512, 133, 401/402) behind a flag.
2. **Start-print safety on CC1.** Orca and Elegoo's web UI use Cmd 128 routinely with the full
   payload, but HA saw crashes with a reduced payload. Do the first start on hardware with a
   tiny file.
3. **Freshness.** Periodic pushes may be dead while idle (OpenCentauri). Poll Cmd 0 as the
   primary path.
4. **Connection budget.** There are 5 WS slots and about 1 camera slot (which leaks). One
   connection per printer, one camera feed fanned out. Other farm tools (HA, OctoEverywhere,
   the slicer device tab) compete for the same slots.
5. **Our header must say `OrcaSlicer`** within the first 30 lines, or the CC1 shows no preview
   or metadata. Emit exactly one 144×144 PNG thumbnail.
6. **CC2 is a separate driver**:
   - MQTT and registration
   - access code entry
   - "LAN Only" mode required
   - firmware 02.00.02.00 is a lockdown release
   - methods 1042/1044/1047 didn't work on 01.03.02.51 but do on 02.01.00.00
7. **Things that conflict across sources:**
   - upload port 80 vs 3030 (use 80)
   - the 4 vs 5 WS limit
   - tick units (seconds on CC1)
   - the `MainboardID` length
   - the CC2 1045 param name (`file_name` per Elegoo's panel)
   - CC2 speed-mode multipliers (50/100/150/200 per HA vs 50/100/130/160 on CC1)
   - CC2 `/system/info` (works with a `?X-Token=` query on some firmware, 404 on others; don't
     depend on it; get the SN from discovery or 1001)
8. **Canvas on CC1** (Cmd 324, `slot_map` in 128) is unverified.
