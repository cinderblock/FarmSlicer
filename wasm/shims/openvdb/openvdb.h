#pragma once

// Minimal OpenVDB shim for WASM builds.
// Provides just enough API surface for conditional compilation when
// ORCA_DISABLE_OPENVDB is defined. This is not a functional replacement.

namespace openvdb {
inline void initialize() {}
} // namespace openvdb
