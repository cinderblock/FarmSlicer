#[cxx::bridge(namespace = "farmslicer")]
mod ffi {
    struct SliceResult {
        success: bool,
        gcode_path: String,
        error: String,
        print_time_sec: f64,
        filament_used_g: f64,
    }

    unsafe extern "C++" {
        include!("farmslicer/cxx/slicer_bridge.h");

        type Slicer;

        fn new_slicer() -> UniquePtr<Slicer>;
        fn slice(&self, model_path: &str, config_json: &str, output_path: &str) -> SliceResult;
    }
}

pub use ffi::*;
