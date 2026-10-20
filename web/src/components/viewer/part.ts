// Parts on the plate: a loaded model (its shape, shared by every copy) and
// each copy's placement, and whether it fits.
//
// The scene is in slicer coordinates (Z up, X right, Y back) with its origin
// at the bed centre. The placement the slicer gets (src/placement.rs) is the
// part's rotation, applied to the model as loaded, plus the XY of its
// bounding-box centre; the part always rests on the plate.

import * as THREE from "three";
import { ConvexHull } from "three/examples/jsm/math/ConvexHull.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import type { Placement } from "../../engine/types";
import { findOverhangs, OverhangOverlay, type Overhangs } from "./overhangs";

/** The printer's bed from the resolved profile: absolute slicer coordinates. */
export interface Bed {
  /** `printable_area` corners (mm). */
  area: [number, number][];
  /** `printable_height` (mm); 0 = unlimited. */
  height: number;
}

/** Where the part is relative to the printable volume. */
export type Fit = "inside" | "partly" | "outside";

/** The bed in scene coordinates (origin at its centre). */
export interface SceneBed {
  polygon: THREE.Vector2[];
  min: THREE.Vector2;
  max: THREE.Vector2;
  /** Bed centre in slicer coordinates: add it to show absolute positions. */
  center: THREE.Vector2;
  height: number;
}

export function sceneBed(bed: Bed): SceneBed {
  const box = new THREE.Box2();
  for (const [x, y] of bed.area) box.expandByPoint(new THREE.Vector2(x, y));
  const center = box.getCenter(new THREE.Vector2());
  return {
    polygon: bed.area.map(([x, y]) => new THREE.Vector2(x - center.x, y - center.y)),
    min: box.min.clone().sub(center),
    max: box.max.clone().sub(center),
    center,
    height: bed.height,
  };
}

/** A 256 mm Bambu-sized bed until the profile says otherwise. */
export const DEFAULT_BED: Bed = {
  area: [
    [0, 0],
    [256, 0],
    [256, 256],
    [0, 256],
  ],
  height: 256,
};

const partMaterial = new THREE.MeshStandardMaterial({ color: "#4a9eff", roughness: 0.6, metalness: 0.05 });
/** Parts other than the selected one, when there are several. */
const idleMaterial = new THREE.MeshStandardMaterial({ color: "#3b7fd0", roughness: 0.7, metalness: 0.05 });
const errorMaterial = new THREE.MeshStandardMaterial({
  color: "#f87171",
  emissive: "#5c1010",
  roughness: 0.6,
  metalness: 0.05,
});

/** Hull input limit: three's quickhull takes ~0.3 s per 100k points on a curved surface. */
const HULL_POINT_BUDGET = 120_000;
/** Matches libslic3r's BuildVolume::SceneEpsilon closely enough (mm). */
const FIT_EPSILON = 1e-3;

function parseModel(data: ArrayBuffer, filename: string): THREE.Object3D {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "stl") {
    const geo = new STLLoader().parse(data);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, partMaterial);
  }
  if (ext === "3mf") {
    const group = new ThreeMFLoader().parse(data);
    let hasMeshes = false;
    group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) hasMeshes = true;
    });
    if (!hasMeshes) throw new Error("3MF file contains no geometry");
    return group;
  }
  throw new Error(`Unsupported format: .${ext}`);
}

/**
 * Every distinct vertex of the model in world coordinates (an STL repeats
 * each ~6 times). Open-addressing hash on the float bits: a 1M-triangle STL
 * takes tens of milliseconds where string keys took seconds.
 */
function uniqueVertices(obj: THREE.Object3D): Float32Array {
  obj.updateMatrixWorld(true);
  let total = 0;
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) total += mesh.geometry.getAttribute("position").count;
  });
  const all = new Float32Array(total * 3);
  const v = new THREE.Vector3();
  let n = 0;
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++, n++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      all[n * 3] = v.x;
      all[n * 3 + 1] = v.y;
      all[n * 3 + 2] = v.z;
    }
  });
  const bits = new Uint32Array(all.buffer);
  const size = 1 << Math.ceil(Math.log2(Math.max(2, total * 2)));
  const table = new Int32Array(size).fill(-1);
  const out = new Float32Array(total * 3);
  let kept = 0;
  for (let i = 0; i < total; i++) {
    const a = bits[i * 3];
    const b = bits[i * 3 + 1];
    const c = bits[i * 3 + 2];
    let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d)) >>> 0;
    for (;;) {
      h &= size - 1;
      const j = table[h];
      if (j < 0) {
        table[h] = i;
        out[kept * 3] = all[i * 3];
        out[kept * 3 + 1] = all[i * 3 + 1];
        out[kept * 3 + 2] = all[i * 3 + 2];
        kept++;
        break;
      }
      if (bits[j * 3] === a && bits[j * 3 + 1] === b && bits[j * 3 + 2] === c) break;
      h++;
    }
  }
  return out.slice(0, kept * 3);
}

/**
 * Real vertices for the hull, at most HULL_POINT_BUDGET: one per cell of the
 * coarsest grid that's fine enough. The hull of a subset of vertices lies
 * inside the true hull by at most a cell.
 */
function hullInput(vertices: Float32Array, size: number): THREE.Vector3[] {
  const count = vertices.length / 3;
  let pick: number[] | null = null;
  if (count > HULL_POINT_BUDGET) {
    // Centred frame: coordinates are within ±size, so cell indices fit
    // one exact integer key.
    let cell = size / 2000;
    for (;;) {
      const span = Math.ceil((2 * size) / cell) + 2;
      const cells = new Map<number, number>();
      for (let i = 0; i < count; i++) {
        const x = Math.floor((vertices[i * 3] + size) / cell);
        const y = Math.floor((vertices[i * 3 + 1] + size) / cell);
        const z = Math.floor((vertices[i * 3 + 2] + size) / cell);
        const key = (z * span + y) * span + x;
        if (!cells.has(key)) cells.set(key, i);
      }
      if (cells.size <= HULL_POINT_BUDGET) {
        pick = [...cells.values()];
        break;
      }
      cell *= 1.5;
    }
  }
  const points: THREE.Vector3[] = [];
  const add = (i: number) => points.push(new THREE.Vector3(vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]));
  if (pick) for (const i of pick) add(i);
  else for (let i = 0; i < count; i++) add(i);
  return points;
}

function hullGeometry(hull: ConvexHull): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const face of hull.faces) {
    let edge = face.edge;
    do {
      const p = edge.head().point;
      positions.push(p.x, p.y, p.z);
      edge = edge.next;
    } while (edge !== face.edge);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * A loaded model: its meshes (centred on their bounding box) and convex
 * hull, shared by every copy of it on the plate.
 */
export class PartShape {
  /** The model, shifted so its bounding-box centre is at the origin. Copies clone it (sharing geometry). */
  readonly template: THREE.Object3D;
  /** Convex hull as triangles, in the template's (centred) frame. */
  readonly hullGeometry: THREE.BufferGeometry;
  /** Hull faces' outward normals and plane constants, one per triangle. */
  readonly hullFaces: { normal: THREE.Vector3; constant: number }[];
  readonly hullPoints: THREE.Vector3[];
  /** Overhangs by rotation and threshold: copies turned alike share them. */
  readonly overhangs = new Map<string, Overhangs>();
  /** The model file's name. */
  readonly name: string;
  private users = 0;

  private constructor(content: THREE.Object3D, name: string) {
    this.name = name;
    const box = new THREE.Box3().setFromObject(content, true);
    const mid = box.getCenter(new THREE.Vector3());
    content.position.sub(mid);
    const holder = new THREE.Group();
    holder.add(content);
    holder.updateMatrixWorld(true);
    this.template = content;

    // Hull in the centred frame (uniqueVertices reads world matrices).
    const vertices = uniqueVertices(holder);
    holder.remove(content);
    const size = box.getSize(new THREE.Vector3()).length() || 1;
    const hull = new ConvexHull().setFromPoints(hullInput(vertices, size));
    const unique = new Map<string, THREE.Vector3>();
    for (const v of hull.vertices) unique.set(`${v.point.x},${v.point.y},${v.point.z}`, v.point);
    this.hullPoints = [...unique.values()];
    this.hullFaces = hull.faces.map((f) => ({ normal: f.normal.clone(), constant: f.constant }));
    this.hullGeometry = hullGeometry(hull);
  }

  static load(data: ArrayBuffer, filename: string): PartShape {
    return new PartShape(parseModel(data, filename), filename);
  }

  /** A part made of this shape is on the plate (or gone: free the geometry with the last one). */
  retain() {
    this.users++;
  }
  release() {
    if (--this.users > 0) return;
    this.template.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    this.hullGeometry.dispose();
  }
}

let nextPartId = 1;

export class Part {
  /** Stable id (React keys, selection). */
  readonly id = nextPartId++;
  /** Placement: position and rotation. Add this to the scene. */
  readonly root = new THREE.Group();
  /** The model, its bounding-box centre at the root's origin. */
  readonly content: THREE.Object3D;
  /** Convex hull as triangles: picking for lay-on-face, which mounts it under the root. */
  readonly hullMesh: THREE.Mesh;
  private readonly meshes: THREE.Mesh[] = [];
  private look: "normal" | "idle" | "error" = "normal";
  /** XY of the bounding-box centre (scene coordinates). */
  readonly center = new THREE.Vector2();
  /** Bounding box of the rotated part relative to the root's origin. */
  readonly extent = new THREE.Box3();
  /** What would print in the air, painted on the part. */
  private readonly overlay = new OverhangOverlay();
  private overhangKey = "";
  private current: Overhangs | null = null;
  /** Hull points rotated (relative to the root's origin), for fit checks and footprints. */
  private rotated: THREE.Vector3[] = [];

  /** The loaded model this part is a copy of. */
  readonly shape: PartShape;
  /** Which of the job's plates the part is on (0-based; `setPlate`). */
  plate = 0;

  constructor(shape: PartShape) {
    this.shape = shape;
    shape.retain();
    this.content = shape.template.clone();
    this.root.add(this.content);
    this.content.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.material = partMaterial;
        this.meshes.push(mesh);
      }
    });
    this.hullMesh = new THREE.Mesh(
      shape.hullGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    this.root.add(this.overlay.group);
    this.updateRotation();
  }

  /**
   * Find (or recall) the overhangs for the part as turned now and paint
   * them: amber when supports will hold them, red when they'd print in the
   * air. `show` false hides the paint.
   */
  updateOverhangs(thresholdDeg: number, supported: boolean, show: boolean): Overhangs {
    const q = this.root.quaternion;
    const key = `${thresholdDeg}|${q.x.toFixed(5)},${q.y.toFixed(5)},${q.z.toFixed(5)},${q.w.toFixed(5)}`;
    if (key !== this.overhangKey || !this.current) {
      let found = this.shape.overhangs.get(key);
      if (!found) {
        found = findOverhangs(this.root, this.content, thresholdDeg);
        // A handful of orientations per model is plenty to remember.
        if (this.shape.overhangs.size >= 8) this.shape.overhangs.delete(this.shape.overhangs.keys().next().value!);
        this.shape.overhangs.set(key, found);
      }
      this.current = found;
      this.overhangKey = key;
      this.overlay.show(found, supported);
    }
    this.overlay.setSupported(supported);
    this.overlay.group.visible = show;
    return this.current;
  }

  /** The model's name (its file). */
  get name(): string {
    return this.shape.name;
  }

  get hullFaces() {
    return this.shape.hullFaces;
  }

  /** Another part of the same shape, turned the same way, at the same place on the same plate. */
  clone(): Part {
    const copy = new Part(this.shape);
    copy.setRotation(this.root.quaternion);
    copy.setCenter(this.center.x, this.center.y);
    copy.plate = this.plate;
    return copy;
  }

  get quaternion(): THREE.Quaternion {
    return this.root.quaternion;
  }

  /** Radius of the part's bounding sphere (about the bounding-box centre). */
  get radius(): number {
    return this.extent.getSize(new THREE.Vector3()).length() / 2;
  }

  /** Put the part on another plate (0-based). */
  setPlate(plate: number) {
    this.plate = plate;
  }

  /** Rotate the part, keeping its bounding-box centre where it is and resting on the plate. */
  setRotation(q: THREE.Quaternion) {
    this.root.quaternion.copy(q).normalize();
    this.updateRotation();
  }

  /** Move the part's bounding-box centre to (x, y). */
  setCenter(x: number, y: number) {
    this.center.set(x, y);
    this.apply();
  }

  /** Put the part where a placement says (the inverse of `placement()`). */
  setPlacement(p: Placement) {
    const r = p.rotation;
    const m = new THREE.Matrix4().set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
    this.root.quaternion.setFromRotationMatrix(m);
    this.updateRotation();
    this.setCenter(p.offset[0], p.offset[1]);
  }

  private updateRotation() {
    this.extent.makeEmpty();
    this.rotated = this.shape.hullPoints.map((p) => {
      const r = p.clone().applyQuaternion(this.root.quaternion);
      this.extent.expandByPoint(r);
      return r;
    });
    this.apply();
  }

  private apply() {
    const mid = this.extent.getCenter(new THREE.Vector3());
    this.root.position.set(this.center.x - mid.x, this.center.y - mid.y, -this.extent.min.z);
    this.root.updateMatrixWorld(true);
  }

  /** Bounding box in scene coordinates. */
  worldBox(): THREE.Box3 {
    return this.extent.clone().translate(this.root.position);
  }

  /** The rotated hull's points on the plate (XY, scene coordinates). */
  footprintPoints(): THREE.Vector2[] {
    return this.rotated.map((r) => new THREE.Vector2(r.x + this.root.position.x, r.y + this.root.position.y));
  }

  /** The slicer's placement for where the part is now. */
  placement(): Placement {
    const m = new THREE.Matrix4().makeRotationFromQuaternion(this.root.quaternion).elements;
    // Matrix4 elements are column-major; the placement is row-major.
    const rotation = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]].map((v) =>
      Math.abs(v) < 1e-12 ? 0 : v,
    );
    return { rotation, offset: [this.center.x, this.center.y] };
  }

  /** Inside, partly outside or off the printable volume (libslic3r's test, on the hull). */
  fit(bed: SceneBed): Fit {
    const box = this.worldBox();
    if (
      box.max.x < bed.min.x - FIT_EPSILON ||
      box.min.x > bed.max.x + FIT_EPSILON ||
      box.max.y < bed.min.y - FIT_EPSILON ||
      box.min.y > bed.max.y + FIT_EPSILON
    )
      return "outside";
    if (bed.height > 0 && box.max.z > bed.height + FIT_EPSILON) return "partly";
    const p = new THREE.Vector2();
    for (const r of this.rotated) {
      p.set(r.x + this.root.position.x, r.y + this.root.position.y);
      if (!insidePolygon(p, bed.polygon)) return "partly";
    }
    return "inside";
  }

  /**
   * How the part is drawn: its own colour, the dimmer one of a part that
   * isn't selected (several on the plate), or the error colour.
   */
  setLook(look: "normal" | "idle" | "error") {
    if (look === this.look) return;
    this.look = look;
    const material = look === "error" ? errorMaterial : look === "idle" ? idleMaterial : partMaterial;
    for (const mesh of this.meshes) mesh.material = material;
  }

  dispose() {
    (this.hullMesh.material as THREE.Material).dispose();
    this.overlay.dispose();
    this.shape.release();
  }
}

/** Point in polygon (on the edge counts as inside, within FIT_EPSILON). */
export function insidePolygon(p: THREE.Vector2, polygon: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (distanceToSegment(p, a, b) <= FIT_EPSILON) return true;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distanceToSegment(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const ab = b.clone().sub(a);
  const len = ab.lengthSq();
  const t = len > 0 ? THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / len, 0, 1) : 0;
  return a.clone().addScaledVector(ab, t).distanceTo(p);
}
