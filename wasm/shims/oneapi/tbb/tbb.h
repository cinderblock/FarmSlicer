#pragma once
// Minimal TBB shim for WASM builds
#include "scalable_allocator.h"
#include "../../tbb/blocked_range.h"
#include "../../tbb/parallel_for.h"

namespace oneapi { namespace tbb {
    // expose simple globals under oneapi::tbb as well
    inline void tbb_set_num_threads(int) { /* no-op in WASM */ }
    inline int tbb_get_num_threads() { return 1; }
}} // namespace oneapi::tbb

#ifndef ORCA_WASM_TBB_ALIAS_DEFINED
#define ORCA_WASM_TBB_ALIAS_DEFINED
// Provide a legacy alias tbb -> oneapi::tbb for code expecting either
namespace tbb = oneapi::tbb;
#endif