// Painting on a mesh's surface, as libslic3r's TriangleSelector does it:
// each original triangle may be split (into 2, 3 or 4) again and again
// around the brush's edge, and every leaf has a state. The data reads and
// writes the 3MF attributes OrcaSlicer and Bambu Studio use
// (`paint_color`, `paint_supports`, `paint_seam`, `paint_fuzzy_skin`), so
// a painted model slices as the desktop app would slice it.
//
// Split rule (TriangleSelector::perform_split): with the triangle's
// vertices taken from its "special side" on, r0 r1 r2,
//   1 side split:  m = mid(r1, r2); children (r0 r1 m), (m r2 r0)
//   2 sides split: m1 = mid(r0, r1), m2 = mid(r0, r2);
//                  children (r0 m1 m2), (m1 r1 m2), (r1 r2 m2)
//   3 sides split: special side 0, m01 m12 m20;
//                  children (r0 m01 m20), (m01 r1 m12), (m12 r2 m20), (m01 m12 m20)
//
// Serialization (TriangleSelector::serialize + get_triangle_as_string): per
// painted triangle a stream of 4-bit codes, depth first; a split node is
// `split | special << 2` followed by its children last to first; a leaf is
// `state << 2` (state 0-2) or `0b1100` then `state - 3` (3-15). The hex
// string holds the codes last first.

import { applyPoint, faceNeighbors, triangleCount, type Mat4, type Mesh, type Vec3 } from "./mesh";

export type PaintKind = "color" | "supports" | "seam" | "fuzzy";

/** The 3MF triangle attribute of each kind (bbs_3mf.cpp). */
export const PAINT_ATTRIBUTE: Record<PaintKind, string> = {
  color: "paint_color",
  supports: "paint_supports",
  seam: "paint_seam",
  fuzzy: "paint_fuzzy_skin",
};

/** PrusaSlicer's names for the same data (read only). */
export const PRUSA_PAINT_ATTRIBUTE: Record<string, PaintKind> = {
  "slic3rpe:mmu_segmentation": "color",
  "slic3rpe:custom_supports": "supports",
  "slic3rpe:custom_seam": "seam",
};

/** Supports and seams: 1 enforces, 2 blocks. Colour: 1..N is filament N.
 *  Fuzzy skin: 1 is on. 0 is unpainted everywhere. */
export const ENFORCER = 1;
export const BLOCKER = 2;
/** Highest state the format holds (4 bits + 3). */
export const MAX_STATE = 18;

interface Node {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  state: number;
  /** 0 = leaf, else how many sides are split (1-3). */
  split: number;
  special: number;
  children: Node[] | null;
}

function mid(p: Vec3, q: Vec3): Vec3 {
  return [Math.fround((p[0] + q[0]) / 2), Math.fround((p[1] + q[1]) / 2), Math.fround((p[2] + q[2]) / 2)];
}

function leaf(a: Vec3, b: Vec3, c: Vec3, state: number): Node {
  return { a, b, c, state, split: 0, special: 0, children: null };
}

/** Split `n` (split/special set) into children that inherit `state`. */
function performSplit(n: Node, state: number) {
  const v = [n.a, n.b, n.c];
  const s = n.special;
  const r0 = v[s];
  const r1 = v[(s + 1) % 3];
  const r2 = v[(s + 2) % 3];
  switch (n.split) {
    case 1: {
      const m = mid(r2, r1);
      n.children = [leaf(r0, r1, m, state), leaf(m, r2, r0, state)];
      break;
    }
    case 2: {
      const m1 = mid(r1, r0);
      const m2 = mid(r0, r2);
      n.children = [leaf(r0, m1, m2, state), leaf(m1, r1, m2, state), leaf(r1, r2, m2, state)];
      break;
    }
    case 3: {
      const m01 = mid(r1, r0);
      const m12 = mid(r2, r1);
      const m20 = mid(r0, r2);
      n.children = [
        leaf(r0, m01, m20, state),
        leaf(m01, r1, m12, state),
        leaf(m12, r2, m20, state),
        leaf(m01, m12, m20, state),
      ];
      break;
    }
  }
  n.state = 0;
}

function undivide(n: Node) {
  n.children = null;
  n.split = 0;
  n.special = 0;
}

/** Merge children that ended up as leaves of one state. */
function removeUselessChildren(n: Node) {
  if (!n.children) return;
  for (const c of n.children) if (c.children) removeUselessChildren(c);
  const first = n.children[0];
  if (first.children) return;
  for (const c of n.children) if (c.children || c.state !== first.state) return;
  const state = first.state;
  undivide(n);
  n.state = state;
}

const HEX = "0123456789ABCDEF";

function serializeNode(n: Node, out: number[]) {
  if (n.children) {
    out.push(n.split | (n.special << 2));
    for (let i = n.split; i >= 0; i--) serializeNode(n.children[i], out);
  } else if (n.state >= 3) {
    out.push(0b1100, n.state - 3);
  } else {
    out.push(n.state << 2);
  }
}

/** Where a brush is, in the coordinates the layer's `trafo` maps to. */
export interface Cursor {
  kind: "circle" | "sphere" | "height";
  /** Circle and sphere: centre (world). */
  center?: Vec3;
  radius?: number;
  /** Circle: the view direction (unit, world). Also hides faces turned away. */
  dir?: Vec3;
  /** Height range: world Z band [z0, z1]. */
  z0?: number;
  z1?: number;
}

export interface BrushOptions {
  /** Split triangles to follow the brush's edge (false = whole triangles). */
  splitting?: boolean;
  /** Only paint faces at most this far from facing down (deg); 0 = any face. */
  overhangDeg?: number;
}

function sub(p: Vec3, q: Vec3): Vec3 {
  return [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
}
function dot(p: Vec3, q: Vec3): number {
  return p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
}
function len2(p: Vec3): number {
  return dot(p, p);
}

/** One paint layer (one kind) of one volume's mesh. */
export class PaintLayer {
  readonly mesh: Mesh;
  /** Painted or split original triangles; the rest are unpainted. */
  private roots = new Map<number, Node>();
  private neighbors: Int32Array | null = null;
  private normals: Float32Array | null = null;

  constructor(mesh: Mesh) {
    this.mesh = mesh;
  }

  get empty(): boolean {
    return this.roots.size === 0;
  }

  /** Original triangles with paint (or splits). */
  painted(): number[] {
    return [...this.roots.keys()].sort((x, y) => x - y);
  }

  clear() {
    this.roots.clear();
  }

  clone(mesh: Mesh = this.mesh): PaintLayer {
    const out = new PaintLayer(mesh);
    for (const t of this.roots.keys()) out.setString(t, this.getString(t));
    return out;
  }

  private corners(t: number): [Vec3, Vec3, Vec3] {
    const p = this.mesh.positions;
    const i = this.mesh.indices;
    const v = (k: number): Vec3 => {
      const j = i[t * 3 + k] * 3;
      return [p[j], p[j + 1], p[j + 2]];
    };
    return [v(0), v(1), v(2)];
  }

  private root(t: number): Node {
    let n = this.roots.get(t);
    if (!n) {
      const [a, b, c] = this.corners(t);
      n = leaf(a, b, c, 0);
      this.roots.set(t, n);
    }
    return n;
  }

  private prune(t: number) {
    const n = this.roots.get(t);
    if (n && !n.children && n.state === 0) this.roots.delete(t);
  }

  /** The 3MF attribute value for triangle `t` ("" = unpainted). */
  getString(t: number): string {
    const n = this.roots.get(t);
    if (!n || (!n.children && n.state === 0)) return "";
    const codes: number[] = [];
    serializeNode(n, codes);
    let s = "";
    for (let i = codes.length - 1; i >= 0; i--) s += HEX[codes[i]];
    return s;
  }

  /** Load triangle `t`'s paint from its 3MF attribute value. */
  setString(t: number, str: string) {
    if (!str) {
      this.roots.delete(t);
      return;
    }
    const codes: number[] = [];
    for (let i = str.length - 1; i >= 0; i--) {
      const d = HEX.indexOf(str[i].toUpperCase());
      if (d < 0) throw new Error(`paint: bad digit '${str[i]}'`);
      codes.push(d);
    }
    let at = 0;
    const next = () => {
      if (at >= codes.length) throw new Error("paint: data ends early");
      return codes[at++];
    };
    const read = (n: Node, depth: number) => {
      if (depth > 64) throw new Error("paint: split too deep");
      const code = next();
      const split = code & 0b11;
      if (split === 0) {
        const state = (code & 0b1100) === 0b1100 ? next() + 3 : code >> 2;
        n.state = Math.min(state, MAX_STATE);
        return;
      }
      n.split = split;
      n.special = split === 3 ? 0 : (code >> 2) % 3;
      performSplit(n, 0);
      for (let i = split; i >= 0; i--) read(n.children![i], depth + 1);
    };
    const [a, b, c] = this.corners(t);
    const n = leaf(a, b, c, 0);
    read(n, 0);
    this.roots.set(t, n);
    this.prune(t);
  }

  /** Paint a whole original triangle. */
  setTriangle(t: number, state: number) {
    const n = this.root(t);
    undivide(n);
    n.state = state;
    this.prune(t);
  }

  /** The state at a point of triangle `t` (barycentric descent). */
  stateAt(t: number, p: Vec3): number {
    const root = this.roots.get(t);
    if (!root) return 0;
    let n: Node = root;
    while (n.children) {
      let best: Node = n.children[0];
      let bestScore = -Infinity;
      for (const c of n.children) {
        const s = minBarycentric(p, c.a, c.b, c.c);
        if (s > bestScore) {
          bestScore = s;
          best = c;
        }
      }
      n = best;
    }
    return n.state;
  }

  /** States used anywhere (0 left out). */
  usedStates(): Set<number> {
    const out = new Set<number>();
    const walk = (n: Node) => {
      if (n.children) n.children.forEach(walk);
      else if (n.state) out.add(n.state);
    };
    this.roots.forEach(walk);
    return out;
  }

  /** Renumber states (`map[old]` = new; missing = unchanged). */
  remap(map: Map<number, number>) {
    const walk = (n: Node) => {
      if (n.children) n.children.forEach(walk);
      else if (map.has(n.state)) n.state = map.get(n.state)!;
    };
    for (const [t, n] of this.roots) {
      walk(n);
      removeUselessChildren(n);
      this.prune(t);
    }
  }

  /** Every painted leaf: its corners (9 floats each) and its state. */
  leaves(): { positions: Float32Array; states: Uint8Array; sources: Uint32Array } {
    const pos: number[] = [];
    const states: number[] = [];
    const sources: number[] = [];
    for (const [t, root] of this.roots) {
      const walk = (n: Node) => {
        if (n.children) return n.children.forEach(walk);
        if (!n.state) return;
        pos.push(...n.a, ...n.b, ...n.c);
        states.push(n.state);
        sources.push(t);
      };
      walk(root);
    }
    return { positions: Float32Array.from(pos), states: Uint8Array.from(states), sources: Uint32Array.from(sources) };
  }

  private ensureTopology() {
    if (!this.neighbors) this.neighbors = faceNeighbors(this.mesh);
    if (!this.normals) {
      const n = triangleCount(this.mesh);
      const out = new Float32Array(n * 3);
      for (let t = 0; t < n; t++) {
        const [a, b, c] = this.corners(t);
        const u = sub(b, a);
        const v = sub(c, a);
        const nx = u[1] * v[2] - u[2] * v[1];
        const ny = u[2] * v[0] - u[0] * v[2];
        const nz = u[0] * v[1] - u[1] * v[0];
        const l = Math.hypot(nx, ny, nz) || 1;
        out[t * 3] = nx / l;
        out[t * 3 + 1] = ny / l;
        out[t * 3 + 2] = nz / l;
      }
      this.normals = out;
    }
  }

  private worldNormal(t: number, trafo: Mat4 | null): Vec3 {
    const n = this.normals!;
    const v: Vec3 = [n[t * 3], n[t * 3 + 1], n[t * 3 + 2]];
    if (!trafo) return v;
    // Normal matrix = inverse transpose; for the facing test the cofactor
    // matrix (same direction) does.
    const m = trafo;
    const a = [m[0], m[1], m[2]];
    const b = [m[4], m[5], m[6]];
    const c = [m[8], m[9], m[10]];
    const cross = (p: number[], q: number[]): Vec3 => [
      p[1] * q[2] - p[2] * q[1],
      p[2] * q[0] - p[0] * q[2],
      p[0] * q[1] - p[1] * q[0],
    ];
    const r0 = cross(b, c);
    const r1 = cross(c, a);
    const r2 = cross(a, b);
    const w: Vec3 = [
      r0[0] * v[0] + r1[0] * v[1] + r2[0] * v[2],
      r0[1] * v[0] + r1[1] * v[1] + r2[1] * v[2],
      r0[2] * v[0] + r1[2] * v[1] + r2[2] * v[2],
    ];
    const l = Math.hypot(...w) || 1;
    return [w[0] / l, w[1] / l, w[2] / l];
  }

  /**
   * Paint `state` with the cursor, starting from original triangle `start`
   * (the one under the pointer) and spreading to neighbours it touches, as
   * TriangleSelector::select_patch does. `trafo` maps mesh coordinates to
   * the cursor's (the volume's world matrix). Returns the triangles changed.
   */
  brush(start: number, cursor: Cursor, state: number, trafo: Mat4 | null, opts: BrushOptions = {}): number[] {
    this.ensureTopology();
    const splitting = opts.splitting ?? true;
    const world = (p: Vec3): Vec3 => (trafo ? applyPoint(trafo, p[0], p[1], p[2]) : p);
    const inside = pointTest(cursor);
    const edgeIn = edgeTest(cursor);
    const edgeLimit2 =
      cursor.kind === "height" ? 0.1 * 0.1 : Math.max(0.05, Math.min((cursor.radius ?? 1) / 5, 0.5)) ** 2;
    const overhang = opts.overhangDeg ? -Math.cos((opts.overhangDeg * Math.PI) / 180) : null;

    const select = (n: Node): boolean => {
      const a = world(n.a);
      const b = world(n.b);
      const c = world(n.c);
      const k = (inside(a) ? 1 : 0) + (inside(b) ? 1 : 0) + (inside(c) ? 1 : 0);
      if (k === 0 && !pointerIn(cursor, a, b, c) && !edgeIn(a, b, c)) return false;
      if (k === 3) {
        undivide(n);
        n.state = state;
        return true;
      }
      if (!n.children && n.state === state) return true;
      if (splitting && !n.children) {
        const sides = [len2(sub(c, b)), len2(sub(a, c)), len2(sub(b, a))];
        const toSplit: number[] = [];
        let keep = -1;
        for (let i = 0; i < 3; i++) {
          if (sides[i] > edgeLimit2) toSplit.push(i);
          else keep = i;
        }
        if (toSplit.length) {
          n.split = toSplit.length;
          n.special = toSplit.length === 2 ? keep : toSplit[0];
          if (n.split === 3) n.special = 0;
          performSplit(n, n.state);
        }
      }
      // A leaf too small to split further and only partly under the brush
      // stays as it is (TriangleSelector does the same); without
      // splitting, the whole triangle takes the paint.
      if (!n.children) {
        if (!splitting) n.state = state;
        return true;
      }
      for (const child of n.children) select(child);
      return true;
    };

    const changed: number[] = [];
    const visited = new Set<number>();
    const queue: number[] = [];
    if (cursor.kind === "height") {
      // Every triangle crossing the band.
      for (let t = 0; t < triangleCount(this.mesh); t++) {
        const [a, b, c] = this.corners(t).map(world) as [Vec3, Vec3, Vec3];
        const lo = Math.min(a[2], b[2], c[2]);
        const hi = Math.max(a[2], b[2], c[2]);
        if (hi >= cursor.z0! && lo <= cursor.z1!) queue.push(t);
      }
    } else queue.push(start);
    const nb = this.neighbors!;
    for (let qi = 0; qi < queue.length; qi++) {
      const t = queue[qi];
      if (visited.has(t)) continue;
      visited.add(t);
      if (overhang !== null && this.worldNormal(t, trafo)[2] >= overhang) continue;
      const n = this.root(t);
      if (select(n)) {
        removeUselessChildren(n);
        changed.push(t);
        if (cursor.kind !== "height")
          for (let k = 0; k < 3; k++) {
            const o = nb[t * 3 + k];
            if (o >= 0 && !visited.has(o) && this.facing(o, cursor, trafo)) queue.push(o);
          }
      }
      this.prune(t);
    }
    return changed;
  }

  private facing(t: number, cursor: Cursor, trafo: Mat4 | null): boolean {
    if (!cursor.dir) return true;
    return dot(this.worldNormal(t, trafo), cursor.dir) < 0;
  }

  /**
   * Smart fill: from `start`, every connected original triangle whose
   * normal is within `angleDeg` of its neighbour's (a flat or gently
   * curved region), painted whole. `angleDeg` 0 = only exactly coplanar.
   */
  smartFill(start: number, angleDeg: number, state: number): number[] {
    this.ensureTopology();
    const limit = Math.cos((Math.max(angleDeg, 1e-3) * Math.PI) / 180) - 1e-9;
    return this.flood(start, (from, to) => this.normalDot(from, to) >= limit, state);
  }

  /** Bucket fill: the connected region of the start triangle's state. With
   *  `angleDeg`, also stop at edges sharper than that. */
  bucketFill(start: number, state: number, angleDeg?: number): number[] {
    this.ensureTopology();
    const target = this.stateOfRoot(start);
    const limit = angleDeg ? Math.cos((angleDeg * Math.PI) / 180) - 1e-9 : -2;
    return this.flood(start, (from, to) => this.stateOfRoot(to) === target && this.normalDot(from, to) >= limit, state);
  }

  private normalDot(a: number, b: number): number {
    const n = this.normals!;
    return n[a * 3] * n[b * 3] + n[a * 3 + 1] * n[b * 3 + 1] + n[a * 3 + 2] * n[b * 3 + 2];
  }

  /** A whole triangle's state, or -1 when it's split. */
  private stateOfRoot(t: number): number {
    const n = this.roots.get(t);
    if (!n) return 0;
    return n.children ? -1 : n.state;
  }

  private flood(start: number, ok: (from: number, to: number) => boolean, state: number): number[] {
    const nb = this.neighbors!;
    const seen = new Uint8Array(triangleCount(this.mesh));
    const out: number[] = [];
    const queue = [start];
    seen[start] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      const t = queue[qi];
      out.push(t);
      for (let k = 0; k < 3; k++) {
        const o = nb[t * 3 + k];
        if (o >= 0 && !seen[o] && ok(t, o)) {
          seen[o] = 1;
          queue.push(o);
        }
      }
    }
    for (const t of out) this.setTriangle(t, state);
    return out;
  }
}

/** The smallest barycentric coordinate of p in (a, b, c): ≥ 0 inside. */
function minBarycentric(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const v0 = sub(b, a);
  const v1 = sub(c, a);
  const v2 = sub(p, a);
  const d00 = dot(v0, v0);
  const d01 = dot(v0, v1);
  const d11 = dot(v1, v1);
  const d20 = dot(v2, v0);
  const d21 = dot(v2, v1);
  const den = d00 * d11 - d01 * d01;
  if (!den) return -Infinity;
  const v = (d11 * d20 - d01 * d21) / den;
  const w = (d00 * d21 - d01 * d20) / den;
  return Math.min(1 - v - w, v, w);
}

function pointTest(c: Cursor): (p: Vec3) => boolean {
  if (c.kind === "height") return (p) => p[2] >= c.z0! && p[2] <= c.z1!;
  const r2 = c.radius! ** 2;
  const center = c.center!;
  if (c.kind === "sphere") return (p) => len2(sub(center, p)) < r2;
  const dir = c.dir!;
  return (p) => {
    const d = sub(center, p);
    const along = dot(d, dir);
    return len2(d) - along * along < r2;
  };
}

/** Whether the cursor's centre falls in the triangle (seen along dir for a
 *  circle; projected onto its plane for a sphere). */
function pointerIn(c: Cursor, a: Vec3, b: Vec3, cc: Vec3): boolean {
  if (c.kind === "height") return false;
  let p = c.center!;
  // Project the centre onto the triangle's plane.
  const u = sub(b, a);
  const v = sub(cc, a);
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const nn = len2(n);
  if (!nn) return false;
  const dist = dot(sub(p, a), n) / nn;
  p = [p[0] - n[0] * dist, p[1] - n[1] * dist, p[2] - n[2] * dist];
  return minBarycentric(p, a, b, cc) >= 0;
}

function edgeTest(c: Cursor): (a: Vec3, b: Vec3, cc: Vec3) => boolean {
  if (c.kind === "height")
    return (a, b, cc) => {
      const lo = Math.min(a[2], b[2], cc[2]);
      const hi = Math.max(a[2], b[2], cc[2]);
      return hi >= c.z0! && lo <= c.z1!;
    };
  const r2 = c.radius! ** 2;
  const center = c.center!;
  const dir = c.dir;
  return (a, b, cc) => {
    const pts = [a, b, cc];
    for (let s = 0; s < 3; s++) {
      const p = pts[s];
      const q = pts[(s + 1) % 3];
      const e = sub(q, p);
      const el = Math.sqrt(len2(e));
      if (!el) continue;
      const unit: Vec3 = [e[0] / el, e[1] / el, e[2] / el];
      const t = dot(sub(center, p), unit);
      if (t < 0 || t > el) continue;
      const foot: Vec3 = [p[0] + unit[0] * t, p[1] + unit[1] * t, p[2] + unit[2] * t];
      const d = sub(foot, center);
      let dist2 = len2(d);
      if (c.kind === "circle" && dir) dist2 -= dot(d, dir) ** 2;
      if (dist2 < r2) return true;
    }
    return false;
  };
}
