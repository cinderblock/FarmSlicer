// What the paint tool paints, and how (viewer/PaintTool.tsx).

import type { PaintKind } from "../../model/paint";

export type Brush = "circle" | "sphere" | "triangle" | "smart" | "bucket" | "height";

export interface PaintSettings {
  kind: PaintKind;
  brush: Brush;
  /** Brush radius, or the height range's band (mm). */
  radius: number;
  /** Smart fill: the most two neighbouring faces may turn (degrees). */
  angle: number;
  /** What to paint: a filament (colour), enforce/block, on (fuzzy); 0 erases. */
  state: number;
  /** Supports: paint only faces hanging over more than this (degrees; 0 = any). */
  overhangDeg: number;
}

export const DEFAULT_PAINT: PaintSettings = {
  kind: "color",
  brush: "circle",
  radius: 2,
  angle: 30,
  state: 1,
  overhangDeg: 0,
};

export const PAINT_TOOLS: { kind: PaintKind; label: string; key: string }[] = [
  { kind: "color", label: "Colour", key: "N" },
  { kind: "supports", label: "Supports", key: "L" },
  { kind: "seam", label: "Seam", key: "P" },
  { kind: "fuzzy", label: "Fuzzy skin", key: "H" },
];
