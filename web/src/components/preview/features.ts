// Extrusion feature types: the names slicers write in `;TYPE:` /
// `; FEATURE:` comments, folded onto OrcaSlicer's names, and the colours
// OrcaSlicer's preview gives them.

/** OrcaSlicer's feature names and preview colours. */
export const FEATURE_COLORS: Record<string, string> = {
  "Inner wall": "#ffe64d",
  "Outer wall": "#ff7d38",
  "Overhang wall": "#1f1fff",
  "Sparse infill": "#b03029",
  "Internal solid infill": "#9654cc",
  "Top surface": "#f04040",
  "Bottom surface": "#665cc7",
  Ironing: "#ff8c69",
  Bridge: "#4d80ba",
  "Internal Bridge": "#6c94c4",
  "Gap infill": "#ffffff",
  Skirt: "#00876e",
  Brim: "#00876e",
  Support: "#00ff00",
  "Support interface": "#1f6121",
  "Support transition": "#4c8c4f",
  "Prime tower": "#b3e3ab",
  Custom: "#5ed194",
  "Multiple": "#00ff00",
  Extrusion: "#4a9eff",
};

/** Colours for feature names nobody listed above. */
const SPARE = ["#e0a3ff", "#7fd7ff", "#ffd27f", "#a3ffb4", "#ff9fbf", "#c2c2c2"];

/** Other slicers' names (lower case) → OrcaSlicer's. */
const SYNONYMS: Record<string, string> = {
  // PrusaSlicer / SuperSlicer
  "external perimeter": "Outer wall",
  perimeter: "Inner wall",
  "overhang perimeter": "Overhang wall",
  "internal infill": "Sparse infill",
  "solid infill": "Internal solid infill",
  "top solid infill": "Top surface",
  "bridge infill": "Bridge",
  "internal bridge infill": "Internal Bridge",
  "gap fill": "Gap infill",
  "skirt/brim": "Skirt",
  "support material": "Support",
  "support material interface": "Support interface",
  "wipe tower": "Prime tower",
  // Cura
  "wall-outer": "Outer wall",
  "wall-inner": "Inner wall",
  skin: "Top surface",
  fill: "Sparse infill",
  support: "Support",
  "support-interface": "Support interface",
  "support-infill": "Support",
  skirt: "Skirt",
  "prime-tower": "Prime tower",
  // OrcaSlicer / BambuStudio spellings
  "internal bridge": "Internal Bridge",
  "inner wall": "Inner wall",
  "outer wall": "Outer wall",
  "overhang wall": "Overhang wall",
  "sparse infill": "Sparse infill",
  "internal solid infill": "Internal solid infill",
  "top surface": "Top surface",
  "bottom surface": "Bottom surface",
  ironing: "Ironing",
  bridge: "Bridge",
  "gap infill": "Gap infill",
  brim: "Brim",
  "support interface": "Support interface",
  "support transition": "Support transition",
  "prime tower": "Prime tower",
  custom: "Custom",
};

/** The canonical name for a feature comment's text. */
export function canonicalFeature(name: string): string {
  const trimmed = name.trim();
  return SYNONYMS[trimmed.toLowerCase()] ?? trimmed;
}

/** Colours for a file's feature list, by index. */
export function featureColors(features: string[]): string[] {
  let spare = 0;
  return features.map((f) => FEATURE_COLORS[f] ?? SPARE[spare++ % SPARE.length]);
}

/** A stable order for the legend: OrcaSlicer's, then anything else. */
export function featureOrder(features: string[]): number[] {
  const known = Object.keys(FEATURE_COLORS);
  const rank = (f: string) => {
    const i = known.indexOf(f);
    return i < 0 ? known.length : i;
  };
  return features.map((_, i) => i).sort((a, b) => rank(features[a]) - rank(features[b]) || a - b);
}
