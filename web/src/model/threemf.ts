// 3MF files: read the core spec, the production extension (components in
// other model files of the package), materials/colour groups, and the
// metadata OrcaSlicer, Bambu Studio and PrusaSlicer add; write the dialect
// OrcaSlicer reads (bbs_3mf.cpp): one mesh object per volume, an object of
// components per model object, `Metadata/model_settings.config` with each
// object's and part's name, type, filament and settings, and paint as
// triangle attributes.

import { unzipSync, zipSync, type Zippable } from "fflate";
import {
  makeObject,
  makeVolume,
  VOLUME_SUBTYPE,
  volumeTypeFromSubtype,
  type ModelObject,
  type Volume,
} from "./document";
import { identity, multiply, scaling, type Mat4, type Mesh } from "./mesh";
import { PAINT_ATTRIBUTE, PaintLayer, PRUSA_PAINT_ATTRIBUTE, type PaintKind } from "./paint";
import { formatFloat, parseXml, XmlWriter, localName } from "./xml";

const CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const PRODUCTION_NS = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";
const BAMBU_NS = "http://schemas.bambulab.com/package/2021";
const MODEL_TYPE = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
const MODEL_SETTINGS = "Metadata/model_settings.config";
const PRUSA_SETTINGS = "Metadata/Slic3r_PE_model.config";

/** Millimetres per unit (3MF `unit`). */
const UNITS: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/** One object of a 3MF and where its build items put it. */
export interface LoadedObject {
  object: ModelObject;
  /** Each build item's transform (the object's instances). */
  items: Mat4[];
}

export interface Loaded3mf {
  objects: LoadedObject[];
  /** Colours of the file's materials, in the order they became paint
   *  states 1..N (core 3MF colours, not Orca's filaments). Empty when the
   *  file had none. */
  palette: string[];
  /** Anything worth telling the user (skipped parts, unknown units). */
  warnings: string[];
}

interface RawTriangleMeta {
  /** Per paint kind, the attribute value of each triangle that has one. */
  paint: Partial<Record<PaintKind, Map<number, string>>>;
  /** Core material colour index per triangle (into the palette), or -1. */
  color: Int32Array | null;
}

interface RawObject {
  id: string;
  name: string;
  /** Object-level material (pid/pindex). */
  pid?: string;
  pindex?: number;
  mesh?: Mesh;
  meta?: RawTriangleMeta;
  components: { objectid: string; path?: string; transform: Mat4 }[];
}

interface RawModel {
  unit: number;
  objects: Map<string, RawObject>;
  build: { objectid: string; path?: string; transform: Mat4 }[];
  metadata: Map<string, string>;
  /** Material groups: id → colours (#RRGGBB(AA)). */
  materials: Map<string, string[]>;
}

/** 3MF transform "m00 m01 m02 m10 ... m32" → column-major 4x4. */
export function parseTransform(s: string | undefined): Mat4 {
  const m = identity();
  if (!s) return m;
  const v = s.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) return m;
  const at = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14];
  at.forEach((idx, k) => (m[idx] = v[k]));
  return m;
}

export function formatTransform(m: Mat4): string {
  return [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14].map((i) => formatNumber(m[i])).join(" ");
}

function formatNumber(x: number): string {
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toPrecision(17)));
}

function normaliseColor(c: string): string {
  const s = c.trim();
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) return s.slice(0, 7).toUpperCase();
  return "#FFFFFF";
}

function parseModel(xml: string): RawModel {
  const model: RawModel = { unit: 1, objects: new Map(), build: [], metadata: new Map(), materials: new Map() };
  let obj: RawObject | null = null;
  let pos: number[] = [];
  let idx: number[] = [];
  let paint: Partial<Record<PaintKind, Map<number, string>>> = {};
  let triColor: number[] = [];
  let anyColor = false;
  let material: string[] | null = null;
  let metaName: string | null = null;
  let metaText = "";
  let inBuild = false;
  parseXml(xml, {
    open(name, a) {
      const local = localName(name);
      switch (local) {
        case "model":
          model.unit = UNITS[a.get("unit") ?? "millimeter"] ?? 1;
          break;
        case "metadata":
          if (!obj) {
            metaName = a.get("name") ?? null;
            metaText = "";
          }
          break;
        case "basematerials":
          material = [];
          model.materials.set(a.get("id") ?? "", material);
          break;
        case "base":
          material?.push(normaliseColor(a.get("displaycolor") ?? "#FFFFFF"));
          break;
        case "colorgroup":
          material = [];
          model.materials.set(a.get("id") ?? "", material);
          break;
        case "color":
          material?.push(normaliseColor(a.get("color") ?? "#FFFFFF"));
          break;
        case "object":
          obj = {
            id: a.get("id") ?? "",
            name: a.get("name") ?? "",
            pid: a.get("pid"),
            pindex: a.get("pindex") !== undefined ? Number(a.get("pindex")) : undefined,
            components: [],
          };
          pos = [];
          idx = [];
          paint = {};
          triColor = [];
          anyColor = false;
          break;
        case "vertex":
          pos.push(Number(a.get("x")), Number(a.get("y")), Number(a.get("z")));
          break;
        case "triangle": {
          const t = idx.length / 3;
          idx.push(Number(a.get("v1")), Number(a.get("v2")), Number(a.get("v3")));
          for (let i = 0; i < a.length; i++) {
            const n = a.names[i];
            let kind: PaintKind | undefined;
            for (const [k, attr] of Object.entries(PAINT_ATTRIBUTE) as [PaintKind, string][])
              if (attr === n) kind = k;
            kind ??= PRUSA_PAINT_ATTRIBUTE[n];
            if (kind && a.values[i]) (paint[kind] ??= new Map()).set(t, a.values[i]);
          }
          const pid = a.get("pid") ?? obj?.pid;
          const p1 = a.get("p1");
          if (pid !== undefined && (p1 !== undefined || obj?.pindex !== undefined)) {
            const group = model.materials.get(pid);
            const i = p1 !== undefined ? Number(p1) : obj!.pindex!;
            if (group && group[i]) {
              triColor[t] = encodeColor(group[i]);
              anyColor = true;
            }
          }
          break;
        }
        case "component":
          obj?.components.push({
            objectid: a.get("objectid") ?? "",
            path: a.getLocal("path"),
            transform: parseTransform(a.get("transform")),
          });
          break;
        case "build":
          inBuild = true;
          break;
        case "item":
          if (inBuild)
            model.build.push({
              objectid: a.get("objectid") ?? "",
              path: a.getLocal("path"),
              transform: parseTransform(a.get("transform")),
            });
          break;
      }
    },
    text(t) {
      if (metaName !== null) metaText += t;
    },
    close(name) {
      const local = localName(name);
      if (local === "metadata" && metaName !== null) {
        model.metadata.set(metaName, metaText.trim());
        metaName = null;
      } else if ((local === "basematerials" || local === "colorgroup") && material) {
        material = null;
      } else if (local === "object" && obj) {
        if (idx.length) {
          const nv = pos.length / 3;
          if (idx.some((v) => !(v >= 0 && v < nv) || !Number.isInteger(v)))
            throw new Error(`3MF: object ${obj.id} has a triangle with a bad vertex index`);
          obj.mesh = { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
          let color: Int32Array | null = null;
          if (anyColor) {
            color = new Int32Array(idx.length / 3).fill(-1);
            triColor.forEach((c, t) => (color![t] = c));
          }
          obj.meta = { paint, color };
        }
        model.objects.set(obj.id, obj);
        obj = null;
      } else if (local === "build") inBuild = false;
    },
  });
  return model;
}

// Colours are carried through parsing as 24-bit ints, palette indices later.
function encodeColor(c: string): number {
  return parseInt(c.slice(1, 7), 16);
}
function decodeColor(n: number): string {
  return "#" + n.toString(16).padStart(6, "0").toUpperCase();
}

interface PartSettings {
  name?: string;
  subtype?: string;
  extruder?: number;
  settings: Record<string, string>;
}

interface ObjectSettings {
  name?: string;
  extruder?: number;
  settings: Record<string, string>;
  /** Orca/Bambu: by component object id. */
  parts: Map<string, PartSettings>;
  /** PrusaSlicer: triangle ranges of the object's one mesh. */
  ranges: { first: number; last: number; part: PartSettings }[];
}

/** Keys that describe the part rather than set a profile option. */
const STRUCTURAL = new Set([
  "name",
  "matrix",
  "source_file",
  "source_object_id",
  "source_volume_id",
  "source_offset_x",
  "source_offset_y",
  "source_offset_z",
  "source_in_inches",
  "source_in_meters",
  "mesh_shared",
  "module",
  "volume_type",
  "part_type",
  "modifier",
]);

function parseSettings(xml: string): Map<string, ObjectSettings> {
  const out = new Map<string, ObjectSettings>();
  let obj: ObjectSettings | null = null;
  let part: PartSettings | null = null;
  parseXml(xml, {
    open(name, a) {
      switch (name) {
        case "object":
          obj = { settings: {}, parts: new Map(), ranges: [] };
          out.set(a.get("id") ?? "", obj);
          break;
        case "part":
          part = { subtype: a.get("subtype"), settings: {} };
          obj?.parts.set(a.get("id") ?? "", part);
          break;
        case "volume":
          part = { settings: {} };
          obj?.ranges.push({ first: Number(a.get("firstid")), last: Number(a.get("lastid")), part });
          break;
        case "metadata": {
          const key = a.get("key");
          const value = a.get("value") ?? "";
          if (!key) break;
          const target = part ?? obj;
          if (!target) break;
          if (key === "name") target.name = value;
          else if (key === "extruder") target.extruder = Number(value) || 0;
          else if (key === "volume_type" || key === "part_type") {
            if (part) part.subtype = value;
          } else if (key === "modifier" && value === "1") {
            if (part) part.subtype = part.subtype ?? "modifier_part";
          } else if (!STRUCTURAL.has(key)) target.settings[key] = value;
          break;
        }
      }
    },
    close(name) {
      if (name === "part" || name === "volume") part = null;
      else if (name === "object") obj = null;
    },
  });
  return out;
}

function rootModelPath(files: Record<string, Uint8Array>, dec: TextDecoder): string {
  const rels = files["_rels/.rels"];
  if (rels) {
    let target: string | null = null;
    parseXml(dec.decode(rels), {
      open(name, a) {
        if (localName(name) === "Relationship" && a.get("Type") === MODEL_TYPE && !target)
          target = (a.get("Target") ?? "").replace(/^\//, "");
      },
    });
    if (target && files[target]) return target;
  }
  if (files["3D/3dmodel.model"]) return "3D/3dmodel.model";
  const any = Object.keys(files).find((f) => f.endsWith(".model"));
  if (!any) throw new Error("Not a 3MF: no model inside");
  return any;
}

/** Read a 3MF package into editor objects. */
export function read3mf(data: ArrayBuffer | Uint8Array): Loaded3mf {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("Not a 3MF: the file isn't a zip package");
  }
  // Paths are case-insensitive in OPC; normalise to what we look up.
  const byLower = new Map(Object.keys(files).map((k) => [k.toLowerCase(), k]));
  const dec = new TextDecoder();
  const rootPath = rootModelPath(files, dec);
  const models = new Map<string, RawModel>();
  const modelAt = (path: string | undefined): RawModel => {
    const p = (path ?? rootPath).replace(/^\//, "");
    let m = models.get(p);
    if (!m) {
      const key = files[p] ? p : byLower.get(p.toLowerCase());
      if (!key) throw new Error(`3MF: missing part ${p}`);
      m = parseModel(dec.decode(files[key]));
      models.set(p, m);
    }
    return m;
  };
  const root = modelAt(undefined);
  const warnings: string[] = [];
  const settingsFile = files[MODEL_SETTINGS] ?? files[PRUSA_SETTINGS];
  const settings = settingsFile ? parseSettings(dec.decode(settingsFile)) : new Map<string, ObjectSettings>();
  const application = root.metadata.get("Application") ?? "";

  // Core colours become paint states 1..N in first-seen order.
  const palette: string[] = [];
  const paletteIndex = new Map<number, number>();
  const stateOf = (rgb: number) => {
    let s = paletteIndex.get(rgb);
    if (s === undefined) {
      palette.push(decodeColor(rgb));
      s = palette.length;
      paletteIndex.set(rgb, s);
    }
    return s;
  };

  const unitScale = (m: RawModel): Mat4 => (m.unit === 1 ? identity() : scaling(m.unit, m.unit, m.unit));

  /** Volumes of a raw object: its own mesh, or its components flattened. */
  const volumesOf = (
    model: RawModel,
    raw: RawObject,
    transform: Mat4,
    depth: number,
    out: { raw: RawObject; matrix: Mat4; componentId: string }[],
    componentId: string,
  ) => {
    if (depth > 16) throw new Error("3MF: components nest too deep");
    if (raw.mesh) out.push({ raw, matrix: multiply(transform, unitScale(model)), componentId });
    for (const c of raw.components) {
      const sub = c.path ? modelAt(c.path) : model;
      const child = sub.objects.get(c.objectid);
      if (!child) {
        warnings.push(`A component refers to object ${c.objectid}, which isn't in the file`);
        continue;
      }
      volumesOf(sub, child, multiply(transform, c.transform), depth + 1, out, c.objectid);
    }
  };

  const objects: LoadedObject[] = [];
  const byObject = new Map<string, LoadedObject>();
  for (const item of root.build) {
    const model = item.path ? modelAt(item.path) : root;
    const key = `${item.path ?? ""}#${item.objectid}`;
    const existing = byObject.get(key);
    if (existing) {
      existing.items.push(item.transform);
      continue;
    }
    const raw = model.objects.get(item.objectid);
    if (!raw) {
      warnings.push(`A build item refers to object ${item.objectid}, which isn't in the file`);
      continue;
    }
    const parts: { raw: RawObject; matrix: Mat4; componentId: string }[] = [];
    volumesOf(model, raw, identity(), 0, parts, raw.id);
    if (!parts.length) continue;
    const meta = settings.get(raw.id);
    const volumes: Volume[] = [];
    for (const p of parts) {
      const mesh = p.raw.mesh!;
      const rawMeta = p.raw.meta;
      const ranges = meta?.ranges.length ? meta.ranges : null;
      const pieces: { tris: [number, number] | null; part?: PartSettings }[] = ranges
        ? ranges.map((r) => ({ tris: [r.first, r.last] as [number, number], part: r.part }))
        : [{ tris: null, part: meta?.parts.get(p.componentId) }];
      for (const piece of pieces) {
        const sub = piece.tris ? sliceTriangles(mesh, piece.tris[0], piece.tris[1]) : { mesh, first: 0 };
        const volume = makeVolume(sub.mesh, {
          name: piece.part?.name ?? p.raw.name ?? "",
          type: volumeTypeFromSubtype(piece.part?.subtype),
          matrix: p.matrix,
          extruder: piece.part?.extruder ?? 0,
          settings: piece.part?.settings ?? {},
        });
        const nt = sub.mesh.indices.length / 3;
        if (rawMeta) {
          for (const [kind, values] of Object.entries(rawMeta.paint) as [PaintKind, Map<number, string>][]) {
            const layer = new PaintLayer(sub.mesh);
            for (const [t, value] of values) {
              const local = t - sub.first;
              if (local < 0 || local >= nt) continue;
              try {
                layer.setString(local, value);
              } catch (e) {
                warnings.push(`Skipped unreadable ${kind} paint on a triangle: ${(e as Error).message}`);
              }
            }
            if (!layer.empty) volume.paint[kind] = layer;
          }
          if (rawMeta.color && !volume.paint.color) {
            const layer = new PaintLayer(sub.mesh);
            const states = new Set<number>();
            for (let t = 0; t < nt; t++) {
              const c = rawMeta.color[t + sub.first];
              if (c >= 0) {
                const s = stateOf(c);
                states.add(s);
                layer.setTriangle(t, s);
              }
            }
            // One colour for the whole volume is its filament, not paint.
            if (states.size === 1 && layer.painted().length === nt) {
              volume.extruder = [...states][0];
            } else if (!layer.empty) volume.paint.color = layer;
          }
        }
        volumes.push(volume);
      }
    }
    let objectExtruder = meta?.extruder || 0;
    if (!objectExtruder && raw.pid !== undefined && raw.pindex !== undefined) {
      const c = root.materials.get(raw.pid)?.[raw.pindex];
      if (c) objectExtruder = stateOf(encodeColor(c));
    }
    const object = makeObject(meta?.name || raw.name || `Object ${objects.length + 1}`, volumes, {
      extruder: objectExtruder || 1,
      settings: meta?.settings ?? {},
    });
    // An object whose only part is on its own filament: that's the object's.
    if (volumes.length === 1 && volumes[0].extruder) {
      object.extruder = volumes[0].extruder;
      volumes[0].extruder = 0;
    }
    if (volumes.length === 1 && !volumes[0].name) volumes[0].name = object.name;
    const loaded = { object, items: [item.transform] };
    byObject.set(key, loaded);
    objects.push(loaded);
  }
  if (!objects.length) throw new Error("The 3MF file has no objects to print");
  if (application && !/^(OrcaSlicer|BambuStudio|PrusaSlicer|FarmSlicer)/.test(application) && palette.length > 1)
    warnings.push(`Colours from ${application} became ${palette.length} filaments`);
  return { objects, palette, warnings };
}

function sliceTriangles(mesh: Mesh, first: number, last: number): { mesh: Mesh; first: number } {
  const nt = mesh.indices.length / 3;
  const a = Math.max(0, first);
  const b = Math.min(nt - 1, last);
  if (a === 0 && b === nt - 1) return { mesh, first: 0 };
  const remap = new Int32Array(mesh.positions.length / 3).fill(-1);
  const pos: number[] = [];
  const idx = new Uint32Array((b - a + 1) * 3);
  for (let t = a; t <= b; t++)
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k];
      if (remap[v] < 0) {
        remap[v] = pos.length / 3;
        pos.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      }
      idx[(t - a) * 3 + k] = remap[v];
    }
  return { mesh: { positions: Float32Array.from(pos), indices: idx }, first: a };
}

export interface Write3mfOptions {
  /** Written as the package's Application ("FarmSlicer-<commit>"). */
  application?: string;
  /** Build item transform per object (default identity, one item each). */
  items?: Mat4[][];
}

/**
 * Write objects as an OrcaSlicer-dialect 3MF. Volume meshes are stored as
 * they are with their matrix on the component (as the desktop app does),
 * so triangle order and paint stay exactly as edited.
 */
export function write3mf(objects: ModelObject[], opts: Write3mfOptions = {}): Uint8Array {
  const model = new XmlWriter();
  model.raw('<?xml version="1.0" encoding="UTF-8"?>\n');
  model.open("model", {
    unit: "millimeter",
    "xml:lang": "en-US",
    xmlns: CORE_NS,
    "xmlns:BambuStudio": BAMBU_NS,
    "xmlns:p": PRODUCTION_NS,
  });
  model.element("metadata", { name: "Application" }, opts.application ?? "FarmSlicer");
  model.element("metadata", { name: "BambuStudio:3mfVersion" }, "1");
  model.open("resources");

  const settings = new XmlWriter();
  settings.raw('<?xml version="1.0" encoding="UTF-8"?>\n');
  settings.open("config");

  let nextObjectId = 1;
  const buildIds: number[] = [];
  for (const object of objects) {
    const volumeIds: number[] = [];
    for (const v of object.volumes) {
      const id = nextObjectId++;
      volumeIds.push(id);
      writeMesh(model, id, v);
    }
    const objectId = nextObjectId++;
    buildIds.push(objectId);
    model.open("object", { id: objectId, type: "model" });
    model.open("components");
    object.volumes.forEach((v, i) =>
      model.open("component", { objectid: volumeIds[i], transform: formatTransform(v.matrix) }, true),
    );
    model.close("components");
    model.close("object");

    settings.open("object", { id: objectId });
    settings.open("metadata", { key: "name", value: object.name }, true);
    settings.open("metadata", { key: "extruder", value: object.extruder }, true);
    for (const [k, val] of Object.entries(object.settings)) settings.open("metadata", { key: k, value: val }, true);
    object.volumes.forEach((v, i) => {
      settings.open("part", { id: volumeIds[i], subtype: VOLUME_SUBTYPE[v.type] });
      settings.open("metadata", { key: "name", value: v.name || object.name }, true);
      if (v.extruder) settings.open("metadata", { key: "extruder", value: v.extruder }, true);
      for (const [k, val] of Object.entries(v.settings)) settings.open("metadata", { key: k, value: val }, true);
      settings.open(
        "mesh_stat",
        { edges_fixed: 0, degenerate_facets: 0, facets_removed: 0, facets_reversed: 0, backwards_edges: 0 },
        true,
      );
      settings.close("part");
    });
    settings.close("object");
  }
  model.close("resources");
  model.open("build");
  objects.forEach((_, i) => {
    const items = opts.items?.[i] ?? [identity()];
    for (const t of items) model.open("item", { objectid: buildIds[i], transform: formatTransform(t), printable: 1 }, true);
  });
  model.close("build");
  model.close("model");
  settings.close("config");

  const enc = new TextEncoder();
  const files: Zippable = {
    "[Content_Types].xml": enc.encode(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
        ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
        ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
        ' <Default Extension="png" ContentType="image/png"/>\n' +
        ' <Default Extension="config" ContentType="text/xml"/>\n' +
        "</Types>\n",
    ),
    "_rels/.rels": enc.encode(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
        ` <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="${MODEL_TYPE}"/>\n` +
        "</Relationships>\n",
    ),
    "3D/3dmodel.model": model.toBytes(),
    [MODEL_SETTINGS]: settings.toBytes(),
  };
  return zipSync(files, { level: 6 });
}

function writeMesh(w: XmlWriter, id: number, v: Volume) {
  w.open("object", { id, type: "model" });
  w.raw("<mesh>\n<vertices>\n");
  const p = v.mesh.positions;
  for (let i = 0; i < p.length; i += 3)
    w.raw(`<vertex x="${formatFloat(p[i])}" y="${formatFloat(p[i + 1])}" z="${formatFloat(p[i + 2])}"/>\n`);
  w.raw("</vertices>\n<triangles>\n");
  const idx = v.mesh.indices;
  const layers = (Object.entries(v.paint) as [PaintKind, PaintLayer | undefined][]).filter(
    (e): e is [PaintKind, PaintLayer] => !!e[1] && !e[1].empty,
  );
  const painted = layers.map(([kind, layer]) => ({ attr: PAINT_ATTRIBUTE[kind], layer, set: new Set(layer.painted()) }));
  for (let t = 0; t < idx.length / 3; t++) {
    let s = `<triangle v1="${idx[t * 3]}" v2="${idx[t * 3 + 1]}" v3="${idx[t * 3 + 2]}"`;
    for (const { attr, layer, set } of painted) {
      if (!set.has(t)) continue;
      const value = layer.getString(t);
      if (value) s += ` ${attr}="${value}"`;
    }
    w.raw(s + "/>\n");
  }
  w.raw("</triangles>\n</mesh>\n");
  w.close("object");
}
