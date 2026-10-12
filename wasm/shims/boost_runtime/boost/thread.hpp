#pragma once

#include <chrono>
#include <cstddef>
#include <functional>
#include <mutex>
#include <type_traits>
#include <utility>
#include <pthread.h>

#include <boost/date_time/time_clock.hpp>
#include <boost/date_time/microsec_time_clock.hpp>
#include <boost/date_time/posix_time/posix_time_types.hpp>
#include <boost/core/ref.hpp>

namespace boost {

using system_time = posix_time::ptime;

inline system_time get_system_time() {
#if defined(BOOST_DATE_TIME_HAS_HIGH_PRECISION_CLOCK)
    return boost::posix_time::microsec_clock::universal_time();
#else
    return boost::posix_time::second_clock::universal_time();
#endif
}

namespace detail {

template <typename T>
struct is_boost_reference_wrapper : std::false_type {};

template <typename T>
struct is_boost_reference_wrapper<boost::reference_wrapper<T>> : std::true_type {};

template <typename Fn, typename... Args>
decltype(auto) invoke_callable(Fn&& fn, Args&&... args) {
    if constexpr (is_boost_reference_wrapper<std::decay_t<Fn>>::value) {
        return fn.get()(std::forward<Args>(args)...);
    } else {
        return std::forward<Fn>(fn)(std::forward<Args>(args)...);
    }
}

} // namespace detail

class thread {
public:
    class attributes {
    public:
        void set_stack_size(std::size_t) {}
    };

    class id {
    public:
        id() = default;
        friend constexpr bool operator==(const id&, const id&) { return true; }
        friend constexpr bool operator!=(const id&, const id&) { return false; }
    };

    thread() = default;

    template <class Fn, class... Args>
    explicit thread(Fn&& fn, Args&&... args) {
        (void)detail::invoke_callable(std::forward<Fn>(fn), std::forward<Args>(args)...);
    }

    template <class Fn>
    thread(attributes&, Fn&& fn) {
        (void)detail::invoke_callable(std::forward<Fn>(fn));
    }

    thread(const thread&) = delete;
    thread& operator=(const thread&) = delete;

    thread(thread&&) = default;
    thread& operator=(thread&&) = default;

    ~thread() = default;

    bool joinable() const { return false; }
    void join() {}
    void detach() {}

    using native_handle_type = pthread_t;
    native_handle_type native_handle() { return static_cast<native_handle_type>(0); }
    native_handle_type native_handle() const { return static_cast<native_handle_type>(0); }

    id get_id() const { return id{}; }
};

namespace this_thread {
inline thread::id get_id() { return thread::id{}; }

template <class Rep, class Period>
inline void sleep_for(const std::chrono::duration<Rep, Period>&) {}

template <class Clock, class Duration>
inline void sleep_until(const std::chrono::time_point<Clock, Duration>&) {}

inline void yield() {}
} // namespace this_thread

class mutex {
public:
    void lock() {}
    void unlock() {}
    bool try_lock() { return true; }
};

class recursive_mutex : public mutex {};

template <class Mutex>
class lock_guard {
public:
    explicit lock_guard(Mutex& m) : m_mutex(m) { m_mutex.lock(); }
    ~lock_guard() { m_mutex.unlock(); }

    lock_guard(const lock_guard&) = delete;
    lock_guard& operator=(const lock_guard&) = delete;

private:
    Mutex& m_mutex;
};

class condition_variable {
public:
    template <class Lock>
    void wait(Lock&) {}

    template <class Lock, class Predicate>
    void wait(Lock&, Predicate predicate) {
        (void)predicate;
    }

    template <class Lock>
    bool timed_wait(Lock&, const system_time&) { return true; }

    void notify_one() {}
    void notify_all() {}
};

template <class Mutex>
class unique_lock {
public:
    using mutex_type = Mutex;

    unique_lock() noexcept : m_mutex(nullptr), m_owns(false) {}

    explicit unique_lock(Mutex& mutex) : m_mutex(&mutex), m_owns(true) { m_mutex->lock(); }

    unique_lock(Mutex& mutex, std::defer_lock_t) noexcept : m_mutex(&mutex), m_owns(false) {}

    unique_lock(const unique_lock&) = delete;
    unique_lock& operator=(const unique_lock&) = delete;

    unique_lock(unique_lock&& other) noexcept : m_mutex(other.m_mutex), m_owns(other.m_owns) {
        other.m_mutex = nullptr;
        other.m_owns = false;
    }

    unique_lock& operator=(unique_lock&& other) noexcept {
        if (this != &other) {
            if (owns_lock()) {
                m_mutex->unlock();
            }
            m_mutex = other.m_mutex;
            m_owns = other.m_owns;
            other.m_mutex = nullptr;
            other.m_owns = false;
        }
        return *this;
    }

    ~unique_lock() {
        if (owns_lock()) {
            m_mutex->unlock();
        }
    }

    void lock() {
        if (m_mutex && !m_owns) {
            m_mutex->lock();
            m_owns = true;
        }
    }

    bool try_lock() {
        if (m_mutex && !m_owns) {
            m_owns = m_mutex->try_lock();
            return m_owns;
        }
        return false;
    }

    void unlock() {
        if (m_mutex && m_owns) {
            m_mutex->unlock();
            m_owns = false;
        }
    }

    bool owns_lock() const noexcept { return m_owns; }
    Mutex* mutex() const noexcept { return m_mutex; }

    Mutex* release() noexcept {
        Mutex* result = m_mutex;
        m_mutex = nullptr;
        m_owns = false;
        return result;
    }

private:
    Mutex* m_mutex;
    bool m_owns;
};

class thread_group {
public:
    thread_group() = default;

    template <class Fn>
    thread* create_thread(Fn&& fn) {
        fn();
        return nullptr;
    }

    void join_all() {}
};

} // namespace boost
