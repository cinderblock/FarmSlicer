// Engine-independent slicing pipeline shared by the native server (via the
// cxx bridge in slicer_bridge.cpp) and the WebAssembly engine
// (wasm/bridge/farmslicer_wasm.cpp). No Rust or Emscripten headers here.
#pragma once

#include <functional>
#include <string>
#include <vector>

#include "thumbnail.hpp"

namespace farmslicer::core {

struct Callbacks {
    /// Progress in percent plus the current step name. May be called from
    /// TBB worker threads.
    std::function<void(int percent, const std::string& message)> progress;
    /// Polled at libslic3r's cancellation checkpoints; return true to abort.
    std::function<bool()> cancelled;
};

struct Options {
    /// Also write a Bambu-style sliced project (`.gcode.3mf`: the plate's
    /// G-code, its thumbnail and slice_info.config) here. Empty = don't.
    std::string package_path;
    /// The vendor's model id recorded in slice_info.config ("BL-P001",
    /// "C12", ...); Bambu printers check it.
    std::string printer_model_id;
    /// Name for a single-object model in the package and the G-code (the
    /// file on disk may have a generated name).
    std::string model_name;
    /// Label/logo drawn on every thumbnail. An empty font path means
    /// fonts/Sarabun-SemiBold.ttf in the resources directory.
    ThumbnailOverlay overlay;
};

struct Outcome {
    bool ok = false;
    bool cancelled = false;
    std::string error;
    /// Non-fatal messages: config substitutions, validation warnings, conflicts.
    std::vector<std::string> warnings;
    std::string gcode_path;
    /// Set when Options::package_path was written.
    std::string package_path;
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
/// write G-code to `output_path` (with embedded thumbnails where the printer
/// takes them), plus the package `options` asks for. Never throws; errors
/// land in Outcome::error.
Outcome slice_file(const std::string& model_path,
                   const std::string& config_json,
                   const std::string& output_path,
                   const Callbacks& callbacks,
                   const Options& options = {});

} // namespace farmslicer::core
