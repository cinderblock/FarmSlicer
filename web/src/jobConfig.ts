// Reading a job's stored config and package for its G-code preview
// (pages/Job.tsx, pages/Print.tsx).

import type { BedShape } from "./components/ModelViewer";
import type { Plate } from "./printers";

/** A JSON object column, or null. */
export function parseObject(raw: string | null | undefined): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** The bed from the job's config: `printable_area` ("0x0", ...) and `printable_height`. */
export function bedFromConfig(config: Record<string, unknown> | null): BedShape | null {
  if (!config) return null;
  const raw = config.printable_area;
  const points = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [])
    .map((p) => String(p).split("x").map(Number))
    .filter((p): p is [number, number] => p.length === 2 && p.every(Number.isFinite));
  if (points.length < 3) return null;
  const height = Number(Array.isArray(config.printable_height) ? config.printable_height[0] : config.printable_height);
  return { area: points, height: Number.isFinite(height) && height > 0 ? height : 0 };
}

/** The package's plates. */
export function packagePlates(packageJson: string | null | undefined): Plate[] {
  const plates = parseObject(packageJson)?.plates;
  return Array.isArray(plates) ? (plates as Plate[]) : [];
}

/** Filament colours by slot (`#rrggbb`), for the preview. */
export function plateColors(plate: Plate | null | undefined): string[] {
  const colors: string[] = [];
  for (const f of plate?.filaments ?? []) if (f.id > 0) colors[f.id - 1] = f.color;
  return colors;
}
