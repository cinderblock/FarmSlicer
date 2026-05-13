use std::path::PathBuf;

fn main() {
    let orca_dir = PathBuf::from("extern/OrcaSlicer");
    let deps_prefix = orca_dir.join("deps/build/OrcaSlicer_dep/usr/local");
    let orca_build = orca_dir.join("build");

    let is_windows = cfg!(target_os = "windows");

    // Build the cxx bridge + nanosvg implementation
    let mut build = cxx_build::bridge("src/slicer.rs");
    build
        .file("cxx/slicer_bridge.cpp")
        .file("cxx/nanosvg_impl.cpp")
        .std("c++17")
        .include(".")
        .include(orca_dir.join("src"))
        .include(orca_dir.join("src/libslic3r"))
        .include(orca_build.join("src/libslic3r")) // generated headers (libslic3r_version.h)
        .include(orca_dir.join("deps_src"))
        .include(orca_dir.join("deps_src/clipper"))
        .include(orca_dir.join("deps_src/clipper2"))
        .include(orca_dir.join("deps_src/nanosvg"))
        .include(deps_prefix.join("include"))
        .include(deps_prefix.join("include/eigen3"))
        .define("NDEBUG", None)
        .define("_USE_MATH_DEFINES", None)
        .define("USE_TBB", None)
        .define("TBB_USE_CAPTURED_EXCEPTION", "0")
        .define("BOOST_ALL_NO_LIB", None)
        .define("BOOST_SYSTEM_USE_UTF8", None);

    if is_windows {
        build
            .include(deps_prefix.join("include/boost-1_84"))
            .include(deps_prefix.join("include/occt"))
            .define("_WIN32", None)
            .define("NOMINMAX", None)
            .define("BOOST_USE_WINAPI_VERSION", "0x602")
            .flag_if_supported("/bigobj")
            .flag_if_supported("/utf-8")
            .flag_if_supported("/EHsc")
            .flag_if_supported("/wd4244")
            .flag_if_supported("/wd4267");
    } else {
        build
            .include(deps_prefix.join("include/opencascade"))
            .flag("-Wno-unused-parameter")
            .flag("-Wno-sign-compare");
    }

    build.compile("farmslicer_bridge");

    // --- Link search paths ---

    // Deps prefix (boost, tbb, zlib, openssl, curl, etc.)
    link_search(&deps_prefix.join("lib"));

    if is_windows {
        link_search(&deps_prefix.join("lib/occt"));
    }

    // libslic3r
    if is_windows {
        link_search(&orca_build.join("src/libslic3r/Release"));
    } else {
        link_search(&orca_build.join("src/libslic3r"));
    }

    // Bundled deps_src built alongside libslic3r
    for sub in &[
        "admesh", "clipper", "clipper2", "glu-libtess", "mcut",
        "miniz", "qhull", "qoi", "libnest2d",
    ] {
        if is_windows {
            link_search(&orca_build.join(format!("deps_src/{sub}/Release")));
        } else {
            link_search(&orca_build.join(format!("deps_src/{sub}")));
        }
    }

    // semver
    if is_windows {
        link_search(&orca_build.join("lib/Release"));
    } else {
        link_search(&orca_build.join("lib"));
    }

    // OpenCV
    if is_windows {
        link_search(&deps_prefix.join("x64/vc17/staticlib"));
    } else {
        link_search(&deps_prefix.join("lib/opencv4/3rdparty"));
    }

    // --- Static libraries ---

    if is_windows {
        // On Windows, MSVC handles link order automatically
        link_windows_libs();
    } else {
        // On Linux with lld, static archives have circular dependencies
        // (libslic3r→TBB→tbbmalloc, OCCT→TBB, etc.) that require grouping.
        // We emit ALL C++ static libs via rustc-link-arg inside --start-group
        // so lld iterates until all symbols resolve.
        link_linux_libs();
    }

    println!("cargo:rerun-if-changed=cxx/slicer_bridge.h");
    println!("cargo:rerun-if-changed=cxx/slicer_bridge.cpp");
    println!("cargo:rerun-if-changed=src/slicer.rs");
}

fn link_windows_libs() {
    // libslic3r core
    println!("cargo:rustc-link-lib=static=libslic3r");
    println!("cargo:rustc-link-lib=static=libslic3r_cgal");

    // Bundled deps_src
    for lib in &[
        "admesh", "clipper", "Clipper2", "glu-libtess", "mcut",
        "qoi", "semver", "libnest2d", "miniz_static", "qhullstatic",
    ] {
        println!("cargo:rustc-link-lib=static={lib}");
    }

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
    for lib in &[
        "expat", "draco", "libnoise_static", "nlopt",
        "libgmp-10", "libmpfr-4", "libopenvdb", "libblosc", "Half-2_5",
    ] {
        println!("cargo:rustc-link-lib=static={lib}");
    }

    // Boost (MSVC name-mangled)
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

    // OCCT
    for occt_lib in &[
        "TKernel", "TKMath", "TKG2d", "TKG3d", "TKGeomBase", "TKGeomAlgo",
        "TKBRep", "TKTopAlgo", "TKShHealing", "TKMesh", "TKPrim", "TKBO",
        "TKBool", "TKCAF", "TKCDF", "TKLCAF", "TKService", "TKSTEP", "TKSTEP209",
        "TKSTEPAttr", "TKSTEPBase", "TKXSBase", "TKXCAF", "TKXDESTEP",
        "TKSTL", "TKV3d", "TKVCAF", "TKHLR",
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
}

fn link_linux_libs() {
    let orca_dir = std::fs::canonicalize("extern/OrcaSlicer").expect("OrcaSlicer dir not found");
    let deps_lib = orca_dir.join("deps/build/OrcaSlicer_dep/usr/local/lib");
    let build_dir = orca_dir.join("build");

    // All C++ static libs go through rustc-link-arg in a --start-group
    // to handle circular dependencies with lld's single-pass archive processing.
    // Use absolute -L paths in the group to ensure lld can find archives.
    println!("cargo:rustc-link-arg=-Wl,-Bstatic");
    println!("cargo:rustc-link-arg=-L{}", deps_lib.display());
    println!("cargo:rustc-link-arg=-L{}", build_dir.join("src/libslic3r").display());
    for sub in &["admesh", "clipper", "clipper2", "glu-libtess", "mcut", "miniz", "qoi", "libnest2d"] {
        println!("cargo:rustc-link-arg=-L{}", build_dir.join(format!("deps_src/{sub}")).display());
    }
    println!("cargo:rustc-link-arg=-L{}", build_dir.join("lib").display());
    println!("cargo:rustc-link-arg=-L{}", deps_lib.join("opencv4/3rdparty").display());
    println!("cargo:rustc-link-arg=-Wl,--start-group");

    // The cxx bridge (libfarmslicer_bridge.a) must also be in the group because
    // libslic3r references nsvg symbols defined in it (circular dep).
    println!("cargo:rustc-link-arg=-lfarmslicer_bridge");

    // libslic3r core (cmake target "libslic3r" → file "liblibslic3r.a")
    for lib in &["libslic3r", "libslic3r_cgal"] {
        println!("cargo:rustc-link-arg=-l{lib}");
    }

    // Bundled deps_src
    for lib in &[
        "admesh", "clipper", "Clipper2", "glu-libtess", "mcut",
        "qoi", "semver", "libnest2d", "miniz_static",
        "qhullstatic_r", "qhullcpp",
    ] {
        println!("cargo:rustc-link-arg=-l{lib}");
    }

    // TBB — pass absolute paths; -l search fails with lld for unknown reasons
    println!("cargo:rustc-link-arg={}", deps_lib.join("libtbb.a").display());
    println!("cargo:rustc-link-arg={}", deps_lib.join("libtbbmalloc.a").display());

    // Compression / image
    println!("cargo:rustc-link-arg=-lpng16");
    println!("cargo:rustc-link-arg=-ljpeg");
    println!("cargo:rustc-link-arg=-lz");

    // Crypto / network
    for lib in &["crypto", "ssl", "curl"] {
        println!("cargo:rustc-link-arg=-l{lib}");
    }

    // Other deps
    for lib in &[
        "expat", "draco", "libnoise_static", "nlopt", "gmp", "mpfr",
        "openvdb", "blosc", "Half-2_5", "Iex-2_5", "IlmThread-2_5",
        "Imath-2_5", "freetype", "fontconfig",
    ] {
        println!("cargo:rustc-link-arg=-l{lib}");
    }

    // Boost
    for boost_lib in &[
        "boost_filesystem", "boost_iostreams", "boost_locale",
        "boost_log", "boost_log_setup", "boost_thread",
        "boost_date_time", "boost_chrono", "boost_nowide",
    ] {
        println!("cargo:rustc-link-arg=-l{boost_lib}");
    }

    // OCCT
    for occt_lib in &[
        "TKernel", "TKMath", "TKG2d", "TKG3d", "TKGeomBase", "TKGeomAlgo",
        "TKBRep", "TKTopAlgo", "TKShHealing", "TKMesh", "TKPrim", "TKBO",
        "TKBool", "TKCAF", "TKCDF", "TKLCAF", "TKService", "TKSTEP", "TKSTEP209",
        "TKSTEPAttr", "TKSTEPBase", "TKXSBase", "TKXCAF", "TKXDESTEP",
        "TKSTL", "TKV3d", "TKVCAF", "TKHLR",
    ] {
        println!("cargo:rustc-link-arg=-l{occt_lib}");
    }

    // OpenCV
    println!("cargo:rustc-link-arg=-lopencv_world");

    println!("cargo:rustc-link-arg=-Wl,--end-group");
    println!("cargo:rustc-link-arg=-Wl,-Bdynamic");

    // System / dynamic libraries (outside the group)
    for sys_lib in &["pthread", "dl", "m", "rt", "stdc++"] {
        println!("cargo:rustc-link-lib={sys_lib}");
    }
}

fn link_search(dir: &PathBuf) {
    if dir.exists() {
        println!("cargo:rustc-link-search=native={}", dir.display());
    }
}
