#pragma once

#include <unordered_map>

namespace oneapi { namespace tbb {

template <typename Key,
          typename T,
          typename Hash = std::hash<Key>,
          typename KeyEqual = std::equal_to<Key>,
          typename Allocator = std::allocator<std::pair<const Key, T>>>
class concurrent_unordered_map : public std::unordered_map<Key, T, Hash, KeyEqual, Allocator> {
public:
    using std::unordered_map<Key, T, Hash, KeyEqual, Allocator>::unordered_map;
};

}} // namespace oneapi::tbb

#ifndef ORCA_WASM_TBB_ALIAS_DEFINED
#define ORCA_WASM_TBB_ALIAS_DEFINED
namespace tbb = oneapi::tbb;
#endif
