// Cutting a model on a plane: each volume is split, every cut face capped
// (holes and all), so both halves stay closed solids. Triangles the plane
// misses keep their paint as it is; the pieces of the ones it crosses
// take the paint at their centre.

import { ShapeUtils, Vector2 } from "three";
import { makeObject, makeVolume, type ModelObject, type Volume } from "./document";
import { determinant, identity, invert, multiply, translation, type Mat4, type Mesh, type Vec3 } from "./mesh";
import { frustum } from "./primitives";
import { PaintLayer, type PaintKind } from "./paint";

export interface Plane {
  /** A point on the plane. */
  point: Vec3;
  /** Its normal: the "upper" side is where it points. */
  normal: Vec3;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The plane in a volume's mesh coordinates (the volume's matrix undone). */
export function planeInFrame(plane: Plane, m: Mat4): Plane {
  const inv = invert(m);
  if (!inv) return plane;
  const p = plane.point;
  const point: Vec3 = [
    inv[0] * p[0] + inv[4] * p[1] + inv[8] * p[2] + inv[12],
    inv[1] * p[0] + inv[5] * p[1] + inv[9] * p[2] + inv[13],
    inv[2] * p[0] + inv[6] * p[1] + inv[10] * p[2] + inv[14],
  ];
  // Normals map by the inverse transpose: n' = Mᵀ n.
  const n = plane.normal;
  const normal = norm([
    m[0] * n[0] + m[1] * n[1] + m[2] * n[2],
    m[4] * n[0] + m[5] * n[1] + m[6] * n[2],
    m[8] * n[0] + m[9] * n[1] + m[10] * n[2],
  ]);
  return { point, normal };
}

export interface MeshCut {
  /** Above the plane (where the normal points), capped; null when empty. */
  upper: Mesh | null;
  lower: Mesh | null;
  /** Per new triangle, the original triangle it came from (-1: cap). */
  upperFrom: Int32Array;
  lowerFrom: Int32Array;
  /** Whether a triangle was kept whole (its paint copies exactly). */
  upperWhole: Uint8Array;
  lowerWhole: Uint8Array;
  /** Cut outlines that didn't close (an open mesh): their caps are missing. */
  openLoops: number;
}

/**
 * Split `mesh` by `plane` (in the mesh's coordinates). Vertices within
 * `eps` of the plane count as above it, so no triangle is cut through a
 * corner.
 */
export function cutMesh(mesh: Mesh, plane: Plane, eps = 1e-5): MeshCut {
  const n = norm(plane.normal);
  const pos = mesh.positions;
  const nv = pos.length / 3;
  const d = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    const v = dot([pos[i * 3] - plane.point[0], pos[i * 3 + 1] - plane.point[1], pos[i * 3 + 2] - plane.point[2]], n);
    d[i] = Math.abs(v) < eps ? eps : v;
  }

  // Each side's vertices: original ones remapped, plus the crossing points
  // (shared per edge, so the cut edge stays welded).
  const sides = [0, 1].map(() => ({
    positions: [] as number[],
    indices: [] as number[],
    from: [] as number[],
    whole: [] as number[],
    remap: new Int32Array(nv).fill(-1),
    edgePoint: new Map<number, number>(),
    /** Cut segments, as directed pairs of vertex indices of this side. */
    segments: [] as [number, number][],
  }));
  const vertexOf = (side: number, v: number) => {
    const s = sides[side];
    if (s.remap[v] < 0) {
      s.remap[v] = s.positions.length / 3;
      s.positions.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    }
    return s.remap[v];
  };
  const crossing = (side: number, a: number, b: number) => {
    const s = sides[side];
    const key = Math.min(a, b) * nv + Math.max(a, b);
    let i = s.edgePoint.get(key);
    if (i === undefined) {
      // Interpolate from the lower index, so both sides get the same point.
      const [p, q] = a < b ? [a, b] : [b, a];
      const t = d[p] / (d[p] - d[q]);
      i = s.positions.length / 3;
      s.positions.push(
        pos[p * 3] + (pos[q * 3] - pos[p * 3]) * t,
        pos[p * 3 + 1] + (pos[q * 3 + 1] - pos[p * 3 + 1]) * t,
        pos[p * 3 + 2] + (pos[q * 3 + 2] - pos[p * 3 + 2]) * t,
      );
      s.edgePoint.set(key, i);
    }
    return i;
  };
  const emit = (side: number, a: number, b: number, c: number, from: number, whole: boolean) => {
    const s = sides[side];
    s.indices.push(a, b, c);
    s.from.push(from);
    s.whole.push(whole ? 1 : 0);
  };

  const idx = mesh.indices;
  for (let t = 0; t < idx.length / 3; t++) {
    const v = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    const up = v.map((x) => d[x] > 0);
    const count = up.filter(Boolean).length;
    if (count === 3 || count === 0) {
      const side = count === 3 ? 0 : 1;
      emit(side, vertexOf(side, v[0]), vertexOf(side, v[1]), vertexOf(side, v[2]), t, true);
      continue;
    }
    // Rotate so the lone vertex (alone on its side) comes first.
    const lone = up.findIndex((u) => (count === 1 ? u : !u));
    const a = v[lone];
    const b = v[(lone + 1) % 3];
    const c = v[(lone + 2) % 3];
    const loneSide = d[a] > 0 ? 0 : 1;
    const other = 1 - loneSide;
    // The lone corner's side: one triangle a, ab, ac.
    const ab0 = crossing(loneSide, a, b);
    const ac0 = crossing(loneSide, a, c);
    emit(loneSide, vertexOf(loneSide, a), ab0, ac0, t, false);
    // The other side: the quad ab, b, c, ac as two triangles.
    const ab1 = crossing(other, a, b);
    const ac1 = crossing(other, a, c);
    const vb = vertexOf(other, b);
    const vc = vertexOf(other, c);
    emit(other, ab1, vb, vc, t, false);
    emit(other, ab1, vc, ac1, t, false);
    // The cut edge, directed so each side's cap goes round the hole in
    // its boundary the other way from the side walls: ac → ab for the
    // lone side, ab → ac for the other.
    sides[loneSide].segments.push([ac0, ab0]);
    sides[other].segments.push([ab1, ac1]);
  }

  // Cap each side: chain the cut edges into loops, triangulate in the plane.
  const u = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
  const w = cross(n, u);
  let openLoops = 0;
  sides.forEach((s, side) => {
    const next = new Map<number, number>();
    for (const [a, b] of s.segments) next.set(a, b);
    const loops: number[][] = [];
    const seen = new Set<number>();
    for (const [start] of s.segments) {
      if (seen.has(start)) continue;
      const loop: number[] = [];
      let at: number | undefined = start;
      while (at !== undefined && !seen.has(at)) {
        seen.add(at);
        loop.push(at);
        at = next.get(at);
      }
      if (at === start && loop.length >= 3) loops.push(loop);
      else openLoops++;
    }
    if (!loops.length) return;
    const flat = (i: number) => {
      const p: Vec3 = [s.positions[i * 3], s.positions[i * 3 + 1], s.positions[i * 3 + 2]];
      return new Vector2(dot(p, u), dot(p, w));
    };
    const rings = loops.map((l) => l.map(flat));
    // Nesting: a ring inside an even number of others is an outline, odd a hole.
    const inside = (p: Vector2, ring: Vector2[]) => {
      let inn = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i];
        const b = ring[j];
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inn = !inn;
      }
      return inn;
    };
    const parents = rings.map((r, i) => rings.map((o, j) => (i !== j && inside(r[0], o) ? j : -1)).filter((j) => j >= 0));
    const outline = parents.map((p) => p.length % 2 === 0);
    // The cap faces away from the side it closes: down (-n) for the upper side.
    const want = side === 0 ? -1 : 1;
    rings.forEach((ring, i) => {
      if (!outline[i]) return;
      const holes = rings
        .map((_, j) => j)
        .filter((j) => !outline[j] && parents[j].includes(i) && parents[j].length === parents[i].length + 1);
      const all = [loops[i], ...holes.map((j) => loops[j])];
      const tris = ShapeUtils.triangulateShape(
        ring,
        holes.map((j) => rings[j]),
      );
      const ids = all.flat();
      for (const [a, b, c] of tris) {
        const ia = ids[a];
        let ib = ids[b];
        let ic = ids[c];
        const pa = flat(ia);
        const pb = flat(ib);
        const pc = flat(ic);
        // In the (u, w) plane, counter-clockwise faces +n.
        const ccw = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x) > 0;
        if (ccw !== (want > 0)) [ib, ic] = [ic, ib];
        s.indices.push(ia, ib, ic);
        s.from.push(-1);
        s.whole.push(0);
      }
    });
  });

  const out = (s: (typeof sides)[number]) =>
    s.indices.length ? { positions: Float32Array.from(s.positions), indices: Uint32Array.from(s.indices) } : null;
  return {
    upper: out(sides[0]),
    lower: out(sides[1]),
    upperFrom: Int32Array.from(sides[0].from),
    lowerFrom: Int32Array.from(sides[1].from),
    upperWhole: Uint8Array.from(sides[0].whole),
    lowerWhole: Uint8Array.from(sides[1].whole),
    openLoops,
  };
}

/** Paint for a cut piece: whole triangles copy theirs, pieces take the paint at their centre. */
function cutPaint(layer: PaintLayer, piece: Mesh, from: Int32Array, whole: Uint8Array): PaintLayer | undefined {
  const out = new PaintLayer(piece);
  const p = piece.positions;
  for (let t = 0; t < from.length; t++) {
    const src = from[t];
    if (src < 0) continue;
    if (whole[t]) {
      const s = layer.getString(src);
      if (s) out.setString(t, s);
      continue;
    }
    const c: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const i = piece.indices[t * 3 + k] * 3;
      c[0] += p[i] / 3;
      c[1] += p[i + 1] / 3;
      c[2] += p[i + 2] / 3;
    }
    const state = layer.stateAt(src, c);
    if (state) out.setTriangle(t, state);
  }
  return out.empty ? undefined : out;
}

export interface ObjectCut {
  upper: ModelObject | null;
  lower: ModelObject | null;
  /** Cut outlines that didn't close (the model isn't watertight). */
  openLoops: number;
}

/**
 * Cut an object on a plane given in the object's own coordinates. Each
 * half keeps the volumes (and parts of volumes) on its side; a half with
 * no model part left is null.
 */
export function cutObject(o: ModelObject, plane: Plane): ObjectCut {
  const halves: Volume[][] = [[], []];
  let openLoops = 0;
  for (const v of o.volumes) {
    const local = planeInFrame(plane, v.matrix);
    // A mirrored volume's "upper" side is mirrored too: flip the normal so
    // upper stays upper in the object.
    if (determinant(v.matrix) < 0) local.normal = [-local.normal[0], -local.normal[1], -local.normal[2]];
    const cut = cutMesh(v.mesh, local);
    openLoops += v.type === "part" ? cut.openLoops : 0;
    const pieces: [Mesh | null, Int32Array, Uint8Array][] = [
      [cut.upper, cut.upperFrom, cut.upperWhole],
      [cut.lower, cut.lowerFrom, cut.lowerWhole],
    ];
    pieces.forEach(([mesh, from, whole], side) => {
      if (!mesh) return;
      const paint: Volume["paint"] = {};
      for (const [kind, layer] of Object.entries(v.paint) as [PaintKind, PaintLayer | undefined][]) {
        if (!layer) continue;
        const piece = cutPaint(layer, mesh, from, whole);
        if (piece) paint[kind] = piece;
      }
      halves[side].push(
        makeVolume(mesh, {
          name: v.name,
          type: v.type,
          matrix: v.matrix,
          extruder: v.extruder,
          paint,
          settings: { ...v.settings },
        }),
      );
    });
  }
  const half = (vs: Volume[], suffix: string) =>
    vs.some((v) => v.type === "part")
      ? makeObject(`${o.name} (${suffix})`, vs, { extruder: o.extruder, settings: { ...o.settings } })
      : null;
  return { upper: half(halves[0], "upper"), lower: half(halves[1], "lower"), openLoops };
}

// ---- Connectors -------------------------------------------------------------

/** How the halves join (the desktop slicer's connectors). */
export type ConnectorKind = "plug" | "dowel";
export type ConnectorShape = "round" | "square" | "hexagon";

export interface ConnectorSpec {
  kind: ConnectorKind;
  shape: ConnectorShape;
  /** Across (mm). */
  size: number;
  /** How far it goes into each half (mm). */
  depth: number;
  /** Extra room in the holes for a fit and glue (mm, on each side). */
  gap: number;
}

export const DEFAULT_CONNECTOR: ConnectorSpec = { kind: "plug", shape: "round", size: 5, depth: 5, gap: 0.1 };

/** A rotation taking +Z to `n`. */
function alignZ(n: Vec3): Mat4 {
  const z = norm(n);
  const helper: Vec3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = norm(cross(helper, z));
  const y = cross(z, x);
  const m = identity();
  m[0] = x[0];
  m[1] = x[1];
  m[2] = x[2];
  m[4] = y[0];
  m[5] = y[1];
  m[6] = y[2];
  m[8] = z[0];
  m[9] = z[1];
  m[10] = z[2];
  return m;
}

/** A prism of the connector's shape along +Z, `length` long, starting at z = 0. */
function prism(shape: ConnectorShape, across: number, length: number): Mesh {
  const segments = shape === "square" ? 4 : shape === "hexagon" ? 6 : undefined;
  // Polygons are sized by their flats: `across` is the distance across them.
  const r = shape === "square" ? (across / 2) * Math.SQRT2 : shape === "hexagon" ? across / Math.sqrt(3) : across / 2;
  const m = frustum(r, r, length, segments);
  const p = m.positions;
  for (let i = 2; i < p.length; i += 3) p[i] += length / 2;
  return m;
}

/**
 * Connectors at `points` (on the cut plane, object coordinates) between
 * the halves of a cut. Plugs: a peg on the lower half pointing up and a
 * hole in the upper half (the upper half is the one laid on its cut face,
 * holes down). Dowels: holes in both halves and pins of their own.
 */
export function addConnectors(
  cut: { upper: ModelObject | null; lower: ModelObject | null },
  plane: Plane,
  points: Vec3[],
  spec: ConnectorSpec,
): { upper: ModelObject | null; lower: ModelObject | null; pins: ModelObject | null } {
  const { upper, lower } = cut;
  if (!upper || !lower || points.length === 0) return { upper, lower, pins: null };
  const n = norm(plane.normal);
  const up = alignZ(n);
  const down = alignZ([-n[0], -n[1], -n[2]]);
  const at = (p: Vec3, frame: Mat4) => multiply(translation(p[0], p[1], p[2]), frame);
  const hole = (p: Vec3, frame: Mat4, i: number) =>
    makeVolume(prism(spec.shape, spec.size + 2 * spec.gap, spec.depth + spec.gap), {
      name: `Connector hole ${i + 1}`,
      type: "negative",
      // Starts a hair outside the cut face, so the hole opens cleanly.
      matrix: multiply(at(p, frame), translation(0, 0, -0.01)),
    });
  const upperVolumes = [...upper.volumes];
  const lowerVolumes = [...lower.volumes];
  let pins: ModelObject | null = null;
  points.forEach((p, i) => {
    upperVolumes.push(hole(p, up, i));
    if (spec.kind === "plug")
      lowerVolumes.push(
        makeVolume(prism(spec.shape, spec.size, spec.depth), { name: `Connector ${i + 1}`, type: "part", matrix: at(p, up) }),
      );
    else lowerVolumes.push(hole(p, down, i));
  });
  if (spec.kind === "dowel") {
    // The pins, side by side, a little shorter than both holes together.
    const length = Math.max(1, 2 * spec.depth - 0.4);
    const pinVolumes = points.map((_, i) =>
      makeVolume(prism(spec.shape, spec.size, length), {
        name: `Dowel ${i + 1}`,
        matrix: translation(i * (spec.size + 3), 0, 0),
      }),
    );
    const base = upper.name.endsWith(" (upper)") ? upper.name.slice(0, -" (upper)".length) : upper.name;
    pins = makeObject(`${base} dowels`, pinVolumes, { extruder: upper.extruder });
  }
  return {
    upper: { ...upper, volumes: upperVolumes },
    lower: { ...lower, volumes: lowerVolumes },
    pins,
  };
}

/** The cut face of the model parts, in the object's coordinates: its points, centroid and area. */
export function cutSection(o: ModelObject, plane: Plane): { centroid: Vec3; points: Vec3[]; area: number } | null {
  const pts: Vec3[] = [];
  let area = 0;
  const c: Vec3 = [0, 0, 0];
  for (const v of o.volumes) {
    if (v.type !== "part") continue;
    const cut = cutMesh(v.mesh, planeInFrame(plane, v.matrix));
    const piece = cut.lower;
    if (!piece) continue;
    const m = v.matrix;
    for (let t = 0; t < cut.lowerFrom.length; t++) {
      if (cut.lowerFrom[t] >= 0) continue;
      const tri = [0, 1, 2].map((k): Vec3 => {
        const i = piece.indices[t * 3 + k] * 3;
        const q = [piece.positions[i], piece.positions[i + 1], piece.positions[i + 2]];
        return [
          m[0] * q[0] + m[4] * q[1] + m[8] * q[2] + m[12],
          m[1] * q[0] + m[5] * q[1] + m[9] * q[2] + m[13],
          m[2] * q[0] + m[6] * q[1] + m[10] * q[2] + m[14],
        ];
      });
      const a = Math.hypot(...cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]))) / 2;
      area += a;
      for (const q of tri) {
        pts.push(q);
        for (let k = 0; k < 3; k++) c[k] += (q[k] * a) / 3;
      }
    }
  }
  if (!area) return null;
  return { centroid: [c[0] / area, c[1] / area, c[2] / area], points: pts, area };
}

/**
 * Where `count` connectors go on a cut face: along its longest direction,
 * a quarter in from each end (the centroid alone for one).
 */
export function connectorPoints(section: { centroid: Vec3; points: Vec3[] }, plane: Plane, count: number): Vec3[] {
  const { centroid, points } = section;
  if (count <= 1) return [centroid];
  const n = norm(plane.normal);
  const u0 = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
  const w = cross(n, u0);
  const extent = (dir: Vec3) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      const t = dot(sub(p, centroid), dir);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    return [lo, hi];
  };
  let best = u0;
  let width = -1;
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * Math.PI;
    const dir: Vec3 = [
      u0[0] * Math.cos(a) + w[0] * Math.sin(a),
      u0[1] * Math.cos(a) + w[1] * Math.sin(a),
      u0[2] * Math.cos(a) + w[2] * Math.sin(a),
    ];
    const [lo, hi] = extent(dir);
    if (hi - lo > width + 1e-9) {
      width = hi - lo;
      best = dir;
    }
  }
  const [lo, hi] = extent(best);
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const t = lo + (hi - lo) * (0.25 + (0.5 * i) / (count - 1));
    out.push([centroid[0] + best[0] * t, centroid[1] + best[1] * t, centroid[2] + best[2] * t]);
  }
  return out;
}

// ---- Cutting to fit the printer ----------------------------------------------

/**
 * Planes (in the object's coordinates) that cut the model, as it sits in
 * the scene (`toWorld`: the object's frame to the scene), into pieces at
 * most `fit` long along each scene axis: evenly spaced, as few as do.
 * Plugs stand out of their piece by their depth: leave room for it in
 * `fit`.
 */
export function fitPlanes(o: ModelObject, toWorld: Mat4, fit: Vec3): Plane[] {
  const box = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
  for (const v of o.volumes) {
    if (v.type !== "part") continue;
    const m = multiply(toWorld, v.matrix);
    const p = v.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = [
        m[0] * p[i] + m[4] * p[i + 1] + m[8] * p[i + 2] + m[12],
        m[1] * p[i] + m[5] * p[i + 1] + m[9] * p[i + 2] + m[13],
        m[2] * p[i] + m[6] * p[i + 1] + m[10] * p[i + 2] + m[14],
      ];
      for (let k = 0; k < 3; k++) {
        box.min[k] = Math.min(box.min[k], x[k]);
        box.max[k] = Math.max(box.max[k], x[k]);
      }
    }
  }
  const planes: Plane[] = [];
  for (let k = 0; k < 3; k++) {
    const size = box.max[k] - box.min[k];
    if (!(fit[k] > 0) || !Number.isFinite(fit[k]) || size <= fit[k]) continue;
    const pieces = Math.ceil(size / fit[k]);
    for (let i = 1; i < pieces; i++) {
      const point: Vec3 = [0, 0, 0];
      point[k] = box.min[k] + (size * i) / pieces;
      const normal: Vec3 = [0, 0, 0];
      normal[k] = 1;
      planes.push(planeInFrame({ point, normal }, toWorld));
    }
  }
  return planes;
}

/**
 * Cut a model on every plane in turn. With `connector`, each cut gets
 * `count` of them where its face is wide enough (three connectors across,
 * at least). The pieces are numbered; dowel pins come as models of their
 * own.
 */
export function cutIntoPieces(
  o: ModelObject,
  planes: Plane[],
  connector: { spec: ConnectorSpec; count: number } | null,
): { pieces: ModelObject[]; pins: ModelObject[]; openLoops: number } {
  let pieces = [o];
  const pins: ModelObject[] = [];
  let openLoops = 0;
  for (const plane of planes) {
    const next: ModelObject[] = [];
    for (const piece of pieces) {
      const cut = cutObject(piece, plane);
      openLoops += cut.openLoops;
      let halves: { upper: ModelObject | null; lower: ModelObject | null } = cut;
      if (connector && connector.count > 0 && cut.upper && cut.lower) {
        const section = cutSection(piece, plane);
        const room = connector.spec.size * 3;
        if (section && section.area >= room * room) {
          const joined = addConnectors(cut, plane, connectorPoints(section, plane, connector.count), connector.spec);
          halves = joined;
          if (joined.pins) pins.push(joined.pins);
        }
      }
      for (const h of [halves.lower, halves.upper]) if (h) next.push(h);
    }
    pieces = next;
  }
  if (pieces.length > 1) pieces = pieces.map((p, i) => ({ ...p, name: `${o.name} ${i + 1}/${pieces.length}` }));
  return { pieces, pins: pins.map((p, i) => ({ ...p, name: `${o.name} dowels${pins.length > 1 ? ` ${i + 1}` : ""}` })), openLoops };
}
