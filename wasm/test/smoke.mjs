#!/usr/bin/env node
// Smoke test for the WebAssembly engine, runnable without a browser:
//
//   node wasm/test/smoke.mjs [--engine web/public/wasm] [--variant st|mt]
//                            [--model path.stl] [--config merged.json] [--out out.gcode]
//                            [--plate] [--plates] [--package]
//
// With no --model it slices a generated 20 mm cube with libslic3r's defaults
// (an empty config), which exercises load → place → slice → export. Exit code
// 0 iff the engine reports ok and produced non-empty G-code.
//
// --plate: a plate of three parts from two models (two copies of the model,
// one turned on its side, and a 10 mm cube staged with fs_stage_model); also
// fails unless the G-code prints three objects.
//
// --plates: the same three parts on two plates (the two copies on plate 1,
// the small cube on plate 2), packaged; fails unless the report counts two
// plates, plate 1's G-code prints two objects and the package holds both
// plates' G-code.
//
// --package: also write a Bambu sliced project (.gcode.3mf), as the server
// asks for Bambu printers; fails unless one comes back.
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1"]);
    return acc;
  }, []),
);
const engineDir = resolve(args.engine ?? "web/public/wasm");
const variant = args.variant ?? "st";
const name = variant === "mt" ? "farmslicer-engine-mt" : "farmslicer-engine";
const dir = join(engineDir, variant);
const js = join(dir, `${name}.mjs`);
if (!existsSync(js)) {
  console.error(`engine not found: ${js}`);
  process.exit(2);
}

function cubeStl(size = 20) {
  const v = [[0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0], [0, 0, size], [size, 0, size], [size, size, size], [0, size, size]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  let s = "solid cube\n";
  for (const [a, b, c] of faces) {
    s += "facet normal 0 0 0\n outer loop\n";
    for (const i of [a, b, c]) s += `  vertex ${v[i].join(" ")}\n`;
    s += " endloop\nendfacet\n";
  }
  return s + "endsolid cube\n";
}

const modelName = args.model ? args.model.split(/[\\/]/).pop() : "cube20.stl";
const model = args.model ? readFileSync(args.model) : Buffer.from(cubeStl());
const config = args.config ? readFileSync(args.config, "utf8") : "{}";

const t0 = performance.now();
const { default: factory } = await import(pathToFileURL(js).href);
const m = await factory({
  locateFile: (p) => join(dir, p),
  // pthread workers re-import the engine module from here (Node: a filesystem path).
  mainScriptUrlOrBlob: js,
  fsProgress: (pct, msg) => process.stderr.write(`  ${String(pct).padStart(3)}% ${msg}\n`),
  print: (l) => console.log("[engine]", l),
  printErr: (l) => console.error("[engine]", l),
});
const version = JSON.parse(m.UTF8ToString(m._fs_version()));
console.log(`engine ${JSON.stringify(version)} loaded in ${(performance.now() - t0).toFixed(0)} ms`);

const enc = new TextEncoder();
const put = (bytes) => {
  const p = m._malloc(bytes.length + 1);
  m.HEAPU8.set(bytes, p);
  m.HEAPU8[p + bytes.length] = 0;
  return p;
};
const namePtr = put(enc.encode(modelName));
const modelPtr = put(new Uint8Array(model));
const cfgBytes = enc.encode(config);
const cfgPtr = put(cfgBytes);
const outGcode = m._malloc(4), outLen = m._malloc(4), outReport = m._malloc(4), state = m._malloc(8);

if (args.plates) {
  args.plate = "1";
  args.package = "1";
}
if (args.package && !args.plate) {
  const options = enc.encode(JSON.stringify({ package: true, printer_model_id: "BL-P001", model_name: modelName }));
  const optPtr = put(options);
  if (m._fs_set_options(optPtr, options.length, 0, 0) !== 0) throw new Error("fs_set_options refused the package");
}
if (args.plate) {
  if (typeof m._fs_stage_model !== "function" || !version.plate) throw new Error("this engine takes no plates");
  if (args.plates && !version.plates) throw new Error("this engine takes no list of plates");
  const small = enc.encode(cubeStl(10));
  const smallName = put(enc.encode("small.stl"));
  const smallPtr = put(small);
  if (m._fs_stage_model(1, smallName, smallPtr, small.length) !== 0) throw new Error("fs_stage_model failed");
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const RX90 = [1, 0, 0, 0, 0, -1, 0, 1, 0];
  const copies = [
    { model: 0, placement: { rotation: I, offset: [-40, 0] } },
    { model: 0, placement: { rotation: RX90, offset: [40, 0] } },
  ];
  const smallPart = { model: 1, placement: { rotation: I, offset: [0, 40] } };
  const options = enc.encode(
    JSON.stringify({
      package: Boolean(args.package),
      printer_model_id: "BL-P001",
      model_name: modelName,
      models: [{ name: modelName }, { name: "small.stl" }],
      ...(args.plates
        ? { plates: [{ objects: copies }, { objects: [smallPart] }] }
        : { plate: { objects: [...copies, smallPart] } }),
    }),
  );
  const optPtr = put(options);
  if (m._fs_set_options(optPtr, options.length, 0, 0) !== 0) throw new Error("fs_set_options refused the plate");
  console.log(args.plates ? "plates: 2 copies on plate 1, a small cube on plate 2" : "plate: 3 parts from 2 models");
}

const t1 = performance.now();
let rc;
// --sync: call fs_slice on the main runtime thread even in the pthreads build.
if (version.threads && typeof m._fs_slice_start === "function" && !args.sync) {
  console.error("  starting slice on a pthread (fs_slice_start)");
  const err = m._fs_slice_start(namePtr, modelPtr, model.length, cfgPtr, cfgBytes.length, outGcode, outLen, outReport, state);
  console.error(`  fs_slice_start returned ${err}`);
  if (err !== 0) throw new Error(`fs_slice_start failed: ${err}`);
  // Poll rather than Atomics.waitAsync: in Node the waitAsync promise does not
  // keep the event loop alive, so the process would exit mid-slice.
  await new Promise((done) => {
    const tick = () =>
      Atomics.load(new Int32Array(m.HEAP32.buffer), state >> 2) === 1 ? done() : setTimeout(tick, 20);
    tick();
  });
  m.fsSyncHeap?.();
  rc = m.HEAP32[(state >> 2) + 1];
} else {
  rc = m._fs_slice(namePtr, modelPtr, model.length, cfgPtr, cfgBytes.length, outGcode, outLen, outReport);
}
const elapsed = performance.now() - t1;

const reportPtr = m.HEAPU32[outReport >> 2];
const report = reportPtr ? JSON.parse(m.UTF8ToString(reportPtr)) : null;
const gcodePtr = m.HEAPU32[outGcode >> 2];
const gcodeLen = m.HEAPU32[outLen >> 2];
console.log(`rc=${rc} in ${(elapsed / 1000).toFixed(2)} s; gcode ${gcodeLen} bytes`);
console.log("report:", JSON.stringify(report, null, 2));

if (rc === 0 && gcodeLen > 0) {
  const gcode = Buffer.from(m.HEAPU8.subarray(gcodePtr, gcodePtr + gcodeLen));
  const out = args.out ?? "/tmp/farmslicer-smoke.gcode";
  writeFileSync(out, gcode);
  console.log(`wrote ${out} (${statSync(out).size} bytes)`);
  const text = gcode.toString("latin1");
  for (const key of ["estimated printing time", "total filament", "layer_height", "generated by"]) {
    const line = text.split("\n").find((l) => l.toLowerCase().includes(key));
    if (line) console.log("  " + line.trim());
  }
  if (args.plate) {
    // libslic3r labels each object it prints ("; start printing object,
    // unique label id: N" on Bambu printers, "; printing object NAME" else).
    const labelled = [...text.matchAll(/^; start printing object, unique label id: (\d+)/gm)].map((x) => x[1]);
    const named = [...text.matchAll(/^; printing object (.*)$/gm)].map((x) => x[1].trim());
    const objects = new Set(labelled.length > 0 ? labelled : named);
    console.log(`  objects printed: ${objects.size} ${JSON.stringify([...objects])}`);
    if (objects.size !== (args.plates ? 2 : 3)) rc = 1;
  }
}
if (args.package) {
  const ok = Boolean(report?.package) && m.FS.analyzePath(report.package).exists;
  console.log(`  package: ${ok ? `${m.FS.stat(report.package).size} bytes` : "missing"}`);
  if (!ok) rc = 1;
  if (ok && args.plates) {
    // The zip's directory names every entry.
    const names = Buffer.from(m.FS.readFile(report.package)).toString("latin1");
    const plates = ["Metadata/plate_1.gcode", "Metadata/plate_2.gcode"].filter((n) => names.includes(n));
    console.log(`  plates: report ${report.plates}, package ${JSON.stringify(plates)}`);
    if (report.plates !== 2 || plates.length !== 2) rc = 1;
  }
}
if (m.fsTerminateThreads) m.fsTerminateThreads();
process.exit(rc === 0 && gcodeLen > 0 ? 0 : 1);
