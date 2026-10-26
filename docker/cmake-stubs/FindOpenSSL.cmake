# Stub find-module for OpenSSL, used only by the headless (SLIC3R_GUI=OFF)
# libslic3r build in the Dockerfile.
#
# OrcaSlicer's CMake does `find_package(OpenSSL REQUIRED)` and libslic3r links
# OpenSSL::Crypto, but all it uses is the legacy MD5_* API (<openssl/md5.h>,
# file checksums). That comes from the standalone header in cxx/shims, which
# the WebAssembly engine uses too, so the C++ side needs no OpenSSL at all:
# the only OpenSSL in the server binary is the Rust side's (openssl crate,
# vendored, for webauthn-rs and Web Push). OpenSSL::Crypto carries the shim's
# include directory; OpenSSL::SSL is empty (nothing headless uses it), and any
# other OpenSSL header fails to compile instead of linking something unexpected.
# Found first via -DCMAKE_MODULE_PATH=<this directory>; the shim directory is
# FARMSLICER_SHIMS_DIR (default: cxx/shims next to this repo's docker/).
set(FARMSLICER_SHIMS_DIR "${CMAKE_CURRENT_LIST_DIR}/../../cxx/shims" CACHE PATH
    "Directory holding openssl/md5.h for libslic3r")
if(NOT EXISTS "${FARMSLICER_SHIMS_DIR}/openssl/md5.h")
    message(FATAL_ERROR "FindOpenSSL stub: no openssl/md5.h in ${FARMSLICER_SHIMS_DIR}")
endif()
set(OPENSSL_FOUND TRUE)
set(OpenSSL_FOUND TRUE)
set(OPENSSL_INCLUDE_DIR "${FARMSLICER_SHIMS_DIR}")
set(OPENSSL_LIBRARIES "")
set(OPENSSL_CRYPTO_LIBRARY "")
set(OPENSSL_SSL_LIBRARY "")
if(NOT TARGET OpenSSL::Crypto)
    add_library(OpenSSL::Crypto INTERFACE IMPORTED)
    set_target_properties(OpenSSL::Crypto PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES "${FARMSLICER_SHIMS_DIR}")
endif()
if(NOT TARGET OpenSSL::SSL)
    add_library(OpenSSL::SSL INTERFACE IMPORTED)
endif()
# libslic3r_cgal includes Utils.hpp (so <openssl/md5.h>) without linking
# OpenSSL::Crypto: upstream counts on OpenSSL's headers being on the default
# path. Put the shim there too, for the directory that asked (OrcaSlicer's
# top level, so every target below it).
include_directories(SYSTEM "${FARMSLICER_SHIMS_DIR}")
