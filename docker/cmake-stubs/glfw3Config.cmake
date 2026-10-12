# Stub package config for glfw3, used only by the headless (SLIC3R_GUI=OFF)
# libslic3r build in the Dockerfile.
#
# OrcaSlicer's top-level CMakeLists.txt does `find_package(glfw3 REQUIRED)`
# unconditionally, but the only consumer of GLFW is the wxWidgets/OpenGL GUI in
# src/slic3r, which is not built. Satisfying the lookup with an empty package
# saves cross-compiling GLFW (and the X11/Wayland dev headers it needs) into an
# image that never opens a window. Passed via -Dglfw3_DIR=<this directory>.
set(glfw3_FOUND TRUE)
set(GLFW3_FOUND TRUE)
