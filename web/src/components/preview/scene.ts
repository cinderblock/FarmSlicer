// three.js objects for a parsed G-code file (no React): extrusions as 3D
// beads or lines, travel moves, retraction points and the tool head.
//
// Beads are instanced: one small template mesh (a diamond cross-section with
// pointed ends, so consecutive segments overlap at corners like the
// desktop slicers' previews) drawn once per segment, its vertex shader
// stretching it from the segment's start to its end, `width` wide and
// `height` tall, its top at the G-code's Z. Per-segment data goes to the
// GPU straight from the parser's arrays: start and end both read the
// point chain (one buffer, two offsets), sizes are 16-bit µm, colours 8-bit
// with the feature index in alpha. Nothing per segment is built in JS.
//
// Segments are drawn in file order, so a layer range is one contiguous run:
// the top of the range is the instance count, the bottom a uniform the
// shader compares gl_InstanceID against. The instances are split into
// chunks, so whole chunks below the range are skipped and each can be
// frustum-culled. Above BEAD_BUDGET segments (or on request) the extrusions
// are drawn as 1-pixel lines from the same arrays instead, and above
// MOVING_LINES they stand in for the beads while the camera moves.

import * as THREE from "three";
import { fillColors, type ColorMode, type Gradient } from "./colors";
import { GAP, RETRACT, WIPE, type ParsedGcode } from "./types";

/** Segments drawn as 3D beads; beyond this, lines (GPU memory and vertex work). */
export const BEAD_BUDGET = 6_000_000;
/**
 * Above this many segments, the camera moves over lines and the beads come
 * back when it stops: beads cost ~10 vertex-shader runs per segment, lines
 * one, and on integrated graphics a few million beads draw at 3-4 frames a
 * second where lines draw at 20.
 */
export const MOVING_LINES = 1_000_000;
/** Instances per draw call. */
const CHUNK = 1 << 18;

export type RenderMode = "beads" | "lines";

/** How a file of `segments` is drawn unless lines are asked for. */
export function autoMode(segments: number): RenderMode {
  return segments <= BEAD_BUDGET ? "beads" : "lines";
}

export interface ViewRange {
  /** First and last layer shown (inclusive). */
  bottom: number;
  top: number;
  /** Chain segments of the top layer shown: up to this index (exclusive). */
  upTo: number;
  /** Feature indexes not drawn. */
  hidden: ReadonlySet<number>;
  travel: boolean;
  retractions: boolean;
  /** Darken the layers below the top one. */
  dim: boolean;
}

const HIDDEN_GLSL = /* glsl */ `
uniform uint uHidden0;
uniform uint uHidden1;
bool featureHidden(uint f) {
  if (f == 255u) return true;
  if (f < 32u) return ((uHidden0 >> f) & 1u) == 1u;
  if (f < 64u) return ((uHidden1 >> (f - 32u)) & 1u) == 1u;
  return false;
}
`;

const TUBE_VERTEX = /* glsl */ `
in float aExt;
in vec3 iStart;
in vec3 iEnd;
in vec2 iSize;
in vec4 iColor;
uniform int uBase;
uniform int uLo;
uniform int uDim;
uniform float uDimFactor;
uniform vec4 uTint;
${HIDDEN_GLSL}
out vec3 vColor;
out vec3 vNormal;
out vec3 vView;

void main() {
  int index = uBase + gl_InstanceID;
  if (index < uLo || featureHidden(uint(iColor.a * 255.0 + 0.5))) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume: nothing drawn
    return;
  }
  vec3 d = iEnd - iStart;
  float len = length(d);
  vec3 dir = len > 1e-6 ? d / len : vec3(1.0, 0.0, 0.0);
  vec3 right = cross(dir, vec3(0.0, 0.0, 1.0));
  float rl = length(right);
  right = rl > 1e-4 ? right / rl : vec3(1.0, 0.0, 0.0);
  vec3 up = cross(right, dir);
  float w = iSize.x * 65.535;
  float h = iSize.y * 65.535;
  // The bead's top is at the G-code's Z.
  vec3 p = mix(iStart, iEnd, position.x) - vec3(0.0, 0.0, 0.5 * h)
    + right * (position.y * w) + up * (position.z * h) + dir * (aExt * 0.5 * w);
  vec3 n = aExt != 0.0 ? dir * aExt : normalize(right * position.y + up * position.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vNormal = normalize(normalMatrix * n);
  vView = -mv.xyz;
  vec3 c = uTint.a > 0.5 ? uTint.rgb : iColor.rgb;
  vColor = index < uDim ? c * uDimFactor : c;
}
`;

const TUBE_FRAGMENT = /* glsl */ `
in vec3 vColor;
in vec3 vNormal;
in vec3 vView;
out highp vec4 outColor;

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vView);
  // A light at the camera plus one from above it: every view reads the same.
  vec3 key = normalize(v + vec3(0.0, 0.6, 0.0));
  float diffuse = 0.55 * max(dot(n, v), 0.0) + 0.3 * max(dot(n, key), 0.0);
  float spec = pow(max(dot(n, normalize(v + key)), 0.0), 32.0) * 0.18;
  outColor = vec4(vColor * (0.32 + diffuse) + spec, 1.0);
}
`;

const LINE_VERTEX = /* glsl */ `
in vec4 aColor;
uniform int uLo;
uniform int uDim;
uniform float uDimFactor;
uniform vec4 uTint;
${HIDDEN_GLSL}
flat out vec4 vColor;

void main() {
  // A line strip: segment i ends at point i + 1, which carries its colour
  // (the last vertex of a primitive provides flat values).
  int segment = gl_VertexID - 1;
  bool hidden = segment < uLo || featureHidden(uint(aColor.a * 255.0 + 0.5));
  vec3 c = uTint.a > 0.5 ? uTint.rgb : aColor.rgb;
  vColor = vec4(segment < uDim ? c * uDimFactor : c, hidden ? 0.0 : 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const LINE_FRAGMENT = /* glsl */ `
flat in vec4 vColor;
out highp vec4 outColor;
void main() {
  if (vColor.a < 0.5) discard;
  outColor = vec4(vColor.rgb, 1.0);
}
`;

/** The bead template: x = 0 at the start, 1 at the end; y across, z up (both ±0.5); aExt pushes the tips out. */
function beadTemplate(): THREE.BufferGeometry {
  const ring = [
    [0, 0.5],
    [0.5, 0],
    [0, -0.5],
    [-0.5, 0],
  ];
  const position: number[] = [];
  const ext: number[] = [];
  for (const t of [0, 1])
    for (const [s, u] of ring) {
      position.push(t, s, u);
      ext.push(0);
    }
  position.push(0, 0, 0, 1, 0, 0); // tips: 8 (start), 9 (end)
  ext.push(-1, 1);
  const index: number[] = [];
  for (let k = 0; k < 4; k++) {
    const a = k;
    const b = (k + 1) % 4;
    index.push(a, b, 4 + b, a, 4 + b, 4 + a); // side
    index.push(8, b, a); // start cap
    index.push(9, 4 + a, 4 + b); // end cap
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("aExt", new THREE.Float32BufferAttribute(ext, 1));
  g.setIndex(index);
  return g;
}

/** First index in [lo, hi) of a sorted array whose value is >= v. */
function lowerBound(a: Uint32Array, lo: number, hi: number, v: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Bounding sphere of chain points [from, to]. */
function chainSphere(points: Float32Array, from: number, to: number): THREE.Sphere {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = from; i <= to; i++) box.expandByPoint(v.fromArray(points, i * 3));
  return box.getBoundingSphere(new THREE.Sphere());
}

interface Chunk {
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  start: number;
  end: number;
}

export class Toolpaths {
  /** Add this to the scene (in G-code coordinates; position it on the bed). */
  readonly group = new THREE.Group();
  readonly colors: Uint8Array;
  mode: RenderMode;

  private p: ParsedGcode;
  private shared = {
    uLo: { value: 0 },
    uDim: { value: -1 },
    uDimFactor: { value: 0.5 },
    uHidden0: { value: 0 },
    uHidden1: { value: 0 },
    // rgb, and a = 1 to draw every extrusion in that colour (the compare overlay).
    uTint: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
  private beads = beadTemplate();
  private moving = false;
  private chunks: Chunk[] = [];
  private line: THREE.Line<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private travel: THREE.LineSegments | null = null;
  private retract: THREE.Points | null = null;
  private head: THREE.Mesh;
  private view: ViewRange | null = null;

  constructor(parsed: ParsedGcode, mode: RenderMode = autoMode(parsed.extrusions.count)) {
    this.p = parsed;
    this.mode = mode;
    this.colors = new Uint8Array((parsed.extrusions.count + 1) * 4);
    const cone = new THREE.ConeGeometry(1.2, 4, 20);
    cone.rotateX(-Math.PI / 2); // tip down (Z up)
    cone.translate(0, 0, 2);
    this.head = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: "#f8fafc", transparent: true, opacity: 0.85 }));
    this.head.visible = false;
    this.head.renderOrder = 2;
    this.group.add(this.head);
    this.build();
  }

  /** How this file is drawn in 3D, or "lines" when it's too big for that. */
  get auto(): RenderMode {
    return autoMode(this.p.extrusions.count);
  }

  setMode(mode: RenderMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.clearExtrusions();
    this.build();
    if (this.view) this.setView(this.view);
  }

  /**
   * Recolour every segment (feature, filament, speed or layer time); a
   * gradient over `range` instead of this file's own (two files compared).
   */
  recolor(mode: ColorMode, filamentColors: string[], range?: Gradient): void {
    fillColors(this.colors, this.p, mode, filamentColors, range);
    for (const c of this.chunks) c.mesh.geometry.attributes.iColor.needsUpdate = true;
    if (this.line) this.line.geometry.attributes.aColor.needsUpdate = true;
  }

  setView(v: ViewRange): void {
    this.view = v;
    const { layers, extrusions, travels, retractions } = this.p;
    if (layers.count === 0) return;
    const bottom = Math.max(0, Math.min(v.bottom, layers.count - 1));
    const top = Math.max(bottom, Math.min(v.top, layers.count - 1));
    const lo = layers.extrusionStart[bottom];
    const topStart = layers.extrusionStart[top];
    const topEnd = layers.extrusionStart[top + 1];
    const hi = Math.max(topStart, Math.min(v.upTo, topEnd));
    const scrubbing = hi < topEnd;

    this.shared.uLo.value = lo;
    // Dimming marks the top layer out once the range stops below the last
    // layer (or the scrubber is in use); over the whole print it would only
    // darken it.
    const partial = top < layers.count - 1 || scrubbing;
    this.shared.uDim.value = v.dim && partial && top > bottom ? topStart : -1;
    let h0 = 0;
    let h1 = 0;
    for (const f of v.hidden) {
      if (f < 32) h0 |= 1 << f;
      else if (f < 64) h1 |= 1 << (f - 32);
    }
    this.shared.uHidden0.value = h0 >>> 0;
    this.shared.uHidden1.value = h1 >>> 0;

    // While the camera moves, a big file's beads give way to its lines.
    const standIn = this.moving && this.line !== null;
    for (const c of this.chunks) {
      const from = Math.max(c.start, lo);
      const to = Math.min(c.end, hi);
      c.mesh.visible = to > from && !standIn;
      c.mesh.geometry.instanceCount = Math.max(0, to - c.start);
    }
    if (this.line) {
      this.line.geometry.setDrawRange(lo, hi > lo ? hi - lo + 1 : 0);
      this.line.visible = hi > lo && (this.mode === "lines" || standIn);
    }

    // Travels and retractions in range: up to the scrubbed point in the top layer.
    if (v.travel) {
      const t = this.travelLines();
      const from = layers.travelStart[bottom];
      const to = scrubbing ? lowerBound(travels.at, layers.travelStart[top], layers.travelStart[top + 1], hi) : layers.travelStart[top + 1];
      t.geometry.setDrawRange(from * 2, Math.max(0, to - from) * 2);
      t.visible = true;
    } else if (this.travel) this.travel.visible = false;
    if (v.retractions) {
      const r = this.retractPoints();
      const from = layers.retractStart[bottom];
      const to = scrubbing ? lowerBound(retractions.at, layers.retractStart[top], layers.retractStart[top + 1], hi) : layers.retractStart[top + 1];
      r.geometry.setDrawRange(from, Math.max(0, to - from));
      r.visible = true;
    } else if (this.retract) this.retract.visible = false;

    // The tool head where the scrubbed path ends.
    this.head.visible = scrubbing && hi > 0;
    if (this.head.visible) this.head.position.fromArray(extrusions.points, hi * 3);
  }

  /** Draw every extrusion in one colour (null: their own colours again). */
  setTint(color: THREE.ColorRepresentation | null): void {
    const t = this.shared.uTint.value;
    if (color === null) t.w = 0;
    else {
      const c = new THREE.Color(color);
      t.set(c.r, c.g, c.b, 1);
    }
  }

  /**
   * The depth test the extrusions draw with, and whether they write depth
   * (the compare overlay draws one file over another with `EqualDepth` to
   * find the paths both have).
   */
  setDepth(func: THREE.DepthModes, write: boolean): void {
    for (const c of this.chunks) {
      c.mesh.material.depthFunc = func;
      c.mesh.material.depthWrite = write;
    }
    if (this.line) {
      this.line.material.depthFunc = func;
      this.line.material.depthWrite = write;
    }
  }

  /**
   * The camera started or stopped moving. Big files draw lines meanwhile;
   * returns whether anything changed (so the caller redraws).
   */
  setMoving(moving: boolean): boolean {
    if (moving === this.moving) return false;
    this.moving = moving;
    if (this.mode !== "beads" || !this.line || !this.view) return false;
    this.setView(this.view);
    return true;
  }

  /**
   * The extrusion at or before `index` (not before `from`), for the
   * scrubber's readout: a gap (travel) shows the extrusion it follows.
   */
  segmentAt(index: number, from = 0): { feature: number; tool: number; speed: number; width: number; height: number } | null {
    const e = this.p.extrusions;
    while (index >= from && index >= 0 && index < e.count && e.feature[index] === GAP) index--;
    if (index < Math.max(0, from) || index >= e.count) return null;
    return {
      feature: e.feature[index],
      tool: e.tool[index],
      speed: e.speed[index] / 10,
      width: e.size[index * 2] / 1000,
      height: e.size[index * 2 + 1] / 1000,
    };
  }

  /**
   * Free the GPU buffers and programs. The objects stay as they are: drawn
   * again (React's StrictMode remounts), three uploads them again.
   */
  dispose(): void {
    for (const c of this.chunks) {
      c.mesh.geometry.dispose();
      c.mesh.material.dispose();
    }
    this.beads.dispose();
    for (const o of [this.line, this.travel, this.retract, this.head]) {
      if (!o) continue;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }

  // ---- building -------------------------------------------------------------------

  private build(): void {
    const e = this.p.extrusions;
    if (e.count === 0) return;
    if (this.mode === "lines" || e.count > MOVING_LINES) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(e.points, 3));
      g.setAttribute("aColor", new THREE.BufferAttribute(this.colors, 4, true));
      g.boundingSphere = chainSphere(e.points, 0, e.count);
      const m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: LINE_VERTEX,
        fragmentShader: LINE_FRAGMENT,
        uniforms: { ...this.shared },
      });
      this.line = new THREE.Line(g, m);
      this.line.visible = this.mode === "lines";
      this.group.add(this.line);
      if (this.mode === "lines") return;
    }
    for (let start = 0; start < e.count; start += CHUNK) {
      const end = Math.min(e.count, start + CHUNK);
      const g = new THREE.InstancedBufferGeometry();
      g.index = this.beads.index;
      g.setAttribute("position", this.beads.attributes.position);
      g.setAttribute("aExt", this.beads.attributes.aExt);
      const chain = new THREE.InstancedInterleavedBuffer(e.points.subarray(start * 3, (end + 1) * 3), 3, 1);
      g.setAttribute("iStart", new THREE.InterleavedBufferAttribute(chain, 3, 0));
      g.setAttribute("iEnd", new THREE.InterleavedBufferAttribute(chain, 3, 3));
      g.setAttribute("iSize", new THREE.InstancedBufferAttribute(e.size.subarray(start * 2, end * 2), 2, true));
      g.setAttribute("iColor", new THREE.InstancedBufferAttribute(this.colors.subarray((start + 1) * 4, (end + 1) * 4), 4, true));
      g.instanceCount = end - start;
      // Beads are at most a few mm wide: pad the chain's sphere for them.
      const sphere = chainSphere(e.points, start, end);
      sphere.radius += 3;
      g.boundingSphere = sphere;
      const m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: TUBE_VERTEX,
        fragmentShader: TUBE_FRAGMENT,
        uniforms: { ...this.shared, uBase: { value: start } },
      });
      const mesh = new THREE.Mesh(g, m);
      this.chunks.push({ mesh, start, end });
      this.group.add(mesh);
    }
  }

  private clearExtrusions(): void {
    for (const c of this.chunks) {
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose();
      c.mesh.material.dispose();
    }
    this.chunks = [];
    if (this.line) {
      this.group.remove(this.line);
      this.line.geometry.dispose();
      this.line.material.dispose();
      this.line = null;
    }
  }

  private travelLines(): THREE.LineSegments {
    if (this.travel) return this.travel;
    const t = this.p.travels;
    const colors = new Uint8Array(t.count * 2 * 3);
    for (let i = 0; i < t.count; i++) {
      // OrcaSlicer: travel blue, wipe yellow.
      const c = t.kind[i] === WIPE ? [255, 255, 0] : [56, 72, 155];
      colors.set(c, i * 6);
      colors.set(c, i * 6 + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(t.ends, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3, true));
    const m = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
    this.travel = new THREE.LineSegments(g, m);
    this.travel.frustumCulled = false;
    this.group.add(this.travel);
    return this.travel;
  }

  private retractPoints(): THREE.Points {
    if (this.retract) return this.retract;
    const r = this.p.retractions;
    const colors = new Uint8Array(r.count * 3);
    for (let i = 0; i < r.count; i++) colors.set(r.kind[i] === RETRACT ? [205, 34, 214] : [115, 255, 84], i * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(r.pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3, true));
    const m = new THREE.PointsMaterial({ vertexColors: true, size: 6, sizeAttenuation: false });
    this.retract = new THREE.Points(g, m);
    this.retract.frustumCulled = false;
    this.group.add(this.retract);
    return this.retract;
  }
}
