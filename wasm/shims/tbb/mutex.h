#pragma once

#include <mutex>

namespace oneapi { namespace tbb {

using mutex = std::mutex;
using recursive_mutex = std::recursive_mutex;

class mutex_guard {
public:
    explicit mutex_guard(mutex& m) : m_lock(m) {}

private:
    std::lock_guard<mutex> m_lock;
};

}} // namespace oneapi::tbb

#ifndef ORCA_WASM_TBB_ALIAS_DEFINED
#define ORCA_WASM_TBB_ALIAS_DEFINED
namespace tbb = oneapi::tbb;
#endif
