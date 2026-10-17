// FarmSlicer slicing pipeline on top of libslic3r.
//
// Mirrors what OrcaSlicer's CLI does for a single plate: build a
// DynamicPrintConfig from the merged profile JSON, load the models and put
// every part where the user placed it, Print::apply → validate → process →
// export_gcode, then collect the statistics the G-code processor computed. Used unchanged by the native
// server and the WebAssembly engine so both produce the same G-code for the
// same config.

#include "slice_core.hpp"

#include <libslic3r/libslic3r.h>
#include <libslic3r/Utils.hpp>
#include <libslic3r/BuildVolume.hpp>
#include <libslic3r/Model.hpp>
#include <libslic3r/Print.hpp>
#include <libslic3r/Layer.hpp>
#include <libslic3r/PrintBase.hpp>
#include <libslic3r/PrintConfig.hpp>
#include <libslic3r/Preset.hpp>
#include <libslic3r/FlushVolCalc.hpp>
#include <libslic3r/Config.hpp>
#include <libslic3r/Exception.hpp>
#include <libslic3r/GCode/GCodeProcessor.hpp>
#include <libslic3r/GCode/ThumbnailData.hpp>
#include <libslic3r/Format/bbs_3mf.hpp>
#include <libslic3r/ProjectTask.hpp>

#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace farmslicer::core {

namespace {

std::string g_temp_dir;
std::string g_resources_dir;

/// Plate thumbnail size in sliced projects (Bambu Studio's THUMBNAIL_SIZE_3MF).
constexpr unsigned PACKAGE_THUMBNAIL = 512;

// libslic3r only reads configs from files. Write the merged JSON to the
// scratch dir and hand it the path.
class TempConfigFile {
public:
    explicit TempConfigFile(const std::string& contents) {
        static std::atomic<unsigned> seq{0};
        const std::filesystem::path dir = g_temp_dir.empty()
            ? std::filesystem::temp_directory_path()
            : std::filesystem::path(g_temp_dir);
        path_ = (dir / ("farmslicer_config_" + std::to_string(++seq) + ".json")).string();
        std::ofstream f(path_, std::ios::binary | std::ios::trunc);
        if (!f) throw std::runtime_error("cannot write temporary config file " + path_);
        f << contents;
    }
    ~TempConfigFile() { std::error_code ec; std::filesystem::remove(path_, ec); }
    const std::string& path() const { return path_; }
private:
    std::string path_;
};

size_t vector_size(const Slic3r::DynamicPrintConfig& cfg, const char* key)
{
    const Slic3r::ConfigOption* opt = cfg.option(key);
    if (auto* v = dynamic_cast<const Slic3r::ConfigOptionVectorBase*>(opt)) return v->size();
    return 0;
}

/// "#RRGGBB" (or "#RRGGBBAA") as RGBA; black when unreadable.
std::array<unsigned char, 4> parse_colour(const std::string& hex)
{
    std::array<unsigned char, 4> rgba{0, 0, 0, 255};
    const std::string h = !hex.empty() && hex[0] == '#' ? hex.substr(1) : hex;
    for (size_t i = 0; i < 4 && i * 2 + 2 <= h.size(); ++i) {
        try {
            rgba[i] = static_cast<unsigned char>(std::stoi(h.substr(i * 2, 2), nullptr, 16));
        } catch (...) {
        }
    }
    return rgba;
}

/// Filament volume a nozzle's own purge already covers (mm³), less what a
/// long retraction before the cut pulls out (Plater.cpp
/// get_min_flush_volumes in the desktop app).
std::vector<int> min_flush_volumes(const Slic3r::DynamicPrintConfig& config, size_t nozzle, size_t filaments)
{
    using namespace Slic3r;
    const auto* volume = config.option<ConfigOptionFloatsNullable>("nozzle_volume");
    const int nozzle_volume = volume && !volume->values.empty() ? int(volume->get_at(nozzle)) : 0;
    const auto* level = config.option<ConfigOptionInt>("enable_long_retraction_when_cut");
    const int enabled = level ? level->value : 0;
    const auto* machine_on = config.option<ConfigOptionBools>("long_retractions_when_cut");
    const bool activated = machine_on && !machine_on->values.empty() && machine_on->get_at(nozzle);
    const auto* filament_dist = config.option<ConfigOptionFloats>("filament_retraction_distances_when_cut");
    const auto* machine_dist = config.option<ConfigOptionFloats>("retraction_distances_when_cut");
    const auto* filament_on = config.option<ConfigOptionBools>("filament_long_retractions_when_cut");
    std::vector<int> out;
    for (size_t i = 0; i < filaments; ++i) {
        double retract = enabled && activated && machine_dist ? machine_dist->get_at(nozzle) : 0.0;
        const unsigned char on = filament_on && !filament_on->values.empty() ? filament_on->get_at(i) : 0;
        if (on == 0)
            retract = 0;
        else if (on == 1 && enabled == LongRectrationLevel::EnableFilament) {
            const double d = filament_dist && !filament_dist->values.empty() ? filament_dist->get_at(i) : NAN;
            retract = !std::isnan(d) ? d : (machine_dist ? machine_dist->get_at(nozzle) : 0.0);
        }
        out.push_back(int(nozzle_volume - M_PI * 1.75 * 1.75 / 4 * retract));
    }
    return out;
}

// What the desktop app keeps in the project rather than in presets, for
// more than one filament: purge volumes between every pair of filaments on
// every nozzle (from their colours, with libslic3r's flush model; a support
// material takes a fixed amount), like OrcaSlicer's CLI computes them.
void complete_flush_volumes(Slic3r::DynamicPrintConfig& config, size_t filaments, size_t nozzles)
{
    using namespace Slic3r;
    auto& matrix = config.option<ConfigOptionFloats>("flush_volumes_matrix", true)->values;
    if (filaments < 2 || matrix.size() == filaments * filaments * nozzles) return;
    matrix.assign(filaments * filaments * nozzles, 0.0);
    config.option<ConfigOptionFloats>("flush_multiplier", true)->values.resize(nozzles, 1.0);
    const auto& colours = config.option<ConfigOptionStrings>("filament_colour", true)->values;
    const auto* support = config.option<ConfigOptionBools>("filament_is_support");
    std::vector<int> dataset_full;
    if (const auto* d = config.option<ConfigOptionIntsNullable>("nozzle_flush_dataset")) dataset_full = d->values;
    for (size_t nozzle = 0; nozzle < nozzles; ++nozzle) {
        // The flush data set of the nozzle's variant (Standard / High Flow).
        int dataset = dataset_full.empty() ? 0 : dataset_full[0];
        if (config.has("printer_extruder_id") && config.has("printer_extruder_variant") && config.has("extruder_type") &&
            config.has("nozzle_volume_type")) {
            const int type = config.option<ConfigOptionEnumsGeneric>("extruder_type")->get_at(nozzle);
            const int volume = config.option<ConfigOptionEnumsGeneric>("nozzle_volume_type")->get_at(nozzle);
            const int index = config.get_index_for_extruder(int(nozzle) + 1, "printer_extruder_id", ExtruderType(type),
                                                            NozzleVolumeType(volume), "printer_extruder_variant");
            if (index >= 0 && size_t(index) < dataset_full.size()) dataset = dataset_full[index];
        }
        const std::vector<int> minimum = min_flush_volumes(config, nozzle, filaments);
        std::vector<double> nozzle_matrix(filaments * filaments, 0.0);
        for (size_t from = 0; from < filaments; ++from) {
            const auto a = parse_colour(from < colours.size() ? colours[from] : "#FFFFFF");
            const bool from_support = support && !support->values.empty() && support->get_at(from);
            for (size_t to = 0; to < filaments; ++to) {
                if (from == to) continue;
                int volume;
                if (support && !support->values.empty() && support->get_at(to)) {
                    volume = g_flush_volume_to_support;
                } else {
                    const auto b = parse_colour(to < colours.size() ? colours[to] : "#FFFFFF");
                    FlushVolCalculator calc(minimum[from], g_max_flush_volume, dataset);
                    volume = calc.calc_flush_vol(a[3], a[0], a[1], a[2], b[3], b[0], b[1], b[2]);
                    if (from_support) volume = std::max(g_min_flush_volume_from_support, volume);
                }
                nozzle_matrix[filaments * from + to] = volume;
            }
        }
        set_flush_volumes_matrix(matrix, nozzle_matrix, nozzles > 1 ? nozzle : size_t(-1), nozzles);
    }
}

// Load the merged profile JSON on top of the full defaults, recording
// substitutions and unknown keys as warnings instead of failing.
void load_config(Slic3r::DynamicPrintConfig& config, const std::string& json,
                 std::vector<std::string>& warnings)
{
    using namespace Slic3r;
    config.apply(FullPrintConfig::defaults());
    if (!json.empty() && json != "{}") {
        TempConfigFile file(json);
        ConfigSubstitutionContext ctx(ForwardCompatibilitySubstitutionRule::EnableSilent);
        std::map<std::string, std::string> key_values;
        std::string reason;
        const int rc = config.load_from_json(file.path(), ctx, true, key_values, reason);
        if (rc != 0)
            throw std::runtime_error("invalid config: " + (reason.empty() ? std::string("parse error") : reason));

        for (const ConfigSubstitution& s : ctx.substitutions) {
            warnings.push_back(s.opt_def
                ? "config substitution " + s.opt_def->opt_key + ": '" + s.old_value + "' -> '" +
                  (s.new_value ? s.new_value->serialize() : std::string()) + "'"
                : "config substitution: " + s.old_value);
        }
        // Vendor profiles carry a handful of GUI/preset-level keys libslic3r
        // does not know (adaptive_layer_height, silent_mode, ...). Report them
        // once, in one line, instead of one warning per key per job.
        if (!ctx.unrecogized_keys.empty()) {
            std::string msg = "ignored " + std::to_string(ctx.unrecogized_keys.size()) +
                              " config keys unknown to libslic3r:";
            for (const std::string& k : ctx.unrecogized_keys) msg += " " + k;
            warnings.push_back(msg);
        }
    }

    // Every filament key gets an entry per filament, like the desktop app
    // makes presets when it loads them: a key no profile sets keeps
    // libslic3r's one-entry default otherwise, and with several filaments
    // libslic3r reads past it (filament_colour sizes the filament grouping:
    // "Grouping error: PLA can not be placed in the right nozzle").
    Preset::normalize(config);

    // Multi-extruder bookkeeping the desktop app does before slicing.
    const int filament_count = int(std::max<size_t>(1, vector_size(config, "filament_diameter")));
    const int extruder_count = int(std::max<size_t>(1, vector_size(config, "nozzle_diameter")));
    complete_flush_volumes(config, size_t(filament_count), size_t(extruder_count));
    {
        auto& fmap = config.option<ConfigOptionInts>("filament_map", true)->values;
        if (int(fmap.size()) < filament_count) fmap.resize(filament_count, 1);
        if (extruder_count == 1) std::fill(fmap.begin(), fmap.end(), 1);
        if (!config.has("nozzle_volume_type")) {
            auto* nvt = config.option<ConfigOptionEnumsGeneric>("nozzle_volume_type", true);
            nvt->values.resize(extruder_count, nvtStandard);
        }
    }
    config.normalize_fdm();
}

const char* nozzle_side(int extruder) { return extruder == 0 ? "left" : "right"; }

// The part of the bed every nozzle reaches: `printable_area`, cut down to
// each nozzle's `extruder_printable_area` on printers with several (the
// H2D's: x 25-325 of 350).
Slic3r::BoundingBoxf reachable_area(const Slic3r::DynamicPrintConfig& config)
{
    using namespace Slic3r;
    BoundingBoxf area;
    if (const auto* bed = config.option<ConfigOptionPoints>("printable_area"))
        for (const Vec2d& p : bed->values) area.merge(p);
    if (const auto* nozzles = config.option<ConfigOptionPointsGroups>("extruder_printable_area"))
        for (const Vec2ds& points : nozzles->values) {
            if (points.empty()) continue;
            const BoundingBoxf reach(points);
            area.min = area.min.cwiseMax(reach.min);
            area.max = area.max.cwiseMin(reach.max);
        }
    return area;
}

void set_wipe_tower_position(Slic3r::DynamicPrintConfig& config, double x, double y)
{
    using namespace Slic3r;
    config.option<ConfigOptionFloats>("wipe_tower_x", true)->values = {x};
    config.option<ConfigOptionFloats>("wipe_tower_y", true)->values = {y};
}

// Where the desktop app puts the prime tower on a new plate
// (PartPlateList::set_default_wipe_tower_pos_for_plate): x 165 (0 on
// bed-slingers), y 250, then inside the area every nozzle reaches
// (fit_wipe_tower, once its size is known). Only on printers with several
// nozzles, where the profiles' x 15 is out of one nozzle's reach; others
// keep the profile's position.
void place_wipe_tower(Slic3r::DynamicPrintConfig& config)
{
    using namespace Slic3r;
    const auto* nozzles = config.option<ConfigOptionPointsGroups>("extruder_printable_area");
    if (!nozzles || nozzles->values.size() < 2) return;
    const auto* structure = config.option<ConfigOptionEnum<PrinterStructure>>("printer_structure");
    set_wipe_tower_position(config, structure && structure->value == psI3 ? 0.0 : 165.0, 250.0);
}

// Move a prime tower (its first layer, brim and cone included) that pokes
// out of the area every nozzle reaches back inside it, a margin from the
// edge, as the desktop app clamps it. Returns whether it moved (then
// process again: only the wipe tower and the G-code depend on it).
bool fit_wipe_tower(const Slic3r::Print& print, Slic3r::DynamicPrintConfig& config)
{
    using namespace Slic3r;
    const Points corners = print.first_layer_wipe_tower_corners();
    if (corners.empty()) return false;
    BoundingBoxf tower;
    for (const Point& p : corners) tower.merge(Vec2d(unscale<double>(p.x()), unscale<double>(p.y())));
    const BoundingBoxf area = reachable_area(config);
    if (!area.defined) return false;
    auto shift = [](double lo, double hi, double area_lo, double area_hi) {
        if (hi + WIPE_TOWER_MARGIN > area_hi) return area_hi - WIPE_TOWER_MARGIN - hi;
        if (lo - WIPE_TOWER_MARGIN < area_lo) return area_lo + WIPE_TOWER_MARGIN - lo;
        return 0.0;
    };
    const double dx = shift(tower.min.x(), tower.max.x(), area.min.x(), area.max.x());
    const double dy = shift(tower.min.y(), tower.max.y(), area.min.y(), area.max.y());
    if (std::abs(dx) < 1e-3 && std::abs(dy) < 1e-3) return false;
    set_wipe_tower_position(config, print.config().wipe_tower_x.get_at(0) + dx, print.config().wipe_tower_y.get_at(0) + dy);
    return true;
}

// On dual-nozzle printers each nozzle misses part of the build volume (the
// H2D's: a strip of the bed each, `extruder_printable_area`, and the top
// few millimetres, `extruder_printable_height`). The G-code check that
// runs with the export looks at every move of every copy and records, per
// filament, the nozzles that can't print it (`limit_filament_maps`).
//
// With a Manual filament map (FarmSlicer chose each filament's nozzle, see
// src/nozzles.rs) libslic3r takes the map as given, so move a filament its
// nozzle can't reach to the other one when that one can. Returns whether
// the map changed (then slice again: only the wipe tower and the G-code
// depend on it).
bool move_unreachable_filaments(const Slic3r::Print& print, const Slic3r::GCodeProcessorResult& result,
                                Slic3r::DynamicPrintConfig& config, std::vector<std::string>& warnings)
{
    using namespace Slic3r;
    if (print.config().filament_map_mode.value != fmmManual || print.config().nozzle_diameter.size() != 2)
        return false;
    std::vector<int> fmap = print.config().filament_map.values;
    bool changed = false;
    for (size_t f = 0; f < fmap.size() && f < result.limit_filament_maps.size(); ++f) {
        const int limits = result.limit_filament_maps[f];
        const int e = fmap[f] - 1;
        if (e < 0 || e > 1 || !(limits >> e & 1)) continue;
        const int other = 1 - e;
        if (limits >> other & 1) continue; // neither can: check_nozzle_reach refuses the slice
        fmap[f] = other + 1;
        changed = true;
        warnings.push_back("filament " + std::to_string(f + 1) + " prints from the " + nozzle_side(other) +
                           " nozzle instead: the " + nozzle_side(e) + " one can't reach all of it");
    }
    if (changed) config.option<ConfigOptionInts>("filament_map", true)->values = fmap;
    return changed;
}

// Refuse G-code a nozzle can't print: part of it lies where the nozzle
// that prints it can't reach (Bambu Studio won't send such a plate either).
void check_nozzle_reach(const Slic3r::GCodeProcessorResult& result)
{
    const auto& check = result.gcode_check_result;
    if (!(check.error_code & 0b11)) return;
    std::set<std::pair<int, int>> seen; // (nozzle, filament)
    std::string msg;
    for (const auto* infos : {&check.print_area_error_infos, &check.print_height_error_infos})
        for (const auto& [extruder, list] : *infos)
            for (const auto& [filament, object] : list) {
                (void)object;
                if (!seen.insert({extruder, filament}).second) continue;
                msg += msg.empty() ? "" : "; ";
                msg += "the " + std::string(nozzle_side(extruder)) + " nozzle can't reach all of filament " +
                       std::to_string(filament + 1);
            }
    throw std::runtime_error("the plate can't be printed as sliced: " +
                             (msg.empty() ? std::string("a nozzle can't reach part of it") : msg) +
                             " (each nozzle misses part of the bed and the top of the build volume)");
}

/// The bed's centre from `printable_area` (origin when there is none).
Slic3r::Vec2d bed_center(const Slic3r::DynamicPrintConfig& config)
{
    using namespace Slic3r;
    BoundingBoxf bed;
    if (const auto* area = config.option<ConfigOptionPoints>("printable_area"))
        for (const Vec2d& p : area->values) bed.merge(p);
    return bed.defined ? bed.center() : Vec2d(0.0, 0.0);
}

// Build the plate: every model file once, every copy of it where the user
// placed it. A copy is the file's objects (with their instances as loaded)
// as one rigid group: rotated, its bounding box centred on the bed centre
// plus the placement's offset (just the bed centre without one, like the
// desktop plater on import) and dropped onto Z=0. Copies are instances of
// the same objects, so libslic3r slices identical copies once.
// (ModelObject::ensure_on_bed would drop every instance by the lowest one;
// each copy here rests on the bed by itself.)
Slic3r::Model build_plate(const std::vector<ModelInput>& inputs, const Slic3r::Vec2d& center)
{
    using namespace Slic3r;
    Model plate;
    for (const ModelInput& in : inputs) {
        Model src = Model::read_from_file(in.path);
        const std::string what = in.name.empty() ? std::string("a model file") : "\"" + in.name + "\"";
        if (src.objects.empty()) throw std::runtime_error(what + " contains no objects");
        if (!in.name.empty() && src.objects.size() == 1) src.objects.front()->name = in.name;

        // The file's objects on the plate, and their instances as loaded.
        std::vector<ModelObject*> objects;
        std::vector<std::vector<Transform3d>> as_loaded;
        for (ModelObject* o : src.objects) {
            if (o->instances.empty()) o->add_instance();
            ModelObject* copy = plate.add_object(*o);
            std::vector<Transform3d> trafos;
            for (const ModelInstance* inst : copy->instances) trafos.push_back(inst->get_matrix());
            copy->clear_instances();
            objects.push_back(copy);
            as_loaded.push_back(std::move(trafos));
        }

        const std::vector<Placement> parts = in.parts.empty() ? std::vector<Placement>{Placement{}} : in.parts;
        for (const Placement& part : parts) {
            Transform3d rotation = Transform3d::Identity();
            if (part.set)
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c) rotation.linear()(r, c) = part.rotation[r * 3 + c];
            std::vector<ModelInstance*> group;
            BoundingBoxf3 box;
            for (size_t k = 0; k < objects.size(); ++k)
                for (const Transform3d& trafo : as_loaded[k]) {
                    ModelInstance* inst = objects[k]->add_instance();
                    inst->set_transformation(Geometry::Transformation(rotation * trafo));
                    box.merge(objects[k]->instance_bounding_box(*inst));
                    group.push_back(inst);
                }
            const Vec2d target = center + (part.set ? Vec2d(part.offset[0], part.offset[1]) : Vec2d::Zero());
            const Vec3d shift(target.x() - box.center().x(), target.y() - box.center().y(), -box.min.z());
            for (ModelInstance* inst : group) inst->set_offset(inst->get_offset() + shift);
        }
        for (ModelObject* o : objects) o->invalidate_bounding_box();
    }
    return plate;
}

// Refuse parts that don't fit: libslic3r would slice them, and the G-code
// would drive the head beyond the bed.
void check_build_volume(Slic3r::Model& model, const Slic3r::DynamicPrintConfig& config)
{
    using namespace Slic3r;
    const auto* area = config.option<ConfigOptionPoints>("printable_area");
    if (!area || area->values.size() < 3) return;
    const auto* height = config.option<ConfigOptionFloat>("printable_height");
    const BuildVolume volume(area->values, height ? height->value : 0.0, {}, {});
    model.update_print_volume_state(volume);
    size_t parts = 0;
    for (const ModelObject* obj : model.objects) parts += obj->instances.size();
    for (const ModelObject* obj : model.objects)
        for (size_t i = 0; i < obj->instances.size(); ++i) {
            const ModelInstance* inst = obj->instances[i];
            if (inst->print_volume_state == ModelInstancePVS_Inside) continue;
            std::string what = parts > 1 ? "\"" + obj->name + "\"" : std::string("the model");
            if (obj->instances.size() > 1) what += " (copy " + std::to_string(i + 1) + ")";
            throw std::runtime_error(inst->print_volume_state == ModelInstancePVS_Fully_Outside
                                         ? what + " is off the bed: move it onto the build plate"
                                         : what + " doesn't fit in the printable volume: move, rotate or "
                                                  "shrink it so it stays inside the build plate and under the "
                                                  "maximum height");
        }
}

double filament_density(const Slic3r::DynamicPrintConfig& cfg, size_t e)
{
    const auto* dens = cfg.option<Slic3r::ConfigOptionFloats>("filament_density");
    return dens && !dens->values.empty() ? dens->get_at(e) : 1.24;
}

double filament_diameter(const Slic3r::DynamicPrintConfig& cfg, size_t e)
{
    const auto* diam = cfg.option<Slic3r::ConfigOptionFloats>("filament_diameter");
    return diam && !diam->values.empty() ? diam->get_at(e) : 1.75;
}

// A Print built in zeroed memory. libslic3r's Print leaves its stand-in
// prime tower (FakeWipeTower: position, size, layer height) uninitialised
// until a prime tower is built, yet checks the plate for path conflicts
// against it whenever the config lists more than one filament
// (Print::has_wipe_tower). A plate that ends up printing with one of them
// gets no tower, and the check reads whatever was in memory: a segfault in
// FakeWipeTower::getFakeExtrusionPathsFromWipeTower2 (seen with three
// filaments on a plate that needed no supports). Zeroed, those fields read
// 0, an empty tower, as in the desktop app's fresh heap and the WebAssembly
// engine. See issues/libslic3r-fake-wipe-tower.md.
class ZeroedPrint {
public:
    ZeroedPrint()
    {
        static_assert(alignof(Slic3r::Print) <= alignof(std::max_align_t), "calloc alignment");
        memory_ = std::calloc(1, sizeof(Slic3r::Print));
        if (!memory_) throw std::bad_alloc();
        print_ = new (memory_) Slic3r::Print();
    }
    ~ZeroedPrint()
    {
        print_->~Print();
        std::free(memory_);
    }
    ZeroedPrint(const ZeroedPrint&) = delete;
    ZeroedPrint& operator=(const ZeroedPrint&) = delete;
    Slic3r::Print& get() { return *print_; }

private:
    void* memory_ = nullptr;
    Slic3r::Print* print_ = nullptr;
};

void report(const Callbacks& cb, int percent, const std::string& message)
{
    if (cb.progress) cb.progress(percent, message);
}

} // namespace

void init_runtime(const std::string& resources_dir, const std::string& temp_dir)
{
    g_temp_dir = temp_dir;
    g_resources_dir = resources_dir;
    Slic3r::set_resources_dir(resources_dir);
    Slic3r::set_temporary_dir(temp_dir);
    Slic3r::set_logging_level(2); // errors + warnings
}

Outcome slice_models(const std::vector<ModelInput>& models,
                     const std::string& config_json,
                     const std::string& output_path,
                     const Callbacks& cb,
                     const Options& options)
{
    using namespace Slic3r;
    Outcome out;

    try {
        if (models.empty()) throw std::runtime_error("nothing to slice: no model");

        report(cb, 0, "Loading configuration");
        DynamicPrintConfig config;
        load_config(config, config_json, out.warnings);

        report(cb, 2, models.size() > 1 ? "Loading models" : "Loading model");
        Model model = build_plate(models, bed_center(config));
        check_build_volume(model, config);

        const int filament_count = int(std::max<size_t>(1, vector_size(config, "filament_diameter")));

        ZeroedPrint print_holder;
        Print& print = print_holder.get();
        print.set_plate_origin(Vec3d::Zero());
        const std::string printer_model = config.opt_string("printer_model", true);
        print.is_BBL_printer() = printer_model.rfind("Bambu Lab", 0) == 0;
        Model::setExtruderParams(config, filament_count);

        std::mutex status_mutex;
        print.set_status_callback([&](const PrintBase::SlicingStatus& s) {
            std::lock_guard<std::mutex> lock(status_mutex);
            if (s.percent >= 0)
                report(cb, int(5 + s.percent * 0.85), s.text);
            if (s.warning_step != -1 && !s.text.empty())
                out.warnings.push_back(s.text);
        });
        if (cb.cancelled) {
            print.set_cancel_callback([&cb]() {
                if (cb.cancelled()) throw CanceledException();
            });
        }

        place_wipe_tower(config);
        print.apply(model, config);
        Model::setPrintSpeedTable(config, print.config());
        if (print.empty())
            throw std::runtime_error("nothing to slice: no object is inside the printable volume");

        {
            StringObjectException warning;
            StringObjectException err = print.validate(&warning);
            if (!err.string.empty()) throw std::runtime_error(err.string);
            if (!warning.string.empty()) out.warnings.push_back(warning.string);
        }

        report(cb, 5, "Slicing");
        print.process();
        if (fit_wipe_tower(print, config)) {
            print.apply(model, config);
            print.process();
        }
        if (std::string conflict = print.get_conflict_string(); !conflict.empty())
            out.warnings.push_back(conflict);

        // Thumbnails: the G-code exporter asks for the sizes the printer
        // profile lists (none for Bambu printers, which read the package's).
        ThumbnailOverlay overlay = options.overlay;
        if (overlay.font_path.empty())
            overlay.font_path = (std::filesystem::path(g_resources_dir) / "fonts" / "Sarabun-SemiBold.ttf").string();
        std::vector<std::string> colors;
        if (const auto* c = config.option<ConfigOptionStrings>("filament_colour")) colors = c->values;
        std::set<std::string> overlay_warnings;
        auto make_thumbnail = [&](unsigned w, unsigned h) {
            ThumbnailData t;
            render_thumbnail(model, colors, w, h, t);
            if (!overlay.empty())
                for (std::string& w : apply_overlay(t, overlay)) overlay_warnings.insert(std::move(w));
            return t;
        };
        ThumbnailsGeneratorCallback thumbnails = [&](const ThumbnailsParams& params) {
            ThumbnailsList list;
            for (const Vec2d& size : params.sizes)
                list.push_back(make_thumbnail(unsigned(size.x()), unsigned(size.y())));
            return list;
        };

        report(cb, 90, "Exporting G-code");
        GCodeProcessorResult gcode_result;
        std::string written = print.export_gcode(output_path, &gcode_result, thumbnails);
        if (move_unreachable_filaments(print, gcode_result, config, out.warnings)) {
            print.apply(model, config);
            print.process();
            if (fit_wipe_tower(print, config)) {
                print.apply(model, config);
                print.process();
            }
            gcode_result = GCodeProcessorResult();
            written = print.export_gcode(output_path, &gcode_result, thumbnails);
        }
        check_nozzle_reach(gcode_result);
        if (written.empty()) written = output_path;
        if (!std::filesystem::exists(written))
            throw std::runtime_error("G-code export produced no file");

        // Statistics from the G-code processor (same numbers the desktop app
        // shows in its sliced-plate panel).
        const auto& ps = gcode_result.print_statistics;
        out.print_time_sec =
            double(ps.modes[static_cast<size_t>(PrintEstimatedStatistics::ETimeMode::Normal)].time);
        for (const auto& [extruder, vol_mm3] : ps.total_volumes_per_extruder) {
            const double d = filament_diameter(config, extruder);
            const double area = M_PI * d * d / 4.0;
            out.filament_used_g += vol_mm3 / 1000.0 * filament_density(config, extruder);
            out.filament_used_mm += area > 0 ? vol_mm3 / area : 0.0;
        }

        std::set<long long> layer_zs;
        for (const PrintObject* po : print.objects()) {
            for (const Layer* l : po->layers()) layer_zs.insert(llround(l->print_z * 1e4));
            for (const SupportLayer* l : po->support_layers()) layer_zs.insert(llround(l->print_z * 1e4));
        }
        out.layer_count = unsigned(layer_zs.size());

        out.gcode_path = written;

        if (!options.package_path.empty()) {
            report(cb, 96, "Packaging");
            ThumbnailData plate_thumbnail = make_thumbnail(PACKAGE_THUMBNAIL, PACKAGE_THUMBNAIL);

            // What OrcaSlicer's "send to printer" records for one plate
            // (PartPlateList::store_to_3mf_structure + Plater::export_3mf).
            auto plate = std::make_unique<PlateData>();
            plate->plate_index = 0;
            for (size_t oi = 0; oi < model.objects.size(); ++oi)
                for (size_t ii = 0; ii < model.objects[oi]->instances.size(); ++ii)
                    plate->objects_and_instances.emplace_back(int(oi), int(ii));
            plate->printer_model_id = options.printer_model_id;
            if (const ConfigOption* nd = config.option("nozzle_diameter")) plate->nozzle_diameters = nd->serialize();
            plate->gcode_file = written;
            plate->is_sliced_valid = true;
            plate->gcode_prediction = std::to_string(int(std::lround(out.print_time_sec)));
            char weight[32];
            std::snprintf(weight, sizeof weight, "%.2f", out.filament_used_g);
            plate->gcode_weight = weight;
            plate->is_support_used = print.is_support_used();
            // Which nozzle each filament printed from (1-based), as libslic3r
            // chose it on printers with several: dual-nozzle printers read
            // it from slice_info.
            plate->filament_maps = print.get_filament_maps();
            plate->parse_filament_info(&gcode_result);
            const auto* filament_ids = config.option<ConfigOptionStrings>("filament_ids");
            for (FilamentInfo& f : plate->slice_filaments_info) {
                std::string displayed;
                f.type = config.get_filament_type(displayed, f.id);
                f.filament_id = filament_ids && size_t(f.id) < filament_ids->values.size() ? filament_ids->get_at(f.id) : "";
                f.color = size_t(f.id) < colors.size() ? colors[f.id] : "#FFFFFF";
            }

            StoreParams params;
            params.path = options.package_path.c_str();
            params.model = &model;
            params.plate_data_list = {plate.get()};
            params.export_plate_idx = 0;
            params.config = &config;
            params.thumbnail_data = {&plate_thumbnail};
            params.strategy = SaveStrategy::Silence | SaveStrategy::SkipModel | SaveStrategy::WithGcode |
                              SaveStrategy::SkipAuxiliary | SaveStrategy::Zip64;
            // The exporter gives the model a scratch "backup" directory, which
            // ~Model would hand to libslic3r's backup manager thread: a hang
            // in the single-threaded WebAssembly build, a stray thread and
            // temp dir on the server. Remove it here, synchronously.
            struct DropBackup {
                Model& m;
                ~DropBackup()
                {
                    const std::filesystem::path dir = m.get_backup_path();
                    m.remove_backup_path_if_exist();
                    // Its parents (orcaslicer_model/<day>/) too, once empty;
                    // removing a non-empty directory just fails.
                    std::error_code ec;
                    std::filesystem::remove(dir.parent_path(), ec);
                    std::filesystem::remove(dir.parent_path().parent_path(), ec);
                }
            } drop_backup{model};
            if (!store_bbs_3mf(params) || !std::filesystem::exists(options.package_path))
                throw std::runtime_error("could not write the sliced project " + options.package_path);
            out.package_path = options.package_path;
        }

        for (const std::string& w : overlay_warnings) out.warnings.push_back(w);
        out.ok = true;
        report(cb, 100, "Done");
    } catch (const CanceledException&) {
        out.cancelled = true;
        out.error = "cancelled";
        std::error_code ec;
        std::filesystem::remove(output_path, ec);
    } catch (const std::exception& e) {
        out.error = e.what();
    } catch (...) {
        out.error = "unknown error inside libslic3r";
    }

    return out;
}

} // namespace farmslicer::core
