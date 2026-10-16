# libslic3r: uninitialised FakeWipeTower crashes multi-filament slices

**Status:** worked around in `cxx/slice_core.cpp` (`ZeroedPrint`); the real
fix belongs upstream (OrcaSlicer v2.4.2).

## What happens

`Print::process` checks the plate for path conflicts
(`ConflictChecker::find_inter_of_lines_in_diff_objs`) and includes the prime
tower whenever `Print::has_wipe_tower()` is true. That is true for any config
with more than one filament (`filament_diameter.size() > 1`) and
`enable_prime_tower`, even when the plate ends up printing with one filament.
In that case `Print::_make_wipe_tower` returns early (the tool ordering needs
no tower) and never calls `FakeWipeTower::set_fake_extrusion_data`, so the
struct's `width`, `height`, `layer_height`, `depth`, ... (declared without
initialisers in `Print.hpp`) hold whatever was in memory.
`FakeWipeTower::getFakeExtrusionPathsFromWipeTower2` then walks garbage
and segfaults.

## How it showed

The native server died (exit 139) slicing a 20 mm cube for an X1C with three
filaments (`Bambu PLA Basic`, the same again, `Bambu Support For PLA`),
supports on (`support_filament` 2, `support_interface_filament` 3): the cube
needs no supports, so only filament 1 printed. Backtrace (unstripped image):

```
#0 Slic3r::FakeWipeTower::getFakeExtrusionPathsFromWipeTower2() const
#1 Slic3r::FakeWipeTower::getTrueExtrusionLayersFromWipeTower() const
#2 Slic3r::ConflictChecker::find_inter_of_lines_in_diff_objs(...)
#3 Slic3r::Print::process(long long*, bool)
#4 farmslicer::core::slice_models(...)
```

Other combinations didn't crash, depending on what the stack held. The
WebAssembly engine never did: its memory starts zeroed.

## Workaround

`slice_core` builds its `Print` in `calloc`ed memory, so the fields the
constructor leaves alone read 0 (an empty tower).

## Real fix

Initialise `FakeWipeTower`'s members (`float width = 0.f;` ...) in
`src/libslic3r/Print.hpp`, or skip the tower in the conflict check when
`m_wipe_tower_data.tool_ordering.has_wipe_tower()` is false. Worth reporting
upstream; applying it here means patching the submodule in the Docker
`libslic3r` stage (a long rebuild).
