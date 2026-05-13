#pragma once
#include "rust/cxx.h"
#include <memory>
#include <cstdint>

namespace farmslicer {

struct SliceProgress;
struct SliceResult;

class Slicer {
public:
    Slicer();
    ~Slicer();

    SliceResult slice(
        rust::Str model_path,
        rust::Str config_json,
        rust::Str output_path
    ) const;

    rust::Vec<rust::String> list_profiles(rust::Str profiles_dir) const;

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

std::unique_ptr<Slicer> new_slicer();

} // namespace farmslicer
