// Indexed triangle meshes: what every model, volume, cut piece and paint
// layer is made of. Plain typed arrays, no three.js, so it runs in workers
// and under `bun test`.
//
// Transforms are 4x4 matrices in three.js's layout (column-major
// `Float64Array(16)`: `elements` of a THREE.Matrix4), so the viewer can
// hand them over as they are. A 3MF transform's 12 numbers are elements
// 0,1,2, 4,5,6, 8,9,10, 12,13,14 of it.

export interface Mesh {
  /** x, y, z per vertex (mm). */
  positions: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  indices: Uint32Array;
}

export type Mat4 = Float64Array;
export type Vec3 = [number, number, number];

export function triangleCount(mesh: Mesh): number {
  return mesh.indices.length / 3;
}

export function vertexCount(mesh: Mesh): number {
  return mesh.positions.length / 3;
}

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function isIdentity(m: Mat4, eps = 1e-12): boolean {
  const id = identity();
  for (let i = 0; i < 16; i++) if (Math.abs(m[i] - id[i]) > eps) return false;
  return true;
}

/** a × b (apply b first, then a), both column-major. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  return out;
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function scaling(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

/** Inverse of an affine matrix; null when singular. */
export function invert(m: Mat4): Mat4 | null {
  const [a, b, c] = [m[0], m[4], m[8]];
  const [d, e, f] = [m[1], m[5], m[9]];
  const [g, h, i] = [m[2], m[6], m[10]];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-300) return null;
  const inv = 1 / det;
  // Rows of the inverse 3x3.
  const r = [
    [A * inv, -(b * i - c * h) * inv, (b * f - c * e) * inv],
    [B * inv, (a * i - c * g) * inv, -(a * f - c * d) * inv],
    [C * inv, -(a * h - b * g) * inv, (a * e - b * d) * inv],
  ];
  const out = identity();
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) out[col * 4 + row] = r[row][col];
  const t = [m[12], m[13], m[14]];
  for (let row = 0; row < 3; row++) out[12 + row] = -(r[row][0] * t[0] + r[row][1] * t[1] + r[row][2] * t[2]);
  return out;
}

/** Determinant of the linear part: negative = mirrored. */
export function determinant(m: Mat4): number {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

export function applyPoint(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** A copy of the mesh with `m` applied to every vertex; a mirroring
 *  matrix also flips the triangles so they still face out. */
export function transformMesh(mesh: Mesh, m: Mat4): Mesh {
  const p = mesh.positions;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const v = applyPoint(m, p[i], p[i + 1], p[i + 2]);
    out[i] = v[0];
    out[i + 1] = v[1];
    out[i + 2] = v[2];
  }
  let indices = mesh.indices;
  if (determinant(m) < 0) {
    indices = new Uint32Array(mesh.indices);
    for (let t = 0; t < indices.length; t += 3) {
      const tmp = indices[t + 1];
      indices[t + 1] = indices[t + 2];
      indices[t + 2] = tmp;
    }
  }
  return { positions: out, indices };
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

export function emptyBox(): Box {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

export function boxIsEmpty(b: Box): boolean {
  return !(b.min[0] <= b.max[0]);
}

/** Bounds of the mesh, after `m` when given. Only referenced vertices count. */
export function meshBounds(mesh: Mesh, m?: Mat4, into: Box = emptyBox()): Box {
  const p = mesh.positions;
  const seen = new Uint8Array(p.length / 3);
  for (const i of mesh.indices) seen[i] = 1;
  for (let i = 0; i < seen.length; i++) {
    if (!seen[i]) continue;
    const v: Vec3 = m ? applyPoint(m, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) : [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
    for (let k = 0; k < 3; k++) {
      if (v[k] < into.min[k]) into.min[k] = v[k];
      if (v[k] > into.max[k]) into.max[k] = v[k];
    }
  }
  return into;
}

/** Unit normal of triangle `t` (zero for a degenerate one). */
export function triangleNormal(mesh: Mesh, t: number): Vec3 {
  const p = mesh.positions;
  const ia = mesh.indices[t * 3] * 3;
  const ib = mesh.indices[t * 3 + 1] * 3;
  const ic = mesh.indices[t * 3 + 2] * 3;
  const ux = p[ib] - p[ia];
  const uy = p[ib + 1] - p[ia + 1];
  const uz = p[ib + 2] - p[ia + 2];
  const vx = p[ic] - p[ia];
  const vy = p[ic + 1] - p[ia + 1];
  const vz = p[ic + 2] - p[ia + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return len > 0 ? [nx / len, ny / len, nz / len] : [0, 0, 0];
}

/** Every triangle's unit normal. */
export function faceNormals(mesh: Mesh): Float32Array {
  const n = triangleCount(mesh);
  const out = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    const v = triangleNormal(mesh, t);
    out[t * 3] = v[0];
    out[t * 3 + 1] = v[1];
    out[t * 3 + 2] = v[2];
  }
  return out;
}

/** Signed volume (mm³): positive when the triangles face out. */
export function signedVolume(mesh: Mesh): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

export function surfaceArea(mesh: Mesh): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  let area = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return area;
}

/** Hash of a vertex's float bits, for welding. */
function hash3(a: number, b: number, c: number): number {
  return (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d)) >>> 0;
}

/**
 * Merge vertices at exactly the same position (an STL repeats each one
 * ~6 times) and drop vertices no triangle uses. Triangle order is kept:
 * triangle `t` of the result is triangle `t` of the input.
 */
export function weld(mesh: Mesh): Mesh {
  const src = mesh.positions;
  const total = src.length / 3;
  const bits = new Uint32Array(src.buffer, src.byteOffset, src.length);
  const size = 1 << Math.ceil(Math.log2(Math.max(2, total * 2)));
  const table = new Int32Array(size).fill(-1);
  const remap = new Int32Array(total).fill(-1);
  const used = new Uint8Array(total);
  for (const i of mesh.indices) used[i] = 1;
  const out = new Float32Array(src.length);
  const outBits = new Uint32Array(out.buffer);
  let kept = 0;
  for (let i = 0; i < total; i++) {
    if (!used[i]) continue;
    const a = bits[i * 3];
    const b = bits[i * 3 + 1];
    const c = bits[i * 3 + 2];
    let h = hash3(a, b, c);
    for (;;) {
      h &= size - 1;
      const j = table[h];
      if (j < 0) {
        table[h] = kept;
        remap[i] = kept;
        out[kept * 3] = src[i * 3];
        out[kept * 3 + 1] = src[i * 3 + 1];
        out[kept * 3 + 2] = src[i * 3 + 2];
        kept++;
        break;
      }
      if (outBits[j * 3] === a && outBits[j * 3 + 1] === b && outBits[j * 3 + 2] === c) {
        remap[i] = j;
        break;
      }
      h++;
    }
  }
  const indices = new Uint32Array(mesh.indices.length);
  for (let t = 0; t < indices.length; t++) indices[t] = remap[mesh.indices[t]];
  return { positions: out.slice(0, kept * 3), indices };
}

/**
 * For every triangle, the triangle across each of its edges (edge k runs
 * from vertex k to vertex k+1), or -1: what libslic3r's
 * `its_face_neighbors` gives TriangleSelector. Edges shared by more than
 * two triangles (non-manifold) pair up the first two seen, oppositely
 * oriented ones preferred.
 */
export function faceNeighbors(mesh: Mesh): Int32Array {
  const idx = mesh.indices;
  const n = idx.length / 3;
  const out = new Int32Array(n * 3).fill(-1);
  // Edges keyed by (min, max) vertex in a hash table of edge ids.
  const edgeCount = n * 3;
  const size = 1 << Math.ceil(Math.log2(Math.max(2, edgeCount * 2)));
  const keysA = new Int32Array(size).fill(-1);
  const keysB = new Int32Array(size);
  const first = new Int32Array(size).fill(-1); // half-edge id (t*3+k) waiting for a partner
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const v0 = idx[t * 3 + k];
      const v1 = idx[t * 3 + ((k + 1) % 3)];
      const a = Math.min(v0, v1);
      const b = Math.max(v0, v1);
      let h = hash3(a, b, 0x5bd1e995);
      for (;;) {
        h &= size - 1;
        if (keysA[h] < 0) {
          keysA[h] = a;
          keysB[h] = b;
          first[h] = t * 3 + k;
          break;
        }
        if (keysA[h] === a && keysB[h] === b) {
          const other = first[h];
          if (other >= 0) {
            const ot = (other / 3) | 0;
            const ok = other % 3;
            out[t * 3 + k] = ot;
            out[ot * 3 + ok] = t;
            first[h] = -1;
          }
          // A third triangle on this edge stays without a neighbour there.
          break;
        }
        h++;
      }
    }
  }
  return out;
}

/** Groups of triangles connected through shared vertices: a part each. */
export function connectedComponents(mesh: Mesh): Uint32Array[] {
  const idx = mesh.indices;
  const nv = mesh.positions.length / 3;
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(idx[t]);
    parent[find(idx[t + 1])] = a;
    parent[find(idx[t + 2])] = a;
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < idx.length / 3; t++) {
    const root = find(idx[t * 3]);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = []));
    g.push(t);
  }
  return [...groups.values()].map((g) => Uint32Array.from(g));
}

/** The triangles `tris` of a mesh as a mesh of their own, with only the
 *  vertices they use, in order. */
export function submesh(mesh: Mesh, tris: ArrayLike<number>): Mesh {
  const remap = new Int32Array(mesh.positions.length / 3).fill(-1);
  const pos: number[] = [];
  const indices = new Uint32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[tris[i] * 3 + k];
      if (remap[v] < 0) {
        remap[v] = pos.length / 3;
        pos.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      }
      indices[i * 3 + k] = remap[v];
    }
  }
  return { positions: Float32Array.from(pos), indices };
}

/** Several meshes as one (vertices and triangles appended in order). */
export function mergeMeshes(meshes: Mesh[]): Mesh {
  let nv = 0;
  let nt = 0;
  for (const m of meshes) {
    nv += m.positions.length;
    nt += m.indices.length;
  }
  const positions = new Float32Array(nv);
  const indices = new Uint32Array(nt);
  let pv = 0;
  let pt = 0;
  for (const m of meshes) {
    positions.set(m.positions, pv);
    const base = pv / 3;
    for (let i = 0; i < m.indices.length; i++) indices[pt + i] = m.indices[i] + base;
    pv += m.positions.length;
    pt += m.indices.length;
  }
  return { positions, indices };
}

export function cloneMesh(mesh: Mesh): Mesh {
  return { positions: mesh.positions.slice(), indices: mesh.indices.slice() };
}

/** Reverse every triangle (inside out ⇄ outside out). */
export function flipMesh(mesh: Mesh): Mesh {
  const indices = mesh.indices.slice();
  for (let t = 0; t < indices.length; t += 3) {
    const tmp = indices[t + 1];
    indices[t + 1] = indices[t + 2];
    indices[t + 2] = tmp;
  }
  return { positions: mesh.positions, indices };
}

/** Edges used by exactly one triangle: a closed (watertight) mesh has none. */
export function openEdgeCount(mesh: Mesh): number {
  const nb = faceNeighbors(mesh);
  let open = 0;
  for (const v of nb) if (v < 0) open++;
  return open;
}
