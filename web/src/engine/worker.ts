// Web Worker hosting the WebAssembly slicing engine.
//
// One engine instance per worker. The single-threaded engine blocks this
// worker for the whole slice (progress still arrives: Module.fsProgress is
// called synchronously and postMessage queues). The pthreads engine runs the
// slice on its own pthread and this worker stays responsive, which Emscripten
// needs in order to hand pool workers to TBB.

/// <reference lib="webworker" />
import type { SliceOptions, SliceReport, WorkerRequest, WorkerResponse } from "./types";

interface EngineModule {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  UTF8ToString(ptr: number): string;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _fs_version(): number;
  _fs_slice(
    modelName: number, model: number, modelLen: number,
    config: number, configLen: number,
    outGcode: number, outGcodeLen: number, outReport: number,
  ): number;
  _fs_slice_start?(
    modelName: number, model: number, modelLen: number,
    config: number, configLen: number,
    outGcode: number, outGcodeLen: number, outReport: number, state: number,
  ): number;
  _fs_thread_count?(): number;
  /** Engines built before packaging lack it. */
  _fs_set_options?(json: number, jsonLen: number, logo: number, logoLen: number): number;
  FS: { readFile(path: string): Uint8Array; unlink(path: string): void };
  _fs_cancel(): void;
  _fs_free(ptr: number): void;
  fsSyncHeap?(): void;
}

type ModuleFactory = (opts: Record<string, unknown>) => Promise<EngineModule>;

const post = (msg: WorkerResponse, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? []);

let engine: EngineModule | null = null;
let threaded = false;
/** The engine applies SliceOptions.placement (older engines ignore it). */
let placesModels = false;
let currentId = 0;

function writeString(m: EngineModule, s: string): { ptr: number; len: number } {
  const bytes = new TextEncoder().encode(s);
  const ptr = m._malloc(bytes.length + 1);
  m.HEAPU8.set(bytes, ptr);
  m.HEAPU8[ptr + bytes.length] = 0;
  return { ptr, len: bytes.length };
}

function heap(m: EngineModule) {
  // After another thread grew the shared heap the cached views are stale.
  m.fsSyncHeap?.();
  return m;
}

async function init(variant: "st" | "mt", baseUrl: string, threads?: number) {
  const name = variant === "mt" ? "farmslicer-engine-mt" : "farmslicer-engine";
  const dir = `${baseUrl}${variant}/`;
  const jsUrl = `${dir}${name}.mjs`;
  const mod = (await import(/* @vite-ignore */ jsUrl)) as { default: ModuleFactory };
  const opts: Record<string, unknown> = {
    locateFile: (path: string) => dir + path,
    // Where pthread workers load the engine script from.
    mainScriptUrlOrBlob: jsUrl,
    fsProgress: (percent: number, message: string) =>
      post({ type: "progress", id: currentId, percent, message }),
    print: (line: string) => console.info("[engine]", line),
    printErr: (line: string) => console.warn("[engine]", line),
  };
  if (threads) opts.fsThreads = threads;
  engine = await mod.default(opts);
  const version = JSON.parse(engine.UTF8ToString(engine._fs_version()));
  threaded = Boolean(version.threads) && typeof engine._fs_slice_start === "function";
  placesModels = Boolean(version.placement);
  const threadCount = threaded && engine._fs_thread_count ? engine._fs_thread_count() : 1;
  post({ type: "ready", version, threadCount });
}

function waitForState(m: EngineModule, statePtr: number): Promise<void> {
  const i32 = new Int32Array(m.HEAP32.buffer);
  const index = statePtr >> 2;
  if (typeof Atomics.waitAsync === "function" && m.HEAP32.buffer instanceof SharedArrayBuffer) {
    const loop = (): Promise<void> => {
      if (Atomics.load(i32, index) === 1) return Promise.resolve();
      const r = Atomics.waitAsync(i32, index, 0);
      return (r.async ? r.value : Promise.resolve()).then(loop);
    };
    return loop();
  }
  // No Atomics.waitAsync (older Safari): poll.
  return new Promise((resolve) => {
    const tick = () => {
      if (Atomics.load(new Int32Array(m.HEAP32.buffer), index) === 1) resolve();
      else setTimeout(tick, 50);
    };
    tick();
  });
}

/** Hand the next slice its options. False if this engine can't take them. */
function setOptions(m: EngineModule, options: SliceOptions): boolean {
  if (!m._fs_set_options) return false;
  const { logo, ...rest } = options;
  const json = writeString(
    m,
    JSON.stringify({ ...rest, logo_width: logo?.width ?? 0, logo_height: logo?.height ?? 0 }),
  );
  let logoPtr = 0;
  let logoLen = 0;
  if (logo) {
    const bytes = new Uint8Array(logo.rgba);
    logoPtr = m._malloc(bytes.length);
    heap(m).HEAPU8.set(bytes, logoPtr);
    logoLen = bytes.length;
  }
  const rc = m._fs_set_options(json.ptr, json.len, logoPtr, logoLen);
  m._free(json.ptr);
  if (logoPtr) m._free(logoPtr);
  if (rc !== 0) console.warn("[engine] slice options rejected");
  return rc === 0;
}

async function slice(id: number, modelName: string, model: ArrayBuffer, config: string, options?: SliceOptions) {
  if (!engine) {
    post({ type: "error", id, error: "engine not initialised" });
    return;
  }
  const m = engine;
  currentId = id;
  const started = performance.now();
  // A placed model must not be sliced by an engine that would ignore the
  // placement: the G-code would come out centred, in the file's orientation.
  if (options?.placement && !placesModels) {
    post({ type: "error", id, error: "this browser engine predates part placement; reload the page, or slice on the server" });
    return;
  }
  if (options && !setOptions(m, options) && options.placement) {
    post({ type: "error", id, error: "the browser engine refused the part's placement" });
    return;
  }

  const modelBytes = new Uint8Array(model);
  const modelPtr = m._malloc(Math.max(1, modelBytes.length));
  m.HEAPU8.set(modelBytes, modelPtr);
  const name = writeString(m, modelName);
  const cfg = writeString(m, config);
  const outGcode = m._malloc(4);
  const outGcodeLen = m._malloc(4);
  const outReport = m._malloc(4);
  const state = m._malloc(8);
  m.HEAPU32[outGcode >> 2] = 0;
  m.HEAPU32[outGcodeLen >> 2] = 0;
  m.HEAPU32[outReport >> 2] = 0;

  let rc: number;
  try {
    if (threaded && m._fs_slice_start) {
      const err = m._fs_slice_start(
        name.ptr, modelPtr, modelBytes.length, cfg.ptr, cfg.len,
        outGcode, outGcodeLen, outReport, state,
      );
      if (err !== 0) throw new Error(`could not start slicing thread (${err})`);
      await waitForState(m, state);
      rc = heap(m).HEAP32[(state >> 2) + 1];
    } else {
      rc = m._fs_slice(
        name.ptr, modelPtr, modelBytes.length, cfg.ptr, cfg.len,
        outGcode, outGcodeLen, outReport,
      );
    }
  } catch (e) {
    post({ type: "error", id, error: `engine crashed: ${e instanceof Error ? e.message : String(e)}` });
    return;
  }

  heap(m);
  const reportPtr = m.HEAPU32[outReport >> 2];
  const report: SliceReport = reportPtr
    ? JSON.parse(m.UTF8ToString(reportPtr))
    : { ok: false, cancelled: false, error: "no report", warnings: [], stats: { printTimeSec: 0, filamentG: 0, filamentMm: 0, layers: 0 } };
  const gcodePtr = m.HEAPU32[outGcode >> 2];
  const gcodeLen = m.HEAPU32[outGcodeLen >> 2];

  let gcode: ArrayBuffer | null = null;
  if (rc === 0 && gcodePtr && gcodeLen > 0) {
    gcode = m.HEAPU8.slice(gcodePtr, gcodePtr + gcodeLen).buffer;
  }
  let pkg: ArrayBuffer | null = null;
  if (report.package) {
    try {
      pkg = m.FS.readFile(report.package).slice().buffer;
      m.FS.unlink(report.package);
    } catch (e) {
      console.warn("[engine] could not read the sliced project", e);
    }
  }

  if (gcodePtr) m._fs_free(gcodePtr);
  if (reportPtr) m._fs_free(reportPtr);
  m._free(modelPtr);
  m._free(name.ptr);
  m._free(cfg.ptr);
  m._free(outGcode);
  m._free(outGcodeLen);
  m._free(outReport);
  m._free(state);

  const elapsedMs = performance.now() - started;
  if (rc === 0 && gcode) {
    post({ type: "done", id, gcode, package: pkg, report, elapsedMs }, pkg ? [gcode, pkg] : [gcode]);
  } else {
    post({ type: "error", id, error: report.error ?? (rc === 2 ? "cancelled" : "slicing failed"), report });
  }
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init":
      init(msg.variant, msg.baseUrl, msg.threads).catch((e) =>
        post({ type: "init-error", error: e instanceof Error ? e.message : String(e) }),
      );
      break;
    case "slice":
      void slice(msg.id, msg.modelName, msg.model, msg.config, msg.options);
      break;
    case "cancel":
      engine?._fs_cancel();
      break;
  }
};
