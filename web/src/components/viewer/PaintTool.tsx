// Painting on the selected part: filament colours, support enforcers and
// blockers, seam enforcers and blockers, fuzzy skin. The paint lands in
// the model's volumes (web/src/model/paint.ts, the desktop slicers' own
// format), so every copy shows it and the slicer reads it from the 3MF.
//
// Brushes as in the desktop apps: a circle (paints what the view sees
// under it), a sphere (what's within reach in 3D), whole triangles,
// smart fill (a smooth region), bucket fill (a region of one paint), and
// for colours a height range (a band of the model).

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree } from "three-mesh-bvh";
import { BLOCKER, ENFORCER, PaintLayer, type Cursor, type PaintKind } from "../../model/paint";
import type { PaintChange } from "./history";
import type { Brush, PaintSettings } from "./paintSettings";
import { filamentColor, meshInfo, type Part } from "./part";

const BRUSHES: { brush: Brush; label: string; title: string; kinds?: PaintKind[] }[] = [
  { brush: "circle", label: "Circle", title: "Paints what you see under the circle" },
  { brush: "sphere", label: "Sphere", title: "Paints the surface within the sphere, front and back" },
  { brush: "triangle", label: "Triangles", title: "Whole triangles under the circle, no splitting" },
  { brush: "smart", label: "Smart fill", title: "A smooth region: stops at edges sharper than the angle" },
  { brush: "bucket", label: "Fill", title: "The connected region painted like the face you click" },
  { brush: "height", label: "Height range", title: "Everything in a band of heights", kinds: ["color"] },
];

/** What the second button / Shift paints instead: block for enforce, erase otherwise. */
function alternate(kind: PaintKind, state: number): number {
  if ((kind === "supports" || kind === "seam") && state === ENFORCER) return BLOCKER;
  return 0;
}

/** The paint panel: what to paint, with which brush. */
export function PaintControls({
  settings,
  onChange,
  colors,
  filamentCount,
  onClear,
}: {
  settings: PaintSettings;
  onChange: (s: PaintSettings) => void;
  colors: string[];
  filamentCount: number;
  onClear: () => void;
}) {
  const set = (patch: Partial<PaintSettings>) => onChange({ ...settings, ...patch });
  const { kind } = settings;
  const states: { state: number; label: string; color?: string }[] =
    kind === "color"
      ? Array.from({ length: filamentCount }, (_, i) => ({ state: i + 1, label: String(i + 1), color: filamentColor(colors, i + 1) }))
      : kind === "fuzzy"
        ? [{ state: 1, label: "Fuzzy", color: "#f0883e" }]
        : [
            { state: ENFORCER, label: "Enforce", color: kind === "seam" ? "#58a6ff" : "#3fb950" },
            { state: BLOCKER, label: "Block", color: "#f85149" },
          ];
  return (
    <div className="placement-panel paint-panel">
      <div className="placement-row">
        <span className="placement-label">{kind === "color" ? "Filament" : "Paint"}</span>
        <div className="paint-states">
          {states.map((s) => (
            <button
              key={s.state}
              className={`btn-sm ${settings.state === s.state ? "active" : ""}`}
              onClick={() => set({ state: s.state })}
              title={kind === "color" ? `Paint filament ${s.state}` : s.label}
            >
              {s.color && <span className="filament-swatch" style={{ background: s.color }} aria-hidden />}
              {s.label}
            </button>
          ))}
          <button className={`btn-sm ${settings.state === 0 ? "active" : ""}`} onClick={() => set({ state: 0 })} title="Erase paint">
            Erase
          </button>
        </div>
      </div>
      <div className="placement-row">
        <span className="placement-label">Brush</span>
        <div className="paint-states">
          {BRUSHES.filter((b) => !b.kinds || b.kinds.includes(kind)).map((b) => (
            <button
              key={b.brush}
              className={`btn-sm ${settings.brush === b.brush ? "active" : ""}`}
              onClick={() => set({ brush: b.brush })}
              title={b.title}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
      {(settings.brush === "circle" || settings.brush === "sphere" || settings.brush === "triangle" || settings.brush === "height") && (
        <label className="placement-row">
          <span className="placement-label">{settings.brush === "height" ? "Band" : "Size"}</span>
          <input
            type="range"
            min={0.2}
            max={30}
            step={0.1}
            value={settings.radius}
            onChange={(e) => set({ radius: Number(e.target.value) })}
          />
          <span className="placement-unit">{settings.radius.toFixed(1)} mm</span>
        </label>
      )}
      {(settings.brush === "smart" || settings.brush === "bucket") && (
        <label className="placement-row">
          <span className="placement-label">Angle</span>
          <input type="range" min={1} max={90} step={1} value={settings.angle} onChange={(e) => set({ angle: Number(e.target.value) })} />
          <span className="placement-unit">{settings.angle}°</span>
        </label>
      )}
      {kind === "supports" && (
        <label className="placement-row" title="Only faces hanging over more than this get paint">
          <span className="placement-label">Overhangs</span>
          <input
            type="range"
            min={0}
            max={89}
            step={1}
            value={settings.overhangDeg}
            onChange={(e) => set({ overhangDeg: Number(e.target.value) })}
          />
          <span className="placement-unit">{settings.overhangDeg ? `${settings.overhangDeg}°` : "any face"}</span>
        </label>
      )}
      <div className="placement-row paint-hint">
        {settings.brush === "smart" || settings.brush === "bucket" ? "Click a face" : "Drag on the part"} ·{" "}
        {kind === "supports" || kind === "seam" ? "Shift: block" : "Shift: erase"} · right-drag turns the view
        <button className="btn-sm btn-ghost" onClick={onClear} title="Remove this kind of paint from the model">
          Clear
        </button>
      </div>
    </div>
  );
}

/** Painted volume meshes of a part (model parts only), with fast raycasts. */
function paintable(part: Part): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  part.content.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const info = meshInfo(mesh);
    if (!mesh.isMesh || info?.role !== "volume" || info.volumeType !== "part") return;
    const geo = mesh.geometry as THREE.BufferGeometry & { boundsTree?: unknown };
    if (!geo.boundsTree) (computeBoundsTree as (this: THREE.BufferGeometry) => void).call(geo);
    mesh.raycast = acceleratedRaycast;
    out.push(mesh);
  });
  return out;
}

/**
 * Pointer handling for painting the selected part, and the brush cursor.
 * Left drag paints (Shift: block or erase); orbiting stays on the right and
 * middle buttons and on empty space.
 */
export function PaintSurface({
  part,
  settings,
  current,
  onStroke,
}: {
  part: Part;
  /** The settings to draw the cursor with. */
  settings: PaintSettings;
  /**
   * The settings as they are this moment: the viewer keeps it up to date.
   * (The 3D view is a React root of its own and gets new props a frame
   * later; a stroke started right after a key press would paint the old
   * kind.)
   */
  current: { readonly current: PaintSettings };
  /** A stroke ended: what it changed (for undo). */
  onStroke: (change: PaintChange) => void;
}) {
  const { gl, camera, get } = useThree();
  const meshes = useMemo(() => paintable(part), [part]);
  const cursor = useRef<THREE.Mesh>(null);
  const [hover, setHover] = useState<{ point: THREE.Vector3; normal: THREE.Vector3 } | null>(null);
  const settingsRef = current;
  const strokeRef = useRef(onStroke);
  useEffect(() => {
    strokeRef.current = onStroke;
  });
  /** Painted since the last frame: `volumeId:kind`. */
  const dirty = useRef(new Set<string>());

  // Draw what changed once per frame (a stroke paints many times a frame).
  useFrame(() => {
    if (dirty.current.size === 0) return;
    for (const key of dirty.current) {
      const [id, kind] = key.split(":");
      part.shape.refreshPaint(id, kind as PaintKind);
    }
    dirty.current.clear();
  });

  useEffect(() => {
    const el = gl.domElement;
    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true;
    const ndc = new THREE.Vector2();
    const toNdc = (ev: PointerEvent, out: THREE.Vector2) => {
      const r = el.getBoundingClientRect();
      return out.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    };
    const hit = (at: THREE.Vector2) => {
      raycaster.setFromCamera(at, camera);
      return raycaster.intersectObjects(meshes, false)[0] ?? null;
    };

    // A stroke keeps the settings it started with to its end.
    let stroke: {
      before: Map<string, PaintLayer | undefined>;
      state: number;
      last: THREE.Vector2;
      settings: PaintSettings;
    } | null = null;

    const paintAt = (h: THREE.Intersection, state: number, first: boolean) => {
      if (!stroke) return;
      const s = stroke.settings;
      const info = meshInfo(h.object);
      const volume = part.shape.object.volumes.find((v) => v.id === info?.volumeId);
      if (!volume || h.faceIndex == null) return;
      if (!stroke.before.has(volume.id)) stroke.before.set(volume.id, volume.paint[s.kind]?.clone());
      let layer = volume.paint[s.kind];
      if (!layer) {
        layer = new PaintLayer(volume.mesh);
        volume.paint[s.kind] = layer;
      }
      const trafo = Float64Array.from(h.object.matrixWorld.elements);
      const p = h.point;
      const dir = raycaster.ray.direction;
      let c: Cursor;
      switch (s.brush) {
        case "smart":
          if (first) layer.smartFill(h.faceIndex, s.angle, state);
          break;
        case "bucket":
          if (first) layer.bucketFill(h.faceIndex, state, s.angle < 90 ? s.angle : undefined);
          break;
        case "height":
          c = { kind: "height", z0: p.z - s.radius / 2, z1: p.z + s.radius / 2 };
          layer.brush(h.faceIndex, c, state, trafo);
          break;
        default:
          c = {
            kind: s.brush === "sphere" ? "sphere" : "circle",
            center: [p.x, p.y, p.z],
            radius: s.radius,
            dir: [dir.x, dir.y, dir.z],
          };
          layer.brush(h.faceIndex, c, state, trafo, {
            splitting: s.brush !== "triangle",
            overhangDeg: s.kind === "supports" ? s.overhangDeg : 0,
          });
      }
      dirty.current.add(`${volume.id}:${s.kind}`);
    };

    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      const at = toNdc(ev, new THREE.Vector2());
      const h = hit(at);
      if (!h) return;
      // Ours: the camera stays put while painting.
      const controls = get().controls as unknown as { enabled: boolean } | null;
      if (controls) controls.enabled = false;
      ev.stopPropagation();
      const s = { ...settingsRef.current };
      stroke = { before: new Map(), state: ev.shiftKey ? alternate(s.kind, s.state) : s.state, last: at, settings: s };
      paintAt(h, stroke.state, true);
      el.setPointerCapture(ev.pointerId);
    };

    const onMove = (ev: PointerEvent) => {
      const at = toNdc(ev, ndc.clone());
      if (stroke && (stroke.settings.brush === "smart" || stroke.settings.brush === "bucket")) return;
      if (stroke) {
        // Fill the gap since the last event: stamps a third of the brush apart.
        const s = stroke.settings;
        const h0 = hit(stroke.last);
        const h1 = hit(at);
        const span = h0 && h1 ? h0.point.distanceTo(h1.point) : 0;
        const steps = Math.min(64, Math.max(1, Math.ceil(span / Math.max(0.05, s.radius / 3))));
        for (let i = 1; i <= steps; i++) {
          const h = hit(stroke.last.clone().lerp(at, i / steps));
          if (h) paintAt(h, stroke.state, false);
        }
        stroke.last = at;
      }
      const h = hit(at);
      if (h?.face) {
        const normal = h.face.normal.clone().transformDirection(h.object.matrixWorld);
        setHover({ point: h.point.clone(), normal });
      } else setHover(null);
    };

    const onUp = (ev: PointerEvent) => {
      if (!stroke) return;
      const controls = get().controls as unknown as { enabled: boolean } | null;
      if (controls) controls.enabled = true;
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      const kind = stroke.settings.kind;
      const change: PaintChange = {
        shape: part.shape,
        layers: [...stroke.before].map(([volumeId, before]) => {
          const volume = part.shape.object.volumes.find((v) => v.id === volumeId);
          const after = volume?.paint[kind];
          if (volume && after?.empty) delete volume.paint[kind];
          return { volumeId, kind, before, after: after && !after.empty ? after.clone() : undefined };
        }),
      };
      stroke = null;
      for (const l of change.layers) part.shape.refreshPaint(l.volumeId, kind);
      strokeRef.current(change);
    };

    // Capture phase: ahead of the camera controls' own listener.
    el.addEventListener("pointerdown", onDown, { capture: true });
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    const onLeave = () => setHover(null);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointerdown", onDown, { capture: true });
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("pointerleave", onLeave);
      const controls = get().controls as unknown as { enabled: boolean } | null;
      if (controls) controls.enabled = true;
    };
  }, [gl, camera, get, meshes, part, settingsRef]);

  // The cursor: a ring on the surface (circle), a ball (sphere), a slab
  // (height range); fills show nothing but the pointer.
  const s = settings;
  if (!hover || s.brush === "smart" || s.brush === "bucket") return null;
  const color = s.state === 0 ? "#ffffff" : s.kind === "color" ? "#ffd23f" : "#ffffff";
  if (s.brush === "height")
    return (
      <mesh position={[hover.point.x, hover.point.y, hover.point.z]} renderOrder={20}>
        <boxGeometry args={[part.radius * 2.2, part.radius * 2.2, s.radius]} />
        <meshBasicMaterial color={color} transparent opacity={0.15} depthWrite={false} />
      </mesh>
    );
  if (s.brush === "sphere")
    return (
      <mesh position={hover.point} renderOrder={20}>
        <sphereGeometry args={[s.radius, 24, 16]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={0.5} depthWrite={false} />
      </mesh>
    );
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), hover.normal);
  return (
    <mesh ref={cursor} position={hover.point.clone().addScaledVector(hover.normal, 0.05)} quaternion={q} renderOrder={20}>
      <ringGeometry args={[Math.max(0, s.radius - Math.max(0.08, s.radius * 0.06)), s.radius, 48]} />
      <meshBasicMaterial color={color} side={THREE.DoubleSide} depthTest={false} transparent opacity={0.9} />
    </mesh>
  );
}
