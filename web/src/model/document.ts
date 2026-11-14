// What the editor edits: objects made of volumes, as libslic3r's Model has
// them (ModelObject → ModelVolume). One object is one model file of the job
// and every copy of it on the plates is an instance placed by the page
// (src/placement.rs): the object itself has no position.

import { identity, multiply, type Mat4, type Mesh } from "./mesh";
import type { PaintKind, PaintLayer } from "./paint";

/** ModelVolumeType, by the names model_settings.config uses. */
export type VolumeType = "part" | "modifier" | "negative" | "enforcer" | "blocker";

export const VOLUME_SUBTYPE: Record<VolumeType, string> = {
  part: "normal_part",
  modifier: "modifier_part",
  negative: "negative_part",
  enforcer: "support_enforcer",
  blocker: "support_blocker",
};

export function volumeTypeFromSubtype(s: string | undefined): VolumeType {
  switch (s) {
    case "modifier_part":
    case "ParameterModifier":
      return "modifier";
    case "negative_part":
    case "NegativeVolume":
      return "negative";
    case "support_enforcer":
    case "SupportEnforcer":
      return "enforcer";
    case "support_blocker":
    case "SupportBlocker":
      return "blocker";
    default:
      return "part";
  }
}

export interface Volume {
  /** Stable while editing (React keys, selection); not saved. */
  id: string;
  name: string;
  type: VolumeType;
  mesh: Mesh;
  /** Where the volume sits in its object. */
  matrix: Mat4;
  /** 1-based filament; 0 = the object's. */
  extruder: number;
  paint: Partial<Record<PaintKind, PaintLayer>>;
  /** Other settings of this volume (a modifier's), as profile keys. */
  settings: Record<string, string>;
}

export interface ModelObject {
  id: string;
  name: string;
  volumes: Volume[];
  /** 1-based filament of the object's parts. */
  extruder: number;
  /** Per-object settings, as profile keys. */
  settings: Record<string, string>;
}

let nextId = 1;
export function newId(prefix: string): string {
  return `${prefix}${nextId++}`;
}

export function makeVolume(mesh: Mesh, init: Partial<Omit<Volume, "id" | "mesh">> = {}): Volume {
  return {
    id: newId("v"),
    name: init.name ?? "",
    type: init.type ?? "part",
    mesh,
    matrix: init.matrix ?? identity(),
    extruder: init.extruder ?? 0,
    paint: init.paint ?? {},
    settings: init.settings ?? {},
  };
}

export function makeObject(name: string, volumes: Volume[], init: Partial<Omit<ModelObject, "id" | "name" | "volumes">> = {}): ModelObject {
  return {
    id: newId("o"),
    name,
    volumes,
    extruder: init.extruder ?? 1,
    settings: init.settings ?? {},
  };
}

/** The filament a volume prints with. */
export function volumeExtruder(o: ModelObject, v: Volume): number {
  return v.extruder || o.extruder;
}

/** Every filament the object uses: parts' own, painted colours. */
export function usedFilaments(o: ModelObject): Set<number> {
  const out = new Set<number>();
  for (const v of o.volumes) {
    if (v.type !== "part" && v.type !== "modifier") continue;
    if (v.type === "part" || v.extruder) out.add(volumeExtruder(o, v));
    const color = v.paint.color;
    if (color) for (const s of color.usedStates()) out.add(s);
  }
  return out;
}

/** True when the object holds nothing an STL could carry: one plain part,
 *  no paint, no settings, filament 1. Such objects can go as they are. */
export function isPlain(o: ModelObject): boolean {
  if (o.volumes.length !== 1 || o.extruder !== 1 || Object.keys(o.settings).length) return false;
  const v = o.volumes[0];
  return (
    v.type === "part" &&
    !v.extruder &&
    !Object.keys(v.settings).length &&
    !Object.values(v.paint).some((p) => p && !p.empty)
  );
}

/** A volume's matrix composed with a parent's. */
export function volumeWorld(parent: Mat4, v: Volume): Mat4 {
  return multiply(parent, v.matrix);
}
