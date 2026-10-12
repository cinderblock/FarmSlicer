// --pre-js for the pthreads engine (ORCA_WASM_THREADS=ON).
//
// Thread budget: one slicing pthread + (N-1) oneTBB workers, all served from a
// pthread pool created during instantiation (-sPTHREAD_POOL_SIZE=fsThreadCount()),
// and TBB is capped to N (tbb::global_control in farmslicer_wasm.cpp). Host override:
// Module.fsThreads. Capped at 16: beyond that the per-thread stacks (16 MB) and
// memory-bandwidth contention cost more than the extra cores return.
function fsThreadCount() {
  var n = Module['fsThreads'] | 0;
  if (!(n > 0)) {
    n = (typeof navigator == 'object' && navigator['hardwareConcurrency']) | 0;
    if (!(n > 0)) n = 4;
  }
  return Math.max(2, Math.min(16, n));
}
