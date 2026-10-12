#pragma once

namespace oneapi { namespace tbb {

template <typename Range, typename Value, typename Func, typename Reduction>
Value parallel_reduce(const Range& range, Value identity, const Func& func, const Reduction& reduction) {
    (void)reduction;
    return func(range, identity);
}

}} // namespace oneapi::tbb

#ifndef ORCA_WASM_TBB_ALIAS_DEFINED
#define ORCA_WASM_TBB_ALIAS_DEFINED
namespace tbb = oneapi::tbb;
#endif
