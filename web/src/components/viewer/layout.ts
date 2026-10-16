// Several parts on one plate: their footprints, whether they overlap, where
// a new copy fits, and packing them all (Arrange). Footprints are the 2D
// convex hulls of the parts' rotated convex hulls: exact for convex parts,
// a safe outline for the rest. Everything here is in scene coordinates (the
// bed centre is the origin).

import * as THREE from "three";
import { insidePolygon, type Part, type SceneBed } from "./part";

/** Gap kept between parts by Duplicate, Fill and Arrange (mm). */
export const PART_SPACING = 5;
/** Parts closer than this count as touching, not overlapping (mm). */
const OVERLAP_EPSILON = 0.05;
/** Most copies one Fill adds. */
const FILL_LIMIT = 200;

/** A part's outline on the plate: a convex polygon, counter-clockwise. */
export interface Footprint {
  points: THREE.Vector2[];
  box: THREE.Box2;
}

/** Andrew's monotone chain: the convex hull of points, counter-clockwise. */
export function convexHull2(points: THREE.Vector2[]): THREE.Vector2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: THREE.Vector2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: THREE.Vector2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function footprint(part: Part): Footprint {
  const points = convexHull2(part.footprintPoints());
  return { points, box: new THREE.Box2().setFromPoints(points) };
}

/** The footprint moved by (dx, dy). */
function shifted(f: Footprint, dx: number, dy: number): Footprint {
  const d = new THREE.Vector2(dx, dy);
  return { points: f.points.map((p) => p.clone().add(d)), box: f.box.clone().translate(d) };
}

/** Projection of a polygon onto an axis. */
function project(points: THREE.Vector2[], axis: THREE.Vector2): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const v = p.dot(axis);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/**
 * Do two footprints come closer than `gap`? Separating axes of convex
 * polygons: they're apart iff some edge normal separates their projections
 * by more than `gap`.
 */
export function overlaps(a: Footprint, b: Footprint, gap = OVERLAP_EPSILON): boolean {
  if (
    a.box.max.x + gap <= b.box.min.x ||
    b.box.max.x + gap <= a.box.min.x ||
    a.box.max.y + gap <= b.box.min.y ||
    b.box.max.y + gap <= a.box.min.y
  )
    return false;
  for (const poly of [a.points, b.points]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const axis = new THREE.Vector2(q.y - p.y, p.x - q.x);
      if (axis.lengthSq() === 0) continue;
      axis.normalize();
      const [a0, a1] = project(a.points, axis);
      const [b0, b1] = project(b.points, axis);
      if (a1 + gap <= b0 || b1 + gap <= a0) return false;
    }
  }
  return true;
}

/** The parts that overlap another one. */
export function overlapping(parts: Part[]): Set<Part> {
  const prints = parts.map(footprint);
  const out = new Set<Part>();
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++)
      if (overlaps(prints[i], prints[j])) {
        out.add(parts[i]);
        out.add(parts[j]);
      }
  return out;
}

/** Is the footprint on the bed (every hull point inside the bed polygon)? */
function onBed(f: Footprint, bed: SceneBed): boolean {
  if (f.box.min.x < bed.min.x || f.box.min.y < bed.min.y || f.box.max.x > bed.max.x || f.box.max.y > bed.max.y)
    return false;
  return f.points.every((p) => insidePolygon(p, bed.polygon));
}

/**
 * Where `part` (as turned now) fits on the bed at least PART_SPACING from
 * `others`: the free spot nearest to where it is, scanning the bed on a grid.
 * Returns its new centre, or null when the plate is full.
 */
export function findFreeSpot(part: Part, others: Part[], bed: SceneBed): THREE.Vector2 | null {
  const own = footprint(part);
  const theirs = others.map(footprint);
  const size = own.box.getSize(new THREE.Vector2());
  const step = Math.max(1, Math.min(size.x, size.y) / 6);
  // Offsets that move the footprint's box to each grid position.
  const candidates: { at: THREE.Vector2; dist: number }[] = [];
  for (let y = bed.min.y; y + size.y <= bed.max.y + 1e-6; y += step)
    for (let x = bed.min.x; x + size.x <= bed.max.x + 1e-6; x += step) {
      const at = new THREE.Vector2(x - own.box.min.x, y - own.box.min.y);
      candidates.push({ at, dist: at.lengthSq() });
    }
  candidates.sort((a, b) => a.dist - b.dist);
  for (const { at } of candidates) {
    const moved = shifted(own, at.x, at.y);
    if (!onBed(moved, bed)) continue;
    if (theirs.some((t) => overlaps(moved, t, PART_SPACING))) continue;
    return part.center.clone().add(at);
  }
  return null;
}

/**
 * Copies of `part` in the free space, as many as fit (at most FILL_LIMIT),
 * each placed like Duplicate does. The copies aren't on the plate yet: the
 * caller adds them.
 */
export function fillCopies(part: Part, others: Part[], bed: SceneBed): Part[] {
  const copies: Part[] = [];
  const placed = [...others, part];
  while (copies.length < FILL_LIMIT) {
    const copy = part.clone();
    const spot = findFreeSpot(copy, placed, bed);
    if (!spot) {
      copy.dispose();
      break;
    }
    copy.setCenter(spot.x, spot.y);
    copies.push(copy);
    placed.push(copy);
  }
  return copies;
}

/**
 * Pack every part on the plate, rows of footprint boxes (tallest first),
 * PART_SPACING apart, the whole block centred on the bed. Parts keep their
 * rotations. Returns false (and moves nothing) when they don't all fit.
 */
export function arrange(parts: Part[], bed: SceneBed): boolean {
  if (parts.length === 0) return true;
  const items = parts.map((p) => ({ part: p, print: footprint(p) }));
  items.sort((a, b) => {
    const da = a.print.box.max.y - a.print.box.min.y;
    const db = b.print.box.max.y - b.print.box.min.y;
    return db - da || b.print.box.max.x - b.print.box.min.x - (a.print.box.max.x - a.print.box.min.x);
  });
  const width = bed.max.x - bed.min.x;
  const depth = bed.max.y - bed.min.y;
  // Shelves: fill a row left to right, then start the next one above it.
  const spots: { item: (typeof items)[number]; x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let rowDepth = 0;
  let usedWidth = 0;
  for (const item of items) {
    const w = item.print.box.max.x - item.print.box.min.x;
    const d = item.print.box.max.y - item.print.box.min.y;
    if (x > 0 && x + w > width) {
      y += rowDepth + PART_SPACING;
      x = 0;
      rowDepth = 0;
    }
    if (w > width || y + d > depth) return false;
    spots.push({ item, x, y });
    usedWidth = Math.max(usedWidth, x + w);
    x += w + PART_SPACING;
    rowDepth = Math.max(rowDepth, d);
  }
  const usedDepth = y + rowDepth;
  const originX = bed.min.x + (width - usedWidth) / 2;
  const originY = bed.min.y + (depth - usedDepth) / 2;
  const moves = spots.map(({ item, x: sx, y: sy }) => {
    const dx = originX + sx - item.print.box.min.x;
    const dy = originY + sy - item.print.box.min.y;
    return { part: item.part, moved: shifted(item.print, dx, dy), center: item.part.center.clone().add(new THREE.Vector2(dx, dy)) };
  });
  // Round or odd-shaped beds: the box packing must also be on the bed.
  if (!moves.every((m) => onBed(m.moved, bed))) return false;
  for (const m of moves) m.part.setCenter(m.center.x, m.center.y);
  return true;
}
