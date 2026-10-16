// Support materials: which filaments print a part's supports, and what the
// Slice page proposes. Interface layers (the ones touching the part) peel off
// cleanly in a support material. The base under them only has to bond with
// the interface and the plate; it stays in the part's own filament by
// default: on a one-nozzle printer a base in another filament swaps
// filament on every layer with supports (a small PLA-CF part with a PLA base
// took 3 h instead of 43 min on an X1C). Cheaper plain filaments of the
// part's polymer are offered for it all the same.

/** A filament the machine offers (GET /api/profiles/filaments?machine=). */
export interface FilamentOption {
  name: string;
  vendor: string;
  /** `filament_type`: "PLA", "PETG", "PLA-CF", ... */
  material?: string;
  /** A support material (`filament_is_support`). */
  support?: boolean;
  /** Dissolves in water (PVA, BVOH). */
  soluble?: boolean;
  /** What printers call it ("PLA-S" for Bambu Support For PLA). */
  tray_material?: string;
  /** From the farm's filament prices. */
  price_per_kg?: number;
}

/** How the part's supports are printed. */
export type SupportMaterials =
  | { mode: "same" }
  | { mode: "separate"; interface: string; base: string };

/** The polymer a material is made of: "PLA-CF" → "PLA", "PA6-GF" → "PA". */
export function polymer(material: string): string {
  const m = material.toUpperCase().trim();
  const families: [string, string][] = [
    ["PAHT", "PA"],
    ["PPA", "PPA"],
    ["PA", "PA"],
    ["PETG", "PETG"],
    ["PCTG", "PETG"],
    ["PET", "PET"],
    ["PLA", "PLA"],
    ["ABS", "ABS"],
    ["ASA", "ABS"],
    ["PC", "PC"],
    ["TPU", "TPU"],
    ["HIPS", "HIPS"],
    ["PVA", "PVA"],
    ["BVOH", "BVOH"],
  ];
  return families.find(([prefix]) => m.startsWith(prefix))?.[1] ?? m;
}

/** Fibre-filled ("PLA-CF", "PA6-GF") materials cost more and wear nozzles. */
function filled(material: string): boolean {
  return /-(CF|GF)\b/i.test(material) || /\b(CF|GF)$/i.test(material);
}

/**
 * How well a support material suits a part's polymer (0 = not at all).
 * Bambu's guidance: Support For PLA (or PLA/PETG) under PLA, Support For
 * PLA/PETG under PETG, Support For PA/PET under PA and PET, Support for ABS
 * (or HIPS) under ABS and ASA; PVA/BVOH dissolve away from PLA.
 */
function interfaceScore(part: string, s: FilamentOption): number {
  const p = polymer(part);
  const own = polymer(s.material ?? "");
  const name = s.name.toUpperCase();
  const petg = name.includes("PETG");
  switch (p) {
    case "PLA":
      if (own === "PLA") return petg ? 2 : 3;
      if (own === "PVA" || own === "BVOH") return 1;
      return 0;
    case "PETG":
      if (own === "PLA" && petg) return 3;
      if (own === "PA") return 2;
      return 0;
    case "PET":
    case "PA":
    case "PPA":
      return own === "PA" ? 3 : 0;
    case "ABS":
      if (own === "ABS") return 3;
      if (own === "HIPS") return 2;
      return 0;
    default:
      return 0;
  }
}

/**
 * Support materials for a part made of `part`, best first: the most
 * suitable kind, then one loaded on the printers in question (`loaded`:
 * their trays' materials, "PLA-S", ...), then the part's own vendor.
 */
export function interfaceCandidates(
  part: FilamentOption,
  all: FilamentOption[],
  loaded: Set<string> = new Set(),
): FilamentOption[] {
  const scored = all
    .filter((f) => f.support)
    .map((f) => {
      let score = interfaceScore(part.material ?? "", f) * 10;
      if (score === 0) return { f, score };
      if (f.tray_material && loaded.has(f.tray_material.toUpperCase())) score += 5;
      if (f.vendor === part.vendor) score += 2;
      return { f, score };
    })
    .filter(({ score }) => score > 0);
  scored.sort((a, b) => b.score - a.score || a.f.name.localeCompare(b.f.name));
  return scored.map(({ f }) => f);
}

/**
 * Filaments for the support base: the part's own first (no extra filament
 * changes), then plain (not fibre-filled, not a support material)
 * filaments of the part's polymer, cheapest first, then the part's vendor,
 * then "Basic" lines and generics.
 */
export function baseCandidates(part: FilamentOption, all: FilamentOption[]): FilamentOption[] {
  const family = polymer(part.material ?? "");
  const plain = all.filter(
    (f) => f.name !== part.name && !f.support && f.material && polymer(f.material) === family && !filled(f.material),
  );
  const rank = (f: FilamentOption) => [
    f.price_per_kg ?? Infinity,
    f.name === part.name ? 0 : 1,
    f.vendor === part.vendor ? 0 : 1,
    /\bBasic\b/i.test(f.name) ? 0 : 1,
    /^Generic\b/i.test(f.name) ? 0 : 1,
  ];
  plain.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return a.name.localeCompare(b.name);
  });
  return [part, ...plain];
}

/**
 * What the page proposes: a support material for the interface when the
 * printers can load several filaments and a suitable one exists (the base in
 * the part's own filament), else supports all in the part's filament.
 */
export function defaultSupportMaterials(
  part: FilamentOption | undefined,
  all: FilamentOption[],
  options: { multiMaterial: boolean; loaded?: Set<string> },
): SupportMaterials {
  if (!part || !options.multiMaterial) return { mode: "same" };
  const iface = interfaceCandidates(part, all, options.loaded)[0];
  if (!iface) return { mode: "same" };
  return { mode: "separate", interface: iface.name, base: part.name };
}

/**
 * The job's filaments (1 = the part's, then the interface's, then the
 * base's when it isn't the part's) and the support settings that point at
 * them. Supports off: just the part's filament.
 */
export function supportFilaments(
  part: string,
  enabled: boolean,
  materials: SupportMaterials,
): { filaments: string[]; overrides: Record<string, string> } {
  if (!enabled || materials.mode === "same") {
    return { filaments: [part], overrides: { support_filament: "0", support_interface_filament: "0" } };
  }
  const filaments = [part, materials.interface];
  let base = "1";
  if (materials.base !== part) {
    filaments.push(materials.base);
    base = "3";
  }
  return { filaments, overrides: { support_filament: base, support_interface_filament: "2" } };
}

/** The support choice a job was made with (re-slicing), from its filaments and overrides. */
export function materialsFromJob(filaments: string[], overrides: Record<string, string>): SupportMaterials {
  const at = (key: string) => filaments[Number(overrides[key] ?? 0) - 1];
  const iface = at("support_interface_filament");
  if (!iface) return { mode: "same" };
  return { mode: "separate", interface: iface, base: at("support_filament") ?? filaments[0] };
}
