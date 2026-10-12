#pragma once

namespace oneapi { namespace tbb {

template <typename Iterator, typename Func>
void parallel_for_each(Iterator first, Iterator last, const Func& func) {
    for (; first != last; ++first) {
        func(*first);
    }
}

}} // namespace oneapi::tbb

#ifndef ORCA_WASM_TBB_ALIAS_DEFINED
#define ORCA_WASM_TBB_ALIAS_DEFINED
namespace tbb = oneapi::tbb;
#endif
