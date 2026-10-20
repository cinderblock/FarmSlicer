#pragma once
#include "rust/cxx.h"
#include <memory>
#include <string>

namespace farmslicer {

struct SliceResult;
struct SliceOptions;
struct ModelInput;
struct ArrangeResult;

/// Thin wrapper over libslic3r's Model → Print → G-code pipeline.
///
/// One instance per process; `slice()` is synchronous and must not be called
/// concurrently (the Rust side serialises calls behind a Mutex). Progress and
/// cancellation go through the `slice_progress` / `slice_cancelled` functions
/// exported from Rust (see src/slicer.rs).
class Slicer {
public:
    explicit Slicer(std::string resources_dir);
    ~Slicer();

    SliceResult slice(
        rust::Str job_id,
        const rust::Vec<ModelInput>& models,
        rust::Str config_json,
        rust::Str output_path,
        const SliceOptions& options
    ) const;

    ArrangeResult arrange(const rust::Vec<ModelInput>& models, rust::Str config_json, double spacing_mm) const;

private:
    std::string resources_dir_;
};

std::unique_ptr<Slicer> new_slicer(rust::Str resources_dir);

} // namespace farmslicer
