// Simple solids for parts, modifiers, negative volumes and support
// enforcers/blockers the user adds to a model. Closed, outward-facing, the
// origin at the centre of the bounding box.

import type { Mesh } from "./mesh";

export type Primitive = "box" | "cylinder" | "sphere" | "cone";

export const PRIMITIVES: { kind: Primitive; label: string }[] = [
  { kind: "box", label: "Box" },
  { kind: "cylinder", label: "Cylinder" },
  { kind: "sphere", label: "Sphere" },
  { kind: "cone", label: "Cone" },
];

export function box(x: number, y: number, z: number): Mesh {
  const [a, b, c] = [x / 2, y / 2, z / 2];
  const v = [
    [-a, -b, -c],
    [a, -b, -c],
    [a, b, -c],
    [-a, b, -c],
    [-a, -b, c],
    [a, -b, c],
    [a, b, c],
    [-a, b, c],
  ].flat();
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: Float32Array.from(v), indices: Uint32Array.from(t) };
}

/** Sides of a round solid of radius r: fine enough that a facet is under 0.05 mm off. */
function segmentsFor(r: number): number {
  return Math.max(16, Math.min(256, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.05 / Math.max(r, 0.05))))));
}

/** A frustum along Z: radius `r0` at the bottom, `r1` at the top (0 = a point). */
export function frustum(r0: number, r1: number, h: number, segments = segmentsFor(Math.max(r0, r1))): Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const ring = (r: number, z: number) => {
    const start = pos.length / 3;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pos.push(r * Math.cos(a), r * Math.sin(a), z);
    }
    return start;
  };
  const bottom = ring(r0, -h / 2);
  const top = r1 > 0 ? ring(r1, h / 2) : -1;
  const bottomCentre = pos.push(0, 0, -h / 2) / 3 - 1;
  const topCentre = pos.push(0, 0, h / 2) / 3 - 1;
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    idx.push(bottomCentre, bottom + j, bottom + i);
    if (top >= 0) {
      idx.push(bottom + i, bottom + j, top + j, bottom + i, top + j, top + i);
      idx.push(topCentre, top + i, top + j);
    } else idx.push(bottom + i, bottom + j, topCentre);
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

export function cylinder(r: number, h: number, segments?: number): Mesh {
  return frustum(r, r, h, segments);
}

export function cone(r: number, h: number, segments?: number): Mesh {
  return frustum(r, 0, h, segments);
}

/** A UV sphere. */
export function sphere(r: number, segments = segmentsFor(r)): Mesh {
  const rings = Math.max(8, Math.round(segments / 2));
  const pos: number[] = [0, 0, -r];
  const idx: number[] = [];
  for (let k = 1; k < rings; k++) {
    const phi = -Math.PI / 2 + (k / rings) * Math.PI;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pos.push(r * Math.cos(phi) * Math.cos(a), r * Math.cos(phi) * Math.sin(a), r * Math.sin(phi));
    }
  }
  const north = pos.push(0, 0, r) / 3 - 1;
  const at = (k: number, i: number) => 1 + (k - 1) * segments + (i % segments);
  for (let i = 0; i < segments; i++) {
    idx.push(0, at(1, i + 1), at(1, i));
    for (let k = 1; k < rings - 1; k++)
      idx.push(at(k, i), at(k, i + 1), at(k + 1, i + 1), at(k, i), at(k + 1, i + 1), at(k + 1, i));
    idx.push(at(rings - 1, i), at(rings - 1, i + 1), north);
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

/** A primitive that fits a box of `size` (mm). */
export function primitive(kind: Primitive, size: [number, number, number]): Mesh {
  const [x, y, z] = size;
  const r = Math.min(x, y) / 2;
  switch (kind) {
    case "box":
      return box(x, y, z);
    case "cylinder":
      return cylinder(r, z);
    case "cone":
      return cone(r, z);
    case "sphere":
      return sphere(Math.min(r, z / 2));
  }
}
