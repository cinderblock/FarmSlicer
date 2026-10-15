// Dragging the part and its handles: pointer rays, snapping, the drag that
// moves the part across the plate. Shared by the gizmos (Gizmo.tsx).

import { useCallback } from "react";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import type { Part, SceneBed } from "./part";

export type Tool = "none" | "move" | "rotate" | "flat";

export const ROTATE_STEP = THREE.MathUtils.degToRad(15);
const MOVE_STEP = 1; // mm
export const MAGNET_PX = 8;

/** World units per screen pixel at `point`. */
export function worldPerPixel(camera: THREE.Camera, point: THREE.Vector3, heightPx: number): number {
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const cam = camera as THREE.PerspectiveCamera;
    const dist = cam.position.distanceTo(point);
    return (2 * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / heightPx;
  }
  const cam = camera as THREE.OrthographicCamera;
  return (cam.top - cam.bottom) / cam.zoom / heightPx;
}

export function toScreen(p: THREE.Vector3, camera: THREE.Camera, rect: DOMRect): THREE.Vector2 {
  const v = p.clone().project(camera);
  return new THREE.Vector2(((v.x + 1) / 2) * rect.width, ((1 - v.y) / 2) * rect.height);
}

interface DragHandlers {
  move(ray: THREE.Ray, ev: PointerEvent): void;
  end(): void;
}

/**
 * Start a drag from a pointer-down on a handle: the camera controls stop,
 * pointer moves arrive as rays until the button comes up.
 */
export function useDrag() {
  const get = useThree((s) => s.get);
  return useCallback(
    (e: ThreeEvent<PointerEvent>, h: DragHandlers) => {
      e.stopPropagation();
      const { gl, camera, controls } = get();
      const ctrl = controls as unknown as { enabled: boolean } | null;
      if (ctrl) ctrl.enabled = false;
      const el = gl.domElement;
      const raycaster = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      const onMove = (ev: PointerEvent) => {
        const r = el.getBoundingClientRect();
        ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        h.move(raycaster.ray, ev);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (ctrl) ctrl.enabled = true;
        h.end();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [get],
  );
}

/** A snap line on the plate: x = value (axis 0) or y = value (axis 1). */
export interface Guide {
  axis: 0 | 1;
  value: number;
}

/**
 * Snap a bounding-box centre coordinate on one axis: to the bed's centre
 * line or flush with an edge when within MAGNET_PX, else to whole mm.
 */
export function snapCoordinate(
  value: number,
  axis: 0 | 1,
  half: number,
  bed: SceneBed,
  magnet: number,
): { value: number; guide: Guide | null } {
  const lo = axis === 0 ? bed.min.x : bed.min.y;
  const hi = axis === 0 ? bed.max.x : bed.max.y;
  const candidates = [
    { at: 0, guide: 0 },
    { at: lo + half, guide: lo },
    { at: hi - half, guide: hi },
  ];
  let best: { at: number; guide: number } | null = null;
  for (const c of candidates)
    if (Math.abs(value - c.at) <= magnet && (!best || Math.abs(value - c.at) < Math.abs(value - best.at))) best = c;
  if (best) return { value: best.at, guide: { axis, value: best.guide } };
  // Whole millimetres in slicer coordinates, as the panel shows them.
  const shift = axis === 0 ? bed.center.x : bed.center.y;
  return { value: Math.round((value + shift) / MOVE_STEP) * MOVE_STEP - shift, guide: null };
}

/** Keep a dragged part within reach: at most a bed's width beyond the edges. */
export function clampCenter(x: number, y: number, bed: SceneBed): [number, number] {
  const w = bed.max.x - bed.min.x;
  const d = bed.max.y - bed.min.y;
  return [
    THREE.MathUtils.clamp(x, bed.min.x - w, bed.max.x + w),
    THREE.MathUtils.clamp(y, bed.min.y - d, bed.max.y + d),
  ];
}

export interface GizmoProps {
  part: Part;
  bed: SceneBed;
  /** The part moved or turned (during a drag too). */
  onChange: () => void;
  /** A manipulation finished: report the placement. */
  onCommit: () => void;
  onGuides: (guides: Guide[]) => void;
}

/** Drag the part across the plate by grabbing it (any tool but lay-on-face). */
export function useBodyDrag({ part, bed, onChange, onCommit, onGuides }: GizmoProps) {
  const drag = useDrag();
  const { camera, size } = useThree();
  return useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (e.button !== 0) return;
      // A handle drawn over the part wins.
      if (e.intersections.some((i) => i.object.userData.handle)) return;
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -e.point.z);
      const start = e.point.clone();
      const startCenter = part.center.clone();
      const hit = new THREE.Vector3();
      drag(e, {
        move(ray, ev) {
          if (!ray.intersectPlane(plane, hit)) return;
          let x = startCenter.x + hit.x - start.x;
          let y = startCenter.y + hit.y - start.y;
          const guides: Guide[] = [];
          if (!ev.shiftKey) {
            const half = part.extent.getSize(new THREE.Vector3()).multiplyScalar(0.5);
            const magnet = MAGNET_PX * worldPerPixel(camera, part.worldBox().getCenter(new THREE.Vector3()), size.height);
            const sx = snapCoordinate(x, 0, half.x, bed, magnet);
            const sy = snapCoordinate(y, 1, half.y, bed, magnet);
            x = sx.value;
            y = sy.value;
            if (sx.guide) guides.push(sx.guide);
            if (sy.guide) guides.push(sy.guide);
          }
          [x, y] = clampCenter(x, y, bed);
          part.setCenter(x, y);
          onGuides(guides);
          onChange();
        },
        end() {
          onGuides([]);
          onCommit();
        },
      });
    },
    [part, bed, drag, camera, size.height, onChange, onCommit, onGuides],
  );
}

