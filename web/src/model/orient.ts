// Auto-orient: which way down a model prints best. Every direction a good
// share of its surface faces is tried as "down"; the winner has the least
// overhanging area for the support angle, the most surface on the plate,
// and then the lowest height.

import type { ModelObject } from "./document";
import { applyPoint, type Vec3 } from "./mesh";

interface Faces {
  normals: Float64Array;
  areas: Float64Array;
  /** Each face's lowest corner along the candidate axis is needed for contact: keep the centroids. */
  centroids: Float64Array;
  /** All vertices of the model parts (for the height and the resting plane). */
  points: Float64Array;
}

function collect(o: ModelObject): Faces {
  const normals: number[] = [];
  const areas: number[] = [];
  const centroids: number[] = [];
  const points: number[] = [];
  for (const v of o.volumes) {
    if (v.type !== "part") continue;
    const p = v.mesh.positions;
    const world = (i: number) => applyPoint(v.matrix, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    const verts: Vec3[] = [];
    for (let i = 0; i < p.length / 3; i++) {
      const w = world(i);
      verts.push(w);
      points.push(...w);
    }
    const idx = v.mesh.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const a = verts[idx[t]];
      const b = verts[idx[t + 1]];
      const c = verts[idx[t + 2]];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const len = Math.hypot(n[0], n[1], n[2]);
      if (!len) continue;
      normals.push(n[0] / len, n[1] / len, n[2] / len);
      areas.push(len / 2);
      centroids.push((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3);
    }
  }
  return {
    normals: Float64Array.from(normals),
    areas: Float64Array.from(areas),
    centroids: Float64Array.from(centroids),
    points: Float64Array.from(points),
  };
}

export interface Orientation {
  /** The model's direction (its own coordinates) that should face down. */
  down: Vec3;
  overhang: number;
  contact: number;
  height: number;
}

/**
 * The best "down" for the model with supports from `supportDeg` (the
 * profile's support_threshold_angle; 0 = 30°). `limit` caps how many
 * candidate directions are scored (the largest by facing area).
 */
export function bestOrientation(o: ModelObject, supportDeg = 0, limit = 64): Orientation | null {
  const f = collect(o);
  const n = f.areas.length;
  if (!n) return null;
  // Candidate directions: the face normals, merged when within ~2°, by area.
  const buckets = new Map<string, { dir: Vec3; area: number }>();
  for (let i = 0; i < n; i++) {
    const d: Vec3 = [f.normals[i * 3], f.normals[i * 3 + 1], f.normals[i * 3 + 2]];
    const key = d.map((x) => Math.round(x * 30)).join(",");
    const b = buckets.get(key);
    if (b) b.area += f.areas[i];
    else buckets.set(key, { dir: d, area: f.areas[i] });
  }
  const candidates = [...buckets.values()].sort((a, b) => b.area - a.area).slice(0, limit).map((b) => b.dir);
  for (const axis of [
    [0, 0, -1],
    [0, 0, 1],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
  ] as Vec3[])
    if (!candidates.some((c) => c[0] * axis[0] + c[1] * axis[1] + c[2] * axis[2] > 0.9995)) candidates.push(axis);

  const threshold = ((supportDeg > 0 ? supportDeg : 30) * Math.PI) / 180;
  // A face overhangs when it faces down more steeply than the threshold
  // from the horizontal: its normal's "down" component > cos(threshold).
  const steep = Math.cos(threshold);
  let best: Orientation | null = null;
  let bestScore = Infinity;
  const total = f.areas.reduce((s, a) => s + a, 0);
  for (const down of candidates) {
    // Heights along "up" (= -down).
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < f.points.length; i += 3) {
      const h = -(f.points[i] * down[0] + f.points[i + 1] * down[1] + f.points[i + 2] * down[2]);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    const onPlate = Math.max(0.05, (hi - lo) * 1e-4);
    let overhang = 0;
    let contact = 0;
    for (let i = 0; i < n; i++) {
      const facing = f.normals[i * 3] * down[0] + f.normals[i * 3 + 1] * down[1] + f.normals[i * 3 + 2] * down[2];
      if (facing <= steep) continue;
      const h = -(f.centroids[i * 3] * down[0] + f.centroids[i * 3 + 1] * down[1] + f.centroids[i * 3 + 2] * down[2]);
      if (h - lo < onPlate && facing > 0.999) contact += f.areas[i];
      else overhang += f.areas[i];
    }
    const height = hi - lo;
    // Overhangs cost the most; resting area makes up for some; height breaks ties.
    const score = overhang - 0.5 * contact + total * 1e-4 * height;
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = { down, overhang, contact, height };
    }
  }
  return best;
}
