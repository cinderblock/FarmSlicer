# Eigen 2D/3D Matrix Size Mismatch in OrcaSlicer

## Location

`extern/OrcaSlicer/src/libslic3r/ExtrusionEntity.hpp:513`

## Error

```
error C2338: static_assert failed: 'YOU_MIXED_MATRICES_OF_DIFFERENT_SIZES'
```

Eigen's `operator==` is called between an `Eigen::Matrix<coord_t,2,1>` (2D point) and an `Eigen::Matrix<coord_t,3,1>` (3D point) inside `ExtrusionLoop::validate()`:

```cpp
#ifndef NDEBUG
bool validate() const {
    assert(this->first_point() == this->paths.back().polyline.points.back());
    // ...
}
#endif
```

`first_point()` returns a 2D `Point` while `polyline.points.back()` returns a 3D point — the types don't match for comparison.

## Cause

OrcaSlicer commit `dc5897d7b5` updated Eigen from v3.x to v5.0.1. Eigen 5.x adds a static_assert in `CwiseBinaryOp` that rejects comparing matrices of different dimensions. The older Eigen allowed this (likely silently ignoring extra dimensions or producing undefined behavior).

## Current Workaround

We define `NDEBUG` in `build.rs` which disables the `#ifndef NDEBUG` block entirely. This is acceptable for our bridge compilation since we don't need OrcaSlicer's debug assertions.

## Proper Fix

The OrcaSlicer code should be patched to ensure consistent point dimensions in `validate()`. This is an upstream bug that should be reported or fixed in a future submodule update.

## Impact

Only affects debug builds. Does not affect runtime behavior since `validate()` is assertion-only code.
