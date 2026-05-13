# Slicer Runtime Crash on Initialization

## Symptom

Calling `new_slicer()` (which creates a `Slicer` object with `std::make_unique<Impl>()`) causes a crash:
- Debug build: `STATUS_STACK_BUFFER_OVERRUN` (0xc0000409)
- Release build: silent exit

## Context

- libslic3r.lib is built in Release mode by OrcaSlicer's CMake
- The cxx bridge compiles and links successfully
- Server works fine without calling slicer functions
- OCCT, GMP, MPFR are dynamic (DLLs copied to target dir)

## Likely Causes

1. **Static initializer issue** — libslic3r may have C++ static constructors that run when the library's symbols are first resolved, and these may require initialization order that isn't guaranteed
2. **CRT mismatch** — libslic3r built with Release CRT vs bridge built in dev mode (though both should use `/MD`)
3. **Missing runtime initialization** — libslic3r might expect certain global state (e.g., Boost.Log, TBB) to be initialized before use
4. **OCCT DLL loading** — linking static import libs but the DLLs may fail to load properly

## Next Steps

- Try building libslic3r in Debug mode and linking against that
- Add a try/catch in the C++ constructor to catch initialization errors
- Use Windows debugger (WinDbg or VS debugger) to get the actual crash location
- Check if `Slic3r::` namespace has any required initialization functions
