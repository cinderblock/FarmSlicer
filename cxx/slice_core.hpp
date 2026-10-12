// Engine-independent slicing pipeline shared by the native server (via the
// cxx bridge in slicer_bridge.cpp) and the WebAssembly engine
// (wasm/bridge/farmslicer_wasm.cpp). No Rust or Emscripten headers here.
#pragma once

#include <functional>
#include <string>
#include <vector>

namespace farmslicer::core {

struct Callbacks {
    /// Progress in percent plus the current step name. May be called from
    /// TBB worker threads.
    std::function<void(int percent, const std::string& message)> progress;
    /// Polled at libslic3r's cancellation checkpoints; return true to abort.
    std::function<bool()> cancelled;
};

struct Outcome {
    bool ok = false;
    bool cancelled = false;
    std::string error;
    /// Non-fatal messages: config substitutions, validation warnings, conflicts.
    std::vector<std::string> warnings;
    std::string gcode_path;
    double print_time_sec = 0;
    double filament_used_g = 0;
    double filament_used_mm = 0;
    unsigned layer_count = 0;
};

/// Point libslic3r at OrcaSlicer's resources/ tree (nozzle info tables, flush
/// matrices) and a scratch directory. Call once per process.
void init_runtime(const std::string& resources_dir, const std::string& temp_dir);

/// Slice `model_path` (STL/3MF/OBJ/STEP where supported) with the merged
/// OrcaSlicer profile config `config_json` (a JSON object of profile keys) and
/// write G-code to `output_path`. Never throws; errors land in Outcome::error.
Outcome slice_file(const std::string& model_path,
                   const std::string& config_json,
                   const std::string& output_path,
                   const Callbacks& callbacks);

} // namespace farmslicer::core
