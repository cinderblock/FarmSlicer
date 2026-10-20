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

/// Where the user put a part on the bed (the web viewer's placement).
struct Placement {
    /// False = centre the part on the bed in its file orientation.
    bool set = false;
    /// Rotation applied to the model as loaded: a 3x3 matrix, row-major.
    double rotation[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
    /// Where the rotated part's bounding-box centre goes, relative to the
    /// bed centre (mm, XY). It always rests on the bed (Z = 0).
    double offset[2] = {0, 0};
    /// Which of the job's plates the part is on (0-based).
    unsigned plate = 0;
};

/// One model file and every copy of it on the job's plates. A file with
/// several objects is one rigid part (like the viewer shows it).
struct ModelInput {
    std::string path;
    /// Name for a single-object model in the package and the G-code (the
    /// file on disk may have a generated name).
    std::string name;
    /// Each copy, on its plate. Empty = one copy, centred as loaded on
    /// plate 1.
    std::vector<Placement> parts;
};

struct Options {
    /// Also write a Bambu-style sliced project (`.gcode.3mf`: each plate's
    /// G-code and thumbnail, slice_info.config) here. Empty = don't. A job
    /// with several plates needs one: it is where they all go together.
    std::string package_path;
    /// The vendor's model id recorded in slice_info.config ("BL-P001",
    /// "C12", ...); Bambu printers check it.
    std::string printer_model_id;
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
    /// Plate 1's G-code (`output_path`); plate N's is `plate_gcode_path(output_path, N)`.
    std::string gcode_path;
    /// How many plates were sliced.
    unsigned plates = 0;
    /// Set when Options::package_path was written.
    std::string package_path;
    /// Totals over every plate (layers: the tallest plate's). Each plate's
    /// own numbers are in the package's slice_info.
    double print_time_sec = 0;
    double filament_used_g = 0;
    double filament_used_mm = 0;
    unsigned layer_count = 0;
};

/// Where plate `plate` (1-based) of a job writing `output_path` puts its
/// G-code: `output_path` itself for plate 1, `<stem>.plate<N><ext>` after.
std::string plate_gcode_path(const std::string& output_path, unsigned plate);

/// Point libslic3r at OrcaSlicer's resources/ tree (nozzle info tables, flush
/// matrices) and a scratch directory. Call once per process.
void init_runtime(const std::string& resources_dir, const std::string& temp_dir);

/// Slice the plates `models` make (STL/3MF/OBJ/STEP where supported) with
/// the merged OrcaSlicer profile config `config_json` (a JSON object of
/// profile keys) and write each plate's G-code (`plate_gcode_path`, with
/// embedded thumbnails where the printer takes them), plus the package
/// `options` asks for. Every plate is a Print of its own on one Model, as
/// in the desktop app. A plate with no part is an error.
/// Never throws; errors land in Outcome::error.
Outcome slice_models(const std::vector<ModelInput>& models,
                     const std::string& config_json,
                     const std::string& output_path,
                     const Callbacks& callbacks,
                     const Options& options = {});

} // namespace farmslicer::core
