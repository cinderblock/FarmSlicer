# Profile Nozzle/Build Plate Separation

## Goal

Separate nozzle size selection from machine model selection in both the Printers admin page and the Slice page. Currently, every nozzle variant appears as a separate machine profile (e.g., "Bambu Lab A1 0.2 nozzle", "Bambu Lab A1 0.4 nozzle", "Bambu Lab A1 0.6 nozzle", "Bambu Lab A1 0.8 nozzle"). The user wants to select the base model once, then pick nozzle size as a separate dropdown. This better matches reality: swapping a nozzle doesn't change the printer.

## Environment / Context

- OrcaSlicer profiles live in `extern/OrcaSlicer/resources/profiles/{vendor}/machine/`
- Two types of machine JSON files:
  - `type: "machine_model"` — base models (367 total across all vendors). Has `nozzle_diameter` as semicolon-separated string of all supported sizes (e.g., `"0.4;0.2;0.6;0.8"`).
  - `type: "machine"` — instantiable variants. Has `printer_model` (pointing back to model name), `printer_variant` (e.g., `"0.4"`), and `instantiation: "true"`.
- The nozzle variant profile name is the key used for slicing: processes/filaments have `compatible_printers` lists that reference the full nozzle variant name (e.g., `"Bambu Lab A1 0.4 nozzle"`).
- Build plates are NOT separate profiles — just a runtime setting (`default_bed_type`).
- Currently 1361 instantiable machine profiles across all vendors.

## Plan

### Backend (profiles.rs)

1. Add a new struct `MachineModel` with fields: `name`, `vendor`, `nozzle_diameters: Vec<String>`, where nozzle_diameters is derived from the `machine_model` JSON's semicolon-separated `nozzle_diameter` field.
2. Add method `machine_models() -> Vec<MachineModel>` that returns deduplicated base models with their available nozzle sizes.
3. For machines that don't have a corresponding `machine_model` entry (some vendors may skip it), derive the base model by stripping the nozzle suffix pattern from instantiable profile names, and collect unique nozzle sizes.
4. Keep the existing `instantiable_machines()` for backward compatibility — the resolved profile name (with nozzle) is still what the slicer needs.

### Backend (server.rs)

5. New endpoint: `GET /api/profiles/machine-models` — returns `[{name, vendor, nozzle_diameters}]`.
6. Existing `GET /api/profiles/machines` stays — used internally when resolving the full profile name from model + nozzle.
7. Optionally add a helper: `GET /api/profiles/machines?model=NAME` to filter instantiable machines for a given model.

### Frontend (Printers.tsx)

8. Replace single `SearchSelect` for machine_profile with:
   - `SearchSelect` for base model (fewer entries, ~367 instead of 1361)
   - Regular `<select>` for nozzle size (populated based on selected model, typically 4 options)
9. When saving a printer, combine model + nozzle back into the full profile name.
10. Discovery pre-fill: map discovered printer's `machine_profile` to model + nozzle.

### Frontend (Slice.tsx)

11. Same two-dropdown pattern: model + nozzle.
12. When fetching processes/filaments, use the full nozzle-variant name (model + nozzle) as the `machine` query parameter.

## Decisions Already Made

- Build plates are NOT part of this — they're runtime settings, not profile variants.
- The slicer still needs the full nozzle-variant profile name internally. The separation is UI-only; the backend reconstructs the full name when needed.
- Don't break the existing API — add new endpoints alongside existing ones.

## Progress

- [ ] Backend: Parse `machine_model` entries and build model → nozzle map
- [ ] Backend: New API endpoint for machine models
- [ ] Frontend: Split Printers.tsx machine select into model + nozzle
- [ ] Frontend: Split Slice.tsx machine select into model + nozzle
- [ ] Update discovery mapping to separate model from nozzle
- [ ] Test on buildhost

## Open Questions

1. Should the printer DB record store the base model + nozzle separately, or keep storing the full profile name? Recommendation: store them separately (`machine_model` + `nozzle_diameter`) so the nozzle can be changed without re-selecting the model.
