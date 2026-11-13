# Spool remaining: show it, and warn before a plate runs a spool dry

## Goal

Show how much filament is left on each spool everywhere a spool appears,
especially where one is chosen (the Send dialog's tray picker), and warn
when a plate needs more than its mapped spool has left, in the Send dialog
and in the queue's fit problems.

## Environment / context

- Only Bambu reports what's left: `remain` (percent; `-1` when unknown,
  i.e. non-RFID spools unless the printer estimates them) and
  `tray_weight` (grams of a full spool, a string, `"0"` when unknown) per
  tray in `print.ams.ams[].tray[]` and `print.vt_tray`. Parsed in
  `src/bambu/status.rs` `tray()`. Other drivers report no trays.
- `src/printer/status.rs` `Tray` is the shared shape; `web/src/printers.ts`
  mirrors it.
- `printing::send_problems` → `check_mapping` produces the per-tray
  problems used by `/api/jobs/{id}/targets`, direct sends (409 unless
  `ignore_mapping_problems`), approvals, and `queue::fit`.

## Decisions already made (don't re-ask)

- All three parts (user, 2026-11-13): grams from `tray_weight`; remaining
  shown wherever a spool is shown; a "not enough filament" warning in the
  Send dialog and the queue's fit.
- Low filament is a **send problem** (the existing mechanism): a manual send
  asks for "send anyway", automatic dispatch skips the printer like any
  other mapping problem. Unknown amounts never warn.
- No AMS backup / auto-refill reasoning: the warning is about the mapped
  tray only.

## Plan / steps

1. Rust: `Tray.remain_g` (grams left = remain% × tray_weight); test.
2. Rust: `check_mapping` problem when `used_g > remain_g`; test.
3. Web: `Tray.remain_g`, a `trayLeft()` label helper; Send dialog options,
   selected tray, client-side problem; printer card swatch shows the level
   visibly (not only the tooltip); pre-heat options.
4. Changelog line; checks (cargo test on buildhost, web tsc/bun test);
   commit.

## Findings / gotchas

- No other driver (Klipper, OctoPrint, PrusaLink, SDCP) reports trays, so they
  have nothing to show.
- `bambu::status::summarize` reads the merged full report, so
  `tray_weight` persists across delta reports.

## Progress log

- [x] 1. remain_g (`src/bambu/status.rs`, test in `summary_reads_strings_and_packed_temps`)
- [x] 2. check_mapping warning (`printing::tests::mapping_warns_when_a_spool_runs_short`)
- [x] 3. web: printer card swatches show grams/percent + level bar (warning colour at
  15% or less), pre-heat options, Send dialog options ("⚠ not enough"), the chosen
  spool's amount under its picker, client-side problem line
- [x] 4. changelog `2026-11-13b`; cargo test (stub, buildhost: 180 pass), web tsc + bun
  test pass. The e2e suite wasn't run: no fake sends tray amounts, so it can't exercise this.

## Not verified

- Against a real AMS: that `tray_weight` comes as Bambu's documented string
  ("1000") and `remain` stays in 0-100 for RFID spools.

## Open questions for the user

(none)

## Things not to do

- Don't refuse sends for low filament outright; it's a confirmable problem.
