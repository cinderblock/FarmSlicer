#pragma once

#include <cstddef>
#include <iterator>
#include <type_traits>

namespace oneapi { namespace tbb {

struct split {};

// Minimal sequential blocked_range implementation sufficient for WASM builds.
template <typename T>
class blocked_range {
public:
    using value_type = T;
    using const_iterator = T;
    using iterator = T;

    blocked_range(T begin, T end, std::size_t grainsize = 1)
        : m_begin(begin), m_end(end), m_grainsize(grainsize) {}

    blocked_range(const blocked_range& other, split)
        : m_begin(other.m_begin), m_end(other.m_end), m_grainsize(other.m_grainsize) {}

    T begin() const { return m_begin; }
    T end() const { return m_end; }
    std::size_t grainsize() const { return m_grainsize; }
    bool empty() const { return m_begin == m_end; }

    std::size_t size() const {
        if constexpr (std::is_integral_v<T>) {
            return static_cast<std::size_t>(m_end - m_begin);
        } else {
            return static_cast<std::size_t>(std::distance(m_begin, m_end));
        }
    }

    bool is_divisible() const { return false; }

    class iterator_wrapper {
    public:
        explicit iterator_wrapper(T value) : m_value(value) {}
        iterator_wrapper& operator++() {
            ++m_value;
            return *this;
        }
        iterator_wrapper operator++(int) {
            iterator_wrapper tmp(*this);
            ++(*this);
            return tmp;
        }
        bool operator!=(const iterator_wrapper& other) const { return m_value != other.m_value; }
        auto operator*() const { return m_value; }

    private:
        T m_value;
    };

    friend iterator_wrapper begin(const blocked_range& range) {
        return iterator_wrapper(range.m_begin);
    }

    friend iterator_wrapper end(const blocked_range& range) {
        return iterator_wrapper(range.m_end);
    }

private:
    T m_begin;
    T m_end;
    std::size_t m_grainsize;
};

}} // namespace oneapi::tbb

#ifndef ORCA_WASM_TBB_ALIAS_DEFINED
#define ORCA_WASM_TBB_ALIAS_DEFINED
namespace tbb = oneapi::tbb;
#endif
