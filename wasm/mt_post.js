// --post-js for the pthreads engine (ORCA_WASM_THREADS=ON).
//
// Module.fsTerminateThreads(): terminate every pthread Worker of this instance
// (pool + running). Emscripten has no instance teardown with EXIT_RUNTIME=0,
// so a host that drops an instance must call this or the Workers (and the
// shared heap they reference) live until the host worker itself exits. The
// instance is unusable afterwards.
Module['fsTerminateThreads'] = () => PThread.terminateAllThreads();

// Module.fsSyncHeap(): refresh Module.HEAP* after another thread grew the
// shared heap. With a growable SharedArrayBuffer (newer engines) the views track
// the length on their own and this is a no-op; otherwise the main thread only
// notices growth inside Emscripten's own glue, so a host reading HEAPU8/HEAPU32
// after a pthread slice must call this first.
Module['fsSyncHeap'] = () => {
  if (typeof growMemViews == 'function') growMemViews();
};
