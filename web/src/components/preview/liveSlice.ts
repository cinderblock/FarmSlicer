// The live view of a slice in progress (plans/live-slice-preview.md): the
// frames libslic3r's steps send as they finish (cxx/live_geometry.cpp),
// one per object and step (outlines, walls, infill, supports), decoded and
// merged into what the G-code preview draws (a `ParsedGcode`, with no
// travels: they come with the G-code). Pure, no DOM; web/test/live-slice.test.ts.
//
// An object's outlines give way to its walls once they're in. A frame for
// the same plate, object and step replaces the one before.

import { GAP, type ParsedGcode } from "./types";

export const STEP_OUTLINES = 0;
export const STEP_WALLS = 1;
export const STEP_INFILL = 2;
export const STEP_SUPPORTS = 3;
export const STEP_NAMES = ["Outlines", "Walls", "Infill", "Supports"] as const;

/** One decoded frame: an object's step on a plate. */
export interface LiveFrame {
  /** 1-based. */
  plate: number;
  object: number;
  step: number;
  /** Over the slice's point budget: no geometry came. */
  skipped: boolean;
  /** The object's copies: x, y shift (mm) each. */
  instances: Float32Array;
  /** Feature names the paths index. */
  names: string[];
  layers: {
    count: number;
    z: Float32Array;
    height: Float32Array;
    /** Paths of layer i: `[pathStart[i], pathStart[i + 1])`. */
    pathStart: Uint32Array;
  };
  paths: {
    count: number;
    name: Uint8Array;
    tool: Uint8Array;
    /** µm. */
    width: Uint16Array;
    height: Uint16Array;
    /** Points of path i: `[pointStart[i], pointStart[i + 1])`. */
    pointStart: Uint32Array;
  };
  /** x, y per point (object coordinates, mm). */
  points: Float32Array;
}

const MAGIC = 0x314c5346; // "FSL1", little-endian

/** Decode one frame; throws on anything that isn't one. */
export function decodeFrame(buffer: ArrayBuffer | Uint8Array): LiveFrame {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n: number) => {
    if (at + n > bytes.byteLength) throw new Error("live frame: truncated");
  };
  const u8 = () => (need(1), view.getUint8(at++));
  const u16 = () => {
    need(2);
    const v = view.getUint16(at, true);
    at += 2;
    return v;
  };
  const u32 = () => {
    need(4);
    const v = view.getUint32(at, true);
    at += 4;
    return v;
  };
  const f32 = () => {
    need(4);
    const v = view.getFloat32(at, true);
    at += 4;
    return v;
  };

  if (u32() !== MAGIC) throw new Error("live frame: not a frame");
  const plate = u32();
  const object = u32();
  const step = u8();
  const flags = u8();
  u16();
  const instanceCount = u32();
  const instances = new Float32Array(instanceCount * 2);
  for (let i = 0; i < instances.length; i++) instances[i] = f32();
  const nameCount = u16();
  const names: string[] = [];
  const text = new TextDecoder();
  for (let i = 0; i < nameCount; i++) {
    const len = u16();
    need(len);
    names.push(text.decode(bytes.subarray(at, at + len)));
    at += len;
  }

  // Layers and paths: one pass to find the sizes, one to fill.
  const layerCount = u32();
  const layersAt = at;
  let pathCount = 0;
  let pointCount = 0;
  for (let l = 0; l < layerCount; l++) {
    at += 8;
    const paths = u32();
    pathCount += paths;
    for (let p = 0; p < paths; p++) {
      at += 8;
      const n = u32();
      pointCount += n;
      need(n * 8);
      at += n * 8;
    }
  }
  at = layersAt;
  const z = new Float32Array(layerCount);
  const height = new Float32Array(layerCount);
  const pathStart = new Uint32Array(layerCount + 1);
  const name = new Uint8Array(pathCount);
  const tool = new Uint8Array(pathCount);
  const width = new Uint16Array(pathCount);
  const pathHeight = new Uint16Array(pathCount);
  const pointStart = new Uint32Array(pathCount + 1);
  const points = new Float32Array(pointCount * 2);
  let path = 0;
  let point = 0;
  for (let l = 0; l < layerCount; l++) {
    z[l] = f32();
    height[l] = f32();
    pathStart[l] = path;
    const paths = u32();
    for (let p = 0; p < paths; p++, path++) {
      name[path] = u8();
      tool[path] = u8();
      width[path] = u16();
      pathHeight[path] = u16();
      u16();
      const n = u32();
      pointStart[path] = point;
      if ((bytes.byteOffset + at) % 4 === 0) {
        points.set(new Float32Array(bytes.buffer, bytes.byteOffset + at, n * 2), point * 2);
        at += n * 8;
      } else {
        for (let i = 0; i < n * 2; i++) points[point * 2 + i] = f32();
      }
      point += n;
    }
  }
  pathStart[layerCount] = path;
  pointStart[pathCount] = point;

  return {
    plate,
    object,
    step,
    skipped: (flags & 1) !== 0,
    instances,
    names,
    layers: { count: layerCount, z, height, pathStart },
    paths: { count: pathCount, name, tool, width, height: pathHeight, pointStart },
    points,
  };
}

/**
 * Splits the server's stream (`GET /api/jobs/{id}/live`: each frame after
 * its u32 length) into frames, whatever the chunks.
 */
export class FrameReader {
  private pending = new Uint8Array(0);

  /** The frames this chunk completes. */
  push(chunk: Uint8Array): Uint8Array[] {
    let buf: Uint8Array;
    if (this.pending.length === 0) buf = chunk;
    else {
      buf = new Uint8Array(this.pending.length + chunk.length);
      buf.set(this.pending);
      buf.set(chunk, this.pending.length);
    }
    const out: Uint8Array[] = [];
    let at = 0;
    while (buf.length - at >= 4) {
      const len = new DataView(buf.buffer, buf.byteOffset + at, 4).getUint32(0, true);
      if (buf.length - at - 4 < len) break;
      out.push(buf.slice(at + 4, at + 4 + len));
      at += 4 + len;
    }
    this.pending = buf.slice(at);
    return out;
  }
}

/** What has arrived of one step, over a plate's objects. */
export interface StepState {
  step: number;
  /** Objects whose step is in. */
  done: number;
  /** ...of which over the point budget (not shown). */
  skipped: number;
}

/** Every frame so far, by plate. Immutable: adding a frame makes another. */
export class LiveSlice {
  private readonly frames: ReadonlyMap<string, LiveFrame>;

  private constructor(frames: ReadonlyMap<string, LiveFrame>) {
    this.frames = frames;
  }

  static empty(): LiveSlice {
    return new LiveSlice(new Map());
  }

  /** These frames and `frame` (in place of the one for its plate, object and step). */
  add(frame: LiveFrame): LiveSlice {
    const frames = new Map(this.frames);
    frames.set(`${frame.plate}:${frame.object}:${frame.step}`, frame);
    return new LiveSlice(frames);
  }

  get empty(): boolean {
    return this.frames.size === 0;
  }

  /** Plates that have frames, in order. */
  plates(): number[] {
    return [...new Set([...this.frames.values()].map((f) => f.plate))].sort((a, b) => a - b);
  }

  private ofPlate(plate: number): LiveFrame[] {
    return [...this.frames.values()].filter((f) => f.plate === plate).sort((a, b) => a.object - b.object || a.step - b.step);
  }

  /** How far each step has come on `plate` (objects counted from the outlines). */
  steps(plate: number): { objects: number; steps: StepState[] } {
    const frames = this.ofPlate(plate);
    const objects = new Set(frames.map((f) => f.object)).size;
    const steps = STEP_NAMES.map((_, step) => {
      const of = frames.filter((f) => f.step === step);
      return { step, done: of.length, skipped: of.filter((f) => f.skipped).length };
    });
    return { objects, steps };
  }

  /** The plate as the preview draws it; null before anything arrived. */
  build(plate: number): ParsedGcode | null {
    const all = this.ofPlate(plate).filter((f) => !f.skipped);
    if (all.length === 0) return null;
    const withWalls = new Set(all.filter((f) => f.step === STEP_WALLS).map((f) => f.object));
    const shown = all.filter((f) => f.step !== STEP_OUTLINES || !withWalls.has(f.object));

    // Feature names over every frame.
    const features: string[] = [];
    const featureIndex = new Map<string, number>();
    const featureOf = shown.map((f) =>
      f.names.map((n) => {
        let i = featureIndex.get(n);
        if (i === undefined) {
          i = features.length;
          features.push(n);
          featureIndex.set(n, i);
        }
        return i;
      }),
    );

    // Layers: every print_z over every frame (to the micrometre), in order.
    const key = (z: number) => Math.round(z * 1000);
    const heights = new Map<number, { z: number; height: number }>();
    for (const f of shown)
      for (let l = 0; l < f.layers.count; l++) {
        const k = key(f.layers.z[l]);
        if (!heights.has(k)) heights.set(k, { z: f.layers.z[l], height: f.layers.height[l] });
      }
    const order = [...heights.keys()].sort((a, b) => a - b);
    const layerOf = new Map(order.map((k, i) => [k, i]));
    // Per merged layer: (frame, its layer) pairs, in frame order.
    const byLayer: [number, number][][] = order.map(() => []);
    shown.forEach((f, fi) => {
      for (let l = 0; l < f.layers.count; l++) byLayer[layerOf.get(key(f.layers.z[l]))!].push([fi, l]);
    });

    // Sizes: per path and copy, its segments, plus a gap before it.
    let segments = 0;
    for (const pairs of byLayer)
      for (const [fi, l] of pairs) {
        const f = shown[fi];
        const copies = f.instances.length / 2;
        for (let p = f.layers.pathStart[l]; p < f.layers.pathStart[l + 1]; p++) {
          const n = f.paths.pointStart[p + 1] - f.paths.pointStart[p];
          if (n >= 2) segments += copies * n; // n - 1 segments + 1 gap
        }
      }
    if (segments > 0) segments -= 1; // no gap before the first path

    const points = new Float32Array((segments + 1) * 3);
    const size = new Uint16Array(segments * 2);
    const feature = new Uint8Array(segments);
    const tool = new Uint8Array(segments);
    const layerZ = new Float32Array(order.length);
    const layerHeight = new Float32Array(order.length);
    const extrusionStart = new Uint32Array(order.length + 1);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let toolCount = 1;
    let seg = 0;
    let started = false;

    order.forEach((k, li) => {
      const { z, height } = heights.get(k)!;
      layerZ[li] = z;
      layerHeight[li] = height;
      extrusionStart[li] = seg;
      for (const [fi, l] of byLayer[li]) {
        const f = shown[fi];
        const names = featureOf[fi];
        for (let c = 0; c < f.instances.length / 2; c++) {
          const dx = f.instances[c * 2];
          const dy = f.instances[c * 2 + 1];
          for (let p = f.layers.pathStart[l]; p < f.layers.pathStart[l + 1]; p++) {
            const from = f.paths.pointStart[p];
            const to = f.paths.pointStart[p + 1];
            if (to - from < 2) continue;
            const feat = names[f.paths.name[p]] ?? 0;
            const t = f.paths.tool[p];
            if (t + 1 > toolCount) toolCount = t + 1;
            for (let i = from; i < to; i++) {
              const x = f.points[i * 2] + dx;
              const y = f.points[i * 2 + 1] + dy;
              if (!started) {
                started = true;
              } else {
                // The segment into this point: a gap into the path's first one.
                feature[seg] = i === from ? GAP : feat;
                tool[seg] = t;
                size[seg * 2] = f.paths.width[p];
                size[seg * 2 + 1] = f.paths.height[p];
                seg++;
              }
              points[seg * 3] = x;
              points[seg * 3 + 1] = y;
              points[seg * 3 + 2] = z;
              if (x < min[0]) min[0] = x;
              if (y < min[1]) min[1] = y;
              if (z < min[2]) min[2] = z;
              if (x > max[0]) max[0] = x;
              if (y > max[1]) max[1] = y;
              if (z > max[2]) max[2] = z;
            }
          }
        }
      }
    });
    extrusionStart[order.length] = seg;
    // A layer's first segment is the gap into it: it belongs to the layer,
    // as the parser has it (the gap is drawn with the extrusion after it).
    const bounds = Number.isFinite(min[0]) ? { min, max } : null;

    return {
      info: {
        features,
        toolCount,
        filamentColors: [],
        filamentTypes: [],
        bed: null,
        totalTime: 0,
        timeSource: "estimate",
        prepareTime: 0,
        featureTime: features.map(() => 0),
        travelTime: 0,
        filament: [],
        generator: null,
        bounds,
        modelBounds: bounds,
        speedRange: [0, 0],
        layerComments: true,
        lines: 0,
        bytes: 0,
        meta: {},
      },
      layers: {
        count: order.length,
        z: layerZ,
        height: layerHeight,
        time: new Float32Array(order.length),
        extrusionStart,
        travelStart: new Uint32Array(order.length + 1),
        retractStart: new Uint32Array(order.length + 1),
        line: new Uint32Array(order.length),
      },
      extrusions: {
        count: seg,
        points,
        size,
        feature,
        tool,
        speed: new Uint16Array(seg),
        offset: new Uint32Array(seg),
      },
      travels: {
        count: 0,
        ends: new Float32Array(0),
        kind: new Uint8Array(0),
        speed: new Uint16Array(0),
        line: new Uint32Array(0),
        at: new Uint32Array(0),
      },
      retractions: { count: 0, pos: new Float32Array(0), kind: new Uint8Array(0), line: new Uint32Array(0), at: new Uint32Array(0) },
    };
  }
}

/**
 * The layer G-code export has reached, from its progress message
 * ("Generating G-code: layer 12", possibly after "Plate 2/3: "), 0-based;
 * null when the message is about something else.
 */
export function exportLayer(message: string | null | undefined): number | null {
  const m = /Generating G-code: layer (\d+)/.exec(message ?? "");
  return m ? Number(m[1]) : null;
}

/** The plate a progress message is about ("Plate 2/3: ..."), 1-based; 1 without one. */
export function messagePlate(message: string | null | undefined): number {
  const m = /^Plate (\d+)\/\d+:/.exec(message ?? "");
  return m ? Number(m[1]) : 1;
}
