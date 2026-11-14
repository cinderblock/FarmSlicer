// Undo and redo for the plate. Every change ends in a commit; a commit
// compares the plate with how it was after the last one and, when it
// differs, records both (`PlateSnapshot`): which parts are on which plate,
// each part's model (its shape: edits to a model make a new one), turn,
// scale and place. Paint strokes change a model's paint in place and record
// the layers they touched instead (`PaintChange`).
//
// Parts and shapes that only a recorded state still refers to are disposed
// (their GPU buffers freed); three.js uploads them again if an undo brings
// them back.

import * as THREE from "three";
import type { PaintKind, PaintLayer } from "../../model/paint";
import type { Part, PartShape } from "./part";

export interface PartState {
  part: Part;
  shape: PartShape;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
  center: THREE.Vector2;
  plate: number;
}

export interface PlateSnapshot {
  parts: PartState[];
  plateCount: number;
}

export function snapshot(parts: Part[], plateCount: number): PlateSnapshot {
  return {
    parts: parts.map((p) => ({
      part: p,
      shape: p.shape,
      quaternion: p.quaternion.clone(),
      scale: p.scale.clone(),
      center: p.center.clone(),
      plate: p.plate,
    })),
    plateCount,
  };
}

const EPS = 1e-9;

export function sameSnapshot(a: PlateSnapshot, b: PlateSnapshot): boolean {
  if (a.plateCount !== b.plateCount || a.parts.length !== b.parts.length) return false;
  return a.parts.every((x, i) => {
    const y = b.parts[i];
    return (
      x.part === y.part &&
      x.shape === y.shape &&
      x.plate === y.plate &&
      Math.abs(x.quaternion.dot(y.quaternion)) > 1 - EPS &&
      x.scale.distanceTo(y.scale) < EPS &&
      x.center.distanceTo(y.center) < EPS
    );
  });
}

/** Put every part back as the snapshot has it; returns the parts. */
export function restore(s: PlateSnapshot): Part[] {
  for (const st of s.parts) {
    st.part.revive();
    st.part.setShape(st.shape);
    st.part.root.scale.copy(st.scale);
    st.part.setRotation(st.quaternion);
    st.part.setCenter(st.center.x, st.center.y);
    st.part.setPlate(st.plate);
  }
  return s.parts.map((st) => st.part);
}

/** A paint stroke (or fill, or clear): the layers before and after. */
export interface PaintChange {
  shape: PartShape;
  layers: { volumeId: string; kind: PaintKind; before: PaintLayer | undefined; after: PaintLayer | undefined }[];
}

export type Change = { kind: "plate"; before: PlateSnapshot; after: PlateSnapshot } | ({ kind: "paint" } & PaintChange);

export interface Entry {
  label: string;
  change: Change;
}

/** The undo and redo stacks. */
export class History {
  private done: Entry[] = [];
  private undone: Entry[] = [];
  private readonly limit: number;

  constructor(limit = 200) {
    this.limit = limit;
  }

  push(entry: Entry) {
    this.done.push(entry);
    this.undone = [];
    if (this.done.length > this.limit) this.done.shift();
  }

  undo(): Entry | undefined {
    const e = this.done.pop();
    if (e) this.undone.push(e);
    return e;
  }

  redo(): Entry | undefined {
    const e = this.undone.pop();
    if (e) this.done.push(e);
    return e;
  }

  get canUndo() {
    return this.done.length > 0;
  }
  get canRedo() {
    return this.undone.length > 0;
  }
  /** What Undo would undo ("Move", "Paint", ...). */
  get undoLabel() {
    return this.done.at(-1)?.label;
  }
  get redoLabel() {
    return this.undone.at(-1)?.label;
  }

  clear() {
    this.done = [];
    this.undone = [];
  }

  /** Every part any recorded state refers to (not to be disposed). */
  referencedParts(): Set<Part> {
    const out = new Set<Part>();
    for (const e of [...this.done, ...this.undone])
      if (e.change.kind === "plate") for (const s of [e.change.before, e.change.after]) s.parts.forEach((p) => out.add(p.part));
    return out;
  }
}

/** Put a paint change's layers in place (`which`: before = undo, after = redo). */
export function applyPaint(change: PaintChange, which: "before" | "after") {
  for (const l of change.layers) {
    const volume = change.shape.object.volumes.find((v) => v.id === l.volumeId);
    if (!volume) continue;
    const layer = l[which];
    if (layer && !layer.empty) volume.paint[l.kind] = layer.clone();
    else delete volume.paint[l.kind];
    change.shape.refreshPaint(l.volumeId, l.kind);
  }
  change.shape.version++;
}
