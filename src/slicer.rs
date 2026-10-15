//! cxx bridge to libslic3r (see cxx/slicer_bridge.cpp).
//!
//! The C++ side reports progress and polls for cancellation through the two
//! `extern "Rust"` functions below; they forward to [`crate::progress`].
//!
//! Built with `FARMSLICER_SKIP_CXX` (cfg `farmslicer_no_cxx`), a pure-Rust
//! stub with the same interface takes the bridge's place: the server runs
//! without libslic3r, browser slicing works, server slices fail.

#[cfg(not(farmslicer_no_cxx))]
#[cxx::bridge(namespace = "farmslicer")]
mod ffi {
    /// What to produce besides the G-code.
    #[derive(Default)]
    struct SliceOptions {
        /// Write a Bambu-style `.gcode.3mf` here ("" = don't).
        package_path: String,
        /// Vendor model id for the package's slice_info ("BL-P001", ...).
        printer_model_id: String,
        /// Thumbnail overlay: a label (bottom right) and a logo (top left,
        /// RGBA rows top-down, straight alpha; empty = none).
        label: String,
        logo_rgba: Vec<u8>,
        logo_width: u32,
        logo_height: u32,
        /// TrueType font for the label.
        font_path: String,
        /// Name for a single-object model (instead of the stored file's).
        model_name: String,
        /// Where the user put the model (`crate::placement::Placement`): a
        /// row-major 3x3 rotation and the XY offset of its bounding-box
        /// centre from the bed centre. Empty = centred, as loaded.
        placement_rotation: Vec<f64>,
        placement_offset: Vec<f64>,
    }

    /// Outcome of one `Slicer::slice` call.
    struct SliceResult {
        success: bool,
        /// True when the job was cancelled via `progress::request_cancel`.
        cancelled: bool,
        gcode_path: String,
        /// The package, when one was asked for and written.
        package_path: String,
        error: String,
        /// Non-fatal messages from libslic3r (config substitutions, validation
        /// warnings, print conflicts).
        warnings: Vec<String>,
        print_time_sec: f64,
        filament_used_g: f64,
        filament_used_mm: f64,
        layer_count: u32,
    }

    extern "Rust" {
        fn slice_progress(job_id: &str, percent: i32, message: &str);
        fn slice_cancelled(job_id: &str) -> bool;
    }

    unsafe extern "C++" {
        include!("farmslicer/cxx/slicer_bridge.h");

        type Slicer;

        /// `resources_dir` is OrcaSlicer's `resources/` directory (profiles,
        /// nozzle info tables, flush matrices).
        fn new_slicer(resources_dir: &str) -> UniquePtr<Slicer>;

        /// Slice `model_path` (STL/3MF/OBJ/STEP) with the merged OrcaSlicer
        /// config `config_json` (a JSON object of profile keys) and write
        /// G-code to `output_path`, plus what `options` asks for.
        fn slice(
            &self,
            job_id: &str,
            model_path: &str,
            config_json: &str,
            output_path: &str,
            options: &SliceOptions,
        ) -> SliceResult;
    }
}

#[cfg(not(farmslicer_no_cxx))]
pub use ffi::*;

/// Owning handle to the engine.
#[cfg(not(farmslicer_no_cxx))]
pub type SlicerBox = cxx::UniquePtr<Slicer>;

#[cfg(farmslicer_no_cxx)]
pub use stub::*;

#[cfg(farmslicer_no_cxx)]
mod stub {
    #[derive(Default)]
    pub struct SliceOptions {
        pub package_path: String,
        pub printer_model_id: String,
        pub label: String,
        pub logo_rgba: Vec<u8>,
        pub logo_width: u32,
        pub logo_height: u32,
        pub font_path: String,
        pub model_name: String,
        pub placement_rotation: Vec<f64>,
        pub placement_offset: Vec<f64>,
    }

    pub struct SliceResult {
        pub success: bool,
        pub cancelled: bool,
        pub gcode_path: String,
        pub package_path: String,
        pub error: String,
        pub warnings: Vec<String>,
        pub print_time_sec: f64,
        pub filament_used_g: f64,
        #[allow(dead_code)]
        pub filament_used_mm: f64,
        pub layer_count: u32,
    }

    pub struct Slicer;

    pub type SlicerBox = Box<Slicer>;

    pub fn new_slicer(_resources_dir: &str) -> SlicerBox {
        println!("Server slicing unavailable: built with FARMSLICER_SKIP_CXX (no libslic3r)");
        Box::new(Slicer)
    }

    impl Slicer {
        pub fn slice(
            &self,
            _job_id: &str,
            _model_path: &str,
            _config_json: &str,
            _output_path: &str,
            _options: &SliceOptions,
        ) -> SliceResult {
            SliceResult {
                success: false,
                cancelled: false,
                gcode_path: String::new(),
                package_path: String::new(),
                error: "this server was built without libslic3r (FARMSLICER_SKIP_CXX); slice in the browser".into(),
                warnings: Vec::new(),
                print_time_sec: 0.0,
                filament_used_g: 0.0,
                filament_used_mm: 0.0,
                layer_count: 0,
            }
        }
    }
}

#[cfg(not(farmslicer_no_cxx))]
fn slice_progress(job_id: &str, percent: i32, message: &str) {
    crate::progress::report(job_id, percent, message);
}

#[cfg(not(farmslicer_no_cxx))]
fn slice_cancelled(job_id: &str) -> bool {
    crate::progress::is_cancelled(job_id)
}
