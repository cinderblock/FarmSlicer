// Splitting and merging models: a model whose part is several separate
// pieces (an STL of a whole kit) becomes several models or several parts;
// two models become one. Paint goes with its triangles.

import { makeObject, makeVolume, type ModelObject, type Volume } from "./document";
import { connectedComponents, identity, multiply, submesh, type Mat4 } from "./mesh";
import { PaintLayer, type PaintKind } from "./paint";

/** A volume's pieces (connected triangles), each with its paint. */
export function volumePieces(v: Volume): Volume[] {
  const groups = connectedComponents(v.mesh);
  if (groups.length <= 1) return [v];
  return groups.map((tris, i) => {
    const mesh = submesh(v.mesh, tris);
    const paint: Volume["paint"] = {};
    for (const [kind, layer] of Object.entries(v.paint) as [PaintKind, PaintLayer | undefined][]) {
      if (!layer) continue;
      const piece = new PaintLayer(mesh);
      tris.forEach((t, j) => {
        const s = layer.getString(t);
        if (s) piece.setString(j, s);
      });
      if (!piece.empty) paint[kind] = piece;
    }
    return makeVolume(mesh, {
      name: `${v.name || "Part"} ${i + 1}`,
      type: v.type,
      matrix: v.matrix,
      extruder: v.extruder,
      paint,
      settings: { ...v.settings },
    });
  });
}

/** How many separate pieces the model's parts are made of. */
export function pieceCount(o: ModelObject): number {
  return o.volumes.filter((v) => v.type === "part").reduce((n, v) => n + connectedComponents(v.mesh).length, 0);
}

/**
 * Every piece of the model's parts as a model of its own. Modifiers,
 * negative volumes and support enforcers/blockers stay with the first.
 */
export function splitToObjects(o: ModelObject): ModelObject[] {
  const pieces = o.volumes.filter((v) => v.type === "part").flatMap(volumePieces);
  if (pieces.length <= 1) return [o];
  const others = o.volumes.filter((v) => v.type !== "part");
  return pieces.map((p, i) =>
    makeObject(`${o.name} ${i + 1}`, i === 0 ? [p, ...others] : [p], {
      extruder: o.extruder,
      settings: { ...o.settings },
    }),
  );
}

/** Every piece of the model's parts as a part of its own (each may take its own filament). */
export function splitToParts(o: ModelObject): ModelObject {
  return { ...o, volumes: o.volumes.flatMap((v) => (v.type === "part" ? volumePieces(v) : [v])) };
}

/**
 * One model of two: `b`'s volumes join `a`'s, placed by `bToA` (b's frame in
 * a's). Each keeps its filament (b's parts take b's when they had none of
 * their own) and b's settings go to its volumes.
 */
export function mergeInto(a: ModelObject, b: ModelObject, bToA: Mat4 = identity()): ModelObject {
  const moved = b.volumes.map((v) =>
    makeVolume(v.mesh, {
      name: v.name || b.name,
      type: v.type,
      matrix: multiply(bToA, v.matrix),
      extruder: v.extruder || (v.type === "part" || v.type === "modifier" ? b.extruder : 0),
      paint: Object.fromEntries(Object.entries(v.paint).map(([k, l]) => [k, l?.clone()])),
      settings: { ...b.settings, ...v.settings },
    }),
  );
  return { ...a, volumes: [...a.volumes, ...moved] };
}
