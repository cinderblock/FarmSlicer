// Model files to editor objects, and editor objects back to the files a
// job uploads.

import { isPlain, makeObject, makeVolume, type ModelObject, type Volume } from "./document";
import { identity, isIdentity, multiply, type Mat4 } from "./mesh";
import { readStl } from "./stl";
import { read3mf, write3mf } from "./threemf";

/** One object from a file, and where the file put each of its instances. */
export interface LoadedObject {
  object: ModelObject;
  /** Each instance's transform in the file (identity for an STL). */
  items: Mat4[];
}

export interface LoadedFile {
  objects: LoadedObject[];
  /** Colours the file's own materials gave filaments 1..N (core 3MF
   *  colours); empty when it named none. */
  palette: string[];
  warnings: string[];
}

export const MODEL_EXTENSIONS = [".stl", ".3mf"];

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

export function loadModel(name: string, data: ArrayBuffer | Uint8Array): LoadedFile {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "stl") {
    const mesh = readStl(data);
    const title = baseName(name);
    return {
      objects: [{ object: makeObject(title, [makeVolume(mesh, { name: title })]), items: [identity()] }],
      palette: [],
      warnings: [],
    };
  }
  if (ext === "3mf") {
    const loaded = read3mf(data);
    // A file of one object takes the file's name when it has none of its own.
    if (loaded.objects.length === 1 && /^Object \d+$/.test(loaded.objects[0].object.name))
      loaded.objects[0].object.name = baseName(name);
    return loaded;
  }
  throw new Error(`${name}: not a model file FarmSlicer reads (STL or 3MF)`);
}

/**
 * The file a job uploads for `object`: `original` when it's an STL the
 * object still matches exactly (smaller, and the job keeps what was
 * dropped in), else a 3MF of the object as edited. The name keeps the
 * object's name, so jobs and G-code say what it is. The bytes depend on
 * the object alone (no version or date in them): the slice cache knows
 * models by their digest.
 */
export function modelFile(object: ModelObject, original: File | null): File {
  if (original && original.name.toLowerCase().endsWith(".stl") && isPlain(object)) return original;
  const bytes = write3mf([object], { application: "FarmSlicer" });
  const safe = object.name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "model";
  return new File([new Uint8Array(bytes)], `${safe}.3mf`, { type: "model/3mf" });
}

/**
 * A file's objects as one rigid model, each instance where the file put it
 * (how jobs from before the editor placed a 3MF: one part for the whole
 * file). Every volume keeps its own filament.
 */
export function mergeObjects(loaded: LoadedObject[], name: string): ModelObject {
  if (loaded.length === 1 && loaded[0].items.length === 1 && isIdentity(loaded[0].items[0])) return loaded[0].object;
  const volumes: Volume[] = [];
  for (const { object, items } of loaded)
    for (const item of items)
      for (const v of object.volumes) {
        const paint: Volume["paint"] = {};
        for (const [kind, layer] of Object.entries(v.paint)) if (layer) paint[kind as keyof Volume["paint"]] = layer.clone();
        volumes.push(
          makeVolume(v.mesh, {
            name: v.name || object.name,
            type: v.type,
            matrix: multiply(item, v.matrix),
            extruder: v.extruder || (v.type === "part" || v.type === "modifier" ? object.extruder : 0),
            paint,
            settings: { ...object.settings, ...v.settings },
          }),
        );
      }
  return makeObject(name, volumes);
}
