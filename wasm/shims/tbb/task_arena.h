#pragma once

namespace oneapi { namespace tbb {

class task_arena {
public:
    static int max_concurrency() { return 1; }
};

namespace this_task_arena {

inline int max_concurrency() { return task_arena::max_concurrency(); }

} // namespace this_task_arena

}} // namespace oneapi::tbb

#ifndef ORCA_WASM_TBB_ALIAS_DEFINED
#define ORCA_WASM_TBB_ALIAS_DEFINED
namespace tbb = oneapi::tbb;
#endif
