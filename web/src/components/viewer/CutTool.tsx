// The cut tool: a plane through the selected part (height and tilt), what
// to keep, whether to turn the upper half onto its cut face, and
// connectors so the halves fit back together (plugs, or dowels with pins
// of their own, with a gap for glue). The cut itself is
// web/src/model/cut.ts; ModelViewer puts the halves on the plate.

import { useMemo, useRef, useState } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import type { ConnectorKind, ConnectorShape } from "../../model/cut";
import { cutNormal, cutPivot, type CutSettings } from "./cutSettings";
import { toScreen, useDrag, worldPerPixel } from "./drag";
import type { Part } from "./part";

const PLANE_COLOR = "#ffd23f";
const HOVER_COLOR = "#ffffff";
const ARROW_PX = 80;
const RING_PX = 95;
/** Snaps while dragging (Shift: free). */
const MOVE_SNAP = 0.5; // mm
const TILT_SNAP = 5; // degrees

const handle = (color: string) => ({ color, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });

/** Unit circle about `axis`, and the basis of its plane (u × v = axis). */
function ring(axis: THREE.Vector3, segments = 96) {
  const u = new THREE.Vector3(1, 0, 0).cross(axis).lengthSq() > 1e-6 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  u.addScaledVector(axis, -u.dot(axis)).normalize();
  const v = axis.clone().cross(u);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a)));
  }
  return pts;
}

/**
 * The plane drawn through the part, where the connectors would go, and its
 * handles: the arrow moves it along its normal, the rings tilt it (about
 * the scene's X and Y, like the Tilt fields).
 */
export function CutPlane({
  part,
  settings,
  points,
  onSettings,
}: {
  part: Part;
  settings: CutSettings;
  points: THREE.Vector3[];
  onSettings: (s: CutSettings) => void;
}) {
  const drag = useDrag();
  const { camera, size: viewport, gl } = useThree();
  const [hover, setHover] = useState<string | null>(null);
  const [readout, setReadout] = useState<string | null>(null);
  const box = part.worldBox();
  const extent = box.getSize(new THREE.Vector3());
  const span = Math.max(extent.x, extent.y, extent.z) * 1.6 + 10;
  const pivot = cutPivot(settings, part.center.x, part.center.y);
  const normal = cutNormal(settings);
  const q = useMemo(
    () => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), cutNormal(settings)),
    [settings],
  );
  // The tilt rings: about the scene's Y, and about X as turned by the Y tilt.
  const axes = useMemo(() => {
    const y = new THREE.Vector3(0, 1, 0);
    const x = new THREE.Vector3(1, 0, 0).applyAxisAngle(y, THREE.MathUtils.degToRad(settings.tiltY));
    return { x, y, ringX: ring(x), ringY: ring(y) };
  }, [settings.tiltY]);
  // Handles stay the same size on screen.
  const px = useRef<THREE.Group>(null);
  useFrame(() => {
    px.current?.scale.setScalar(worldPerPixel(camera, pivot, viewport.height));
  });

  /** Move along the normal: the height while the plane is mostly flat, else the shift. */
  const startMove = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return;
    const s0 = settings;
    const p0 = pivot.clone();
    const n = normal.clone();
    const view = camera.getWorldDirection(new THREE.Vector3());
    const facing = view.clone().addScaledVector(n, -view.dot(n));
    if (facing.lengthSq() < 1e-6) return;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing.normalize(), p0);
    const hit = new THREE.Vector3();
    if (!e.ray.intersectPlane(plane, hit)) return;
    const t0 = hit.clone().sub(p0).dot(n);
    setHover("move");
    drag(e, {
      move(ray, ev) {
        if (!ray.intersectPlane(plane, hit)) return;
        let t = hit.clone().sub(p0).dot(n) - t0;
        if (!ev.shiftKey) t = Math.round(t / MOVE_SNAP) * MOVE_SNAP;
        const next =
          Math.abs(n.z) >= 0.5
            ? { ...s0, height: Math.max(0, Math.round((s0.height + t / n.z) * 100) / 100) }
            : { ...s0, shift: Math.round((s0.shift + t) * 100) / 100 };
        setReadout(`${t >= 0 ? "+" : "−"}${Math.abs(t).toFixed(1)} mm`);
        onSettings(next);
      },
      end() {
        setHover(null);
        setReadout(null);
      },
    });
  };

  /** Tilt about `axis` (the X ring or the Y ring). */
  const startTilt = (which: "x" | "y") => (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return;
    const s0 = settings;
    const A = which === "x" ? axes.x : axes.y;
    const centre = pivot.clone();
    const u = e.point.clone().sub(centre);
    u.addScaledVector(A, -u.dot(A));
    if (u.lengthSq() < 1e-9) return;
    u.normalize();
    const v = A.clone().cross(u);
    const rect = gl.domElement.getBoundingClientRect();
    const toCentre = centre.clone().sub(camera.position).normalize();
    const facing = Math.abs(toCentre.dot(A)) > 0.3;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(A, centre);
    const wpp = worldPerPixel(camera, centre, viewport.height);
    const grab = centre.clone().addScaledVector(u, RING_PX * wpp);
    const tangent = toScreen(grab.clone().addScaledVector(v, RING_PX * wpp * 0.05), camera, rect)
      .sub(toScreen(grab, camera, rect))
      .normalize();
    const pointer0 = new THREE.Vector2(e.nativeEvent.clientX - rect.left, e.nativeEvent.clientY - rect.top);
    const hit = new THREE.Vector3();
    let raw = 0;
    let last = 0;
    setHover(which);
    drag(e, {
      move(ray, ev) {
        if (facing) {
          if (!ray.intersectPlane(plane, hit)) return;
          const r = hit.sub(centre);
          const a = Math.atan2(r.dot(v), r.dot(u));
          let d = a - last;
          if (d > Math.PI) d -= 2 * Math.PI;
          if (d < -Math.PI) d += 2 * Math.PI;
          raw += d;
          last = a;
        } else {
          const p = new THREE.Vector2(ev.clientX - rect.left, ev.clientY - rect.top).sub(pointer0);
          raw = p.dot(tangent) / RING_PX;
        }
        let deg = THREE.MathUtils.radToDeg(raw);
        if (!ev.shiftKey) deg = Math.round(deg / TILT_SNAP) * TILT_SNAP;
        const key = which === "x" ? "tiltX" : "tiltY";
        const value = THREE.MathUtils.clamp(Math.round((s0[key] + deg) * 10) / 10, -90, 90);
        setReadout(`${which.toUpperCase()} ${value.toFixed(ev.shiftKey ? 1 : 0)}°`);
        onSettings({ ...s0, [key]: value });
      },
      end() {
        setHover(null);
        setReadout(null);
      },
    });
  };

  const hoverProps = (name: string) => ({
    userData: { handle: true },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      setHover(name);
    },
    onPointerOut: () => setHover((h) => (h === name ? null : h)),
  });

  return (
    <>
      <mesh position={pivot} quaternion={q} renderOrder={15}>
        <planeGeometry args={[span, span]} />
        <meshBasicMaterial color={PLANE_COLOR} transparent opacity={0.22} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <lineSegments position={pivot} quaternion={q} renderOrder={16}>
        <edgesGeometry args={[new THREE.PlaneGeometry(span, span)]} />
        <lineBasicMaterial color={PLANE_COLOR} />
      </lineSegments>
      {points.map((p, i) => (
        <mesh key={i} position={p} renderOrder={17}>
          <sphereGeometry args={[Math.max(0.8, settings.connector.size / 2), 16, 12]} />
          <meshBasicMaterial color="#58a6ff" depthTest={false} transparent opacity={0.85} />
        </mesh>
      ))}
      <group position={pivot}>
        <group ref={px}>
          {/* The arrow along the normal (both ways: the plane moves either side). */}
          <group quaternion={q}>
            <Line points={[[0, 0, -ARROW_PX], [0, 0, ARROW_PX]]} lineWidth={3} {...handle(hover === "move" ? HOVER_COLOR : PLANE_COLOR)} renderOrder={1000} />
            {[1, -1].map((dir) => (
              <mesh key={dir} position={[0, 0, dir * (ARROW_PX + 7)]} rotation={[dir > 0 ? Math.PI / 2 : -Math.PI / 2, 0, 0]} renderOrder={1000}>
                <coneGeometry args={[6, 16, 20]} />
                <meshBasicMaterial {...handle(hover === "move" ? HOVER_COLOR : PLANE_COLOR)} />
              </mesh>
            ))}
            <mesh rotation={[Math.PI / 2, 0, 0]} onPointerDown={startMove} {...hoverProps("move")}>
              <cylinderGeometry args={[10, 10, 2 * ARROW_PX + 30, 8]} />
              <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
            </mesh>
          </group>
          {(["x", "y"] as const).map((which) => {
            const color = hover === which ? HOVER_COLOR : which === "x" ? "#e5484d" : "#46a758";
            const pts = (which === "x" ? axes.ringX : axes.ringY).map((p) => p.clone().multiplyScalar(RING_PX));
            return (
              <group key={which}>
                <Line points={pts} lineWidth={3} {...handle(color)} renderOrder={1000} />
                <Line
                  points={pts}
                  lineWidth={16}
                  transparent
                  opacity={0}
                  depthTest={false}
                  depthWrite={false}
                  onPointerDown={startTilt(which)}
                  {...hoverProps(which)}
                />
              </group>
            );
          })}
          {readout && (
            <Html position={[0, 0, RING_PX + 30]} center className="gizmo-readout">
              {readout}
            </Html>
          )}
        </group>
      </group>
    </>
  );
}

function Num({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="placement-row">
      <span className="placement-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <input
        className="object-number"
        type="number"
        step={step}
        value={Number(value.toFixed(2))}
        onChange={(e) => Number.isFinite(Number(e.target.value)) && onChange(Number(e.target.value))}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <span className="placement-unit">{unit}</span>
    </label>
  );
}

const CONNECTORS: { kind: ConnectorKind; label: string; title: string }[] = [
  { kind: "plug", label: "Plugs", title: "A peg on the lower half fits a hole in the upper" },
  { kind: "dowel", label: "Dowels", title: "Holes in both halves and pins to print" },
  { kind: "snap", label: "Snaps", title: "A split peg with a bulb that clicks into its socket: no glue needed" },
  {
    kind: "dovetail",
    label: "Dovetails",
    title: "A key across the cut face: the upper half slides onto it from the side and can't be pulled off",
  },
];

/** The cut panel (in the placement panel's place). */
export function CutControls({
  settings,
  onChange,
  maxHeight,
  onCut,
  onCutToFit,
  canConnect,
}: {
  settings: CutSettings;
  onChange: (s: CutSettings) => void;
  /** The part's height on the plate (mm). */
  maxHeight: number;
  onCut: () => void;
  /** Cut into as many pieces as it takes to fit the printer (null: it fits). */
  onCutToFit: (() => void) | null;
  /** Both halves are kept: connectors make sense. */
  canConnect: boolean;
}) {
  const set = (patch: Partial<CutSettings>) => onChange({ ...settings, ...patch });
  const c = settings.connector;
  const setC = (patch: Partial<typeof c>) => set({ connector: { ...c, ...patch } });
  return (
    <div className="placement-panel paint-panel cut-panel">
      <Num label="Height" value={settings.height} min={0} max={Math.max(1, maxHeight)} step={0.1} unit="mm" onChange={(height) => set({ height })} />
      <Num label="Tilt X" value={settings.tiltX} min={-90} max={90} step={1} unit="°" onChange={(tiltX) => set({ tiltX })} />
      <Num label="Tilt Y" value={settings.tiltY} min={-90} max={90} step={1} unit="°" onChange={(tiltY) => set({ tiltY })} />
      {(Math.abs(cutNormal(settings).z) < 0.5 || settings.shift !== 0) && (
        <Num
          label="Shift"
          value={settings.shift}
          min={-Math.max(1, maxHeight)}
          max={Math.max(1, maxHeight)}
          step={0.1}
          unit="mm"
          onChange={(shift) => set({ shift })}
        />
      )}
      <div className="placement-row">
        <span className="placement-label">Keep</span>
        <div className="paint-states">
          {(["both", "upper", "lower"] as const).map((k) => (
            <button key={k} className={`btn-sm ${settings.keep === k ? "active" : ""}`} onClick={() => set({ keep: k })}>
              {k === "both" ? "Both halves" : k === "upper" ? "Upper" : "Lower"}
            </button>
          ))}
        </div>
      </div>
      <label className="placement-row placement-check">
        <input type="checkbox" checked={settings.layUpper} onChange={(e) => set({ layUpper: e.target.checked })} />
        Turn the upper half onto its cut face
      </label>
      {canConnect && (
        <>
          <div className="placement-row">
            <span className="placement-label">Connect</span>
            <div className="paint-states">
              <button className={`btn-sm ${settings.count === 0 ? "active" : ""}`} onClick={() => set({ count: 0 })}>
                None
              </button>
              {CONNECTORS.map(({ kind: k, label, title }) => (
                <button
                  key={k}
                  className={`btn-sm ${settings.count > 0 && c.kind === k ? "active" : ""}`}
                  onClick={() => set({ count: settings.count || 1, connector: { ...c, kind: k } })}
                  title={title}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {settings.count > 0 && (
            <>
              {(c.kind === "plug" || c.kind === "dowel") && (
              <div className="placement-row">
                <span className="placement-label">Shape</span>
                <div className="paint-states">
                  {(["round", "square", "hexagon"] as ConnectorShape[]).map((sh) => (
                    <button key={sh} className={`btn-sm ${c.shape === sh ? "active" : ""}`} onClick={() => setC({ shape: sh })}>
                      {sh[0].toUpperCase() + sh.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              )}
              <Num label="How many" value={settings.count} min={1} max={6} step={1} unit="" onChange={(count) => set({ count: Math.round(count) })} />
              <Num
                label={c.kind === "dovetail" ? "Width" : "Size"}
                value={c.size}
                min={1}
                max={30}
                step={0.5}
                unit="mm"
                onChange={(size) => setC({ size })}
              />
              <Num
                label={c.kind === "dovetail" ? "Height" : "Depth"}
                value={c.depth}
                min={1}
                max={30}
                step={0.5}
                unit="mm"
                onChange={(depth) => setC({ depth })}
              />
              <Num label="Glue gap" value={c.gap} min={0} max={1} step={0.05} unit="mm" onChange={(gap) => setC({ gap })} />
            </>
          )}
        </>
      )}
      <div className="placement-row">
        <button className="btn-sm btn-accent" onClick={onCut}>
          Cut
        </button>
        {onCutToFit && (
          <button
            className="btn-sm"
            onClick={onCutToFit}
            title="Too big for the printer: cut it into as few pieces as fit, with these connectors"
          >
            Cut to fit
          </button>
        )}
        <span className="paint-hint">
          Drag the arrow to move the plane, the rings to tilt it · every copy of the model is cut · Esc leaves the tool
        </span>
      </div>
    </div>
  );
}
