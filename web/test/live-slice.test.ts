// Unit tests of the live view's frames (src/components/preview/liveSlice.ts):
// `bun test` in web/. Frames are encoded here as cxx/live_geometry.cpp
// writes them (plans/live-slice-preview.md has the format).
import { describe, expect, test } from "bun:test";
import {
  FrameReader,
  LiveSlice,
  STEP_INFILL,
  STEP_OUTLINES,
  STEP_SUPPORTS,
  STEP_WALLS,
  decodeFrame,
  decodeProgress,
  exportLayer,
  messagePlate,
} from "../src/components/preview/liveSlice";
import { GAP } from "../src/components/preview/types";

interface TestPath {
  name: number;
  tool?: number;
  width?: number;
  height?: number;
  points: [number, number][];
}
interface TestFrame {
  plate?: number;
  object?: number;
  step: number;
  skipped?: boolean;
  instances?: [number, number][];
  names?: string[];
  layers?: { z: number; height: number; paths: TestPath[] }[];
}

/** A frame, byte for byte as the C++ side writes it. */
function encode(f: TestFrame): Uint8Array {
  const bytes: number[] = [];
  const view = new DataView(new ArrayBuffer(4));
  const u8 = (v: number) => bytes.push(v & 0xff);
  const u16 = (v: number) => {
    view.setUint16(0, v, true);
    bytes.push(view.getUint8(0), view.getUint8(1));
  };
  const u32 = (v: number) => {
    view.setUint32(0, v, true);
    for (let i = 0; i < 4; i++) bytes.push(view.getUint8(i));
  };
  const f32 = (v: number) => {
    view.setFloat32(0, v, true);
    for (let i = 0; i < 4; i++) bytes.push(view.getUint8(i));
  };
  for (const c of "FSL1") u8(c.charCodeAt(0));
  u32(f.plate ?? 1);
  u32(f.object ?? 0);
  u8(f.step);
  u8(f.skipped ? 1 : 0);
  u16(0);
  const instances = f.instances ?? [[0, 0]];
  u32(instances.length);
  for (const [x, y] of instances) {
    f32(x);
    f32(y);
  }
  const names = f.names ?? [];
  u16(names.length);
  for (const n of names) {
    const b = new TextEncoder().encode(n);
    u16(b.length);
    for (const x of b) u8(x);
  }
  const layers = f.layers ?? [];
  u32(layers.length);
  for (const l of layers) {
    f32(l.z);
    f32(l.height);
    u32(l.paths.length);
    for (const p of l.paths) {
      u8(p.name);
      u8(p.tool ?? 0);
      u16(p.width ?? 420);
      u16(p.height ?? 200);
      u16(0);
      u32(p.points.length);
      for (const [x, y] of p.points) {
        f32(x);
        f32(y);
      }
    }
  }
  return new Uint8Array(bytes);
}

const square: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];

describe("decodeFrame", () => {
  test("reads every field", () => {
    const f = decodeFrame(
      encode({
        plate: 2,
        object: 3,
        step: STEP_WALLS,
        instances: [
          [100, 120],
          [140, 120],
        ],
        names: ["Outer wall", "Inner wall"],
        layers: [
          { z: 0.2, height: 0.2, paths: [{ name: 0, tool: 1, width: 450, points: square }] },
          { z: 0.4, height: 0.2, paths: [{ name: 1, points: square.slice(0, 3) }, { name: 0, points: square }] },
        ],
      }),
    );
    expect(f.plate).toBe(2);
    expect(f.object).toBe(3);
    expect(f.step).toBe(STEP_WALLS);
    expect(f.skipped).toBe(false);
    expect([...f.instances]).toEqual([100, 120, 140, 120]);
    expect(f.names).toEqual(["Outer wall", "Inner wall"]);
    expect(f.layers.count).toBe(2);
    expect(f.layers.z[1]).toBeCloseTo(0.4);
    expect([...f.layers.pathStart]).toEqual([0, 1, 3]);
    expect([...f.paths.name]).toEqual([0, 1, 0]);
    expect(f.paths.tool[0]).toBe(1);
    expect(f.paths.width[0]).toBe(450);
    expect([...f.paths.pointStart]).toEqual([0, 5, 8, 13]);
    expect(f.points[2]).toBe(10);
  });

  test("reads points at any alignment", () => {
    // A three-letter name leaves the points off a 4-byte boundary.
    const f = decodeFrame(encode({ step: STEP_OUTLINES, names: ["abc"], layers: [{ z: 0.2, height: 0.2, paths: [{ name: 0, points: square }] }] }));
    expect([...f.points.slice(0, 4)]).toEqual([0, 0, 10, 0]);
  });

  test("refuses what isn't a frame", () => {
    expect(() => decodeFrame(new Uint8Array([1, 2, 3, 4, 5]))).toThrow();
    const ok = encode({ step: STEP_WALLS, names: ["x"], layers: [{ z: 0.2, height: 0.2, paths: [{ name: 0, points: square }] }] });
    expect(() => decodeFrame(ok.slice(0, ok.length - 3))).toThrow("truncated");
  });
});

describe("FrameReader", () => {
  test("splits a stream whatever its chunks", () => {
    const a = encode({ step: STEP_OUTLINES });
    const b = encode({ step: STEP_WALLS, object: 1 });
    const stream: number[] = [];
    for (const f of [a, b]) {
      const len = new DataView(new ArrayBuffer(4));
      len.setUint32(0, f.length, true);
      stream.push(...new Uint8Array(len.buffer), ...f);
    }
    const bytes = new Uint8Array(stream);
    for (const cut of [1, 3, 4, 7, a.length + 4, a.length + 6, bytes.length - 1]) {
      const r = new FrameReader();
      const out = [...r.push(bytes.slice(0, cut)), ...r.push(bytes.slice(cut))];
      expect(out.map((f) => decodeFrame(f).object)).toEqual([0, 1]);
    }
  });
});

describe("LiveSlice", () => {
  const outline = (object = 0, z = [0.2, 0.4]) =>
    decodeFrame(
      encode({ object, step: STEP_OUTLINES, names: ["Outline"], layers: z.map((zz) => ({ z: zz, height: 0.2, paths: [{ name: 0, points: square }] })) }),
    );

  test("builds a chain the preview draws: gaps between paths, layers in order", () => {
    let live = LiveSlice.empty();
    live = live.add(outline());
    const p = live.build(1)!;
    expect(p.layers.count).toBe(2);
    expect([...p.layers.z].map((z) => Math.round(z * 10) / 10)).toEqual([0.2, 0.4]);
    // Two squares of 4 segments, one gap between them.
    expect(p.extrusions.count).toBe(9);
    expect([...p.layers.extrusionStart]).toEqual([0, 4, 9]);
    expect(p.extrusions.feature[4]).toBe(GAP);
    expect(p.info.features).toEqual(["Outline"]);
    expect(p.extrusions.points[3 * 9 + 2]).toBeCloseTo(0.4);
    expect(p.info.modelBounds?.max[0]).toBe(10);
  });

  test("walls replace an object's outlines; other objects keep theirs", () => {
    let live = LiveSlice.empty();
    live = live.add(outline(0));
    live = live.add(outline(1));
    live = live.add(
      decodeFrame(encode({ object: 0, step: STEP_WALLS, names: ["Outer wall"], layers: [{ z: 0.2, height: 0.2, paths: [{ name: 0, points: square }] }] })),
    );
    const p = live.build(1)!;
    expect(new Set(p.info.features)).toEqual(new Set(["Outer wall", "Outline"]));
    // Object 1's two outline layers + object 0's one wall layer: 3 squares.
    expect(p.extrusions.count).toBe(3 * 5 - 1);
  });

  test("copies are drawn at their shifts", () => {
    let live = LiveSlice.empty();
    live = live.add(
      decodeFrame(
        encode({
          step: STEP_OUTLINES,
          instances: [
            [100, 100],
            [150, 100],
          ],
          names: ["Outline"],
          layers: [{ z: 0.2, height: 0.2, paths: [{ name: 0, points: square }] }],
        }),
      ),
    );
    const p = live.build(1)!;
    expect(p.extrusions.count).toBe(9);
    expect(p.info.modelBounds?.min[0]).toBe(100);
    expect(p.info.modelBounds?.max[0]).toBe(160);
  });

  test("support layers between the object's merge in by height", () => {
    let live = LiveSlice.empty();
    live = live.add(outline(0, [0.4, 0.6]));
    live = live.add(
      decodeFrame(encode({ step: STEP_SUPPORTS, names: ["Support"], layers: [{ z: 0.2, height: 0.2, paths: [{ name: 0, points: square }] }] })),
    );
    const p = live.build(1)!;
    expect(p.layers.count).toBe(3);
    expect(p.info.features[p.extrusions.feature[0]]).toBe("Support");
  });

  test("a newer frame of a step replaces the older; plates are kept apart", () => {
    let live = LiveSlice.empty();
    live = live.add(outline(0, [0.2]));
    live = live.add(outline(0, [0.2, 0.4, 0.6]));
    live = live.add(decodeFrame(encode({ plate: 2, step: STEP_OUTLINES, names: ["Outline"], layers: [{ z: 0.2, height: 0.2, paths: [{ name: 0, points: square }] }] })));
    expect(live.build(1)!.layers.count).toBe(3);
    expect(live.build(2)!.layers.count).toBe(1);
    expect(live.build(3)).toBeNull();
    expect(live.plates()).toEqual([1, 2]);
  });

  test("steps count objects, and skipped ones", () => {
    let live = LiveSlice.empty();
    live = live.add(outline(0));
    live = live.add(outline(1));
    live = live.add(decodeFrame(encode({ object: 0, step: STEP_INFILL, skipped: true })));
    const { objects, steps } = live.steps(1);
    expect(objects).toBe(2);
    expect(steps[STEP_OUTLINES]).toEqual({ step: STEP_OUTLINES, done: 2, skipped: 0 });
    expect(steps[STEP_INFILL]).toEqual({ step: STEP_INFILL, done: 1, skipped: 1 });
    // A skipped step draws nothing of its own.
    expect(live.build(1)!.info.features).toEqual(["Outline"]);
  });
});

describe("decodeProgress", () => {
  // src/live.rs progress_frame: "FSP1", percent, u16 length, UTF-8.
  const progress = (percent: number, message: string) => {
    const text = new TextEncoder().encode(message);
    return new Uint8Array([0x46, 0x53, 0x50, 0x31, percent, text.length & 0xff, text.length >> 8, ...text]);
  };

  test("reads a progress frame", () => {
    expect(decodeProgress(progress(80, "Generating G-code: layer 12"))).toEqual({ percent: 80, message: "Generating G-code: layer 12" });
    expect(decodeProgress(progress(5, "Décalage"))).toEqual({ percent: 5, message: "Décalage" });
  });

  test("passes geometry frames by, refuses a truncated one", () => {
    expect(decodeProgress(encode({ step: STEP_OUTLINES }))).toBeNull();
    expect(() => decodeProgress(progress(1, "abc").slice(0, 9))).toThrow("truncated");
  });

  test("comes through the stream's framing with geometry", () => {
    const parts = [encode({ step: STEP_WALLS }), progress(40, "Generating infill toolpath")];
    const stream: number[] = [];
    for (const f of parts) stream.push(f.length & 0xff, (f.length >> 8) & 0xff, 0, 0, ...f);
    const out = new FrameReader().push(new Uint8Array(stream));
    expect(out.map((f) => decodeProgress(f)?.percent ?? "geometry")).toEqual(["geometry", 40]);
  });
});

describe("progress messages", () => {
  test("the layer G-code export is at", () => {
    expect(exportLayer("Generating G-code: layer 12")).toBe(12);
    expect(exportLayer("Plate 2/3: Generating G-code: layer 0")).toBe(0);
    expect(exportLayer("Generating infill toolpath")).toBeNull();
    expect(exportLayer(null)).toBeNull();
  });

  test("the plate a message is about", () => {
    expect(messagePlate("Plate 2/3: Generating walls")).toBe(2);
    expect(messagePlate("Generating walls")).toBe(1);
  });
});
