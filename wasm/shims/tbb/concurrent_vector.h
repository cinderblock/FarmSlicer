#pragma once

#include <vector>

namespace oneapi { namespace tbb {

template <typename T, typename Allocator = std::allocator<T>>
class concurrent_vector : public std::vector<T, Allocator> {
public:
    using std::vector<T, Allocator>::vector;
};

}} // namespace oneapi::tbb

#ifndef ORCA_WASM_TBB_ALIAS_DEFINED
#define ORCA_WASM_TBB_ALIAS_DEFINED
namespace tbb = oneapi::tbb;
#endif
