// What a slice looks like while it's being made: each object's layer
// outlines, walls, infill and supports, copied out of libslic3r as each
// step finishes and encoded as binary frames for the page's live view
// (web/src/components/preview/liveSlice.ts reads them). The wire format is
// in plans/live-slice-preview.md. Engine-agnostic, like slice_core.
#pragma once

#include <cstddef>
#include <functional>
#include <map>
#include <string>
#include <utility>

namespace Slic3r {
class Print;
}

namespace farmslicer::core {

/// Receives one frame (binary, in a std::string). May be called from TBB
/// worker threads, never concurrently (slice_core holds a lock).
using GeometryFn = std::function<void(const std::string& frame)>;

/// Points a slice may send in all (every plate): outlines always go, an
/// extrusion step only while it fits (else a "skipped" frame).
constexpr size_t LIVE_POINT_BUDGET = 4'000'000;

/// The steps a frame carries (wire values).
enum class LiveStep : unsigned char { Outlines = 0, Walls = 1, Infill = 2, Supports = 3 };

/// Sends each plate's object steps as they finish. One per plate's Print.
class LiveGeometry {
public:
    /// `budget`: points left for the whole slice, shared by every plate.
    LiveGeometry(GeometryFn sink, unsigned plate, size_t& budget);

    /// Send every object step that finished since the last call. Call it
    /// only where nothing writes the finished steps' data: from the Print's
    /// status callback (the next step's start, before its parallel work) or
    /// after Print::process. Never throws; a failure turns it off.
    void poll(const Slic3r::Print& print);

private:
    GeometryFn sink_;
    unsigned plate_;
    size_t& budget_;
    bool failed_ = false;
    /// (object index, step) → libslic3r's timestamp of the step sent.
    std::map<std::pair<size_t, int>, size_t> sent_;
};

} // namespace farmslicer::core
