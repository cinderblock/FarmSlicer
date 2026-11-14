// STL files (binary and ASCII) to a welded mesh, triangles in file order.

import { weld, type Mesh } from "./mesh";

/** A binary STL is exactly 84 + 50 bytes per triangle; an ASCII one starts
 *  with "solid" and has "facet" in it (some binary headers say "solid" too). */
function isBinary(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  if (84 + count * 50 === bytes.length) return true;
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  return !(/^\s*solid/.test(head) && /facet/.test(head));
}

function readBinary(bytes: Uint8Array): Mesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.min(view.getUint32(80, true), Math.floor((bytes.length - 84) / 50));
  const positions = new Float32Array(count * 9);
  const indices = new Uint32Array(count * 3);
  for (let t = 0; t < count; t++) {
    const base = 84 + t * 50 + 12; // skip the stored normal
    for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(base + k * 4, true);
    indices[t * 3] = t * 3;
    indices[t * 3 + 1] = t * 3 + 1;
    indices[t * 3 + 2] = t * 3 + 2;
  }
  return { positions, indices };
}

function readAscii(text: string): Mesh {
  const pos: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) pos.push(Number(m[1]), Number(m[2]), Number(m[3]));
  const count = Math.floor(pos.length / 9);
  const indices = new Uint32Array(count * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions: Float32Array.from(pos.slice(0, count * 9)), indices };
}

/** Drop triangles with a NaN or infinite coordinate. */
function dropBad(mesh: Mesh): Mesh {
  const p = mesh.positions;
  const keep: number[] = [];
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    let ok = true;
    for (let k = 0; k < 9 && ok; k++) ok = Number.isFinite(p[t * 9 + k]);
    if (ok) keep.push(t);
  }
  if (keep.length * 3 === mesh.indices.length) return mesh;
  const positions = new Float32Array(keep.length * 9);
  keep.forEach((t, i) => positions.set(p.subarray(t * 9, t * 9 + 9), i * 9));
  const indices = new Uint32Array(keep.length * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

export function readStl(data: ArrayBuffer | Uint8Array): Mesh {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const raw = isBinary(bytes) ? readBinary(bytes) : readAscii(new TextDecoder().decode(bytes));
  const mesh = weld(dropBad(raw));
  if (mesh.indices.length === 0) throw new Error("The STL file has no triangles");
  return mesh;
}

/** A binary STL of `mesh` (for "Export STL"). */
export function writeStl(mesh: Mesh, header = "FarmSlicer"): Uint8Array {
  const n = mesh.indices.length / 3;
  const out = new Uint8Array(84 + n * 50);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(header.slice(0, 80)));
  view.setUint32(80, n, true);
  const p = mesh.positions;
  for (let t = 0; t < n; t++) {
    const base = 84 + t * 50;
    const v = [0, 1, 2].map((k) => mesh.indices[t * 3 + k] * 3);
    const ux = p[v[1]] - p[v[0]];
    const uy = p[v[1] + 1] - p[v[0] + 1];
    const uz = p[v[1] + 2] - p[v[0] + 2];
    const wx = p[v[2]] - p[v[0]];
    const wy = p[v[2] + 1] - p[v[0] + 1];
    const wz = p[v[2] + 2] - p[v[0] + 2];
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    view.setFloat32(base, nx, true);
    view.setFloat32(base + 4, ny, true);
    view.setFloat32(base + 8, nz, true);
    for (let k = 0; k < 3; k++)
      for (let c = 0; c < 3; c++) view.setFloat32(base + 12 + k * 12 + c * 4, p[v[k] + c], true);
  }
  return out;
}
