# Stub find-module for libcurl, used only by the headless (SLIC3R_GUI=OFF)
# libslic3r build in the Dockerfile.
#
# OrcaSlicer's top-level CMakeLists.txt does `find_package(CURL REQUIRED)`
# unconditionally and wraps it in an INTERFACE target `libcurl`, but only the
# GUI (src/slic3r) and the profile validator link it: nothing in libslic3r,
# libslic3r_cgal or libnest2d includes a curl header. An empty imported target
# satisfies the lookup without building curl (and the OpenSSL it would link);
# with no include directory, any real use fails to compile instead of linking
# something unexpected. Passed via -DCMAKE_MODULE_PATH=<this directory>, which
# OrcaSlicer appends its own modules to, so this file is found first.
set(CURL_FOUND TRUE)
set(CURL_INCLUDE_DIRS "")
set(CURL_LIBRARIES "")
if(NOT TARGET CURL::libcurl)
    add_library(CURL::libcurl INTERFACE IMPORTED)
endif()
