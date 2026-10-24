// What the G-code parser (parser.ts, run in worker.ts) produces: every move
// of a G-code file as columns of typed arrays, split into extrusions,
// travels and retractions, with per-layer offsets into each. No per-move
// objects: a 300 MB file becomes a few hundred MB of flat arrays that the
// worker hands over without copying, and that the renderer uploads as they
// are.
//
// Coordinates are the G-code's own (absolute machine coordinates, mm, Z up).

/** Feature index of a gap in the extrusion chain (the nozzle travelled). */
export const GAP = 255;

/**
 * Extruding moves, in file order, as a chain: segment i runs from point i to
 * point i + 1. Where the nozzle travels between extrusions, the chain has a
 * gap segment (feature `GAP`) from where it stopped to where it starts
 * again. Storing points once (not start and end) halves the biggest array:
 * a 300 MB file has millions of segments.
 */
export interface Extrusions {
  /** Segments, gaps included. */
  count: number;
  /** x, y, z per point: `count + 1` points. */
  points: Float32Array;
  /** Width, height per segment, in µm. */
  size: Uint16Array;
  /** Index into `GcodeInfo.features`, or GAP. */
  feature: Uint8Array;
  /** Extruder / filament slot (T0 = 0). */
  tool: Uint8Array;
  /** Feedrate, 0.1 mm/s. */
  speed: Uint16Array;
}

export const TRAVEL = 0;
/** A move that retracts while it goes (a wipe). */
export const WIPE = 1;

/** Non-extruding moves, in file order. */
export interface Travels {
  count: number;
  /** x0, y0, z0, x1, y1, z1 per move. */
  ends: Float32Array;
  /** TRAVEL or WIPE. */
  kind: Uint8Array;
  /** Feedrate, 0.1 mm/s. */
  speed: Uint16Array;
  /** 1-based line of the G-code. */
  line: Uint32Array;
  /** Extrusion segments before it: where it falls in the chain. */
  at: Uint32Array;
}

export const RETRACT = 0;
export const UNRETRACT = 1;

/** Filament pulled back (or pushed out again) without moving, in file order. */
export interface Retractions {
  count: number;
  /** x, y, z per retraction. */
  pos: Float32Array;
  /** RETRACT or UNRETRACT. */
  kind: Uint8Array;
  line: Uint32Array;
  /** Extrusion segments before it. */
  at: Uint32Array;
}

/**
 * Layers in file order. `*Start` arrays have `count + 1` entries: layer i
 * holds items `[start[i], start[i + 1])`. Moves before the first layer (the
 * printer's start sequence) belong to the first one, as in the desktop
 * slicers' previews.
 */
export interface Layers {
  count: number;
  /** Top of the layer (mm). */
  z: Float32Array;
  height: Float32Array;
  /** Seconds (see `GcodeInfo.timeSource`). */
  time: Float32Array;
  extrusionStart: Uint32Array;
  travelStart: Uint32Array;
  retractStart: Uint32Array;
  /** 1-based G-code line where the layer starts. */
  line: Uint32Array;
}

export interface FilamentUse {
  tool: number;
  /** Length (mm). */
  mm: number;
  /** Weight (g), when the density is known. */
  g: number | null;
}

export interface GcodeInfo {
  /** Feature names by index (canonical OrcaSlicer names where known). */
  features: string[];
  /** Highest tool used + 1. */
  toolCount: number;
  /** `#rrggbb` per filament from the header (`filament_colour`); may be empty. */
  filamentColors: string[];
  /** Filament type per tool (`filament_type`), when the header says. */
  filamentTypes: string[];
  /** Printable area from the header (`printable_area`/`bed_shape`). */
  bed: { area: [number, number][]; height: number } | null;
  /** Whole print, seconds. */
  totalTime: number;
  /**
   * "slicer": the slicer's own estimate (header), spread over the moves in
   * proportion to a kinematic estimate; "layers": per-layer times from the
   * file itself; "estimate": our kinematic estimate only.
   */
  timeSource: "slicer" | "layers" | "estimate";
  /** Before the first layer (start sequence), seconds. */
  prepareTime: number;
  /** Seconds per feature index (extruding moves only). */
  featureTime: number[];
  /** Seconds spent travelling (and wiping). */
  travelTime: number;
  filament: FilamentUse[];
  /** "OrcaSlicer 2.4.2" etc., when the header says. */
  generator: string | null;
  /** Extrusion bounds: everything, and the model alone (features other than Custom). */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  modelBounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /** Extrusion feedrate range, mm/s. */
  speedRange: [number, number];
  /** Layers came from the slicer's layer comments (not guessed from Z). */
  layerComments: boolean;
  lines: number;
  bytes: number;
  /** Selected header/config values (`; key = value`). */
  meta: Record<string, string>;
}

export interface ParsedGcode {
  info: GcodeInfo;
  layers: Layers;
  extrusions: Extrusions;
  travels: Travels;
  retractions: Retractions;
}

// --- worker protocol ---------------------------------------------------------

/** `keep`: hand the file's bytes back too (a URL's, for the page to keep). */
export type ParseRequest =
  | { type: "url"; url: string; keep?: boolean }
  | { type: "blob"; blob: Blob };

export type ParseResponse =
  | { type: "progress"; done: number; total: number | null }
  | { type: "done"; result: ParsedGcode; ms: number; bytes?: Blob }
  | { type: "error"; error: string };
