// Parts on the plate: a model (its shape, built from an editor object and
// shared by every copy) and each copy's placement, and whether it fits.
//
// The scene is in slicer coordinates (Z up, X right, Y back) with its origin
// at the bed centre. The placement the slicer gets (src/placement.rs) is the
// part's rotation times its scale (negative = mirrored), applied to the
// model as loaded, plus the XY of its bounding-box centre; the part always
// rests on the plate. As in libslic3r, only model parts count for the
// bounding box, the resting height and the footprint: modifiers, negative
// volumes and support enforcers/blockers may stick out.

import * as THREE from "three";
import { ConvexHull } from "three/examples/jsm/math/ConvexHull.js";
import type { Placement } from "../../engine/types";
import type { ModelObject, Volume } from "../../model/document";
import { BLOCKER, ENFORCER, type PaintKind, type PaintLayer } from "../../model/paint";
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

/** Colours for filaments the page hasn't given one (slot N → [N-1]). */
export const FALLBACK_COLORS = ["#4a9eff", "#f5a524", "#3fb950", "#d2a8ff", "#ff7b72", "#79c0ff", "#e3b341", "#56d364"];

export function filamentColor(colors: string[], filament: number): string {
  const i = Math.max(1, filament) - 1;
  return colors[i] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length];
}

const errorMaterial = new THREE.MeshStandardMaterial({
  color: "#f87171",
  emissive: "#5c1010",
  roughness: 0.6,
  metalness: 0.05,
  flatShading: true,
});

/** How each kind of volume looks (model parts take their filament's colour). */
const VOLUME_LOOK: Record<Exclude<Volume["type"], "part">, { color: string; opacity: number }> = {
  modifier: { color: "#ffd23f", opacity: 0.25 },
  negative: { color: "#8b949e", opacity: 0.35 },
  enforcer: { color: "#3fb950", opacity: 0.35 },
  blocker: { color: "#f85149", opacity: 0.35 },
};

export const PAINT_KINDS: PaintKind[] = ["color", "supports", "seam", "fuzzy"];

/** Paint colours for the kinds that aren't filaments. */
const PAINT_LOOK: Record<Exclude<PaintKind, "color">, Record<number, string>> = {
  supports: { [ENFORCER]: "#3fb950", [BLOCKER]: "#f85149" },
  seam: { [ENFORCER]: "#58a6ff", [BLOCKER]: "#f85149" },
  fuzzy: { 1: "#f0883e" },
};

export function paintColor(kind: PaintKind, state: number, colors: string[]): string {
  if (kind === "color") return filamentColor(colors, state);
  return PAINT_LOOK[kind][state] ?? "#ffffff";
}

/** Hull input limit: three's quickhull takes ~0.3 s per 100k points on a curved surface. */
const HULL_POINT_BUDGET = 120_000;
/** Matches libslic3r's BuildVolume::SceneEpsilon closely enough (mm). */
const FIT_EPSILON = 1e-3;

/**
 * Every distinct vertex of the model parts in `obj`'s frame (an STL repeats
 * each ~6 times). Open-addressing hash on the float bits: a 1M-triangle
 * model takes tens of milliseconds where string keys took seconds.
 */
function uniqueVertices(meshes: THREE.Mesh[], frame: THREE.Object3D): Float32Array {
  frame.updateMatrixWorld(true);
  const toFrame = frame.matrixWorld.clone().invert();
  let total = 0;
  for (const mesh of meshes) total += mesh.geometry.getAttribute("position").count;
  const all = new Float32Array(total * 3);
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  let n = 0;
  for (const mesh of meshes) {
    m.multiplyMatrices(toFrame, mesh.matrixWorld);
    const pos = mesh.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++, n++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      all[n * 3] = v.x;
      all[n * 3 + 1] = v.y;
      all[n * 3 + 2] = v.z;
    }
  }
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

/** A volume's mesh as an indexed geometry: face index = triangle index. */
function volumeGeometry(v: Volume): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(v.mesh.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(v.mesh.indices, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** What a mesh in a shape's template is, in its `userData`. */
export interface MeshInfo {
  role: "volume" | "paint";
  volumeId: string;
  /** Volume meshes: the volume's type. */
  volumeType?: Volume["type"];
  /** Paint meshes: which layer. */
  kind?: PaintKind;
  /** Model parts: counted for overhangs, the hull and the footprint. */
  overhangs?: boolean;
}

export function meshInfo(o: THREE.Object3D): MeshInfo | null {
  return (o.userData?.role ? (o.userData as MeshInfo) : null) ?? null;
}

/**
 * A model on the plate: an editor object's volumes as meshes (centred on
 * the model parts' bounding box) and their convex hull, shared by every
 * copy of it. Paint overlays live under each volume's mesh; their
 * geometry is updated in place, so every copy shows new paint at once.
 */
export class PartShape {
  /** The object it shows (treat as read-only: edits make a new shape). */
  readonly object: ModelObject;
  /** The file it was loaded from, while it still says the same. */
  readonly source: File | null;
  /** The model, its model parts' bounding-box centre at the origin. Copies clone it (sharing geometry). */
  readonly template: THREE.Object3D;
  /** Convex hull of the model parts as triangles, in the template's (centred) frame. */
  readonly hullGeometry: THREE.BufferGeometry;
  /** Hull faces' outward normals and plane constants, one per triangle. */
  readonly hullFaces: { normal: THREE.Vector3; constant: number }[];
  readonly hullPoints: THREE.Vector3[];
  /** Overhangs by rotation and threshold: copies turned alike share them. */
  readonly overhangs = new Map<string, Overhangs>();
  /** Where the object's own origin is in the template's frame. */
  readonly offset: THREE.Vector3;
  private readonly volumeMeshes = new Map<string, THREE.Mesh>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly paintMeshes = new Map<string, THREE.Mesh>();
  private colors: string[];
  private users = 0;
  /** Bumped when the object changes in place (paint): what was exported from it is stale. */
  version = 0;

  constructor(object: ModelObject, source: File | null, colors: string[]) {
    this.object = object;
    this.source = source;
    this.colors = colors;
    const content = new THREE.Group();
    for (const v of object.volumes) {
      const material =
        v.type === "part"
          ? new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05, flatShading: true })
          : new THREE.MeshStandardMaterial({
              color: VOLUME_LOOK[v.type].color,
              transparent: true,
              opacity: VOLUME_LOOK[v.type].opacity,
              depthWrite: false,
              roughness: 0.8,
            });
      this.materials.set(v.id, material);
      const mesh = new THREE.Mesh(volumeGeometry(v), material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(v.matrix);
      const info: MeshInfo = { role: "volume", volumeId: v.id, volumeType: v.type, overhangs: v.type === "part" };
      // (Only plain data in userData: three's clone copies it through JSON.)
      mesh.userData = { ...info };
      // Non-parts draw after the parts, so the parts show through them.
      if (v.type !== "part") mesh.renderOrder = 1;
      content.add(mesh);
      this.volumeMeshes.set(v.id, mesh);
    }
    this.applyColors();
    // Every kind of paint has its overlay on every model part from the
    // start (empty until painted): copies clone the template once, so an
    // overlay added later would never reach them.
    for (const v of object.volumes) if (v.type === "part") for (const kind of PAINT_KINDS) this.refreshPaint(v.id, kind);

    // Centre on the model parts' bounding box.
    content.updateMatrixWorld(true);
    const parts = [...this.volumeMeshes.values()].filter((m) => meshInfo(m)?.overhangs);
    const box = new THREE.Box3();
    for (const m of parts) box.expandByObject(m, true);
    if (box.isEmpty()) for (const m of this.volumeMeshes.values()) box.expandByObject(m, true);
    const mid = box.getCenter(new THREE.Vector3());
    content.position.sub(mid);
    this.offset = content.position.clone();
    const holder = new THREE.Group();
    holder.add(content);
    holder.updateMatrixWorld(true);
    this.template = content;

    const vertices = uniqueVertices(parts.length ? parts : [...this.volumeMeshes.values()], holder);
    holder.remove(content);
    const size = box.getSize(new THREE.Vector3()).length() || 1;
    const hull = new ConvexHull().setFromPoints(hullInput(vertices, size));
    const unique = new Map<string, THREE.Vector3>();
    for (const v of hull.vertices) unique.set(`${v.point.x},${v.point.y},${v.point.z}`, v.point);
    this.hullPoints = [...unique.values()];
    this.hullFaces = hull.faces.map((f) => ({ normal: f.normal.clone(), constant: f.constant }));
    this.hullGeometry = hullGeometry(hull);
  }

  get name(): string {
    return this.object.name;
  }

  /** The material volume `id` is drawn with (shared by every copy). */
  material(id: string): THREE.Material | undefined {
    return this.materials.get(id);
  }

  /** The mesh showing volume `id` in the template (copies have their own). */
  volumeMesh(id: string): THREE.Mesh | undefined {
    return this.volumeMeshes.get(id);
  }

  /** New filament colours: the parts and colour paint follow. */
  setColors(colors: string[]) {
    if (colors.join() === this.colors.join()) return;
    this.colors = colors;
    this.applyColors();
    for (const v of this.object.volumes) if (v.paint.color) this.refreshPaint(v.id, "color");
  }

  private applyColors() {
    for (const v of this.object.volumes) {
      if (v.type !== "part") continue;
      const extruder = v.extruder || this.object.extruder;
      this.materials.get(v.id)!.color.set(filamentColor(this.colors, extruder));
    }
  }

  /** Draw volume `volumeId`'s `kind` paint as it is now. */
  refreshPaint(volumeId: string, kind: PaintKind) {
    const volume = this.object.volumes.find((v) => v.id === volumeId);
    const host = this.volumeMeshes.get(volumeId);
    if (!volume || !host) return;
    const layer: PaintLayer | undefined = volume.paint[kind];
    const key = `${volumeId}:${kind}`;
    let mesh = this.paintMeshes.get(key);
    const leaves = layer?.leaves();
    if (!mesh) {
      if (volume.type !== "part" && (!leaves || leaves.states.length === 0)) return;
      const geo = new THREE.BufferGeometry();
      mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.6,
          metalness: 0.05,
          flatShading: true,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -2,
        }),
      );
      const info: MeshInfo = { role: "paint", volumeId, kind };
      mesh.userData = info;
      mesh.raycast = () => {};
      mesh.visible = kind === "color";
      host.add(mesh);
      this.paintMeshes.set(key, mesh);
    }
    const geo = mesh.geometry;
    const positions = leaves?.positions ?? new Float32Array(0);
    const colors = new Float32Array(positions.length);
    const c = new THREE.Color();
    const states = leaves?.states ?? new Uint8Array(0);
    for (let i = 0; i < states.length; i++) {
      c.set(paintColor(kind, states[i], this.colors));
      for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (i * 3 + k) * 3);
    }
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
  }

  /** Draw every paint layer again (after an undo put other layers in place). */
  refreshAllPaint() {
    for (const v of this.object.volumes)
      for (const kind of PAINT_KINDS)
        if (v.paint[kind] || this.paintMeshes.has(`${v.id}:${kind}`)) this.refreshPaint(v.id, kind);
  }

  /** A part made of this shape is on the plate (or gone: free the geometry with the last one). */
  retain() {
    this.users++;
  }
  release() {
    if (--this.users > 0) return;
    this.users = 0;
    this.template.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    for (const m of this.materials.values()) m.dispose();
    for (const m of this.paintMeshes.values()) (m.material as THREE.Material).dispose();
    this.hullGeometry.dispose();
  }
}

let nextPartId = 1;

export class Part {
  /** Stable id (React keys, selection). */
  readonly id = nextPartId++;
  /** Placement: position, rotation and scale. Add this to the scene. */
  readonly root = new THREE.Group();
  /** The model, its bounding-box centre at the root's origin. */
  content: THREE.Object3D;
  /** Convex hull as triangles: picking for lay-on-face, which mounts it under the root. */
  hullMesh: THREE.Mesh;
  private meshes: THREE.Mesh[] = [];
  private look: "normal" | "idle" | "error" = "normal";
  /** XY of the bounding-box centre (scene coordinates). */
  readonly center = new THREE.Vector2();
  /** Bounding box of the turned and scaled part relative to the root's origin. */
  readonly extent = new THREE.Box3();
  /** What would print in the air, painted on the part. */
  private readonly overlay = new OverhangOverlay();
  private overhangKey = "";
  private current: Overhangs | null = null;
  /** Hull points turned and scaled (relative to the root's origin), for fit checks and footprints. */
  private turned: THREE.Vector3[] = [];
  private paintView: PaintKind | null = "color";

  /** The model this part is a copy of. */
  shape: PartShape;
  /** Which of the job's plates the part is on (0-based; `setPlate`). */
  plate = 0;
  private disposed = false;

  constructor(shape: PartShape) {
    this.shape = shape;
    shape.retain();
    this.content = shape.template.clone();
    this.root.add(this.content);
    this.hullMesh = this.makeHullMesh();
    this.collectMeshes();
    this.root.add(this.overlay.group);
    this.updateRotation();
  }

  private makeHullMesh() {
    return new THREE.Mesh(
      this.shape.hullGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
  }

  private collectMeshes() {
    this.meshes = [];
    this.content.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const role = meshInfo(mesh)?.role;
      if (role === "volume") this.meshes.push(mesh);
      // Paint lies on the surface: picking goes to the volume under it
      // (clones don't keep the template's no-op raycast).
      if (role === "paint") mesh.raycast = () => {};
    });
    this.applyPaintView();
    const look = this.look;
    this.look = "normal";
    this.setLook(look);
  }

  /** Show another model in this part's place (an edit made a new shape): same placement, plate and id. */
  setShape(shape: PartShape) {
    if (shape === this.shape) return;
    const old = this.shape;
    this.root.remove(this.content);
    (this.hullMesh.material as THREE.Material).dispose();
    this.shape = shape;
    shape.retain();
    old.release();
    this.content = shape.template.clone();
    this.root.add(this.content);
    this.hullMesh = this.makeHullMesh();
    this.collectMeshes();
    this.overhangKey = "";
    this.updateRotation();
  }

  /** Which paint layer shows (`null`: none; default the colours). */
  setPaintView(kind: PaintKind | null) {
    this.paintView = kind;
    this.applyPaintView();
  }

  private applyPaintView() {
    this.content.traverse((child) => {
      const info = meshInfo(child);
      if (info?.role === "paint") child.visible = info.kind === this.paintView;
    });
  }

  /**
   * Find (or recall) the overhangs for the part as turned now and paint
   * them: amber when supports will hold them, red when they'd print in the
   * air. `show` false hides the paint.
   */
  updateOverhangs(thresholdDeg: number, supported: boolean, show: boolean): Overhangs {
    const q = this.root.quaternion;
    const s = this.root.scale;
    const key = `${thresholdDeg}|${q.x.toFixed(5)},${q.y.toFixed(5)},${q.z.toFixed(5)},${q.w.toFixed(5)}|${s.x.toFixed(5)},${s.y.toFixed(5)},${s.z.toFixed(5)}`;
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

  /** The model's name. */
  get name(): string {
    return this.shape.name;
  }

  get hullFaces() {
    return this.shape.hullFaces;
  }

  /** Another part of the same shape, turned and scaled the same way, at the same place on the same plate. */
  clone(): Part {
    const copy = new Part(this.shape);
    copy.root.scale.copy(this.root.scale);
    copy.setRotation(this.root.quaternion);
    copy.setCenter(this.center.x, this.center.y);
    copy.plate = this.plate;
    return copy;
  }

  get quaternion(): THREE.Quaternion {
    return this.root.quaternion;
  }

  /** Scale along the model's own axes; negative = mirrored along that axis. */
  get scale(): THREE.Vector3 {
    return this.root.scale;
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

  /** Scale the part along its model axes (negative mirrors), keeping its centre and resting on the plate. */
  setScale(s: THREE.Vector3) {
    this.root.scale.copy(s);
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
    const position = new THREE.Vector3();
    m.decompose(position, this.root.quaternion, this.root.scale);
    this.updateRotation();
    this.setCenter(p.offset[0], p.offset[1]);
  }

  private updateRotation() {
    this.extent.makeEmpty();
    const q = this.root.quaternion;
    const s = this.root.scale;
    this.turned = this.shape.hullPoints.map((p) => {
      const r = p.clone().multiply(s).applyQuaternion(q);
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

  /** The turned hull's points on the plate (XY, scene coordinates). */
  footprintPoints(): THREE.Vector2[] {
    return this.turned.map((r) => new THREE.Vector2(r.x + this.root.position.x, r.y + this.root.position.y));
  }

  /** A hull face's normal as the part is turned and scaled (scene axes). */
  worldNormal(local: THREE.Vector3): THREE.Vector3 {
    // Normals scale by the inverse scale (then turn with the part).
    const s = this.root.scale;
    return local.clone().divide(s).applyQuaternion(this.root.quaternion).normalize();
  }

  /** The slicer's placement for where the part is now. */
  placement(): Placement {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(), this.root.quaternion, this.root.scale).elements;
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
    for (const r of this.turned) {
      p.set(r.x + this.root.position.x, r.y + this.root.position.y);
      if (!insidePolygon(p, bed.polygon)) return "partly";
    }
    return "inside";
  }

  /**
   * How the part is drawn: in its filaments' colours, or the error colour.
   * (`idle`, a part that isn't selected among several, looks normal: the
   * selection shows as a box.)
   */
  setLook(look: "normal" | "idle" | "error") {
    if (look === this.look) return;
    this.look = look;
    for (const mesh of this.meshes) {
      const info = meshInfo(mesh);
      if (info?.volumeType !== "part") continue;
      const base = info.volumeId ? this.shape.material(info.volumeId) : undefined;
      mesh.material = look === "error" ? errorMaterial : (base ?? mesh.material);
    }
  }

  /** Off the plate: free what only it uses (an undo may `revive` it). */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    (this.hullMesh.material as THREE.Material).dispose();
    this.overlay.dispose();
    this.shape.release();
  }

  /** Back on the plate after `dispose` (undo). */
  revive() {
    if (!this.disposed) return;
    this.disposed = false;
    this.shape.retain();
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
