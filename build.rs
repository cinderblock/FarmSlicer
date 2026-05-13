use std::path::PathBuf;

fn main() {
    let orca_dir = PathBuf::from("extern/OrcaSlicer");
    let deps_prefix = orca_dir.join("deps/build/OrcaSlicer_dep/usr/local");
    let orca_build = orca_dir.join("build");

    // Build the cxx bridge + nanosvg implementation
    cxx_build::bridge("src/slicer.rs")
        .file("cxx/slicer_bridge.cpp")
        .file("cxx/nanosvg_impl.cpp")
        .std("c++17")
        .include(".")
        .include(orca_dir.join("src"))
        .include(orca_dir.join("src/libslic3r"))
        .include(orca_dir.join("deps_src"))
        .include(orca_dir.join("deps_src/clipper"))
        .include(orca_dir.join("deps_src/clipper2"))
        .include(orca_dir.join("deps_src/nanosvg"))
        .include(deps_prefix.join("include"))
        .include(deps_prefix.join("include/boost-1_84"))
        .include(deps_prefix.join("include/eigen3"))
        .include(deps_prefix.join("include/occt"))
        .define("NDEBUG", None)
        .define("_USE_MATH_DEFINES", None)
        .define("_WIN32", None)
        .define("USE_TBB", None)
        .define("TBB_USE_CAPTURED_EXCEPTION", "0")
        .define("NOMINMAX", None)
        .define("BOOST_ALL_NO_LIB", None)
        .define("BOOST_USE_WINAPI_VERSION", "0x602")
        .define("BOOST_SYSTEM_USE_UTF8", None)
        .flag_if_supported("/bigobj")
        .flag_if_supported("/utf-8")
        .flag_if_supported("/EHsc")
        .flag_if_supported("/wd4244")
        .flag_if_supported("/wd4267")
        .compile("farmslicer_bridge");

    // --- Link search paths ---

    // Deps prefix (boost, tbb, zlib, openssl, curl, etc.)
    link_search(&deps_prefix.join("lib"));
    link_search(&deps_prefix.join("lib/occt"));

    // libslic3r
    link_search(&orca_build.join("src/libslic3r/Release"));

    // Bundled deps_src built alongside libslic3r
    for sub in &[
        "admesh", "clipper", "clipper2", "glu-libtess", "mcut",
        "miniz", "qhull", "qoi", "libnest2d",
    ] {
        link_search(&orca_build.join(format!("deps_src/{sub}/Release")));
    }

    // semver is in a different location
    link_search(&orca_build.join("lib/Release"));

    // OpenCV
    link_search(&deps_prefix.join("x64/vc17/staticlib"));

    // --- Static libraries ---

    // libslic3r core
    println!("cargo:rustc-link-lib=static=libslic3r");
    println!("cargo:rustc-link-lib=static=libslic3r_cgal");

    // Bundled deps_src (exact names as built)
    println!("cargo:rustc-link-lib=static=admesh");
    println!("cargo:rustc-link-lib=static=clipper");
    println!("cargo:rustc-link-lib=static=Clipper2");
    println!("cargo:rustc-link-lib=static=glu-libtess");
    println!("cargo:rustc-link-lib=static=mcut");
    println!("cargo:rustc-link-lib=static=miniz_static");
    println!("cargo:rustc-link-lib=static=qhullstatic");
    println!("cargo:rustc-link-lib=static=qoi");
    println!("cargo:rustc-link-lib=static=semver");
    println!("cargo:rustc-link-lib=static=libnest2d");

    // TBB
    println!("cargo:rustc-link-lib=static=tbb12");
    println!("cargo:rustc-link-lib=static=tbbmalloc");

    // Compression / image
    println!("cargo:rustc-link-lib=static=zlib");
    println!("cargo:rustc-link-lib=static=libpng16_static");
    println!("cargo:rustc-link-lib=static=jpeg-static");

    // Crypto / network
    println!("cargo:rustc-link-lib=static=libcrypto");
    println!("cargo:rustc-link-lib=static=libssl");
    println!("cargo:rustc-link-lib=static=libcurl");

    // Other deps
    println!("cargo:rustc-link-lib=static=expat");
    println!("cargo:rustc-link-lib=static=draco");
    println!("cargo:rustc-link-lib=static=libnoise_static");
    println!("cargo:rustc-link-lib=static=nlopt");
    println!("cargo:rustc-link-lib=static=libgmp-10");
    println!("cargo:rustc-link-lib=static=libmpfr-4");
    println!("cargo:rustc-link-lib=static=libopenvdb");
    println!("cargo:rustc-link-lib=static=libblosc");
    println!("cargo:rustc-link-lib=static=Half-2_5");

    // Boost (static, MSVC name-mangled)
    for boost_lib in &[
        "libboost_filesystem-vc144-mt-x64-1_84",
        "libboost_iostreams-vc144-mt-x64-1_84",
        "libboost_locale-vc144-mt-x64-1_84",
        "libboost_log-vc144-mt-x64-1_84",
        "libboost_log_setup-vc144-mt-x64-1_84",
        "libboost_thread-vc144-mt-x64-1_84",
        "libboost_date_time-vc144-mt-x64-1_84",
        "libboost_chrono-vc144-mt-x64-1_84",
        "libboost_nowide-vc144-mt-x64-1_84",
    ] {
        println!("cargo:rustc-link-lib=static={boost_lib}");
    }

    // OCCT (OpenCASCADE)
    for occt_lib in &[
        "TKernel", "TKMath", "TKG2d", "TKG3d", "TKGeomBase", "TKGeomAlgo",
        "TKBRep", "TKTopAlgo", "TKShHealing", "TKMesh", "TKPrim", "TKBO",
        "TKCAF", "TKCDF", "TKLCAF", "TKService", "TKSTEP", "TKSTEP209",
        "TKSTEPAttr", "TKSTEPBase", "TKXSBase", "TKXCAF", "TKXDESTEP",
        "TKSTL", "TKV3d", "TKVCAF",
    ] {
        println!("cargo:rustc-link-lib=static={occt_lib}");
    }

    // OpenCV
    println!("cargo:rustc-link-lib=static=opencv_world460");

    // Windows system libraries
    for sys_lib in &[
        "Psapi", "bcrypt", "Advapi32", "User32", "Crypt32", "Ws2_32",
        "Wldap32", "Normaliz", "Shell32", "Ole32", "OleAut32", "Gdi32",
        "Comdlg32", "Winmm",
    ] {
        println!("cargo:rustc-link-lib={sys_lib}");
    }

    println!("cargo:rerun-if-changed=cxx/slicer_bridge.h");
    println!("cargo:rerun-if-changed=cxx/slicer_bridge.cpp");
    println!("cargo:rerun-if-changed=src/slicer.rs");
}

fn link_search(dir: &PathBuf) {
    if dir.exists() {
        println!("cargo:rustc-link-search=native={}", dir.display());
    }
}
