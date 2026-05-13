use std::path::PathBuf;

fn main() {
    let orca_dir = PathBuf::from("extern/OrcaSlicer");
    let deps_prefix = orca_dir.join("deps/build/OrcaSlicer_dep/usr/local");

    // Build the cxx bridge
    cxx_build::bridge("src/slicer.rs")
        .file("cxx/slicer_bridge.cpp")
        .std("c++17")
        // Project root (for #include "farmslicer/cxx/slicer_bridge.h")
        .include(".")
        // libslic3r headers
        .include(orca_dir.join("src"))
        .include(orca_dir.join("src/libslic3r"))
        // Dependencies from the OrcaSlicer deps build
        .include(deps_prefix.join("include"))
        // Windows defines
        .define("_USE_MATH_DEFINES", None)
        .define("_WIN32", None)
        .define("USE_TBB", None)
        .define("TBB_USE_CAPTURED_EXCEPTION", "0")
        .define("NOMINMAX", None)
        // MSVC settings
        .flag_if_supported("/bigobj")
        .flag_if_supported("/utf-8")
        .flag_if_supported("/EHsc")
        .compile("farmslicer_bridge");

    // Link against libslic3r and its dependencies
    let lib_dir = deps_prefix.join("lib");
    if lib_dir.exists() {
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
    }

    // Link libslic3r (built by OrcaSlicer's build system)
    let slicer_build_dir = orca_dir.join("build");
    if slicer_build_dir.exists() {
        println!(
            "cargo:rustc-link-search=native={}",
            slicer_build_dir.join("src/libslic3r/Release").display()
        );
        println!(
            "cargo:rustc-link-search=native={}",
            slicer_build_dir.join("src/libslic3r/Debug").display()
        );
    }

    // Windows system libraries
    println!("cargo:rustc-link-lib=Psapi");
    println!("cargo:rustc-link-lib=bcrypt");

    println!("cargo:rerun-if-changed=cxx/slicer_bridge.h");
    println!("cargo:rerun-if-changed=cxx/slicer_bridge.cpp");
    println!("cargo:rerun-if-changed=src/slicer.rs");
}
