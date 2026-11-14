import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { zipSync } from "fflate";
import { makeObject, makeVolume, objectBounds, usedFilaments, isPlain } from "../src/model/document";
import {
  connectedComponents,
  faceNeighbors,
  identity,
  meshBounds,
  invert,
  mergeMeshes,
  multiply,
  openEdgeCount,
  signedVolume,
  translation,
  scaling,
  transformMesh,
  weld,
  type Mesh,
} from "../src/model/mesh";
import { BLOCKER, ENFORCER, PaintLayer } from "../src/model/paint";
import { readStl, writeStl } from "../src/model/stl";
import { formatTransform, parseTransform, read3mf, write3mf } from "../src/model/threemf";
import { formatFloat, parseXml } from "../src/model/xml";

/** A 20 mm cube, triangles facing out (12 triangles, 8 vertices). */
export function cube(size = 20, at: [number, number, number] = [0, 0, 0]): Mesh {
  const s = size;
  const v = [
    [0, 0, 0],
    [s, 0, 0],
    [s, s, 0],
    [0, s, 0],
    [0, 0, s],
    [s, 0, s],
    [s, s, s],
    [0, s, s],
  ].flatMap(([x, y, z]) => [x + at[0], y + at[1], z + at[2]]);
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: Float32Array.from(v), indices: Uint32Array.from(t) };
}

/** The same cube as an STL triangle soup (each vertex repeated). */
function soup(mesh: Mesh): Mesh {
  const positions = new Float32Array(mesh.indices.length * 3);
  mesh.indices.forEach((v, i) => positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), i * 3));
  return { positions, indices: Uint32Array.from(mesh.indices.keys()) };
}

describe("mesh", () => {
  test("cube basics", () => {
    const c = cube();
    expect(signedVolume(c)).toBeCloseTo(8000, 3);
    expect(openEdgeCount(c)).toBe(0);
    const nb = faceNeighbors(c);
    expect([...nb].every((n) => n >= 0)).toBe(true);
  });

  test("weld merges a soup and keeps triangle order", () => {
    const w = weld(soup(cube()));
    expect(w.positions.length / 3).toBe(8);
    expect(w.indices.length).toBe(36);
    expect(signedVolume(w)).toBeCloseTo(8000, 3);
  });

  test("components", () => {
    const two = mergeMeshes([cube(), cube(10, [50, 0, 0])]);
    const comps = connectedComponents(two);
    expect(comps.map((c) => c.length).sort()).toEqual([12, 12]);
  });

  test("matrices", () => {
    const m = multiply(translation(1, 2, 3), scaling(2, 2, 2));
    const inv = invert(m)!;
    const id = multiply(m, inv);
    for (let i = 0; i < 16; i++) expect(id[i]).toBeCloseTo(identity()[i], 12);
    expect(parseTransform(formatTransform(m))).toEqual(m);
  });
});

describe("stl", () => {
  test("binary round trip", () => {
    const bytes = writeStl(cube());
    const back = readStl(bytes);
    expect(back.indices.length).toBe(36);
    expect(signedVolume(back)).toBeCloseTo(8000, 3);
  });

  test("ascii", () => {
    const c = soup(cube());
    let s = "solid x\n";
    for (let t = 0; t < 12; t++) {
      s += "facet normal 0 0 0\nouter loop\n";
      for (let k = 0; k < 3; k++) {
        const i = (t * 3 + k) * 3;
        s += `vertex ${c.positions[i]} ${c.positions[i + 1]} ${c.positions[i + 2]}\n`;
      }
      s += "endloop\nendfacet\n";
    }
    s += "endsolid x\n";
    const m = readStl(new TextEncoder().encode(s));
    expect(m.positions.length / 3).toBe(8);
    expect(signedVolume(m)).toBeCloseTo(8000, 3);
  });
});

describe("xml", () => {
  test("parses attributes, entities, text", () => {
    const seen: string[] = [];
    parseXml(
      '<?xml version="1.0"?><!-- c --><a x="1" y=\'&amp;&lt;\'><b/>hi &amp; bye<![CDATA[<raw>]]></a>',
      {
        open: (n, a) => seen.push(`open ${n} ${JSON.stringify(a.toObject())}`),
        close: (n) => seen.push(`close ${n}`),
        text: (t) => seen.push(`text ${t}`),
      },
    );
    expect(seen).toEqual([
      'open a {"x":"1","y":"&<"}',
      "open b {}",
      "close b",
      "text hi & bye",
      "text <raw>",
      "close a",
    ]);
  });

  test("floats read back exactly", () => {
    for (const f of [0.1, 1 / 3, 123.456, -0.000123, 20]) {
      const x = Math.fround(f);
      expect(Math.fround(Number(formatFloat(x)))).toBe(x);
    }
  });
});

describe("paint (TriangleSelector format)", () => {
  const tri: Mesh = { positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]), indices: Uint32Array.from([0, 1, 2]) };

  test("leaf states", () => {
    const layer = new PaintLayer(tri);
    for (const [state, str] of [
      [1, "4"],
      [2, "8"],
      [3, "0C"],
      [4, "1C"],
      [16, "DC"],
    ] as const) {
      layer.setTriangle(0, state);
      expect(layer.getString(0)).toBe(str);
      const other = new PaintLayer(tri);
      other.setString(0, str);
      expect(other.getString(0)).toBe(str);
      expect([...other.usedStates()]).toEqual([state]);
    }
    layer.setTriangle(0, 0);
    expect(layer.getString(0)).toBe("");
    expect(layer.empty).toBe(true);
  });

  test("split trees round trip", () => {
    // Model.cpp builds strings like these when converting vertex colours:
    // three leaves of a 2-side split, and a 3-side split with a 1-split child.
    for (const s of ["4842", "0C482", "1C0C2C0C1C13", "4848" + "3", "8" + "4" + "41" + "4" + "8" + "3"]) {
      const layer = new PaintLayer(tri);
      layer.setString(0, s);
      expect(layer.getString(0)).toBe(s);
    }
  });

  test("brush splits along the edge and serializes", () => {
    const big = cube(20);
    const layer = new PaintLayer(big);
    // Top face (z = 20) triangles are 2 and 3. A sphere at a corner.
    const changed = layer.brush(2, { kind: "sphere", center: [0, 0, 20], radius: 5 }, ENFORCER, null);
    expect(changed.length).toBeGreaterThan(0);
    for (const t of layer.painted()) {
      const s = layer.getString(t);
      const back = new PaintLayer(big);
      back.setString(t, s);
      expect(back.getString(t)).toBe(s);
    }
    const leaves = layer.leaves();
    expect(leaves.states.every((s) => s === ENFORCER)).toBe(true);
    // Painted area ≈ the sphere's footprint on the top face (quarter disc).
    let area = 0;
    for (let i = 0; i < leaves.positions.length; i += 9) {
      const p = leaves.positions;
      const ux = p[i + 3] - p[i];
      const uy = p[i + 4] - p[i + 1];
      const vx = p[i + 6] - p[i];
      const vy = p[i + 7] - p[i + 1];
      if (Math.abs(p[i + 2] - 20) < 1e-3 && Math.abs(p[i + 5] - 20) < 1e-3 && Math.abs(p[i + 8] - 20) < 1e-3)
        area += Math.abs(ux * vy - uy * vx) / 2;
    }
    expect(area).toBeGreaterThan(Math.PI * 25 * 0.25 * 0.8);
    expect(area).toBeLessThan(Math.PI * 25 * 0.25 * 1.2);
  });

  test("erasing merges children back", () => {
    const big = cube(20);
    const layer = new PaintLayer(big);
    layer.brush(2, { kind: "sphere", center: [10, 10, 20], radius: 4 }, BLOCKER, null);
    expect(layer.empty).toBe(false);
    layer.brush(2, { kind: "sphere", center: [10, 10, 20], radius: 30 }, 0, null);
    expect(layer.empty).toBe(true);
  });

  test("smart fill paints a flat face, bucket fill a region", () => {
    const layer = new PaintLayer(cube());
    const filled = layer.smartFill(2, 5, 3);
    expect(filled.sort()).toEqual([2, 3]);
    layer.bucketFill(0, 4);
    // Every other face (unpainted, connected) took state 4.
    expect(layer.painted().length).toBe(12);
    expect([...layer.usedStates()].sort()).toEqual([3, 4]);
  });

  test("height range", () => {
    const layer = new PaintLayer(cube());
    layer.brush(0, { kind: "height", z0: 5, z1: 10 }, 2, null);
    expect(layer.usedStates().has(2)).toBe(true);
    // The top and bottom faces are outside the band.
    expect(layer.getString(2)).toBe("");
    expect(layer.getString(0)).toBe("");
  });

  test("remap", () => {
    const layer = new PaintLayer(cube());
    layer.setTriangle(0, 2);
    layer.setTriangle(1, 3);
    layer.remap(new Map([[3, 2]]));
    expect([...layer.usedStates()]).toEqual([2]);
  });
});

describe("3mf", () => {
  test("write and read back objects, volumes, filaments, paint, settings", () => {
    const paint = new PaintLayer(cube());
    paint.brush(2, { kind: "sphere", center: [0, 0, 20], radius: 6 }, 3, null);
    const supports = new PaintLayer(cube());
    supports.setTriangle(0, ENFORCER);
    const body = makeVolume(cube(), { name: "Body", paint: { color: paint, supports } });
    const modifier = makeVolume(cube(5), {
      name: "Infill box",
      type: "modifier",
      matrix: translation(5, 5, 5),
      settings: { sparse_infill_density: "50%" },
    });
    const knob = makeVolume(cube(5, [20, 0, 0]), { name: "Knob", extruder: 2 });
    const object = makeObject("Widget", [body, modifier, knob], { extruder: 1, settings: { wall_loops: "4" } });
    const plain = makeObject("Plain", [makeVolume(cube(10))], { extruder: 4 });

    const bytes = write3mf([object, plain], { application: "FarmSlicer-test" });
    const back = read3mf(bytes);
    expect(back.objects.length).toBe(2);
    const w = back.objects[0].object;
    expect(w.name).toBe("Widget");
    expect(w.settings).toEqual({ wall_loops: "4" });
    expect(w.volumes.map((v) => [v.name, v.type, v.extruder])).toEqual([
      ["Body", "part", 0],
      ["Infill box", "modifier", 0],
      ["Knob", "part", 2],
    ]);
    expect(w.volumes[1].settings).toEqual({ sparse_infill_density: "50%" });
    expect(w.volumes[1].matrix[12]).toBe(5);
    for (const t of paint.painted()) expect(w.volumes[0].paint.color!.getString(t)).toBe(paint.getString(t));
    expect(w.volumes[0].paint.supports!.getString(0)).toBe("4");
    expect([...usedFilaments(w)].sort()).toEqual([1, 2, 3]);
    expect(back.objects[1].object.extruder).toBe(4);
    expect(isPlain(back.objects[1].object)).toBe(false);
  });

  test("core colours become filaments", () => {
    const xml = `<?xml version="1.0"?>
<model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources>
<basematerials id="5"><base name="red" displaycolor="#FF0000"/><base name="blue" displaycolor="#0000FFFF"/></basematerials>
<object id="1" type="model" pid="5" pindex="0"><mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>
</vertices><triangles>
<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3" p1="1"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/>
</triangles></mesh></object>
</resources><build><item objectid="1"/></build></model>`;
    const bytes = zipSync({ "3D/3dmodel.model": new TextEncoder().encode(xml) });
    const back = read3mf(bytes);
    expect(back.palette).toEqual(["#FF0000", "#0000FF"]);
    const v = back.objects[0].object.volumes[0];
    // Centimetres: the matrix scales by 10.
    expect(v.matrix[0]).toBe(10);
    expect(v.paint.color!.getString(1)).toBe("8");
    expect(v.paint.color!.getString(0)).toBe("4");
  });

  test("the same objects make the same bytes", () => {
    const o = makeObject("Cube", [makeVolume(cube())]);
    expect(write3mf([o])).toEqual(write3mf([o]));
  });

  const bambu = "../extern/OrcaSlicer/resources/calib/pressure_advance/auto_pa_line_dual.3mf";
  test.skipIf(!existsSync(bambu))("reads a Bambu Studio project", () => {
    const back = read3mf(readFileSync(bambu));
    expect(back.objects.length).toBeGreaterThan(1);
    for (const { object } of back.objects) {
      expect(object.volumes.length).toBeGreaterThan(0);
      for (const v of object.volumes) expect(v.mesh.indices.length).toBeGreaterThan(0);
    }
    // Writing it again keeps every triangle.
    const again = read3mf(write3mf(back.objects.map((o) => o.object)));
    const count = (l: typeof back) => l.objects.reduce((n, o) => n + o.object.volumes.reduce((m, v) => m + v.mesh.indices.length, 0), 0);
    expect(count(again)).toBe(count(back));
  });
});

describe("primitives", () => {
  test("closed and the right volume", async () => {
    const { box, cylinder, sphere, cone } = await import("../src/model/primitives");
    const close = (a: number, b: number, rel: number) => expect(Math.abs(a - b) / b).toBeLessThan(rel);
    for (const [mesh, volume] of [
      [box(10, 20, 30), 6000],
      [cylinder(5, 10), Math.PI * 25 * 10],
      [cone(5, 9), (Math.PI * 25 * 9) / 3],
      [sphere(10), (4 / 3) * Math.PI * 1000],
    ] as const) {
      expect(openEdgeCount(mesh)).toBe(0);
      close(signedVolume(mesh), volume, 0.02);
    }
  });
});

describe("cut", () => {
  test("a cube cut flat: two closed halves of half the volume", async () => {
    const { cutMesh } = await import("../src/model/cut");
    const c = cutMesh(cube(), { point: [0, 0, 10], normal: [0, 0, 1] });
    for (const half of [c.upper!, c.lower!]) {
      expect(openEdgeCount(weld(half))).toBe(0);
      expect(signedVolume(half)).toBeCloseTo(4000, 2);
    }
    expect(c.openLoops).toBe(0);
  });

  test("a tilted cut keeps the total", async () => {
    const { cutMesh } = await import("../src/model/cut");
    const c = cutMesh(cube(), { point: [10, 10, 10], normal: [0.3, -0.5, 0.8] });
    expect(openEdgeCount(weld(c.upper!))).toBe(0);
    expect(openEdgeCount(weld(c.lower!))).toBe(0);
    expect(signedVolume(c.upper!) + signedVolume(c.lower!)).toBeCloseTo(8000, 1);
    expect(signedVolume(c.upper!)).toBeGreaterThan(0);
    expect(signedVolume(c.lower!)).toBeGreaterThan(0);
  });

  test("a tube's cut face has its hole", async () => {
    const { cutMesh } = await import("../src/model/cut");
    const { cylinder } = await import("../src/model/primitives");
    const inner = cylinder(5, 20, 48);
    const outer = cylinder(10, 20, 48);
    // The inner wall faces in: flip it.
    const flipped = { positions: inner.positions, indices: inner.indices.slice() };
    for (let t = 0; t < flipped.indices.length; t += 3)
      [flipped.indices[t + 1], flipped.indices[t + 2]] = [flipped.indices[t + 2], flipped.indices[t + 1]];
    const tube = mergeMeshes([outer, flipped]);
    const whole = signedVolume(tube);
    const c = cutMesh(tube, { point: [0, 0, 0], normal: [0, 0, 1] });
    expect(signedVolume(c.upper!)).toBeCloseTo(whole / 2, 0);
    expect(openEdgeCount(weld(c.upper!))).toBe(0);
  });

  test("paint goes with the pieces", async () => {
    const { cutObject } = await import("../src/model/cut");
    const color = new PaintLayer(cube());
    color.setTriangle(2, 3); // top face
    color.setTriangle(3, 3);
    color.setTriangle(0, 2); // bottom face
    const o = makeObject("Block", [makeVolume(cube(), { paint: { color } })]);
    const { upper, lower } = cutObject(o, { point: [0, 0, 10], normal: [0, 0, 1] });
    expect(upper!.name).toBe("Block (upper)");
    expect([...upper!.volumes[0].paint.color!.usedStates()]).toEqual([3]);
    expect([...lower!.volumes[0].paint.color!.usedStates()]).toEqual([2]);
  });

  test("a plane past the model leaves one half", async () => {
    const { cutObject } = await import("../src/model/cut");
    const o = makeObject("Block", [makeVolume(cube())]);
    const { upper, lower } = cutObject(o, { point: [0, 0, 50], normal: [0, 0, 1] });
    expect(upper).toBeNull();
    expect(lower!.volumes[0].mesh.indices.length).toBe(36);
  });
});

describe("connectors", () => {
  const plane = { point: [0, 0, 10] as [number, number, number], normal: [0, 0, 1] as [number, number, number] };

  test("plugs: a peg on the lower half, a hole in the upper", async () => {
    const { cutObject, addConnectors, cutSection, connectorPoints, DEFAULT_CONNECTOR } = await import("../src/model/cut");
    const o = makeObject("Block", [makeVolume(cube())]);
    const section = cutSection(o, plane)!;
    expect(section.area).toBeCloseTo(400, 3);
    expect(section.centroid.map((x) => Math.round(x))).toEqual([10, 10, 10]);
    const points = connectorPoints(section, plane, 2);
    expect(points.length).toBe(2);
    const joined = addConnectors(cutObject(o, plane), plane, points, DEFAULT_CONNECTOR);
    expect(joined.upper!.volumes.map((v) => v.type)).toEqual(["part", "negative", "negative"]);
    expect(joined.lower!.volumes.map((v) => v.type)).toEqual(["part", "part", "part"]);
    expect(joined.pins).toBeNull();
    // The peg stands on the cut face, going up.
    const peg = joined.lower!.volumes[1];
    const b = meshBounds(peg.mesh, peg.matrix);
    expect(b.min[2]).toBeCloseTo(10, 3);
    expect(b.max[2]).toBeCloseTo(15, 3);
    // Its hole is wider by the gap on each side, and deeper.
    const hole = joined.upper!.volumes[1];
    const h = meshBounds(hole.mesh, hole.matrix);
    expect(h.max[0] - h.min[0]).toBeCloseTo(5.2, 1);
    expect(h.max[2]).toBeGreaterThan(15);
  });

  test("dowels: holes both sides and pins", async () => {
    const { cutObject, addConnectors, DEFAULT_CONNECTOR } = await import("../src/model/cut");
    const o = makeObject("Block", [makeVolume(cube())]);
    const joined = addConnectors(cutObject(o, plane), plane, [[10, 10, 10]], { ...DEFAULT_CONNECTOR, kind: "dowel" });
    expect(joined.lower!.volumes.map((v) => v.type)).toEqual(["part", "negative"]);
    expect(joined.pins!.volumes.length).toBe(1);
    expect(joined.pins!.name).toBe("Block dowels");
  });

  test("snaps: a split peg with a bulb, its socket in the upper half", async () => {
    const { cutObject, addConnectors, lathe, DEFAULT_CONNECTOR } = await import("../src/model/cut");
    const ring = lathe([
      [0, 2],
      [3, 2],
      [4, 3],
      [5, 1],
    ]);
    expect(openEdgeCount(ring)).toBe(0);
    expect(signedVolume(ring)).toBeGreaterThan(0);
    const o = makeObject("Block", [makeVolume(cube())]);
    const joined = addConnectors(cutObject(o, plane), plane, [[10, 10, 10]], { ...DEFAULT_CONNECTOR, kind: "snap" });
    expect(joined.lower!.volumes.map((v) => v.type)).toEqual(["part", "part", "negative"]);
    expect(joined.upper!.volumes.map((v) => v.type)).toEqual(["part", "negative"]);
    const peg = joined.lower!.volumes[1];
    const b = meshBounds(peg.mesh, peg.matrix);
    expect(b.min[2]).toBeCloseTo(10, 3);
    expect(b.max[2]).toBeCloseTo(15, 3);
    // The bulb is wider than the peg.
    expect(b.max[0] - b.min[0]).toBeGreaterThan(5.5);
    // The slit only cuts the peg: it starts above the cut face.
    const slit = meshBounds(joined.lower!.volumes[2].mesh, joined.lower!.volumes[2].matrix);
    expect(slit.min[2]).toBeGreaterThan(10.5);
    const socket = meshBounds(joined.upper!.volumes[1].mesh, joined.upper!.volumes[1].matrix);
    expect(socket.max[0] - socket.min[0]).toBeGreaterThan(b.max[0] - b.min[0]);
  });

  test("dovetails: a key inside the cut face, a slot through the upper half", async () => {
    const { cutObject, addConnectors, cutSection, connectorPoints, DEFAULT_CONNECTOR } = await import("../src/model/cut");
    const bar = makeObject("Bar", [makeVolume(transformMesh(cube(), scaling(3, 1, 1)))]);
    const section = cutSection(bar, plane)!;
    const spec = { ...DEFAULT_CONNECTOR, kind: "dovetail" as const };
    const points = connectorPoints(section, plane, 1, "dovetail");
    const joined = addConnectors(cutObject(bar, plane), plane, points, spec, section);
    expect(joined.lower!.volumes.map((v) => v.type)).toEqual(["part", "part"]);
    expect(joined.upper!.volumes.map((v) => v.type)).toEqual(["part", "negative"]);
    const key = joined.lower!.volumes[1];
    expect(openEdgeCount(key.mesh)).toBe(0);
    expect(signedVolume(key.mesh)).toBeGreaterThan(0);
    const k = meshBounds(key.mesh, key.matrix);
    // Along the bar (its longest way), inside the outline by half a millimetre.
    expect(k.min[0]).toBeCloseTo(0.5, 2);
    expect(k.max[0]).toBeCloseTo(59.5, 2);
    expect(k.min[2]).toBeCloseTo(10, 3);
    expect(k.max[2]).toBeCloseTo(15, 3);
    // Wider at the top than at the cut face: it locks.
    expect(k.max[1] - k.min[1]).toBeGreaterThan(spec.size + 2);
    const slot = meshBounds(joined.upper!.volumes[1].mesh, joined.upper!.volumes[1].matrix);
    expect(slot.min[0]).toBeLessThan(0);
    expect(slot.max[0]).toBeGreaterThan(60);
    // Two keys sit side by side across the bar.
    const two = connectorPoints(section, plane, 2, "dovetail");
    expect(Math.abs(two[0][1] - two[1][1])).toBeGreaterThan(5);
    expect(two[0][0]).toBeCloseTo(two[1][0], 3);
  });
});

describe("split and merge", () => {
  test("a model of two pieces splits into models or parts, paint and all", async () => {
    const { splitToObjects, splitToParts, pieceCount, mergeInto } = await import("../src/model/ops");
    const two = mergeMeshes([cube(), cube(10, [50, 0, 0])]);
    const paint = new PaintLayer(two);
    paint.setTriangle(14, 2); // a face of the small cube
    const o = makeObject("Kit", [makeVolume(two, { paint: { color: paint } })], { extruder: 3 });
    expect(pieceCount(o)).toBe(2);
    const objects = splitToObjects(o);
    expect(objects.map((x) => x.name)).toEqual(["Kit 1", "Kit 2"]);
    expect(objects.map((x) => x.extruder)).toEqual([3, 3]);
    expect(objects[0].volumes[0].paint.color).toBeUndefined();
    expect([...objects[1].volumes[0].paint.color!.usedStates()]).toEqual([2]);
    const parts = splitToParts(o);
    expect(parts.volumes.length).toBe(2);
    const merged = mergeInto(objects[0], objects[1], translation(5, 0, 0));
    expect(merged.volumes.length).toBe(2);
    expect(merged.volumes[1].matrix[12]).toBe(5);
    expect(merged.volumes[1].extruder).toBe(3);
  });
});

describe("cut to fit", () => {
  test("a 300 mm bar in 250 mm makes two halves, joined", async () => {
    const { fitPlanes, cutIntoPieces, DEFAULT_CONNECTOR } = await import("../src/model/cut");
    const { box } = await import("../src/model/primitives");
    const o = makeObject("Bar", [makeVolume(box(300, 40, 30))]);
    const planes = fitPlanes(o, identity(), [250, 250, 250]);
    expect(planes.length).toBe(1);
    expect(planes[0].normal).toEqual([1, 0, 0]);
    const { pieces, pins } = cutIntoPieces(o, planes, { spec: DEFAULT_CONNECTOR, count: 1 });
    expect(pieces.map((p) => p.name)).toEqual(["Bar 1/2", "Bar 2/2"]);
    expect(pins).toEqual([]);
    for (const p of pieces) {
      const b = objectBounds(p);
      // Half the bar, and the peg standing out of one half.
      expect(b.max[0] - b.min[0]).toBeLessThanOrEqual(150 + DEFAULT_CONNECTOR.depth + 0.01);
    }
    // One half has the peg, the other the hole.
    expect(pieces.flatMap((p) => p.volumes.map((v) => v.type)).sort()).toEqual(["negative", "part", "part", "part"]);
  });

  test("a big cube in a small printer: a grid of pieces", async () => {
    const { fitPlanes, cutIntoPieces } = await import("../src/model/cut");
    const o = makeObject("Cube", [makeVolume(cube(100))]);
    const planes = fitPlanes(o, identity(), [60, 60, 1000]);
    expect(planes.length).toBe(2);
    const { pieces } = cutIntoPieces(o, planes, null);
    expect(pieces.length).toBe(4);
    const total = pieces.reduce((v, p) => v + signedVolume(p.volumes[0].mesh), 0);
    expect(total).toBeCloseTo(1e6, -1);
  });
});

describe("auto-orient", () => {
  test("a cone stands on its base, an L lies on its long side", async () => {
    const { bestOrientation } = await import("../src/model/orient");
    const { cone, box } = await import("../src/model/primitives");
    // Upside down: the point at the bottom.
    const flip = scaling(1, -1, -1);
    const upside = makeObject("Cone", [makeVolume(cone(10, 20, 32), { matrix: flip })]);
    const o = bestOrientation(upside)!;
    // In the model's frame the base faces +Z (it was turned over): that goes down.
    expect(o.down[2]).toBeGreaterThan(0.99);
    expect(o.overhang).toBeLessThan(1);
    // A plate 60 x 10 x 2 standing on its end lies down flat.
    const plate = makeObject("Plate", [makeVolume(box(2, 10, 60))]);
    const p = bestOrientation(plate)!;
    expect(Math.abs(p.down[0])).toBeGreaterThan(0.99);
  });
});
