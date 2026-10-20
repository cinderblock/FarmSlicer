// cxx bridge: Rust ↔ the shared slicing pipeline in slice_core.cpp.

#include "farmslicer/src/slicer.rs.h"
#include "farmslicer/cxx/slicer_bridge.h"
#include "farmslicer/cxx/slice_core.hpp"

#include <algorithm>
#include <filesystem>
#include <string>
#include <vector>

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
    const rust::Vec<ModelInput>& models,
    rust::Str config_json,
    rust::Str output_path,
    const SliceOptions& options
) const {
    const std::string job = to_std(job_id);

    core::Callbacks cb;
    cb.progress = [&job](int percent, const std::string& message) {
        slice_progress(job, percent, message);
    };
    cb.cancelled = [&job]() { return slice_cancelled(job); };

    core::Options opts;
    opts.package_path = std::string(options.package_path);
    opts.printer_model_id = std::string(options.printer_model_id);
    opts.overlay.label = std::string(options.label);
    opts.overlay.logo_rgba.assign(options.logo_rgba.begin(), options.logo_rgba.end());
    opts.overlay.logo_width = options.logo_width;
    opts.overlay.logo_height = options.logo_height;
    opts.overlay.font_path = std::string(options.font_path);

    std::vector<core::ModelInput> inputs;
    for (const ModelInput& m : models) {
        core::ModelInput in;
        in.path = std::string(m.path);
        in.name = std::string(m.name);
        // Placed copies: 9 rotation and 2 offset numbers and a plate each
        // (the server checked them); anything else is one copy, centred.
        const size_t copies = m.rotations.size() / 9;
        if (m.rotations.size() == copies * 9 && m.offsets.size() == copies * 2 && m.plates.size() == copies) {
            for (size_t c = 0; c < copies; ++c) {
                core::Placement p;
                p.set = true;
                p.plate = m.plates[c];
                std::copy(m.rotations.begin() + c * 9, m.rotations.begin() + (c + 1) * 9, p.rotation);
                std::copy(m.offsets.begin() + c * 2, m.offsets.begin() + (c + 1) * 2, p.offset);
                in.parts.push_back(p);
            }
        }
        inputs.push_back(std::move(in));
    }

    const core::Outcome out = core::slice_models(inputs, to_std(config_json), to_std(output_path), cb, opts);

    SliceResult result;
    result.success = out.ok;
    result.cancelled = out.cancelled;
    result.gcode_path = rust::String(out.gcode_path);
    result.package_path = rust::String(out.package_path);
    result.error = rust::String(out.error);
    for (const std::string& w : out.warnings) result.warnings.push_back(rust::String(w));
    result.print_time_sec = out.print_time_sec;
    result.filament_used_g = out.filament_used_g;
    result.filament_used_mm = out.filament_used_mm;
    result.layer_count = out.layer_count;
    result.plates = out.plates;
    return result;
}

std::unique_ptr<Slicer> new_slicer(rust::Str resources_dir)
{
    return std::make_unique<Slicer>(to_std(resources_dir));
}

} // namespace farmslicer
