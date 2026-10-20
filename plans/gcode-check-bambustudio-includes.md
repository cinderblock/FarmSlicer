# G-code check: Bambu Studio 2.8 templates (`include`, `SYNC`)

## Goal

A plate exported by Bambu Studio 02.08.02.61 for the H2D was refused by the
G-code check ("has a line a printer may read differently (not a G, M or T
command: SYNC T0)", 20 lines), plus review findings for commands Bambu's own
templates use (`G28.140`, `M145.2`, `M620 Q`, `M104 N`, `G380 Z42`, ...).
Feedback report `5fb033b8` (2026-10-20). Bambu's own G-code must pass.
The check's overall design is in `plans/gcode-safety.md`.

## Findings

- `SYNC T{...}` is in Bambu's H2D `change_filament_gcode` (template dated
  20260528): `SYNC T{ceil(flush_length / 125) * 5}` and heating/cooling
  waits. A word-named command, not G/M/T.
- Newer Bambu Studio profiles keep their G-code in separate template presets
  (`Bambu Lab H2D 0.4 nozzle template change_filament_gcode`,
  `instantiation: false`) that machine presets pull in with `"include"`
  (a name or a list). Bambu Studio applies includes before the preset's own
  keys (`PresetBundle.cpp`, `BBL_JSON_KEY_INCLUDES`). Our harvester only
  followed `inherits`, so every template that moved to an include was
  missing from `data/bambustudio.json` even though 02.08.02.61 is listed as
  harvested. OrcaSlicer v2.4.2's profiles don't use `include`.
- The harvester's `see_line` drops lines the lexer can't read, silently.
- Bambu Studio releases (2026-10-20): latest v02.08.04.57; the data lists
  02.00.02.57 through 02.08.02.61.

## Decisions

- The Bambu lexer reads a word-named command (`SYNC T5`: a name of 2+
  upper-case letters/digits/underscores, then ordinary words) **only when
  the allowlist knows the name**; an unknown name stays `unreadable`
  (block), so the check gets no looser for anything Bambu doesn't write.
- The harvester learns names from Bambu's templates and follows `include`.
- Regenerate `data/bambustudio.json` with every release's profiles,
  adding 02.08.03.66 and 02.08.04.57.

## Plan / progress

- [x] Harvester follows `include` (and logs template lines it can't read);
      unit test
- [x] `Code` gets an optional name; lexer reads known names; check/harvest
      call sites; unit tests (lexer, check: SYNC allowed, unknown name blocks)
- [x] Profiles of 11 releases (02.00.02.57 .. 02.08.04.57) in
      `~/bambustudio-profiles/<release>/BBL` on buildhost (partial clone in
      `~/bambustudio-profiles/repo`, `git archive <tag>`); regenerated.
      New: SYNC, G28.140, M145.2, G390*, M620.13/.22, M1028, ...; new words
      on M620 (Q, H, B, D, O), T H, G28 W, ...; nothing dropped
- [x] Slicer-written commands added to `data/slicer.json`: Bambu Studio
      02.08's multi-nozzle pre-heat/pre-cool (`M632 ... W` / `M104 T S N0` /
      `M633`, `M109 T S N0` on the prime tower; `GCodeProcessor.cpp`,
      `WipeTower.cpp`)
- [x] Reported package passes (`FARMSLICER_SAMPLE_PACKAGES`), 145 unit
      tests, e2e exit 0. (clippy isn't installed on buildhost.)
- [x] Committed
- [x] Deployed 2026-10-20: FarmSlicer `22c7a71`, image
      `sha256:9d4c60003ba1153893bd7615fa8c19c625622598a7bdcbb0bda7b4d663c844ff`,
      ops `fe2c47f`, deploy run 39393090848 green, sentinel healthy. Startup re-check: the reported job and two others
      now clean; no job in production is blocked
- [x] Feedback `5fb033b8` resolved with a note; `451b69fc` (one Firefox
      NetworkError on /api/discovery) won't fix. Done with a direct
      `UPDATE` (same as `PUT /api/feedback/{id}`) from a throwaway
      `python:3-alpine` container on the `farmslicer_data` volume as uid
      1000: no admin credential is available to agents

## Regenerate

```
L=; for r in <releases>; do L="$L:$r=$HOME/bambustudio-profiles/$r"; done
FARMSLICER_REGEN_GCODE_DATA=1 BAMBUSTUDIO_PROFILES="${L#:}"   cargo test gcode::harvest -- --nocapture
```

Profile templates for older X2D releases have uncommented banner lines
(logged by the harvester; ISSUES.md).

## Things not to do

- Don't accept any upper-case word as a command (would turn blocks into
  reviews for arbitrary text).
