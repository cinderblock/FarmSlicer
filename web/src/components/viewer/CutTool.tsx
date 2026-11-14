// The cut tool: a plane through the selected part (height and tilt), what
// to keep, whether to turn the upper half onto its cut face, and
// connectors so the halves fit back together (plugs, or dowels with pins
// of their own, with a gap for glue). The cut itself is
// web/src/model/cut.ts; ModelViewer puts the halves on the plate.

import { useMemo } from "react";
import * as THREE from "three";
import type { ConnectorKind, ConnectorShape } from "../../model/cut";
import { cutNormal, type CutSettings } from "./cutSettings";
import type { Part } from "./part";

/** The plane drawn through the part, and where the connectors would go. */
export function CutPlane({ part, settings, points }: { part: Part; settings: CutSettings; points: THREE.Vector3[] }) {
  const box = part.worldBox();
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z) * 1.6 + 10;
  const center = new THREE.Vector3(part.center.x, part.center.y, settings.height);
  const q = useMemo(
    () => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), cutNormal(settings)),
    [settings],
  );
  return (
    <>
      <mesh position={center} quaternion={q} renderOrder={15}>
        <planeGeometry args={[span, span]} />
        <meshBasicMaterial color="#ffd23f" transparent opacity={0.22} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <lineSegments position={center} quaternion={q} renderOrder={16}>
        <edgesGeometry args={[new THREE.PlaneGeometry(span, span)]} />
        <lineBasicMaterial color="#ffd23f" />
      </lineSegments>
      {points.map((p, i) => (
        <mesh key={i} position={p} renderOrder={17}>
          <sphereGeometry args={[Math.max(0.8, settings.connector.size / 2), 16, 12]} />
          <meshBasicMaterial color="#58a6ff" depthTest={false} transparent opacity={0.85} />
        </mesh>
      ))}
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

/** The cut panel (in the placement panel's place). */
export function CutControls({
  settings,
  onChange,
  maxHeight,
  onCut,
  canConnect,
}: {
  settings: CutSettings;
  onChange: (s: CutSettings) => void;
  /** The part's height on the plate (mm). */
  maxHeight: number;
  onCut: () => void;
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
              {(["plug", "dowel"] as ConnectorKind[]).map((k) => (
                <button
                  key={k}
                  className={`btn-sm ${settings.count > 0 && c.kind === k ? "active" : ""}`}
                  onClick={() => set({ count: settings.count || 1, connector: { ...c, kind: k } })}
                  title={k === "plug" ? "A peg on the lower half fits a hole in the upper" : "Holes in both halves and pins to print"}
                >
                  {k === "plug" ? "Plugs" : "Dowels"}
                </button>
              ))}
            </div>
          </div>
          {settings.count > 0 && (
            <>
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
              <Num label="How many" value={settings.count} min={1} max={6} step={1} unit="" onChange={(count) => set({ count: Math.round(count) })} />
              <Num label="Size" value={c.size} min={1} max={30} step={0.5} unit="mm" onChange={(size) => setC({ size })} />
              <Num label="Depth" value={c.depth} min={1} max={30} step={0.5} unit="mm" onChange={(depth) => setC({ depth })} />
              <Num label="Glue gap" value={c.gap} min={0} max={1} step={0.05} unit="mm" onChange={(gap) => setC({ gap })} />
            </>
          )}
        </>
      )}
      <div className="placement-row">
        <button className="btn-sm btn-accent" onClick={onCut}>
          Cut
        </button>
        <span className="paint-hint">Every copy of the model is cut · Esc leaves the tool</span>
      </div>
    </div>
  );
}
