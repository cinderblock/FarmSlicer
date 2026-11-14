// Writes the 3MF fixtures the tests slice, with the web app's own 3MF
// writer (web/src/model). Run from web/: `bun ../tests/fixtures/models/make.ts`.
//
// - painted.3mf: a 20 mm cube on filament 1 with a corner painted in
//   filament 2, the top face's support painting, a 6 mm knob on filament 3,
//   and an infill modifier: everything a desktop slicer's project carries.
// - member-settings.3mf: one cube whose object sets `wall_loops` (a Slice
//   page setting: anyone may) and its modifier `machine_start_gcode`
//   (admins only).

import { writeFileSync } from "fs";
import { join } from "path";
import { makeObject, makeVolume } from "../../../web/src/model/document";
import { translation, type Mesh } from "../../../web/src/model/mesh";
import { ENFORCER, PaintLayer } from "../../../web/src/model/paint";
import { write3mf } from "../../../web/src/model/threemf";

function cube(size: number, at: [number, number, number] = [0, 0, 0]): Mesh {
  const v = [
    [0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0],
    [0, 0, size], [size, 0, size], [size, size, size], [0, size, size],
  ].flatMap(([x, y, z]) => [x + at[0], y + at[1], z + at[2]]);
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: Float32Array.from(v), indices: Uint32Array.from(t) };
}

const dir = import.meta.dir;

const body = cube(20);
const color = new PaintLayer(body);
// A ball of filament 2 round the top front-left corner: it splits the
// faces it touches, like a brush stroke in the desktop app.
for (const t of [2, 3, 4, 5, 10, 11]) color.brush(t, { kind: "sphere", center: [0, 0, 20], radius: 8 }, 2, null);
const supports = new PaintLayer(body);
supports.smartFill(0, 5, ENFORCER);
const painted = makeObject(
  "Painted cube",
  [
    makeVolume(body, { name: "Body", paint: { color, supports } }),
    makeVolume(cube(6, [7, 7, 20]), { name: "Knob", extruder: 3 }),
    makeVolume(cube(10), {
      name: "Dense core",
      type: "modifier",
      matrix: translation(5, 5, 5),
      settings: { sparse_infill_density: "60%" },
    }),
  ],
  { extruder: 1 },
);
writeFileSync(join(dir, "painted.3mf"), write3mf([painted], { application: "FarmSlicer-fixture" }));

const settings = makeObject(
  "Settings cube",
  [
    makeVolume(cube(20), { name: "Body" }),
    makeVolume(cube(5), { name: "Start", type: "modifier", settings: { machine_start_gcode: "G28" } }),
  ],
  { settings: { wall_loops: "3" } },
);
writeFileSync(join(dir, "member-settings.3mf"), write3mf([settings], { application: "FarmSlicer-fixture" }));
console.log("wrote painted.3mf and member-settings.3mf");
