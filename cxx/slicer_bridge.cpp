// cxx bridge: Rust ↔ the shared slicing pipeline in slice_core.cpp.

#include "farmslicer/src/slicer.rs.h"
#include "farmslicer/cxx/slicer_bridge.h"
#include "farmslicer/cxx/slice_core.hpp"

#include <filesystem>
#include <string>

namespace farmslicer {

namespace {
std::string to_std(rust::Str s) { return std::string(s.data(), s.size()); }
}

Slicer::Slicer(std::string resources_dir) : resources_dir_(std::move(resources_dir))
{
    core::init_runtime(resources_dir_, std::filesystem::temp_directory_path().string());
}

Slicer::~Slicer() = default;

SliceResult Slicer::slice(
    rust::Str job_id,
    rust::Str model_path,
    rust::Str config_json,
    rust::Str output_path
) const {
    const std::string job = to_std(job_id);

    core::Callbacks cb;
    cb.progress = [&job](int percent, const std::string& message) {
        slice_progress(job, percent, message);
    };
    cb.cancelled = [&job]() { return slice_cancelled(job); };

    const core::Outcome out = core::slice_file(
        to_std(model_path), to_std(config_json), to_std(output_path), cb);

    SliceResult result;
    result.success = out.ok;
    result.cancelled = out.cancelled;
    result.gcode_path = rust::String(out.gcode_path);
    result.error = rust::String(out.error);
    for (const std::string& w : out.warnings) result.warnings.push_back(rust::String(w));
    result.print_time_sec = out.print_time_sec;
    result.filament_used_g = out.filament_used_g;
    result.filament_used_mm = out.filament_used_mm;
    result.layer_count = out.layer_count;
    return result;
}

std::unique_ptr<Slicer> new_slicer(rust::Str resources_dir)
{
    return std::make_unique<Slicer>(to_std(resources_dir));
}

} // namespace farmslicer
