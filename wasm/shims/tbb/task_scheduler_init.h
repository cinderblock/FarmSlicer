#pragma once

namespace oneapi { namespace tbb {

class task_scheduler_init {
public:
    static constexpr int automatic = -1;

    explicit task_scheduler_init(int /*threads*/ = automatic) {}
    ~task_scheduler_init() = default;

    void terminate() {}
};

}} // namespace oneapi::tbb

#ifndef ORCA_WASM_TBB_ALIAS_DEFINED
#define ORCA_WASM_TBB_ALIAS_DEFINED
namespace tbb = oneapi::tbb;
#endif
