// What would print in the air: the faces of a part that hang over nothing
// steeper than the support threshold, and the points where a part starts in
// mid-air (a cone's tip, a sphere's bottom): lower than everything around
// them and above the plate. Computed for a part as turned; the plate
// doesn't matter except for what rests on it.

import * as THREE from "three";

/** What the viewer found on the plate, for the page's Supports section. */
export interface SupportCheck {
  /** Overhanging area, mm². */
  overhangArea: number;
  /** Points that would start in mid-air. */
  floating: number;
}

/** One part's overhangs, in its root's frame (they turn and move with it). */
export interface Overhangs {
  /** Triangles to paint (root-local positions). */
  positions: Float32Array;
  /** Mid-air points (root-local). */
  points: Float32Array;
  area: number;
  floating: number;
}

/** Faces this close to the plate rest on it (mm). */
const ON_PLATE = 0.05;
/** Mid-air points closer than this count once (mm). */
const POINT_MERGE = 1;
/** libslic3r's support_threshold_angle 0 = "auto": about this. */
const AUTO_THRESHOLD = 30;

/**
 * Overhangs of `root`'s meshes as placed: faces whose slope from the
 * horizontal is under `thresholdDeg` (libslic3r's support_threshold_angle,
 * 0 = auto) facing down and not resting on the plate (z = 0 in world).
 */
export function findOverhangs(root: THREE.Object3D, content: THREE.Object3D, thresholdDeg: number): Overhangs {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const threshold = THREE.MathUtils.degToRad(thresholdDeg > 0 ? thresholdDeg : AUTO_THRESHOLD);
  const minDown = Math.cos(threshold);
  const tri: number[] = [];
  let area = 0;
  // Every vertex, de-duplicated by position, with its neighbours' lowest z.
  const index = new Map<string, number>();
  const zs: number[] = [];
  const lowestNeighbour: number[] = [];
  const local: THREE.Vector3[] = [];
  const key = (v: THREE.Vector3) => `${Math.round(v.x * 1e3)},${Math.round(v.y * 1e3)},${Math.round(v.z * 1e3)}`;
  const vertex = (w: THREE.Vector3) => {
    const k = key(w);
    let i = index.get(k);
    if (i === undefined) {
      i = zs.length;
      index.set(k, i);
      zs.push(w.z);
      lowestNeighbour.push(Infinity);
      local.push(w.clone().applyMatrix4(toRoot));
    }
    return i;
  };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();
  content.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute("position");
    const idx = mesh.geometry.getIndex();
    const count = idx ? idx.count : pos.count;
    for (let t = 0; t + 2 < count; t += 3) {
      const i0 = idx ? idx.getX(t) : t;
      const i1 = idx ? idx.getX(t + 1) : t + 1;
      const i2 = idx ? idx.getX(t + 2) : t + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
      const va = vertex(a);
      const vb = vertex(b);
      const vc = vertex(c);
      for (const [x, y] of [
        [va, vb],
        [vb, vc],
        [vc, va],
      ]) {
        if (zs[y] < lowestNeighbour[x]) lowestNeighbour[x] = zs[y];
        if (zs[x] < lowestNeighbour[y]) lowestNeighbour[y] = zs[x];
      }
      n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
      const len = n.length();
      if (len === 0) continue;
      if (-n.z / len <= minDown) continue;
      if (Math.min(a.z, b.z, c.z) < ON_PLATE) continue;
      area += len / 2;
      for (const v of [va, vb, vc]) tri.push(local[v].x, local[v].y, local[v].z);
    }
  });
  // Mid-air starts: strictly lower than every neighbour, above the plate.
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < zs.length; i++) {
    if (zs[i] < ON_PLATE || !(lowestNeighbour[i] > zs[i] + 1e-4) || lowestNeighbour[i] === Infinity) continue;
    if (points.some((p) => p.distanceTo(local[i]) < POINT_MERGE)) continue;
    points.push(local[i]);
  }
  return {
    positions: new Float32Array(tri),
    points: new Float32Array(points.flatMap((p) => [p.x, p.y, p.z])),
    area,
    floating: points.length,
  };
}

const supportedColor = new THREE.Color("#f5a524");
const unsupportedColor = new THREE.Color("#ff3b30");

/** The overlay drawn on a part: overhang faces and mid-air points. */
export class OverhangOverlay {
  readonly group = new THREE.Group();
  private readonly faces: THREE.Mesh;
  private readonly dots: THREE.Points;
  private readonly faceMaterial = new THREE.MeshBasicMaterial({
    color: unsupportedColor,
    transparent: true,
    opacity: 0.7,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  private readonly dotMaterial = new THREE.PointsMaterial({ color: unsupportedColor, size: 8, sizeAttenuation: false, depthTest: false });

  constructor() {
    this.faces = new THREE.Mesh(new THREE.BufferGeometry(), this.faceMaterial);
    this.dots = new THREE.Points(new THREE.BufferGeometry(), this.dotMaterial);
    this.faces.userData.overlay = true;
    this.dots.userData.overlay = true;
    // Never in the way of picking the part.
    this.faces.raycast = () => {};
    this.dots.raycast = () => {};
    this.dots.renderOrder = 5;
    this.group.add(this.faces, this.dots);
  }

  show(o: Overhangs, supported: boolean) {
    this.faces.geometry.setAttribute("position", new THREE.BufferAttribute(o.positions, 3));
    this.faces.geometry.computeBoundingSphere();
    this.dots.geometry.setAttribute("position", new THREE.BufferAttribute(o.points, 3));
    this.dots.geometry.computeBoundingSphere();
    this.setSupported(supported);
  }

  setSupported(supported: boolean) {
    const color = supported ? supportedColor : unsupportedColor;
    this.faceMaterial.color.copy(color);
    this.faceMaterial.opacity = supported ? 0.45 : 0.75;
    this.dotMaterial.color.copy(color);
  }

  dispose() {
    this.faces.geometry.dispose();
    this.dots.geometry.dispose();
    this.faceMaterial.dispose();
    this.dotMaterial.dispose();
  }
}
