# FarmSlicer browser engine: libslic3r → WebAssembly superbuild.
#
#   source wasm/toolchain/env.sh            # (WASM_THREADS=1 for the pthreads variant)
#   emcmake cmake -S wasm -B wasm/build-st -G Ninja -DCMAKE_BUILD_TYPE=Release
#   cmake --build wasm/build-st --target farmslicer_engine
#
# Normally driven by wasm/build.sh. The dependency handling (find-modules in
# cmake/, sequential TBB and Boost.Thread shims in shims/, the libslic3r patch
# in patches/) is adapted from JoshTheDerf/orcaslicer-wasm (AGPL-3.0, see
# LICENSE.orcaslicer-wasm); the engine bridge and pipeline are FarmSlicer's.
cmake_minimum_required(VERSION 3.22)
project(farmslicer_wasm CXX C)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with emcmake (source wasm/toolchain/env.sh first).")
endif()

set(BUILD_VARIANT "release" CACHE STRING "release | debug (SAFE_HEAP + assertions)")
set_property(CACHE BUILD_VARIANT PROPERTY STRINGS release debug)

# Threading model. OFF: single-threaded engine, sequential TBB shim, deps from
# the toolchain's install/ prefix. ON: Emscripten pthreads + real oneTBB, deps
# from install-mt/ (source env.sh with WASM_THREADS=1). The env var and the
# option must agree so the two dependency prefixes can never be mixed.
if("$ENV{WASM_THREADS}" STREQUAL "1")
  set(_threads_default ON)
else()
  set(_threads_default OFF)
endif()
option(ORCA_WASM_THREADS "Emscripten pthreads build with real oneTBB" ${_threads_default})
if((ORCA_WASM_THREADS AND NOT _threads_default) OR (_threads_default AND NOT ORCA_WASM_THREADS))
  message(FATAL_ERROR "ORCA_WASM_THREADS=${ORCA_WASM_THREADS} but WASM_THREADS='$ENV{WASM_THREADS}' — "
                      "source env.sh with the matching WASM_THREADS setting")
endif()

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POLICY_VERSION_MINIMUM 3.5)

# ---- shared deps (toolchain prefix) ----------------------------------------
if(NOT DEFINED ENV{WASM_DEPS_PREFIX})
  message(FATAL_ERROR "WASM_DEPS_PREFIX not set — source wasm/toolchain/env.sh")
endif()
set(WASM_DEPS_PREFIX "$ENV{WASM_DEPS_PREFIX}" CACHE PATH "" FORCE)
if(ORCA_WASM_THREADS AND NOT WASM_DEPS_PREFIX MATCHES "/install-mt$")
  message(FATAL_ERROR "ORCA_WASM_THREADS needs the pthreads prefix; got ${WASM_DEPS_PREFIX}")
elseif(NOT ORCA_WASM_THREADS AND WASM_DEPS_PREFIX MATCHES "/install-mt$")
  message(FATAL_ERROR "single-threaded build must not use ${WASM_DEPS_PREFIX}")
endif()
set(WASM_CGAL_PREFIX "$ENV{WASM_DEPS_ROOT}/cgal-5.6.3" CACHE PATH "" FORCE)   # orca pins CGAL 5.6.3
set(WASM_SHIMS_DIR "${CMAKE_CURRENT_LIST_DIR}/shims" CACHE PATH "" FORCE)
set(EM_EH "$ENV{WASM_EH_FLAGS}")
if(NOT EM_EH)
  message(FATAL_ERROR "WASM_EH_FLAGS not set — source wasm/toolchain/env.sh")
endif()

list(PREPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_LIST_DIR}/cmake")
list(PREPEND CMAKE_PREFIX_PATH "${WASM_DEPS_PREFIX}" "${WASM_CGAL_PREFIX}")
set(Eigen3_DIR "${WASM_DEPS_PREFIX}/share/eigen3/cmake" CACHE PATH "" FORCE)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY BOTH)

# ---- one exception/longjmp model for every TU ------------------------------
separate_arguments(_eh UNIX_COMMAND "${EM_EH}")
add_compile_options(${_eh} -Wno-unknown-warning-option -Wno-deprecated-declarations
                    -Wno-unused-command-line-argument -Wno-missing-template-arg-list-after-template-kw)
add_link_options(${_eh})
if(ORCA_WASM_THREADS)
  add_compile_options(-pthread)
  add_link_options(-pthread)
endif()
if(BUILD_VARIANT STREQUAL "debug")
  add_compile_options(-g2)
endif()

find_program(CCACHE_PROGRAM ccache)
if(CCACHE_PROGRAM)
  set(CMAKE_C_COMPILER_LAUNCHER "${CCACHE_PROGRAM}")
  set(CMAKE_CXX_COMPILER_LAUNCHER "${CCACHE_PROGRAM}")
endif()

if(NOT ORCA_WASM_THREADS)
  # Shims: TBB (sequential), Boost.Thread (single-thread), unlinked stubs only.
  include_directories(BEFORE SYSTEM
    "${WASM_SHIMS_DIR}"
    "${WASM_SHIMS_DIR}/boost_runtime")
  add_compile_definitions(SLIC3R_NO_TBB=1 BOOST_LOG_NO_THREADS)
else()
  # MT: real oneTBB + Boost.Thread from install-mt. Only the stubs for libraries
  # that are not linked at all (OpenSSL MD5, OpenVDB) stay on the include path.
  set(_mt_shims "${CMAKE_BINARY_DIR}/mt_shims")
  file(MAKE_DIRECTORY "${_mt_shims}")
  foreach(_d openssl openvdb)
    file(CREATE_LINK "${WASM_SHIMS_DIR}/${_d}" "${_mt_shims}/${_d}" SYMBOLIC)
  endforeach()
  include_directories(BEFORE SYSTEM "${_mt_shims}")
endif()
include_directories(SYSTEM "${WASM_DEPS_PREFIX}/include" "${WASM_DEPS_PREFIX}/include/eigen3")

# Emscripten ports: at compile time too, so a fresh emsdk fetches their headers.
add_compile_options(-sUSE_ZLIB=1 -sUSE_LIBPNG=1 -sUSE_LIBJPEG=1 -sUSE_FREETYPE=1)

add_compile_definitions(
  WASM_BUILD=1
  BOOST_LOG_STATIC_LINK
  BOOST_ALL_NO_LIB
  BOOST_NO_CXX98_FUNCTION_BASE
  ORCA_DISABLE_OPENVDB=1
  _LIBCPP_ENABLE_CXX17_REMOVED_FEATURES=1
  _LIBCPP_DISABLE_DEPRECATION_WARNINGS=1)

# ---- orca configuration ------------------------------------------------------
set(ORCA_SRC_DIR "${CMAKE_CURRENT_LIST_DIR}/../extern/OrcaSlicer" CACHE PATH "OrcaSlicer source tree (patched with patches/orca-wasm.patch)")
set(SLIC3R_WITH_ASSIMP OFF CACHE BOOL "" FORCE)
set(SLIC3R_STATIC ON CACHE BOOL "" FORCE)
set(SLIC3R_GUI OFF CACHE BOOL "" FORCE)
set(SLIC3R_PCH OFF CACHE BOOL "" FORCE)
set(SLIC3R_NLS OFF CACHE BOOL "" FORCE)
set(SLIC3R_ENC_CHECK OFF CACHE BOOL "" FORCE)
set(SLIC3R_WITH_OCCT OFF CACHE BOOL "" FORCE)
set(SLIC3R_WITH_OPENCV OFF CACHE BOOL "" FORCE)
set(SLIC3R_WITH_DRACO OFF CACHE BOOL "" FORCE)
set(BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(ORCA_TOOLS OFF CACHE BOOL "" FORCE)
set(ORCA_CHECK_GCODE_PLACEHOLDERS "0" CACHE STRING "" FORCE)
if(NOT ORCA_WASM_THREADS)
  set(CMAKE_DISABLE_FIND_PACKAGE_TBB ON)
endif()
include(${CMAKE_CURRENT_LIST_DIR}/cmake/FindTBB.cmake)  # shim or real TBB::* targets

add_subdirectory(${ORCA_SRC_DIR} ${CMAKE_BINARY_DIR}/orca-build EXCLUDE_FROM_ALL)

# OrcaSlicer version string, reported by fs_version().
file(STRINGS "${ORCA_SRC_DIR}/version.inc" _orca_ver_line REGEX "set\\(SoftFever_VERSION \"")
string(REGEX REPLACE ".*\"([^\"]+)\".*" "\\1" FS_ORCA_VERSION "${_orca_ver_line}")
if(NOT FS_ORCA_VERSION)
  set(FS_ORCA_VERSION "unknown")
endif()

# VoronoiUtilsCgal.cpp lives in libslic3r but needs the (real) CGAL headers;
# scope the include to that one file so the rest of libslic3r is unaffected.
set_source_files_properties(
  ${ORCA_SRC_DIR}/src/libslic3r/Geometry/VoronoiUtilsCgal.cpp
  DIRECTORY ${ORCA_SRC_DIR}/src/libslic3r
  PROPERTIES COMPILE_OPTIONS "-isystem;${WASM_CGAL_PREFIX}/include;-frounding-math")

if(TARGET libslic3r_cgal)
  # CGAL exact predicates need strict IEEE rounding.
  target_compile_options(libslic3r_cgal PRIVATE -frounding-math -fno-fast-math -ffp-contract=off)
  target_compile_definitions(libslic3r_cgal PRIVATE CGAL_DISABLE_ROUNDING_MATH_CHECK)
endif()
if(TARGET mcut)
  target_compile_options(mcut PRIVATE -Wno-deprecated-non-prototype)
endif()

# ---- engine module ------------------------------------------------------------
set(_engine_name "farmslicer-engine")
if(ORCA_WASM_THREADS)
  set(_engine_name "farmslicer-engine-mt")
endif()

add_executable(farmslicer_engine
  bridge/farmslicer_wasm.cpp
  bridge/fast_strtod.cpp
  ../cxx/slice_core.cpp
  ../cxx/thumbnail.cpp)
set_target_properties(farmslicer_engine PROPERTIES OUTPUT_NAME "${_engine_name}" SUFFIX ".mjs")
target_include_directories(farmslicer_engine PRIVATE
  ${ORCA_SRC_DIR}/src
  ${ORCA_SRC_DIR}/deps_src
  ${CMAKE_BINARY_DIR}/orca-build/src/libslic3r
  ${CMAKE_CURRENT_LIST_DIR}/../cxx)
target_link_libraries(farmslicer_engine PRIVATE libslic3r libslic3r_cgal ${Boost_LIBRARIES}
  "${WASM_DEPS_PREFIX}/lib/libmpfr.a" "${WASM_DEPS_PREFIX}/lib/libgmp.a")
target_compile_definitions(farmslicer_engine PRIVATE FS_ORCA_VERSION="${FS_ORCA_VERSION}")
if(ORCA_WASM_THREADS)
  target_link_libraries(farmslicer_engine PRIVATE TBB::tbb TBB::tbbmalloc)
  target_compile_definitions(farmslicer_engine PRIVATE FS_ENGINE_THREADS=1)
endif()

set(_link
  # musl strtod goes through 128-bit soft-float long double; route it to fast_float.
  -Wl,--wrap=strtod -Wl,--wrap=strtof
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=128MB
  -sMAXIMUM_MEMORY=4GB
  -sSTACK_SIZE=64MB
  -sABORTING_MALLOC=0
  -sMALLOC=dlmalloc
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=FarmSlicerEngine
  -sENVIRONMENT=web,worker,node
  -sUSE_ZLIB=1 -sUSE_LIBPNG=1 -sUSE_LIBJPEG=1 -sUSE_FREETYPE=1
  -sFILESYSTEM=1
  -sEXIT_RUNTIME=0
  "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAP32','HEAPU32','UTF8ToString','stringToUTF8','lengthBytesUTF8','FS']"
  # libslic3r reads only resources/info (nozzle tables) and resources/flush
  # (MM flush matrices) at slice time — ~40 KB. Profiles are resolved by the
  # server and arrive as the merged config JSON.
  "--preload-file=${ORCA_SRC_DIR}/resources/info@/resources/info"
  # The thumbnail label font (SIL OFL, 90 KB).
  "--preload-file=${CMAKE_CURRENT_LIST_DIR}/../resources/fonts/Sarabun-SemiBold.ttf@/resources/fonts/Sarabun-SemiBold.ttf"
)
if(EXISTS "${ORCA_SRC_DIR}/resources/flush")
  list(APPEND _link "--preload-file=${ORCA_SRC_DIR}/resources/flush@/resources/flush")
endif()
set(_incoming "'locateFile','print','printErr','instantiateWasm','wasmBinary','getPreloadedPackage','onAbort','monitorRunDependencies','setStatus'")
set(_exports "'_fs_version','_fs_slice','_fs_set_options','_fs_stage_model','_fs_cancel','_fs_free','_malloc','_free'")
if(ORCA_WASM_THREADS)
  # Worker pool. The host's engine Web Worker is the main runtime thread; it
  # starts each slice on a dedicated pthread (fs_slice_start) and returns to
  # its event loop, so Emscripten can hand out pool workers to TBB at any time.
  list(APPEND _link
    "--pre-js=${CMAKE_CURRENT_LIST_DIR}/mt_pre.js"
    "--post-js=${CMAKE_CURRENT_LIST_DIR}/mt_post.js"
    "-sPTHREAD_POOL_SIZE=fsThreadCount()"
    -sDEFAULT_PTHREAD_STACK_SIZE=16MB)
  string(APPEND _incoming ",'mainScriptUrlOrBlob'")
  string(APPEND _exports ",'_fs_slice_start','_fs_thread_count'")
endif()
list(APPEND _link "-sINCOMING_MODULE_JS_API=[${_incoming}]" "-sEXPORTED_FUNCTIONS=[${_exports}]")
if(BUILD_VARIANT STREQUAL "debug")
  list(APPEND _link -O1 -g2 -sASSERTIONS=2 -sSAFE_HEAP=1 -sSTACK_OVERFLOW_CHECK=2)
else()
  set(ORCA_WASM_LINK_OPT "-O3" CACHE STRING "Link-time (wasm-opt) optimisation level")
  option(ORCA_WASM_NAMES "Keep function names (readable wasm stack traces)" OFF)
  if(ORCA_WASM_NAMES)
    list(APPEND _link --profiling-funcs)
  endif()
  # STACK_OVERFLOW_CHECK=2 bounds-checks every stack-pointer update, so a deep
  # recursion traps deterministically instead of silently corrupting memory.
  list(APPEND _link ${ORCA_WASM_LINK_OPT} -sSTACK_OVERFLOW_CHECK=2)
endif()
target_link_options(farmslicer_engine PRIVATE ${_link})
