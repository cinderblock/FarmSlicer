# Printer error messages

## Goal

Show what a Bambu printer's error means, in the words Bambu's own apps use,
instead of a bare code. Prompted by an H2D-class error the web UI showed only
as `print_error` / HMS digits while Bambu Studio said "Please feed filament
into the PTFE tube until it can not be pushed any farther."

## Environment / context

- Bambu publishes its message tables at
  `https://e.bambulab.com/query.php?lang=en&d=<device type>` (the host
  OrcaSlicer/Bambu Studio use, `AppConfig::get_hms_host`). Device type = the
  first 3 characters of the printer's serial. Response:
  `data.device_hms.en[] {ecode (16 hex: attr then code), intro}` and
  `data.device_error.en[] {ecode (8 hex: print_error), intro}`. An unknown
  device type answers `result: 201` with no data; no `d` answers 400.
- OrcaSlicer v2.4.2 bundles four device types' tables
  (`resources/hms/hms_<lang>_{093,094,22E,239}.json`, 2025-08) and downloads
  the rest at runtime (`src/slic3r/GUI/HMS.cpp`).
- Device types known to answer (2026-10): 00M 00W 01S 01P 030 039 03W 093
  094 22E 239 31B.
- Texts are mostly identical across models; ~100 HMS and ~50 error codes
  differ (e.g. 07FF8006 on 094/239/31B names the right extruder).
- An empty `intro` = an internal code Bambu doesn't show (Orca's
  `is_internal_error`).

## Decisions

- Harvest the English tables of every known device type into a committed
  file (`src/bambu/data/hms.json`): one default text per code (the most common
  one) plus per-device-type texts where they differ. No runtime fetch from
  Bambu (no outbound dependency, works offline). Regenerate with
  `node src/bambu/data/harvest-hms.mjs`.
- The Bambu driver resolves texts when it summarizes a report (it knows the
  serial): `HmsCode.message`, `PrinterStatus.print_error_message`.
- The UI shows the text, with the code beside it (HMS still linking to
  Bambu's wiki page).

## Progress

- [x] Find the data and its shape
- [x] Harvester + data file (3137 HMS codes, 1100 errors, table version
      202609231145; 614 KB, compiled in with `include_str!`)
- [x] `src/bambu/hms.rs` lookup + tests
- [x] Status fields (`HmsCode.message`, `print_error_message`), resolved in
      `bambu::link` with the configured serial; failure reasons
      (`printing.rs`) and incident summaries carry the text
- [x] Printer card: text, code beside it
- [x] Checks: web build + tests; on buildhost `cargo test`, clippy,
      `tests/run-e2e.sh` (exit 0)
- [ ] Deploy (ops pins the new image) and confirm on a real error

## Findings

- The user-reported wording ("...any further") is older; Bambu's current
  table says "any farther" (07FF8006 / 07FFC006 / 07FFC009).
- Bambu's `index.php?e=<code>&d=<type>` help link redirects to the same
  `wiki.bambulab.com/en/x1/troubleshooting/hmscode/<code>` page the card
  already linked, whatever the device type.

## Possible follow-ups (not started)

- HMS severity (`code >> 16`: 1 fatal, 2 serious, 3 common, 4 info): info
  codes could stop painting the card red.
