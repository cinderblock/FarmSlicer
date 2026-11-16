// Live slice geometry: see live_geometry.hpp and plans/live-slice-preview.md.
//
// When a step is copied: libslic3r's Print::process runs each step over
// every object in turn, each step in parallel over the layers, and calls
// the status callback at every step's start (before its parallel work).
// So the first callback after an object's step is DONE comes when nothing
// is writing that step's data, and the copy is made then. Later steps that
// rewrite paths (curled extrusions, path simplification) run after it.
// Tree support calls the callback from TBB workers while other objects'
// supports are generated; those read the finished steps, never write them.

#include "live_geometry.hpp"

#include <libslic3r/libslic3r.h>
#include <libslic3r/ExPolygon.hpp>
#include <libslic3r/ExtrusionEntity.hpp>
#include <libslic3r/ExtrusionEntityCollection.hpp>
#include <libslic3r/Flow.hpp>
#include <libslic3r/Layer.hpp>
#include <libslic3r/Print.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

namespace farmslicer::core {

namespace {

using namespace Slic3r;

/// Douglas-Peucker tolerance for the copied paths (mm): drops the points a
/// preview can't show (Arachne walls are dense) and keeps every corner.
constexpr double SIMPLIFY_MM = 0.01;

/// Paths of one layer, ready to encode.
struct LivePath {
    unsigned char name = 0;
    unsigned char tool = 0;
    uint16_t width_um = 0;
    uint16_t height_um = 0;
    std::vector<float> xy;
};

struct LiveLayer {
    float print_z = 0;
    float height = 0;
    std::vector<LivePath> paths;
};

class Writer {
public:
    std::string buf;
    void u8(unsigned v) { buf.push_back(char(v & 0xff)); }
    void u16(unsigned v) { put(uint16_t(v)); }
    void u32(size_t v) { put(uint32_t(v)); }
    void f32(double v) { put(float(v)); }
    void bytes(const void* p, size_t n) { buf.append(static_cast<const char*>(p), n); }

private:
    // Little-endian hosts only (x86-64, aarch64, wasm32).
    template <typename T> void put(T v) { bytes(&v, sizeof v); }
};

uint16_t micrometres(double mm)
{
    const double um = std::round(mm * 1000.0);
    return uint16_t(std::clamp(um, 0.0, 65535.0));
}

unsigned char tool_of(int filament_id)
{
    // Profiles number filaments from 1; 0 means "the default" (the first).
    return (unsigned char)(std::clamp(filament_id - 1, 0, 255));
}

/// Douglas-Peucker over (x, y) pairs, in place.
void simplify(std::vector<float>& xy, double tolerance)
{
    const size_t n = xy.size() / 2;
    if (n < 3) return;
    std::vector<char> keep(n, 0);
    keep[0] = keep[n - 1] = 1;
    std::vector<std::pair<size_t, size_t>> stack{{0, n - 1}};
    const double tol2 = tolerance * tolerance;
    while (!stack.empty()) {
        const auto [a, b] = stack.back();
        stack.pop_back();
        const double ax = xy[2 * a], ay = xy[2 * a + 1];
        const double dx = xy[2 * b] - ax, dy = xy[2 * b + 1] - ay;
        const double len2 = dx * dx + dy * dy;
        double worst = -1;
        size_t at = a;
        for (size_t i = a + 1; i < b; ++i) {
            const double px = xy[2 * i] - ax, py = xy[2 * i + 1] - ay;
            double d2;
            if (len2 <= 0) {
                d2 = px * px + py * py;
            } else {
                const double cross = px * dy - py * dx;
                d2 = cross * cross / len2;
            }
            if (d2 > worst) {
                worst = d2;
                at = i;
            }
        }
        if (worst > tol2) {
            keep[at] = 1;
            if (at - a > 1) stack.push_back({a, at});
            if (b - at > 1) stack.push_back({at, b});
        }
    }
    size_t w = 0;
    for (size_t i = 0; i < n; ++i)
        if (keep[i]) {
            xy[2 * w] = xy[2 * i];
            xy[2 * w + 1] = xy[2 * i + 1];
            ++w;
        }
    xy.resize(2 * w);
}

/// Copies a step's geometry: names its features, counts its points.
class Collector {
public:
    explicit Collector(const PrintConfig& config) : config_(config) {}

    std::vector<std::string> names;
    std::vector<LiveLayer> layers;
    size_t points = 0;

    unsigned char name(const std::string& n)
    {
        for (size_t i = 0; i < names.size(); ++i)
            if (names[i] == n) return (unsigned char)i;
        names.push_back(n);
        return (unsigned char)(names.size() - 1);
    }

    LiveLayer& layer(double print_z, double height)
    {
        layers.push_back({float(print_z), float(height), {}});
        return layers.back();
    }

    void add(LiveLayer& layer, LivePath&& path)
    {
        // Where the G-code puts it: less the offset of the nozzle that
        // prints it (GCode::point_to_gcode), the filament's by filament_map.
        const Vec2d offset = nozzle_offset(path.tool);
        if (offset.x() != 0 || offset.y() != 0)
            for (size_t i = 0; i + 1 < path.xy.size(); i += 2) {
                path.xy[i] -= float(offset.x());
                path.xy[i + 1] -= float(offset.y());
            }
        simplify(path.xy, SIMPLIFY_MM);
        if (path.xy.size() < 4) return;
        points += path.xy.size() / 2;
        layer.paths.push_back(std::move(path));
    }

    /// One extrusion entity and everything in it, with the tool its role prints with.
    template <typename ToolOf> void entity(LiveLayer& layer, const ExtrusionEntity* e, ToolOf&& tool_of_role)
    {
        if (!e) return;
        if (const auto* c = dynamic_cast<const ExtrusionEntityCollection*>(e)) {
            for (const ExtrusionEntity* child : c->entities) entity(layer, child, tool_of_role);
        } else if (const auto* loop = dynamic_cast<const ExtrusionLoop*>(e)) {
            for (const ExtrusionPath& p : loop->paths) path(layer, p, tool_of_role);
        } else if (const auto* multi = dynamic_cast<const ExtrusionMultiPath*>(e)) {
            for (const ExtrusionPath& p : multi->paths) path(layer, p, tool_of_role);
        } else if (const auto* p = dynamic_cast<const ExtrusionPath*>(e)) {
            path(layer, *p, tool_of_role);
        }
    }

private:
    const PrintConfig& config_;

    Vec2d nozzle_offset(unsigned char tool) const
    {
        const auto& map = config_.filament_map.values;
        const int nozzle = tool < map.size() ? std::max(0, map[tool] - 1) : 0;
        if (config_.extruder_offset.values.empty()) return Vec2d::Zero();
        return config_.extruder_offset.get_at(size_t(nozzle));
    }

    template <typename ToolOf> void path(LiveLayer& layer, const ExtrusionPath& p, ToolOf&& tool_of_role)
    {
        if (p.polyline.points.size() < 2) return;
        LivePath out;
        out.name = name(ExtrusionEntity::role_to_string(p.role()));
        out.tool = tool_of_role(p.role());
        out.width_um = micrometres(p.width);
        out.height_um = micrometres(p.height);
        out.xy.reserve(p.polyline.points.size() * 2);
        for (const auto& pt : p.polyline.points) {
            out.xy.push_back(float(unscale<double>(pt.x())));
            out.xy.push_back(float(unscale<double>(pt.y())));
        }
        add(layer, std::move(out));
    }
};

/// The filament a region prints a role with.
unsigned char region_tool(const PrintRegion& region, ExtrusionRole role)
{
    FlowRole flow;
    switch (role) {
    case erExternalPerimeter: flow = frExternalPerimeter; break;
    case erPerimeter:
    case erOverhangPerimeter: flow = frPerimeter; break;
    case erInternalInfill: flow = frInfill; break;
    case erTopSolidInfill:
    case erIroning: flow = frTopSolidInfill; break;
    default: flow = frSolidInfill; break;
    }
    return tool_of(int(region.extruder(flow)));
}

void outline(Collector& c, LiveLayer& layer, const Polygon& polygon, unsigned char name, unsigned char tool,
             uint16_t width, uint16_t height)
{
    if (polygon.points.size() < 3) return;
    LivePath path{name, tool, width, height, {}};
    path.xy.reserve((polygon.points.size() + 1) * 2);
    for (const Point& pt : polygon.points) {
        path.xy.push_back(float(unscale<double>(pt.x())));
        path.xy.push_back(float(unscale<double>(pt.y())));
    }
    path.xy.push_back(path.xy[0]);
    path.xy.push_back(path.xy[1]);
    c.add(layer, std::move(path));
}

void collect(Collector& c, const PrintObject& object, LiveStep step)
{
    switch (step) {
    case LiveStep::Outlines: {
        const unsigned char name = c.name("Outline");
        for (const Layer* layer : object.layers()) {
            LiveLayer& out = c.layer(layer->print_z, layer->height);
            double width = 0.4;
            unsigned char tool = 0;
            if (!layer->regions().empty()) {
                const LayerRegion* region = layer->regions().front();
                width = region->flow(frExternalPerimeter).width();
                tool = tool_of(int(region->region().extruder(frExternalPerimeter)));
            }
            const uint16_t w = micrometres(width), h = micrometres(layer->height);
            for (const ExPolygon& island : layer->lslices) {
                outline(c, out, island.contour, name, tool, w, h);
                for (const Polygon& hole : island.holes) outline(c, out, hole, name, tool, w, h);
            }
        }
        break;
    }
    case LiveStep::Walls:
    case LiveStep::Infill:
        for (const Layer* layer : object.layers()) {
            LiveLayer& out = c.layer(layer->print_z, layer->height);
            for (const LayerRegion* region : layer->regions()) {
                const PrintRegion& pr = region->region();
                auto tool = [&pr](ExtrusionRole role) { return region_tool(pr, role); };
                c.entity(out, step == LiveStep::Walls ? &region->perimeters : &region->fills, tool);
            }
        }
        break;
    case LiveStep::Supports: {
        const PrintObjectConfig& config = object.config();
        const unsigned char body = tool_of(config.support_filament.value);
        const unsigned char face = tool_of(config.support_interface_filament.value);
        auto tool = [body, face](ExtrusionRole role) { return role == erSupportMaterialInterface ? face : body; };
        for (const SupportLayer* layer : object.support_layers()) {
            LiveLayer& out = c.layer(layer->print_z, layer->height);
            c.entity(out, &layer->support_fills, tool);
        }
        break;
    }
    }
}

/// The libslic3r step whose end makes a live step ready. Infill waits for
/// ironing, which adds to the fills (and follows infill with no callback
/// in between).
PrintObjectStep ready_after(LiveStep step)
{
    switch (step) {
    case LiveStep::Outlines: return posSlice;
    case LiveStep::Walls: return posPerimeters;
    case LiveStep::Infill: return posIroning;
    case LiveStep::Supports: return posSupportMaterial;
    }
    return posSlice;
}

std::string encode(unsigned plate, size_t object_index, LiveStep step, bool skipped, const PrintObject& object,
                   const Collector* c)
{
    Writer w;
    w.bytes("FSL1", 4);
    w.u32(plate);
    w.u32(object_index);
    w.u8(unsigned(step));
    w.u8(skipped ? 1 : 0);
    w.u16(0);
    w.u32(object.instances().size());
    for (const PrintInstance& instance : object.instances()) {
        w.f32(unscale<double>(instance.shift.x()));
        w.f32(unscale<double>(instance.shift.y()));
    }
    const size_t names = c ? std::min<size_t>(c->names.size(), 255) : 0;
    w.u16(unsigned(names));
    for (size_t i = 0; i < names; ++i) {
        const std::string& n = c->names[i];
        const size_t len = std::min<size_t>(n.size(), 255);
        w.u16(unsigned(len));
        w.bytes(n.data(), len);
    }
    w.u32(c ? c->layers.size() : 0);
    if (c)
        for (const LiveLayer& layer : c->layers) {
            w.f32(layer.print_z);
            w.f32(layer.height);
            w.u32(layer.paths.size());
            for (const LivePath& p : layer.paths) {
                w.u8(p.name);
                w.u8(p.tool);
                w.u16(p.width_um);
                w.u16(p.height_um);
                w.u16(0);
                w.u32(p.xy.size() / 2);
                w.bytes(p.xy.data(), p.xy.size() * sizeof(float));
            }
        }
    return std::move(w.buf);
}

} // namespace

LiveGeometry::LiveGeometry(GeometryFn sink, unsigned plate, size_t& budget)
    : sink_(std::move(sink)), plate_(plate), budget_(budget)
{
}

void LiveGeometry::poll(const Slic3r::Print& print)
{
    if (failed_ || !sink_) return;
    try {
        size_t index = 0;
        for (const PrintObject* object : print.objects()) {
            // Objects that share another's geometry get its layers copied
            // only at the end of process(): show the other's, at their places.
            const PrintObject* source = object->get_shared_object() ? object->get_shared_object() : object;
            for (LiveStep step : {LiveStep::Outlines, LiveStep::Walls, LiveStep::Infill, LiveStep::Supports}) {
                const auto state = source->step_state_with_timestamp(ready_after(step));
                if (state.state != PrintStateBase::DONE) continue;
                const auto key = std::make_pair(index, int(step));
                const auto seen = sent_.find(key);
                if (seen != sent_.end() && seen->second == size_t(state.timestamp)) continue;
                sent_[key] = size_t(state.timestamp);

                Collector c(print.config());
                collect(c, *source, step);
                const size_t cost = c.points * std::max<size_t>(1, object->instances().size());
                if (step == LiveStep::Supports && c.points == 0) continue; // no supports: nothing to say
                const bool fits = step == LiveStep::Outlines || cost <= budget_;
                if (fits) budget_ = cost >= budget_ ? 0 : budget_ - cost;
                sink_(encode(plate_, index, step, !fits, *object, fits ? &c : nullptr));
            }
            ++index;
        }
    } catch (...) {
        // The live view is a nicety: the slice goes on without it.
        failed_ = true;
    }
}

} // namespace farmslicer::core
