// Colouring the toolpaths: by feature (default), filament, speed or layer
// time. Colours go into one RGBA byte array shared by the 3D and the line
// renderer; alpha carries the feature index (GAP hides a segment), which the
// shaders use to hide feature types.

import { featureColors } from "./features";
import { GAP, type ParsedGcode } from "./types";

export type ColorMode = "feature" | "tool" | "speed" | "layerTime";

export const COLOR_MODES: { mode: ColorMode; label: string }[] = [
  { mode: "feature", label: "Feature type" },
  { mode: "tool", label: "Filament" },
  { mode: "speed", label: "Speed" },
  { mode: "layerTime", label: "Layer time" },
];

/** PrusaSlicer's / OrcaSlicer's range colours, low to high. */
export const RANGE_COLORS = [
  "#0b2c7a",
  "#135985",
  "#1c8891",
  "#04d60f",
  "#aaf200",
  "#fcf903",
  "#f5ce0a",
  "#d16830",
  "#c2523c",
  "#942616",
];

/** Filament colours when the G-code doesn't name any. */
const TOOL_PALETTE = ["#ff7d38", "#4a9eff", "#4ade80", "#f8d84a", "#c084fc", "#f87171", "#22d3ee", "#a3a3a3"];

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [200, 200, 200];
}

/** Colour of filament slot `tool`. */
export function toolColors(p: ParsedGcode, fallback: string[] = []): string[] {
  const from = p.info.filamentColors.length ? p.info.filamentColors : fallback;
  return Array.from({ length: Math.max(p.info.toolCount, from.length, 1) }, (_, t) => from[t] ?? TOOL_PALETTE[t % TOOL_PALETTE.length]);
}

/** A gradient lookup table: 256 RGB entries. */
function rangeTable(): Uint8Array {
  const table = new Uint8Array(256 * 3);
  const stops = RANGE_COLORS.map(hexToRgb);
  for (let i = 0; i < 256; i++) {
    const f = (i / 255) * (stops.length - 1);
    const a = Math.floor(f);
    const b = Math.min(stops.length - 1, a + 1);
    const t = f - a;
    for (let c = 0; c < 3; c++) table[i * 3 + c] = Math.round(stops[a][c] * (1 - t) + stops[b][c] * t);
  }
  return table;
}
const RANGE = rangeTable();

export interface Gradient {
  min: number;
  max: number;
}

/** The value range a gradient mode spreads its colours over. */
export function gradientRange(p: ParsedGcode, mode: ColorMode): Gradient | null {
  if (mode === "speed") return { min: p.info.speedRange[0], max: p.info.speedRange[1] };
  if (mode === "layerTime") {
    let min = Infinity;
    let max = 0;
    for (let i = 0; i < p.layers.count; i++) {
      // Layers without extrusions (start-only, empty) don't stretch the scale.
      if (p.layers.extrusionStart[i + 1] === p.layers.extrusionStart[i]) continue;
      min = Math.min(min, p.layers.time[i]);
      max = Math.max(max, p.layers.time[i]);
    }
    return Number.isFinite(min) ? { min, max } : { min: 0, max: 0 };
  }
  return null;
}

/**
 * Fill `out` ((count + 1) * 4 bytes): segment i's colour at (i + 1) * 4,
 * alpha = its feature index. The first entry is padding, so that in the line
 * renderer each segment's colour sits on its last point.
 */
export function fillColors(out: Uint8Array, p: ParsedGcode, mode: ColorMode, filamentColors: string[]): void {
  const { count, feature, tool, speed } = p.extrusions;
  out[0] = out[1] = out[2] = 0;
  out[3] = GAP;
  const put = (i: number, r: number, g: number, b: number) => {
    const o = (i + 1) * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = feature[i];
  };
  if (mode === "feature" || mode === "tool") {
    const palette = (mode === "feature" ? featureColors(p.info.features) : filamentColors).map(hexToRgb);
    const key = mode === "feature" ? feature : tool;
    for (let i = 0; i < count; i++) {
      const c = palette[key[i]] ?? [200, 200, 200];
      put(i, c[0], c[1], c[2]);
    }
    return;
  }
  const range = gradientRange(p, mode)!;
  const span = range.max - range.min;
  const index = (v: number) => (span > 0 ? Math.max(0, Math.min(255, Math.round(((v - range.min) / span) * 255))) : 128);
  if (mode === "speed") {
    for (let i = 0; i < count; i++) {
      const k = index(speed[i] / 10) * 3;
      put(i, RANGE[k], RANGE[k + 1], RANGE[k + 2]);
    }
    return;
  }
  for (let l = 0; l < p.layers.count; l++) {
    const k = index(p.layers.time[l]) * 3;
    for (let i = p.layers.extrusionStart[l]; i < p.layers.extrusionStart[l + 1]; i++) put(i, RANGE[k], RANGE[k + 1], RANGE[k + 2]);
  }
}
