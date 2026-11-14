import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { zipSync } from "fflate";
import { makeObject, makeVolume, usedFilaments, isPlain } from "../src/model/document";
import {
  connectedComponents,
  faceNeighbors,
  identity,
  invert,
  mergeMeshes,
  multiply,
  openEdgeCount,
  signedVolume,
  translation,
  scaling,
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
