// Shared types for the in-browser slicing engine (libslic3r compiled to
// WebAssembly, built by wasm/build.sh into public/wasm/).

export type EngineVariant = "st" | "mt";

export interface EngineManifest {
  engine: string;
  /** OrcaSlicer version the engine was built from, e.g. "2.4.2". */
  orca: string;
  variants: Partial<
    Record<EngineVariant, { js: string; wasm: string; data: string; bytes: number }>
  >;
  builtAt: string;
}

export interface SliceStats {
  printTimeSec: number;
  filamentG: number;
  filamentMm: number;
  layers: number;
}

/** JSON report produced by fs_slice (see wasm/bridge/farmslicer_wasm.cpp). */
export interface SliceReport {
  ok: boolean;
  cancelled: boolean;
  error: string | null;
  warnings: string[];
  stats: SliceStats;
}

export interface SliceOutput {
  /** Backed by a plain ArrayBuffer (copied out of the engine heap), so it can go straight into a Blob. */
  gcode: Uint8Array<ArrayBuffer>;
  report: SliceReport;
  /** Wall-clock slicing time in the worker, ms. */
  elapsedMs: number;
}

// --- worker protocol ---------------------------------------------------------

export type WorkerRequest =
  | { type: "init"; variant: EngineVariant; baseUrl: string; threads?: number }
  | { type: "slice"; id: number; modelName: string; model: ArrayBuffer; config: string }
  | { type: "cancel" };

export type WorkerResponse =
  | { type: "ready"; version: { engine: string; orca: string; threads: boolean }; threadCount: number }
  | { type: "init-error"; error: string }
  | { type: "progress"; id: number; percent: number; message: string }
  | { type: "done"; id: number; gcode: ArrayBuffer; report: SliceReport; elapsedMs: number }
  | { type: "error"; id: number; error: string; report?: SliceReport };
