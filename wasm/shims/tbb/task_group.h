#pragma once

#include <functional>

namespace oneapi { namespace tbb {

class task_group {
public:
    task_group() = default;

    template <typename Func>
    void run(Func&& func) {
        func();
    }

    template <typename Func>
    void run_and_wait(Func&& func) {
        func();
    }

    void wait() {}
};

}} // namespace oneapi::tbb

#ifndef ORCA_WASM_TBB_ALIAS_DEFINED
#define ORCA_WASM_TBB_ALIAS_DEFINED
namespace tbb = oneapi::tbb;
#endif
