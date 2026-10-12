#pragma once

#include <cstddef>
#include <type_traits>

#include "blocked_range.h"
#include "task_arena.h"

namespace oneapi { namespace tbb {

struct simple_partitioner {};
struct auto_partitioner {};

template <typename Index, typename Func>
void parallel_for(Index begin, Index end, const Func& func) {
	for (Index i = begin; i < end; ++i) {
		func(i);
	}
}

template <typename Index, typename Step, typename Func>
void parallel_for(Index begin, Index end, Step step, const Func& func) {
	for (Index i = begin; i < end; i += step) {
		func(i);
	}
}

template <typename Range, typename Func>
void parallel_for(const Range& range, const Func& func) {
	func(range);
}

template <typename Range, typename Func, typename Partitioner>
void parallel_for(const Range& range, const Func& func, const Partitioner&) {
	parallel_for(range, func);
}

}} // namespace oneapi::tbb

#ifndef ORCA_WASM_TBB_ALIAS_DEFINED
#define ORCA_WASM_TBB_ALIAS_DEFINED
namespace tbb = oneapi::tbb;
#endif
