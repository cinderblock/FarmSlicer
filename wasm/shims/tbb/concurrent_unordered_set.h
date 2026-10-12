#pragma once

#include <unordered_set>

namespace oneapi { namespace tbb {

template <typename Key,
          typename Hash = std::hash<Key>,
          typename KeyEqual = std::equal_to<Key>,
          typename Allocator = std::allocator<Key>>
class concurrent_unordered_set : public std::unordered_set<Key, Hash, KeyEqual, Allocator> {
public:
    using std::unordered_set<Key, Hash, KeyEqual, Allocator>::unordered_set;
};

}} // namespace oneapi::tbb

#ifndef ORCA_WASM_TBB_ALIAS_DEFINED
#define ORCA_WASM_TBB_ALIAS_DEFINED
namespace tbb = oneapi::tbb;
#endif
