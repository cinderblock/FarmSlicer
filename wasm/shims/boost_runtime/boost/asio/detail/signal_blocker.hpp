#pragma once

namespace boost {
namespace asio {
namespace detail {

class signal_blocker {
public:
    signal_blocker() noexcept = default;
    ~signal_blocker() = default;

    void block() noexcept {}
    void unblock() noexcept {}

private:
    signal_blocker(const signal_blocker&) = delete;
    signal_blocker& operator=(const signal_blocker&) = delete;
};

} // namespace detail
} // namespace asio
} // namespace boost
