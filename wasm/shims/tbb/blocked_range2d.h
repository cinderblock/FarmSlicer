#pragma once

#include <cstddef>

#include "blocked_range.h"

namespace oneapi { namespace tbb {

template <typename RowValue, typename ColValue = RowValue>
class blocked_range2d {
public:
    using rows_range_type = blocked_range<RowValue>;
    using cols_range_type = blocked_range<ColValue>;

    blocked_range2d(RowValue row_begin, RowValue row_end,
                    ColValue col_begin, ColValue col_end)
        : m_rows(row_begin, row_end),
          m_cols(col_begin, col_end) {}

    blocked_range2d(RowValue row_begin, RowValue row_end, std::size_t row_grain,
                    ColValue col_begin, ColValue col_end, std::size_t col_grain = 1)
        : m_rows(row_begin, row_end, row_grain),
          m_cols(col_begin, col_end, col_grain) {}

    const rows_range_type& rows() const { return m_rows; }
    const cols_range_type& cols() const { return m_cols; }

    bool empty() const { return m_rows.empty() || m_cols.empty(); }

private:
    rows_range_type m_rows;
    cols_range_type m_cols;
};

}} // namespace oneapi::tbb

#ifndef ORCA_WASM_TBB_ALIAS_DEFINED
#define ORCA_WASM_TBB_ALIAS_DEFINED
namespace tbb = oneapi::tbb;
#endif
