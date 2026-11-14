// Where a running print is in its G-code, from what the printer reports.
// Pure (no DOM, no React): unit-tested in web/test/preview-live.test.ts.
//
// Printers tell us different things (src/printer/status.rs):
//  - the layer (Bambu, Klipper, Elegoo SDCP): exact to the layer; inside it
//    we estimate from the time since the layer changed and the layer's moves;
//  - only a percentage (OctoPrint, PrusaLink): mapped onto the file's time
//    estimate, so an estimate to the move.

import { GAP, type ParsedGcode } from "./types";

/** What the page knows about the print, from the printer's status. */
export interface PrintProgress {
  /** The printer's layer (1-based; 0 or null before the first). */
  layer?: number | null;
  totalLayers?: number | null;
  /** 0-100. */
  percent?: number | null;
  /** The print has ended (finished): show all of it. */
  done?: boolean;
  /** Paused: the position holds still. */
  paused?: boolean;
  /** Stopped (failed, cancelled): where it got to, from the last percentage. */
  ended?: boolean;
  /** The printer's speed, % of normal (100 = as sliced). */
  speedPercent?: number | null;
}

export interface LivePosition {
  /** Layer index in the parsed file (0-based). */
  layer: number;
  /** Extrusion segment index (exclusive end) within that layer. */
  upTo: number;
  /** How the position inside the layer was found: "layer" = the layer is exact, the move an estimate. */
  source: "layer" | "percent" | "done";
  /** The printer's layer count differs from the file's. */
  layerMismatch: boolean;
}

/** Seconds per extrusion segment of a layer (gaps = travel), by length and feed rate. */
export function segmentTimes(parsed: ParsedGcode, layer: number): Float64Array {
  const { extrusions: ex, layers } = parsed;
  const start = layers.extrusionStart[layer] ?? 0;
  const end = layers.extrusionStart[layer + 1] ?? start;
  const out = new Float64Array(Math.max(0, end - start));
  const p = ex.points;
  for (let i = start; i < end; i++) {
    const dx = p[i * 3 + 3] - p[i * 3];
    const dy = p[i * 3 + 4] - p[i * 3 + 1];
    const dz = p[i * 3 + 5] - p[i * 3 + 2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let speed = ex.speed[i] / 10;
    if (!(speed > 0)) speed = ex.feature[i] === GAP ? 200 : 50;
    out[i - start] = len / speed;
  }
  return out;
}

/** The segment (exclusive end) a fraction of the way through a layer, by time. */
export function segmentAtFraction(parsed: ParsedGcode, layer: number, fraction: number): number {
  const start = parsed.layers.extrusionStart[layer] ?? 0;
  const end = parsed.layers.extrusionStart[layer + 1] ?? start;
  if (fraction <= 0 || end <= start) return start;
  if (fraction >= 1) return end;
  const times = segmentTimes(parsed, layer);
  let total = 0;
  for (const t of times) total += t;
  if (!(total > 0)) return start + Math.round((end - start) * fraction);
  const target = total * fraction;
  let acc = 0;
  for (let i = 0; i < times.length; i++) {
    acc += times[i];
    if (acc >= target) return start + i + 1;
  }
  return end;
}

/**
 * Where the print is. `layerElapsed` = seconds since the printer's layer
 * last changed (for the estimate inside a layer); null = unknown (the
 * layer's start).
 */
export function livePosition(parsed: ParsedGcode, progress: PrintProgress, layerElapsed: number | null): LivePosition | null {
  const { layers } = parsed;
  const count = layers.count;
  if (count === 0) return null;
  const last = count - 1;
  const end = layers.extrusionStart[count] ?? 0;
  if (progress.done) return { layer: last, upTo: end, source: "done", layerMismatch: false };

  const layerMismatch = !!progress.totalLayers && progress.totalLayers !== count;
  if (progress.layer != null) {
    // Bambu reports 0 during the start sequence, which the file counts as layer 1.
    const layer = Math.max(0, Math.min(last, progress.layer - 1));
    const speed = progress.speedPercent && progress.speedPercent > 0 ? progress.speedPercent / 100 : 1;
    const time = layers.time[layer];
    // Never past the layer's last move on an estimate: the printer says when it's done.
    const fraction = layerElapsed != null && time > 0 ? Math.min(0.99, (layerElapsed * speed) / time) : 0;
    return { layer, upTo: segmentAtFraction(parsed, layer, fraction), source: "layer", layerMismatch };
  }

  if (progress.percent != null) {
    let total = 0;
    for (let i = 0; i < count; i++) total += layers.time[i];
    const target = (Math.max(0, Math.min(100, progress.percent)) / 100) * total;
    let acc = 0;
    for (let i = 0; i < count; i++) {
      const t = layers.time[i];
      if (acc + t >= target || i === last) {
        const fraction = t > 0 ? Math.max(0, Math.min(1, (target - acc) / t)) : 1;
        return { layer: i, upTo: segmentAtFraction(parsed, i, fraction), source: "percent", layerMismatch };
      }
      acc += t;
    }
  }
  return null;
}
