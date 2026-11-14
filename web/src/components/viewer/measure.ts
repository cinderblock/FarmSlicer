// What the measure tool (MeasureTool.tsx) measures, and how a click on a
// part becomes a measured point.

import { useCallback } from "react";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { toScreen } from "./drag";

/** Corners within this many pixels of the pointer are snapped to. */
const SNAP_PX = 10;
/** Faces this close to parallel (degrees) are measured apart. */
const PARALLEL_DEG = 0.5;

export type MeasureMode = "points" | "faces";

export interface MeasurePoint {
  /** Where (scene coordinates: slicer mm, the bed's centre at the origin). */
  at: THREE.Vector3;
  /** The face's outward normal there. */
  normal: THREE.Vector3;
  /** It's a corner of the mesh (snapped). */
  corner: boolean;
}

export interface Measurement {
  distance: number;
  /** Along the scene's axes (B − A). */
  delta: THREE.Vector3;
  /** Faces: the angle between them (degrees, 0-180). */
  angle: number | null;
  /** Faces: parallel, and this far apart (mm). */
  gap: number | null;
}

/** What two picks measure (null: fewer than two). */
export function measure(points: MeasurePoint[], mode: MeasureMode): Measurement | null {
  if (points.length < 2) return null;
  const [a, b] = points;
  const delta = b.at.clone().sub(a.at);
  if (mode === "points") return { distance: delta.length(), delta, angle: null, gap: null };
  const angle = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(a.normal.dot(b.normal), -1, 1)));
  const parallel = angle < PARALLEL_DEG || angle > 180 - PARALLEL_DEG;
  return { distance: delta.length(), delta, angle, gap: parallel ? Math.abs(delta.dot(a.normal)) : null };
}

/** Turn a pointer-down on a part into a measured point (snapped to a corner unless `free`). */
export function useMeasurePick() {
  const { camera, gl } = useThree();
  return useCallback(
    (e: ThreeEvent<PointerEvent>, snap: boolean): MeasurePoint | null => {
      const mesh = e.object as THREE.Mesh;
      if (!e.face || !mesh.geometry) return null;
      mesh.updateMatrixWorld();
      const normal = e.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize();
      // A mirrored copy's triangles wind the other way: keep the normal facing the viewer's side of the face.
      if (normal.dot(e.ray.direction) > 0) normal.negate();
      let at = e.point.clone();
      let corner = false;
      if (snap) {
        const pos = mesh.geometry.getAttribute("position");
        const rect = gl.domElement.getBoundingClientRect();
        const pointer = new THREE.Vector2(e.nativeEvent.clientX - rect.left, e.nativeEvent.clientY - rect.top);
        let best = SNAP_PX;
        for (const i of [e.face.a, e.face.b, e.face.c]) {
          const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
          const d = toScreen(v, camera, rect).distanceTo(pointer);
          if (d < best) {
            best = d;
            at = v;
            corner = true;
          }
        }
      }
      return { at, normal, corner };
    },
    [camera, gl],
  );
}
