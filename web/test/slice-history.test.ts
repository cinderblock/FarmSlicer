// Unit tests of the Slice page's slice memory (src/sliceHistory.ts): keys,
// eviction, what two slices differ by, matching heights. `bun test` in web/.
import { describe, expect, test } from "bun:test";
import {
  changeSummary,
  configDiff,
  evictions,
  firstLayerFrom,
  heightStops,
  inputsDiff,
  layerAtZ,
  percentChange,
  sliceKey,
  stableStringify,
  type SliceEntry,
  type SliceInputs,
} from "../src/sliceHistory";

const inputs = (over: Partial<SliceInputs> = {}): SliceInputs => ({
  machine: "Bambu Lab X1 Carbon 0.4 nozzle",
  process: "0.20mm Standard @BBL X1C",
  filaments: ["Bambu PLA Basic @BBL X1C"],
  bed_type: "Textured PEI Plate",
  color: "",
  overrides: { enable_support: "1" },
  printer_id: "",
  routing: "auto",
  group_id: "",
  plates: [{ objects: [{ model: 0, placement: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0] } }] }],
  models: [{ name: "cube.stl", sha256: "aa" }],
  profile: "p1",
  nozzle_plan: null,
  ...over,
});

const entry = (key: string, usedAt: number, gcodeBytes: number): SliceEntry => ({
  key,
  jobId: `job-${key}`,
  project: "",
  source: "browser",
  createdAt: usedAt,
  usedAt,
  inputs: inputs(),
  stats: null,
  gcodeBytes,
});

describe("keys", () => {
  test("object key order doesn't matter", () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
  test("undefined members are left out, like JSON", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  test("same inputs, same key; any change, another", async () => {
    const k = await sliceKey(inputs());
    expect(await sliceKey(inputs({ overrides: { enable_support: "1" } }))).toBe(k);
    expect(await sliceKey(inputs({ overrides: { enable_support: "1", layer_height: "0.16" } }))).not.toBe(k);
    expect(await sliceKey(inputs({ models: [{ name: "cube.stl", sha256: "bb" }] }))).not.toBe(k);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("evictions", () => {
  test("the least recently used go first, by count", () => {
    const all = [entry("a", 1, 0), entry("b", 3, 0), entry("c", 2, 0)];
    expect(evictions(all, { count: 2, bytes: Infinity })).toEqual(["a"]);
  });
  test("by bytes", () => {
    const all = [entry("a", 3, 600), entry("b", 2, 600), entry("c", 1, 100)];
    // a fits; b would pass 1000; c still fits after it.
    expect(evictions(all, { count: 10, bytes: 1000 })).toEqual(["b"]);
  });
  test("kept entries stay whatever they cost", () => {
    const all = [entry("a", 3, 600), entry("b", 1, 900)];
    expect(evictions(all, { count: 1, bytes: 1000 }, ["b"])).toEqual(["a"]);
  });
});

describe("inputsDiff", () => {
  test("nothing changed", () => {
    expect(inputsDiff(inputs(), inputs())).toEqual([]);
    expect(changeSummary([])).toBe("same settings");
  });
  test("a setting, with its label", () => {
    const d = inputsDiff(inputs(), inputs({ overrides: { enable_support: "1", layer_height: "0.16" } }));
    expect(d).toEqual([{ key: "layer_height", label: "Layer Height", a: null, b: "0.16" }]);
    expect(changeSummary(d)).toBe("Layer Height 0.16");
  });
  test("profiles without the printer suffix", () => {
    const d = inputsDiff(inputs(), inputs({ process: "0.16mm Optimal @BBL X1C" }));
    expect(d).toEqual([{ key: "process", label: "Print quality", a: "0.20mm Standard", b: "0.16mm Optimal" }]);
  });
  test("moved parts, not new models", () => {
    const d = inputsDiff(inputs(), inputs({ plates: [{ objects: [{ model: 0 }, { model: 0 }] }] }));
    expect(d.map((c) => [c.key, c.b])).toEqual([["plates", "2 parts on 1 plate"]]);
  });
  test("an edited profile when nothing else differs", () => {
    expect(inputsDiff(inputs(), inputs({ profile: "p2" })).map((c) => c.key)).toEqual(["profile"]);
  });
  test("summary of many", () => {
    const d = inputsDiff(inputs(), inputs({ overrides: { enable_support: "0", layer_height: "0.12", wall_loops: "3" } }));
    expect(d.map((c) => c.key)).toEqual(["enable_support", "layer_height", "wall_loops"]);
    expect(changeSummary(d)).toBe(`${d[0].label} 0, Layer Height 0.12 +1`);
  });
});

describe("configDiff", () => {
  test("schema settings first, lists joined", () => {
    const d = configDiff(
      { zz_custom: "1", layer_height: "0.2", filament_type: ["PLA", "PLA"] },
      { zz_custom: "2", layer_height: "0.16", filament_type: ["PLA", "PETG"] },
    );
    expect(d[0]).toEqual({ key: "layer_height", label: "Layer Height", a: "0.2", b: "0.16" });
    expect(d.find((c) => c.key === "filament_type")).toMatchObject({ a: "PLA, PLA", b: "PLA, PETG" });
    expect(d[d.length - 1].key).toBe("zz_custom");
  });
  test("a key only one has", () => {
    expect(configDiff({ a: "1" }, {})).toEqual([{ key: "a", label: "a", a: "1", b: null }]);
  });
});

describe("heights", () => {
  const za = new Float32Array([0.2, 0.4, 0.6, 0.8]);
  const zb = new Float32Array([0.2, 0.36, 0.52, 0.68, 0.84]);
  test("the layer at or below a height", () => {
    expect(layerAtZ(za, 4, 0.1)).toBe(0);
    expect(layerAtZ(za, 4, 0.4)).toBe(1);
    expect(layerAtZ(za, 4, 0.59)).toBe(1);
    expect(layerAtZ(za, 4, 5)).toBe(3);
    // Float32 0.4 is 0.4000000059604645: still "at" 0.4.
    expect(layerAtZ(zb, 5, 0.36)).toBe(1);
  });
  test("the first layer at or above a height", () => {
    expect(firstLayerFrom(za, 4, 0)).toBe(0);
    expect(firstLayerFrom(za, 4, 0.4)).toBe(1);
    expect(firstLayerFrom(za, 4, 0.41)).toBe(2);
    expect(firstLayerFrom(za, 4, 0.9)).toBe(4);
  });
  test("stops: both slices' heights, once each", () => {
    expect(heightStops(za, 4, zb, 5).map((z) => Math.round(z * 100) / 100)).toEqual([0.2, 0.36, 0.4, 0.52, 0.6, 0.68, 0.8, 0.84]);
  });
});

test("percentChange", () => {
  expect(percentChange(100, 112)).toBe("+12%");
  expect(percentChange(100, 96.5)).toBe("-3.5%");
  expect(percentChange(0, 0)).toBe("0%");
  expect(percentChange(0, 5)).toBe("new");
});
