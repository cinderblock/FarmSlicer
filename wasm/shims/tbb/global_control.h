#pragma once

#include <cstddef>

namespace oneapi { namespace tbb {

class global_control {
public:
    enum parameter {
        max_allowed_parallelism
    };

    global_control(parameter /*param*/, std::size_t /*value*/) {}
    ~global_control() = default;
};

}} // namespace oneapi::tbb

#ifndef ORCA_WASM_TBB_ALIAS_DEFINED
#define ORCA_WASM_TBB_ALIAS_DEFINED
namespace tbb = oneapi::tbb;
#endif
