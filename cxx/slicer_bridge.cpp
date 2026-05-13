#include "farmslicer/src/slicer.rs.h"
#include "farmslicer/cxx/slicer_bridge.h"

#include <libslic3r/Model.hpp>
#include <libslic3r/Print.hpp>
#include <libslic3r/PrintConfig.hpp>
#include <libslic3r/Config.hpp>

#include <filesystem>
#include <string>

namespace farmslicer {

class Slicer::Impl {
public:
    Impl() = default;
};

Slicer::Slicer() : impl_(std::make_unique<Impl>()) {}
Slicer::~Slicer() = default;

SliceResult Slicer::slice(
    rust::Str model_path,
    rust::Str config_json,
    rust::Str output_path
) const {
    SliceResult result;
    result.success = false;

    try {
        std::string model_str(model_path.data(), model_path.size());
        std::string config_str(config_json.data(), config_json.size());
        std::string output_str(output_path.data(), output_path.size());

        // Load model from file (STL, 3MF, OBJ, STEP)
        Slic3r::Model model = Slic3r::Model::read_from_file(model_str);

        // Load config from JSON string
        Slic3r::DynamicPrintConfig config;
        std::map<std::string, std::string> key_values;
        std::string reason;
        auto substitutions = config.load_from_json(
            config_str,
            Slic3r::ForwardCompatibilitySubstitutionRule::Enable,
            key_values,
            reason
        );

        // Set up the print
        Slic3r::Print print;
        print.apply(model, config);

        // Validate
        auto validation_err = print.validate();
        if (!validation_err.string.empty()) {
            result.error = rust::String(validation_err.string);
            return result;
        }

        // Slice
        print.process();

        // Export G-code
        Slic3r::GCodeProcessorResult gcode_result;
        std::string gcode_path = print.export_gcode(output_str, &gcode_result, nullptr);

        // Collect statistics
        auto stats = print.print_statistics();
        result.success = true;
        result.gcode_path = rust::String(gcode_path);
        result.print_time_sec = 0; // TODO: parse from stats
        result.filament_used_g = stats.total_weight;
    } catch (const std::exception& e) {
        result.error = rust::String(e.what());
    }

    return result;
}

rust::Vec<rust::String> Slicer::list_profiles(rust::Str profiles_dir) const {
    rust::Vec<rust::String> profiles;
    std::string dir(profiles_dir.data(), profiles_dir.size());

    for (const auto& entry : std::filesystem::directory_iterator(dir)) {
        if (entry.is_directory()) {
            profiles.push_back(rust::String(entry.path().filename().string()));
        }
    }

    return profiles;
}

std::unique_ptr<Slicer> new_slicer() {
    return std::make_unique<Slicer>();
}

} // namespace farmslicer
