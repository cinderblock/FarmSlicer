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
  /** MEMFS path of the sliced project, when one was asked for (engines built before packaging omit it). */
  package?: string | null;
}

/** What a slice produces besides G-code (the server decides; see POST /api/jobs). */
export interface SliceOptions {
  /** Write a Bambu sliced project (.gcode.3mf). */
  package: boolean;
  printer_model_id: string;
  model_name: string;
  /** Thumbnail label; "" = none. */
  label: string;
  /** Thumbnail logo as RGBA rows, top-down. */
  logo?: { rgba: ArrayBuffer; width: number; height: number };
}

export interface SliceOutput {
  /** Backed by a plain ArrayBuffer (copied out of the engine heap), so it can go straight into a Blob. */
  gcode: Uint8Array<ArrayBuffer>;
  /** The sliced project, when SliceOptions.package asked for one and the engine supports it. */
  package: Uint8Array<ArrayBuffer> | null;
  report: SliceReport;
  /** Wall-clock slicing time in the worker, ms. */
  elapsedMs: number;
}

// --- worker protocol ---------------------------------------------------------

export type WorkerRequest =
  | { type: "init"; variant: EngineVariant; baseUrl: string; threads?: number }
  | { type: "slice"; id: number; modelName: string; model: ArrayBuffer; config: string; options?: SliceOptions }
  | { type: "cancel" };

export type WorkerResponse =
  | { type: "ready"; version: { engine: string; orca: string; threads: boolean }; threadCount: number }
  | { type: "init-error"; error: string }
  | { type: "progress"; id: number; percent: number; message: string }
  | { type: "done"; id: number; gcode: ArrayBuffer; package: ArrayBuffer | null; report: SliceReport; elapsedMs: number }
  | { type: "error"; id: number; error: string; report?: SliceReport };
