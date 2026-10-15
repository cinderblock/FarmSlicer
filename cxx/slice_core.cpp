// FarmSlicer slicing pipeline on top of libslic3r.
//
// Mirrors what OrcaSlicer's CLI does for a single plate: load the model, build
// a DynamicPrintConfig from the merged profile JSON, place the objects on the
// bed, Print::apply → validate → process → export_gcode, then collect the
// statistics the G-code processor computed. Used unchanged by the native
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
#include <libslic3r/Config.hpp>
#include <libslic3r/Exception.hpp>
#include <libslic3r/GCode/GCodeProcessor.hpp>
#include <libslic3r/GCode/ThumbnailData.hpp>
#include <libslic3r/Format/bbs_3mf.hpp>
#include <libslic3r/ProjectTask.hpp>

#include <atomic>
#include <cmath>
#include <cstdio>
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

    // Multi-extruder bookkeeping the desktop app does before slicing.
    const int filament_count = int(std::max<size_t>(1, vector_size(config, "filament_diameter")));
    const int extruder_count = int(std::max<size_t>(1, vector_size(config, "nozzle_diameter")));
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

// Put the model where the user placed it: rotate it as a whole (keeping
// relative placement for multi-object files), centre its bounding box on
// the bed centre plus the placement's offset (just the bed centre without
// one, like the desktop plater on import) and drop it onto Z=0. Then refuse
// a model that doesn't fit: libslic3r would slice it, and the G-code would
// drive the head beyond the bed.
void place_on_bed(Slic3r::Model& model, const Slic3r::DynamicPrintConfig& config, const Placement& placement)
{
    using namespace Slic3r;
    for (ModelObject* obj : model.objects)
        if (obj->instances.empty()) obj->add_instance();

    if (placement.set) {
        Transform3d rotation = Transform3d::Identity();
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) rotation.linear()(r, c) = placement.rotation[r * 3 + c];
        for (ModelObject* obj : model.objects) {
            for (ModelInstance* inst : obj->instances)
                inst->set_transformation(Geometry::Transformation(rotation * inst->get_matrix()));
            obj->invalidate_bounding_box();
        }
    }

    std::vector<Vec2d> bed_shape;
    if (const auto* area = config.option<ConfigOptionPoints>("printable_area")) bed_shape = area->values;
    Vec2d bed_center(0.0, 0.0);
    {
        BoundingBoxf bed;
        for (const Vec2d& p : bed_shape) bed.merge(p);
        if (bed.defined) bed_center = bed.center();
    }
    const Vec2d target = bed_center + (placement.set ? Vec2d(placement.offset[0], placement.offset[1]) : Vec2d::Zero());

    const BoundingBoxf3 bbox = model.bounding_box_exact();
    const Vec3d shift(target.x() - bbox.center().x(), target.y() - bbox.center().y(), 0.0);
    for (ModelObject* obj : model.objects) {
        for (ModelInstance* inst : obj->instances)
            inst->set_offset(inst->get_offset() + shift);
        obj->ensure_on_bed();
    }

    if (bed_shape.size() < 3) return;
    const auto* height = config.option<ConfigOptionFloat>("printable_height");
    const BuildVolume volume(bed_shape, height ? height->value : 0.0, {}, {});
    model.update_print_volume_state(volume);
    for (const ModelObject* obj : model.objects)
        for (const ModelInstance* inst : obj->instances) {
            if (inst->print_volume_state == ModelInstancePVS_Inside) continue;
            const std::string what = model.objects.size() > 1 ? "\"" + obj->name + "\"" : std::string("the model");
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

Outcome slice_file(const std::string& model_path,
                   const std::string& config_json,
                   const std::string& output_path,
                   const Callbacks& cb,
                   const Options& options)
{
    using namespace Slic3r;
    Outcome out;

    try {
        report(cb, 0, "Loading model");
        Model model = Model::read_from_file(model_path);
        if (model.objects.empty())
            throw std::runtime_error("model file contains no objects");
        if (!options.model_name.empty() && model.objects.size() == 1)
            model.objects.front()->name = options.model_name;

        report(cb, 2, "Loading configuration");
        DynamicPrintConfig config;
        load_config(config, config_json, out.warnings);

        const int filament_count = int(std::max<size_t>(1, vector_size(config, "filament_diameter")));
        place_on_bed(model, config, options.placement);

        Print print;
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
