import { describe, expect, test } from "bun:test";
import {
  baseCandidates,
  defaultSupportMaterials,
  interfaceCandidates,
  materialsFromJob,
  polymer,
  supportFilaments,
  type FilamentOption,
} from "./supports";

const f = (name: string, material: string, extra: Partial<FilamentOption> = {}): FilamentOption => ({
  name,
  vendor: name.split(" ")[0],
  material,
  tray_material: material,
  price_per_kg: 19.99,
  ...extra,
});

const PLA = f("Bambu PLA Basic @BBL X1C", "PLA");
const PLA_MATTE = f("Bambu PLA Matte @BBL X1C", "PLA", { price_per_kg: 21.99 });
const GENERIC_PLA = f("Generic PLA @BBL X1C", "PLA", { price_per_kg: 19.99 });
const BETA_PLA = f("BETA PLA Basic @BBL X1C", "PLA", { price_per_kg: 19.99 });
const PLA_CF = f("Bambu PLA-CF @BBL X1C", "PLA-CF", { price_per_kg: 31.99 });
const PETG = f("Bambu PETG Basic @BBL X1C", "PETG");
const PA_CF = f("Bambu PA6-CF @BBL X1C", "PA6-CF", { price_per_kg: 39.99 });
const ABS = f("Bambu ABS @BBL X1C", "ABS");
const TPU = f("Bambu TPU 95A @BBL X1C", "TPU", { price_per_kg: 31.99 });
const SUP_PLA = f("Bambu Support For PLA @BBL X1C", "PLA", { support: true, tray_material: "PLA-S" });
const SUP_PLA_PETG = f("Bambu Support For PLA-PETG @BBL X1C", "PLA", { support: true, tray_material: "PLA-S" });
const SUP_PA = f("Bambu Support For PA PET @BBL X1C", "PA", { support: true, tray_material: "PA-S" });
const SUP_ABS = f("Bambu Support for ABS @BBL X1C", "ABS", { support: true, tray_material: "ABS-S" });
const PVA = f("Bambu PVA @BBL X1C", "PVA", { support: true, soluble: true, price_per_kg: 50 });
const ALL = [PLA, PLA_MATTE, GENERIC_PLA, BETA_PLA, PLA_CF, PETG, PA_CF, ABS, TPU, SUP_PLA, SUP_PLA_PETG, SUP_PA, SUP_ABS, PVA];

describe("polymer", () => {
  test("composites and relatives group with their base polymer", () => {
    expect(polymer("PLA-CF")).toBe("PLA");
    expect(polymer("PA6-GF")).toBe("PA");
    expect(polymer("PAHT-CF")).toBe("PA");
    expect(polymer("PCTG")).toBe("PETG");
    expect(polymer("ASA")).toBe("ABS");
    expect(polymer("PET-CF")).toBe("PET");
  });
});

describe("interface", () => {
  test("PLA gets Support For PLA, then the PLA/PETG one, then PVA", () => {
    expect(interfaceCandidates(PLA, ALL).map((x) => x.name)).toEqual([SUP_PLA.name, SUP_PLA_PETG.name, PVA.name]);
  });
  test("PLA-CF is PLA", () => {
    expect(interfaceCandidates(PLA_CF, ALL)[0]).toBe(SUP_PLA);
  });
  test("PETG gets the PLA/PETG support, then PA/PET", () => {
    expect(interfaceCandidates(PETG, ALL).map((x) => x.name)).toEqual([SUP_PLA_PETG.name, SUP_PA.name]);
  });
  test("PA-CF gets Support For PA/PET; ABS its own", () => {
    expect(interfaceCandidates(PA_CF, ALL)[0]).toBe(SUP_PA);
    expect(interfaceCandidates(ABS, ALL)[0]).toBe(SUP_ABS);
  });
  test("nothing suits TPU", () => {
    expect(interfaceCandidates(TPU, ALL)).toEqual([]);
  });
  test("a support material loaded on the printers wins among equals", () => {
    expect(interfaceCandidates(PLA, ALL, new Set(["PVA"]))[0]).toBe(SUP_PLA);
    // Equally suitable, loaded beats not loaded.
    const w = f("Bambu Support W @BBL X1C", "PLA", { support: true, tray_material: "PLA-S" });
    const other = f("Other Support For PLA @BBL X1C", "PLA", { support: true, tray_material: "PLA-SX", vendor: "Bambu" });
    expect(interfaceCandidates(PLA, [w, other], new Set(["PLA-SX"]))[0]).toBe(other);
  });
});

describe("base", () => {
  test("the part's own filament first, then the cheapest plain filament of its polymer", () => {
    expect(baseCandidates(PLA, ALL)[0]).toBe(PLA);
    expect(baseCandidates(PLA_MATTE, ALL)[0]).toBe(PLA_MATTE);
    expect(baseCandidates(PLA_MATTE, ALL)[1].price_per_kg).toBe(19.99);
  });
  test("a PLA-CF part: itself, then plain PLA, the same vendor's Basic before others", () => {
    expect(baseCandidates(PLA_CF, ALL).slice(0, 2)).toEqual([PLA_CF, PLA]);
  });
  test("never a support material, or another filled one", () => {
    const names = baseCandidates(PLA_CF, ALL).map((x) => x.name);
    expect(names).not.toContain(SUP_PLA.name);
    expect(names.filter((n) => n === PLA_CF.name)).toHaveLength(1);
  });
});

describe("defaults", () => {
  test("a support interface when the printers take several; the base in the part's filament", () => {
    expect(defaultSupportMaterials(PLA_CF, ALL, { multiMaterial: true })).toEqual({
      mode: "separate",
      interface: SUP_PLA.name,
      base: PLA_CF.name,
    });
  });
  test("the part's own filament otherwise, or when nothing suits it", () => {
    expect(defaultSupportMaterials(PLA, ALL, { multiMaterial: false })).toEqual({ mode: "same" });
    expect(defaultSupportMaterials(TPU, ALL, { multiMaterial: true })).toEqual({ mode: "same" });
    expect(defaultSupportMaterials(undefined, ALL, { multiMaterial: true })).toEqual({ mode: "same" });
  });
});

describe("job filaments", () => {
  test("part, interface, and the base when it's another filament", () => {
    expect(supportFilaments(PLA_CF.name, true, { mode: "separate", interface: SUP_PLA.name, base: PLA.name })).toEqual({
      filaments: [PLA_CF.name, SUP_PLA.name, PLA.name],
      overrides: { support_filament: "3", support_interface_filament: "2" },
    });
    expect(supportFilaments(PLA.name, true, { mode: "separate", interface: SUP_PLA.name, base: PLA.name })).toEqual({
      filaments: [PLA.name, SUP_PLA.name],
      overrides: { support_filament: "1", support_interface_filament: "2" },
    });
  });
  test("one filament with supports off or in the part's material", () => {
    expect(supportFilaments(PLA.name, false, { mode: "separate", interface: SUP_PLA.name, base: PLA.name }).filaments).toEqual([PLA.name]);
    expect(supportFilaments(PLA.name, true, { mode: "same" }).filaments).toEqual([PLA.name]);
  });
  test("round trip through a job", () => {
    const choice = { mode: "separate" as const, interface: SUP_PLA.name, base: PLA.name };
    const { filaments, overrides } = supportFilaments(PLA_CF.name, true, choice);
    expect(materialsFromJob(filaments, overrides)).toEqual(choice);
    expect(materialsFromJob([PLA.name], { support_filament: "0", support_interface_filament: "0" })).toEqual({ mode: "same" });
  });
});
