//! cxx bridge to libslic3r (see cxx/slicer_bridge.cpp).
//!
//! The C++ side reports progress and polls for cancellation through the two
//! `extern "Rust"` functions below; they forward to [`crate::progress`].

#[cxx::bridge(namespace = "farmslicer")]
mod ffi {
    /// Outcome of one `Slicer::slice` call.
    struct SliceResult {
        success: bool,
        /// True when the job was cancelled via `progress::request_cancel`.
        cancelled: bool,
        gcode_path: String,
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
        /// G-code to `output_path`.
        fn slice(
            &self,
            job_id: &str,
            model_path: &str,
            config_json: &str,
            output_path: &str,
        ) -> SliceResult;
    }
}

pub use ffi::*;

fn slice_progress(job_id: &str, percent: i32, message: &str) {
    crate::progress::report(job_id, percent, message);
}

fn slice_cancelled(job_id: &str) -> bool {
    crate::progress::is_cancelled(job_id)
}
