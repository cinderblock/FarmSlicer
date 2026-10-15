// FarmSlicer WebAssembly engine: a small C ABI around the shared slicing
// pipeline (cxx/slice_core.cpp), driven from web/src/engine/worker.ts.
//
//   fs_version()      → JSON {engine, orca, threads, placement}
//   fs_slice(...)     → slice synchronously (single-threaded build, or the
//                       pthreads build when the caller wants to block)
//   fs_slice_start()  → pthreads build only: slice on a dedicated pthread,
//                       completion signalled through `state` (see below)
//   fs_set_options()  → how the next slice runs besides the config: where the
//                       model goes on the bed, a Bambu sliced project
//                       (.gcode.3mf), the thumbnail overlay
//   fs_cancel()       → abort the running slice at its next checkpoint
//   fs_free(p)        → free a buffer returned through an out-parameter
//
// Progress: Module.fsProgress(percent, message) if the host installed it.
// The report out-parameter is JSON: {ok, cancelled, error, warnings[],
// stats{printTimeSec, filamentG, filamentMm, layers}, package}; `package` is
// the MEMFS path of the sliced project (the host reads and unlinks it) or
// null.

#include "slice_core.hpp"

#include <nlohmann/json.hpp>

#include <emscripten.h>
#ifdef __EMSCRIPTEN_PTHREADS__
#include <emscripten/eventloop.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <pthread.h>
#include <climits>
#include <tbb/global_control.h>
#include <tbb/task_arena.h>
#endif

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace {

std::atomic<bool> g_cancel{false};

/// Options for the next slice (fs_set_options); consumed by it.
farmslicer::core::Options g_next_options;
std::mutex g_options_mutex;
const char* const PACKAGE_PATH = "/tmp/out.gcode.3mf";

void ensure_runtime()
{
    static std::once_flag once;
    std::call_once(once, [] {
        ::mkdir("/tmp", 0777);
        ::mkdir("/data", 0777);
        // resources/info + resources/flush are preloaded into MEMFS.
        farmslicer::core::init_runtime("/resources", "/tmp");
    });
}

// ---- progress ----------------------------------------------------------------

EM_JS(void, fs_js_progress, (int percent, const char* msg), {
    try {
        if (typeof Module["fsProgress"] === "function")
            Module["fsProgress"](percent, msg ? UTF8ToString(msg) : "");
    } catch (e) {}
});

#ifdef __EMSCRIPTEN_PTHREADS__
// Module.fsProgress only exists on the main runtime thread (a pthread worker
// has its own, empty Module). Progress from any other thread is queued to the
// main runtime thread, fire-and-forget.
struct ProgressMsg { int percent; char text[1]; };
void progress_on_main(void* p)
{
    auto* m = static_cast<ProgressMsg*>(p);
    fs_js_progress(m->percent, m->text);
    std::free(m);
}
#endif

void progress(int percent, const std::string& msg)
{
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
#ifdef __EMSCRIPTEN_PTHREADS__
    if (!emscripten_is_main_runtime_thread()) {
        auto* m = static_cast<ProgressMsg*>(std::malloc(sizeof(ProgressMsg) + msg.size()));
        if (!m) return;
        m->percent = percent;
        std::memcpy(m->text, msg.c_str(), msg.size() + 1);
        if (!emscripten_proxy_async(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(),
                                    progress_on_main, m))
            std::free(m);
        return;
    }
#endif
    fs_js_progress(percent, msg.c_str());
}

// ---- report JSON -------------------------------------------------------------

std::string json_escape(const std::string& s)
{
    std::string out;
    out.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (c < 0x20) {
                char buf[8];
                std::snprintf(buf, sizeof buf, "\\u%04x", c);
                out += buf;
            } else {
                out += char(c);
            }
        }
    }
    return out;
}

std::string build_report(const farmslicer::core::Outcome& o)
{
    std::string r = "{";
    r += std::string("\"ok\":") + (o.ok ? "true" : "false");
    r += std::string(",\"cancelled\":") + (o.cancelled ? "true" : "false");
    r += ",\"error\":" + (o.error.empty() ? std::string("null") : "\"" + json_escape(o.error) + "\"");
    r += ",\"warnings\":[";
    for (size_t i = 0; i < o.warnings.size(); ++i) {
        if (i) r += ",";
        r += "\"" + json_escape(o.warnings[i]) + "\"";
    }
    r += "]";
    char stats[256];
    std::snprintf(stats, sizeof stats,
                  ",\"stats\":{\"printTimeSec\":%.3f,\"filamentG\":%.4f,\"filamentMm\":%.3f,\"layers\":%u}",
                  o.print_time_sec, o.filament_used_g, o.filament_used_mm, o.layer_count);
    r += stats;
    r += ",\"package\":" + (o.package_path.empty() ? std::string("null") : "\"" + json_escape(o.package_path) + "\"");
    r += "}";
    return r;
}

char* dup_cstr(const std::string& s)
{
    char* p = static_cast<char*>(std::malloc(s.size() + 1));
    if (p) std::memcpy(p, s.c_str(), s.size() + 1);
    return p;
}

std::string model_extension(const char* model_name)
{
    std::string name = model_name ? model_name : "";
    const size_t dot = name.find_last_of('.');
    std::string ext = dot == std::string::npos ? "stl" : name.substr(dot + 1);
    for (char& c : ext) c = char(std::tolower(static_cast<unsigned char>(c)));
    if (ext.empty() || ext.size() > 8) ext = "stl";
    return ext;
}

// Returns 0 on success, 1 on error, 2 when cancelled.
int do_slice(const char* model_name, const uint8_t* model, int model_len,
             const char* config_json, int config_len,
             uint8_t** out_gcode, int* out_gcode_len, char** out_report)
{
    ensure_runtime();
    g_cancel.store(false);
    if (out_gcode) *out_gcode = nullptr;
    if (out_gcode_len) *out_gcode_len = 0;
    if (out_report) *out_report = nullptr;

    farmslicer::core::Outcome outcome;

    const std::string model_path = "/tmp/model." + model_extension(model_name);
    const std::string gcode_path = "/tmp/out.gcode";
    ::unlink(model_path.c_str());
    ::unlink(gcode_path.c_str());

    if (FILE* f = std::fopen(model_path.c_str(), "wb")) {
        const size_t wrote = model_len > 0 ? std::fwrite(model, 1, size_t(model_len), f) : 0;
        std::fclose(f);
        if (wrote != size_t(model_len)) outcome.error = "could not stage the model in memory";
    } else {
        outcome.error = "could not stage the model in memory";
    }

    farmslicer::core::Options options;
    {
        std::lock_guard<std::mutex> lock(g_options_mutex);
        options = std::move(g_next_options);
        g_next_options = {};
    }
    ::unlink(PACKAGE_PATH);

    if (outcome.error.empty()) {
        farmslicer::core::Callbacks cb;
        cb.progress = [](int percent, const std::string& message) { progress(percent, message); };
        cb.cancelled = []() { return g_cancel.load(); };
        outcome = farmslicer::core::slice_file(
            model_path, std::string(config_json ? config_json : "", config_len > 0 ? size_t(config_len) : 0),
            gcode_path, cb, options);
    }
    ::unlink(model_path.c_str());

    if (outcome.ok) {
        // Read the G-code straight into the output buffer, then drop the
        // MEMFS file so peak memory stays ~2x the G-code size.
        FILE* f = std::fopen(outcome.gcode_path.c_str(), "rb");
        if (!f) {
            outcome.ok = false;
            outcome.error = "G-code export produced no file";
        } else {
            std::fseek(f, 0, SEEK_END);
            const long sz = std::ftell(f);
            std::fseek(f, 0, SEEK_SET);
            uint8_t* buf = sz > 0 ? static_cast<uint8_t*>(std::malloc(size_t(sz))) : nullptr;
            const size_t got = buf ? std::fread(buf, 1, size_t(sz), f) : 0;
            std::fclose(f);
            if (!buf || got != size_t(sz)) {
                std::free(buf);
                outcome.ok = false;
                outcome.error = "could not read the exported G-code";
            } else if (out_gcode) {
                *out_gcode = buf;
                *out_gcode_len = int(sz);
            } else {
                std::free(buf);
            }
        }
        ::unlink(outcome.gcode_path.c_str());
    }

    if (out_report) *out_report = dup_cstr(build_report(outcome));
    return outcome.ok ? 0 : (outcome.cancelled ? 2 : 1);
}

#ifdef __EMSCRIPTEN_PTHREADS__
EM_JS(int, fs_js_thread_count, (), { return fsThreadCount(); });

int engine_threads()
{
    static int n = 0;
    if (n == 0) {
        // With pthreads, Emscripten's keepRuntimeAlive() is a counter even with
        // EXIT_RUNTIME=0: once a proxied call / mailbox callback finishes on the
        // main runtime thread with the counter at 0, the runtime "exits" and
        // terminates every pthread — the slice silently hangs. The engine lives
        // as long as its host keeps the instance; hold one keepalive forever.
        emscripten_runtime_keepalive_push();
        n = fs_js_thread_count();
        if (n < 2) n = 2;
        // The slicing pthread + (n-1) TBB workers, all from the pre-created pool.
        static tbb::global_control* control =
            new tbb::global_control(tbb::global_control::max_allowed_parallelism, size_t(n));
        (void)control;
    }
    return n;
}

struct StartArgs {
    std::string model_name;
    const uint8_t* model;
    int model_len;
    std::string config_json;
    uint8_t** out_gcode;
    int* out_gcode_len;
    char** out_report;
    int32_t* state;
};

void* slice_thread_main(void* p)
{
    auto* a = static_cast<StartArgs*>(p);
    const int rc = do_slice(a->model_name.c_str(), a->model, a->model_len,
                            a->config_json.data(), int(a->config_json.size()),
                            a->out_gcode, a->out_gcode_len, a->out_report);
    __atomic_store_n(&a->state[1], rc, __ATOMIC_SEQ_CST);
    __atomic_store_n(&a->state[0], 1, __ATOMIC_SEQ_CST);
    emscripten_futex_wake(&a->state[0], INT_MAX);
    delete a;
    return nullptr;
}
#endif

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* fs_version()
{
    static const std::string v = std::string("{\"engine\":\"farmslicer\",\"orca\":\"") + FS_ORCA_VERSION +
#ifdef FS_ENGINE_THREADS
        "\",\"threads\":true"
#else
        "\",\"threads\":false"
#endif
        // fs_set_options takes a placement (hosts refuse to slice a placed
        // model with an engine that would ignore it).
        ",\"placement\":true}";
    return v.c_str();
}

EMSCRIPTEN_KEEPALIVE int fs_slice(const char* model_name, const uint8_t* model, int model_len,
                                  const char* config_json, int config_len,
                                  uint8_t** out_gcode, int* out_gcode_len, char** out_report)
{
#ifdef __EMSCRIPTEN_PTHREADS__
    // Called ON the main runtime thread of the pthreads build: that thread is
    // blocked for the whole call, and a pthread whose creation is requested by
    // another pthread only starts once the main runtime thread returns to its
    // event loop, so TBB work that waits for its workers could deadlock. Run
    // serially; parallel slicing goes through fs_slice_start().
    if (emscripten_is_main_runtime_thread()) {
        engine_threads();
        tbb::task_arena serial(1);
        return serial.execute([&] {
            return do_slice(model_name, model, model_len, config_json, config_len,
                            out_gcode, out_gcode_len, out_report);
        });
    }
#endif
    return do_slice(model_name, model, model_len, config_json, config_len,
                    out_gcode, out_gcode_len, out_report);
}

// Options for the next fs_slice / fs_slice_start, as JSON:
// {package: bool, printer_model_id, model_name, label, logo_width,
// logo_height, placement: {rotation: [9], offset: [2]} | null}, plus the
// logo as RGBA (rows top-down; may be null). Returns 0, or 1 when the JSON
// doesn't parse, the placement is malformed or the logo size doesn't match.
EMSCRIPTEN_KEEPALIVE int fs_set_options(const char* json, int json_len, const uint8_t* logo, int logo_len)
{
    farmslicer::core::Options o;
    try {
        const auto j = nlohmann::json::parse(std::string(json ? json : "", json_len > 0 ? size_t(json_len) : 0));
        if (j.value("package", false)) o.package_path = PACKAGE_PATH;
        o.printer_model_id = j.value("printer_model_id", std::string());
        o.model_name = j.value("model_name", std::string());
        o.overlay.label = j.value("label", std::string());
        o.overlay.logo_width = j.value("logo_width", 0u);
        o.overlay.logo_height = j.value("logo_height", 0u);
        if (const auto p = j.find("placement"); p != j.end() && !p->is_null()) {
            const auto& rotation = p->at("rotation");
            const auto& offset = p->at("offset");
            if (rotation.size() != 9 || offset.size() != 2) return 1;
            for (int i = 0; i < 9; ++i) o.placement.rotation[i] = rotation.at(i).get<double>();
            for (int i = 0; i < 2; ++i) o.placement.offset[i] = offset.at(i).get<double>();
            o.placement.set = true;
        }
    } catch (...) {
        return 1;
    }
    if (logo && logo_len > 0) {
        if (size_t(logo_len) != size_t(o.overlay.logo_width) * o.overlay.logo_height * 4) return 1;
        o.overlay.logo_rgba.assign(logo, logo + logo_len);
    }
    std::lock_guard<std::mutex> lock(g_options_mutex);
    g_next_options = std::move(o);
    return 0;
}

EMSCRIPTEN_KEEPALIVE void fs_cancel() { g_cancel.store(true); }

EMSCRIPTEN_KEEPALIVE void fs_free(void* p) { std::free(p); }

#ifdef __EMSCRIPTEN_PTHREADS__
// Same arguments as fs_slice plus `state` (2 x int32, 4-byte aligned, in the
// shared heap). Returns 0 once the slicing pthread is running. When it
// finishes, the out-params are written, state[1] holds fs_slice's return code
// and state[0] flips 0 -> 1 with a futex wake, so the host can
// Atomics.waitAsync on it. The model buffer and the out-param slots must stay
// valid until then. One slice at a time.
EMSCRIPTEN_KEEPALIVE int fs_slice_start(const char* model_name, const uint8_t* model, int model_len,
                                        const char* config_json, int config_len,
                                        uint8_t** out_gcode, int* out_gcode_len, char** out_report,
                                        int32_t* state)
{
    ensure_runtime();
    engine_threads();
    state[0] = 0;
    state[1] = -1;
    auto* a = new StartArgs{model_name ? model_name : "", model, model_len,
                            std::string(config_json ? config_json : "", config_len > 0 ? size_t(config_len) : 0),
                            out_gcode, out_gcode_len, out_report, state};
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 64u * 1024u * 1024u);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    pthread_t t;
    const int err = pthread_create(&t, &attr, slice_thread_main, a);
    pthread_attr_destroy(&attr);
    if (err != 0) {
        delete a;
        return err;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE int fs_thread_count(void) { return engine_threads(); }
#endif

} // extern "C"
