// Bambu Studio-style manipulators for the part: arrows to move it along X or
// Y, rings to rotate it about X, Y or Z, dragging the part itself across the
// plate, and lay-on-face. Snapping: 15° steps for rotation, 1 mm steps plus
// the bed's centre lines and edges for moves; Shift moves freely.
//
// Handles are drawn in screen pixels (a group scaled to world-units-per-pixel
// at the part) and on top of the part, so they stay the same size and stay
// grabbable from any view.

import { useMemo, useRef, useState } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import type { Part } from "./part";
import {
  clampCenter,
  MAGNET_PX,
  ROTATE_STEP,
  snapCoordinate,
  toScreen,
  useDrag,
  worldPerPixel,
  type GizmoProps,
  type Guide,
} from "./drag";

const AXIS_COLORS = ["#e5484d", "#46a758", "#3e7bff"] as const;
const HOVER_COLOR = "#ffd23f";
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

const ARROW_GAP_PX = 14;
const ARROW_LEN_PX = 70;
const RING_MIN_PX = 80;
const RING_GAP_PX = 16;

/** Follow the part: centre of its bounding box, scaled to pixels. */
function useGizmoFrame(part: Part, onFrame?: (wpp: number, box: THREE.Box3) => void) {
  const group = useRef<THREE.Group>(null);
  const px = useRef<THREE.Group>(null);
  const { camera, size } = useThree();
  useFrame(() => {
    if (!group.current || !px.current) return;
    const box = part.worldBox();
    const center = box.getCenter(new THREE.Vector3());
    group.current.position.copy(center);
    const wpp = worldPerPixel(camera, center, size.height);
    px.current.scale.setScalar(wpp);
    onFrame?.(wpp, box);
  });
  return { group, px };
}

const handleMaterial = (color: string) => ({
  color,
  depthTest: false,
  depthWrite: false,
  transparent: true,
  toneMapped: false,
});

/** Invisible but pickable. */
const hitMaterial = <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />;

export function MoveGizmo(props: GizmoProps) {
  const { part, bed, onChange, onCommit, onGuides } = props;
  const drag = useDrag();
  const { camera, size } = useThree();
  const [hover, setHover] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [readout, setReadout] = useState<{ axis: number; delta: number } | null>(null);
  const arrows = [useRef<THREE.Group>(null), useRef<THREE.Group>(null)];
  const { group, px } = useGizmoFrame(part, (wpp, box) => {
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5 / wpp);
    arrows[0].current?.position.set(half.x + ARROW_GAP_PX, 0, 0);
    arrows[1].current?.position.set(0, half.y + ARROW_GAP_PX, 0);
  });

  const start = (axis: 0 | 1) => (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return;
    const A = AXES[axis];
    const center = part.worldBox().getCenter(new THREE.Vector3());
    // The plane through the axis that faces the camera best.
    const view = camera.getWorldDirection(new THREE.Vector3());
    const normal = view.clone().addScaledVector(A, -view.dot(A));
    if (normal.lengthSq() < 1e-6) return;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.normalize(), center);
    const hit = new THREE.Vector3();
    // Measured on the drag plane like every move, so the arrow doesn't jump.
    if (!e.ray.intersectPlane(plane, hit)) return;
    const t0 = hit.clone().sub(center).dot(A);
    const startValue = axis === 0 ? part.center.x : part.center.y;
    setActive(axis);
    drag(e, {
      move(ray, ev) {
        if (!ray.intersectPlane(plane, hit)) return;
        const raw = startValue + hit.clone().sub(center).dot(A) - t0;
        let value = raw;
        let guide: Guide | null = null;
        if (!ev.shiftKey) {
          const half = part.extent.getSize(new THREE.Vector3()).multiplyScalar(0.5);
          const magnet = MAGNET_PX * worldPerPixel(camera, center, size.height);
          ({ value, guide } = snapCoordinate(raw, axis, axis === 0 ? half.x : half.y, bed, magnet));
        }
        const [x, y] = clampCenter(axis === 0 ? value : part.center.x, axis === 1 ? value : part.center.y, bed);
        part.setCenter(x, y);
        setReadout({ axis, delta: (axis === 0 ? x : y) - startValue });
        onGuides(guide ? [guide] : []);
        onChange();
      },
      end() {
        setActive(null);
        setReadout(null);
        onGuides([]);
        onCommit();
      },
    });
  };

  return (
    <group ref={group}>
      <group ref={px}>
        {([0, 1] as const).map((axis) => {
          const color = hover === axis || active === axis ? HOVER_COLOR : AXIS_COLORS[axis];
          return (
            <group key={axis} ref={arrows[axis]}>
              <group rotation={[0, 0, axis === 0 ? 0 : Math.PI / 2]}>
                <Line points={[[0, 0, 0], [ARROW_LEN_PX, 0, 0]]} lineWidth={3} {...handleMaterial(color)} renderOrder={1000} />
                <mesh position={[ARROW_LEN_PX + 7, 0, 0]} rotation={[0, 0, -Math.PI / 2]} renderOrder={1000}>
                  <coneGeometry args={[6, 16, 20]} />
                  <meshBasicMaterial {...handleMaterial(color)} />
                </mesh>
                <mesh
                  position={[(ARROW_LEN_PX + 16) / 2, 0, 0]}
                  rotation={[0, 0, -Math.PI / 2]}
                  userData={{ handle: true }}
                  onPointerDown={start(axis)}
                  onPointerOver={(e) => {
                    e.stopPropagation();
                    setHover(axis);
                  }}
                  onPointerOut={() => setHover((h) => (h === axis ? null : h))}
                >
                  <cylinderGeometry args={[10, 10, ARROW_LEN_PX + 16, 8]} />
                  {hitMaterial}
                </mesh>
              </group>
              {readout?.axis === axis && (
                <Html position={axis === 0 ? [ARROW_LEN_PX + 30, 0, 0] : [0, ARROW_LEN_PX + 30, 0]} center className="gizmo-readout">
                  {readout.delta >= 0 ? "+" : "−"}
                  {Math.abs(readout.delta).toFixed(1)} mm
                </Html>
              )}
            </group>
          );
        })}
      </group>
    </group>
  );
}

/** Unit circle in the plane perpendicular to `axis`. */
function ringPoints(axis: number, segments = 96): THREE.Vector3[] {
  const [u, v] = planeBasis(axis);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a)));
  }
  return pts;
}

/** Right-handed basis of the plane perpendicular to an axis (u × v = axis). */
function planeBasis(axis: number): [THREE.Vector3, THREE.Vector3] {
  return [AXES[(axis + 1) % 3], AXES[(axis + 2) % 3]];
}

interface RotateDrag {
  axis: number;
  /** Ring radius in pixels, frozen for the drag. */
  radius: number;
  /** In-plane direction of the grab point (angle 0) and its quarter turn. */
  u: THREE.Vector3;
  v: THREE.Vector3;
  angle: number;
  snapped: boolean;
}

export function RotateGizmo(props: GizmoProps) {
  const { part, onChange, onCommit } = props;
  const drag = useDrag();
  const { camera, size, gl } = useThree();
  const [hover, setHover] = useState<number | null>(null);
  const [active, setActive] = useState<RotateDrag | null>(null);
  const radiusPx = useRef(RING_MIN_PX);
  const rings = useRef<THREE.Group>(null);
  const { group, px } = useGizmoFrame(part, (wpp) => {
    if (!active) radiusPx.current = Math.max(part.radius / wpp + RING_GAP_PX, RING_MIN_PX);
    rings.current?.scale.setScalar(radiusPx.current);
  });
  const circles = useMemo(() => [0, 1, 2].map((a) => ringPoints(a)), []);

  const start = (axis: number) => (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return;
    const A = AXES[axis];
    const q0 = part.quaternion.clone();
    const center = part.worldBox().getCenter(new THREE.Vector3());
    const u = e.point.clone().sub(center);
    u.addScaledVector(A, -u.dot(A));
    if (u.lengthSq() < 1e-9) return;
    u.normalize();
    const v = A.clone().cross(u);
    const radius = radiusPx.current;
    const rect = gl.domElement.getBoundingClientRect();
    const view = center.clone().sub(camera.position).normalize();
    // Face-on rings turn with the pointer's angle around the centre; edge-on
    // ones (where that angle is meaningless) with the pointer's travel along
    // the ring's tangent at the grab point.
    const facing = Math.abs(view.dot(A)) > 0.3;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(A, center);
    const wpp = worldPerPixel(camera, center, size.height);
    const grab = center.clone().addScaledVector(u, radius * wpp);
    const tangent = toScreen(grab.clone().addScaledVector(v, radius * wpp * 0.05), camera, rect)
      .sub(toScreen(grab, camera, rect))
      .normalize();
    const pointer0 = new THREE.Vector2(e.nativeEvent.clientX - rect.left, e.nativeEvent.clientY - rect.top);
    const hit = new THREE.Vector3();
    let raw = 0;
    let last = 0;
    const state: RotateDrag = { axis, radius, u, v, angle: 0, snapped: true };
    setActive(state);
    drag(e, {
      move(ray, ev) {
        if (facing) {
          if (!ray.intersectPlane(plane, hit)) return;
          const r = hit.sub(center);
          const a = Math.atan2(r.dot(v), r.dot(u));
          // Unwrap across ±180° so a full turn keeps counting.
          let d = a - last;
          if (d > Math.PI) d -= 2 * Math.PI;
          if (d < -Math.PI) d += 2 * Math.PI;
          raw += d;
          last = a;
        } else {
          const p = new THREE.Vector2(ev.clientX - rect.left, ev.clientY - rect.top).sub(pointer0);
          raw = p.dot(tangent) / radius;
        }
        const snapped = !ev.shiftKey;
        const angle = snapped ? Math.round(raw / ROTATE_STEP) * ROTATE_STEP : raw;
        part.setRotation(new THREE.Quaternion().setFromAxisAngle(A, angle).multiply(q0));
        setActive({ ...state, angle, snapped });
        onChange();
      },
      end() {
        setActive(null);
        onCommit();
      },
    });
  };

  return (
    <group ref={group}>
      <group ref={px}>
        <group ref={rings}>
          {[0, 1, 2].map((axis) => {
            if (active && active.axis !== axis) return null;
            const color = hover === axis || active?.axis === axis ? HOVER_COLOR : AXIS_COLORS[axis];
            return (
              <group key={axis}>
                <Line points={circles[axis]} lineWidth={3} {...handleMaterial(color)} renderOrder={1000} />
                <Line
                  points={circles[axis]}
                  lineWidth={16}
                  transparent
                  opacity={0}
                  depthTest={false}
                  depthWrite={false}
                  userData={{ handle: true }}
                  onPointerDown={start(axis)}
                  onPointerOver={(e) => {
                    e.stopPropagation();
                    setHover(axis);
                  }}
                  onPointerOut={() => setHover((h) => (h === axis ? null : h))}
                />
              </group>
            );
          })}
        </group>
        {active && <RotateScale drag={active} />}
      </group>
    </group>
  );
}

/** Tick marks every 5° (15° long) from the grab point, the swept arc and the angle. */
function RotateScale({ drag }: { drag: RotateDrag }) {
  const { u, v, radius, angle } = drag;
  const at = (a: number, r: number) =>
    u.clone().multiplyScalar(Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r);
  const ticks = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let deg = 0; deg < 360; deg += 5) {
      const a = THREE.MathUtils.degToRad(deg);
      const long = deg % 15 === 0;
      pts.push(at(a, radius + 4), at(a, radius + (long ? 16 : 9)));
    }
    return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [u, v, radius]);
  const arc = useMemo(() => {
    const n = Math.max(2, Math.ceil(Math.abs(angle) / THREE.MathUtils.degToRad(3)));
    const pts = [new THREE.Vector3()];
    for (let i = 0; i <= n; i++) pts.push(at((angle * i) / n, radius - 2));
    pts.push(new THREE.Vector3());
    return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [u, v, radius, angle]);
  const deg = THREE.MathUtils.radToDeg(angle);
  return (
    <group>
      <Line points={ticks} segments lineWidth={1.5} {...handleMaterial("#d8dee9")} renderOrder={1001} />
      {Math.abs(angle) > 1e-6 && <Line points={arc} lineWidth={1.5} {...handleMaterial(HOVER_COLOR)} renderOrder={1001} />}
      <Html position={at(angle, radius + 34)} center className="gizmo-readout">
        {deg >= 0 ? "+" : "−"}
        {Math.abs(deg).toFixed(drag.snapped ? 0 : 1)}°
      </Html>
    </group>
  );
}

/**
 * Lay on face: hover highlights a flat face of the part's convex hull (the
 * faces it can rest on), a click turns the part so that face is on the plate.
 */
export function FaceTool({ part, onChange, onCommit }: GizmoProps) {
  const [faces, setFaces] = useState<number[] | null>(null);
  const highlight = useMemo(() => {
    if (!faces) return null;
    const src = part.hullMesh.geometry.getAttribute("position");
    const positions: number[] = [];
    for (const f of faces)
      for (let k = 0; k < 3; k++) positions.push(src.getX(f * 3 + k), src.getY(f * 3 + k), src.getZ(f * 3 + k));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }, [faces, part]);

  /** Every hull triangle in the same plane as triangle `index`. */
  const coplanar = (index: number) => {
    const ref = part.hullFaces[index];
    const tolerance = Math.max(0.02, part.radius * 1e-4);
    const out: number[] = [];
    part.hullFaces.forEach((f, i) => {
      if (f.normal.dot(ref.normal) > 0.99985 && Math.abs(f.constant - ref.constant) < tolerance) out.push(i);
    });
    return out;
  };

  return (
    <>
      <primitive
        object={part.hullMesh}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          if (e.faceIndex == null) return;
          const index = e.faceIndex;
          if (faces?.includes(index)) return;
          setFaces(coplanar(index));
        }}
        onPointerOut={() => setFaces(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          // A drag (orbiting) isn't a click.
          if (e.delta > 4 || e.faceIndex == null) return;
          e.stopPropagation();
          const normal = part.hullFaces[e.faceIndex].normal.clone().applyQuaternion(part.quaternion);
          const turn = new THREE.Quaternion().setFromUnitVectors(normal, new THREE.Vector3(0, 0, -1));
          part.setRotation(turn.multiply(part.quaternion.clone()));
          setFaces(null);
          onChange();
          onCommit();
        }}
      />
      {highlight && (
        <mesh geometry={highlight} renderOrder={10}>
          <meshBasicMaterial
            color="#ffd23f"
            transparent
            opacity={0.55}
            side={THREE.DoubleSide}
            depthWrite={false}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
          />
        </mesh>
      )}
    </>
  );
}
