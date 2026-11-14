// The measure tool (U): click two points on the parts for the distance
// between them (and along X, Y and Z), snapping to a corner of the face
// under the pointer; or two faces for their angle, and how far apart they
// are when parallel. One point alone shows where it is and its height.

import { useMemo } from "react";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { measure, type MeasureMode, type MeasurePoint } from "./measure";

const fmt = (v: number) => (Math.abs(v) < 0.005 ? "0.00" : v.toFixed(2));

/** The picked points, the line between them and its legs along X, Y and Z, in the view. */
export function MeasureMarks({ points, mode }: { points: MeasurePoint[]; mode: MeasureMode }) {
  const result = measure(points, mode);
  const legs = useMemo(() => {
    if (points.length < 2 || mode !== "points") return null;
    const [a, b] = points.map((p) => p.at);
    return [a, new THREE.Vector3(b.x, a.y, a.z), new THREE.Vector3(b.x, b.y, a.z), b];
  }, [points, mode]);
  return (
    <>
      {points.map((p, i) => (
        <group key={i}>
          <mesh position={p.at} renderOrder={1002}>
            <sphereGeometry args={[0.9, 16, 12]} />
            <meshBasicMaterial color={p.corner ? "#ffffff" : "#ffd23f"} depthTest={false} transparent />
          </mesh>
          {mode === "faces" && (
            <Line
              points={[p.at, p.at.clone().addScaledVector(p.normal, 8)]}
              color="#58a6ff"
              lineWidth={2}
              depthTest={false}
              transparent
              renderOrder={1002}
            />
          )}
        </group>
      ))}
      {points.length === 2 && (
        <Line points={[points[0].at, points[1].at]} color="#ffd23f" lineWidth={2.5} depthTest={false} transparent renderOrder={1002} />
      )}
      {legs && (
        <>
          {[0, 1, 2].map((k) => (
            <Line
              key={k}
              points={[legs[k], legs[k + 1]]}
              color={["#e5484d", "#46a758", "#3e7bff"][k]}
              lineWidth={1.5}
              dashed
              dashSize={2}
              gapSize={1.5}
              depthTest={false}
              transparent
              renderOrder={1001}
            />
          ))}
        </>
      )}
      {result && (
        <Html position={points[0].at.clone().lerp(points[1].at, 0.5)} center className="gizmo-readout">
          {result.gap !== null
            ? `${fmt(result.gap)} mm apart`
            : result.angle !== null
              ? `${result.angle.toFixed(1)}°`
              : `${fmt(result.distance)} mm`}
        </Html>
      )}
    </>
  );
}

/** The measure panel (in the placement panel's place): the mode and the numbers. */
export function MeasureControls({
  points,
  mode,
  onMode,
  onClear,
  origin,
}: {
  points: MeasurePoint[];
  mode: MeasureMode;
  onMode: (m: MeasureMode) => void;
  onClear: () => void;
  /** The bed's centre in slicer coordinates (the panel shows those). */
  origin: { x: number; y: number };
}) {
  const result = measure(points, mode);
  const where = (p: THREE.Vector3) => `${fmt(p.x + origin.x)}, ${fmt(p.y + origin.y)}, ${fmt(p.z)}`;
  return (
    <div className="placement-panel paint-panel measure-panel">
      <div className="placement-row">
        <span className="placement-label">Measure</span>
        <div className="paint-states">
          {(["points", "faces"] as const).map((m) => (
            <button
              key={m}
              className={`btn-sm ${mode === m ? "active" : ""}`}
              onClick={() => onMode(m)}
              title={m === "points" ? "Between two points (snaps to corners; Shift: no snap)" : "Between two faces: their angle, or the gap between parallel ones"}
            >
              {m === "points" ? "Points" : "Faces"}
            </button>
          ))}
        </div>
        {points.length > 0 && (
          <button className="btn-sm btn-ghost" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {points.length === 0 && <div className="paint-hint">Click a {mode === "points" ? "point" : "face"} on a part</div>}
      {points.map((p, i) => (
        <div className="placement-row measure-row" key={i}>
          <span className="placement-label">{"AB"[i]}</span>
          <span>
            {where(p.at)} mm{p.corner ? " (corner)" : ""}
          </span>
        </div>
      ))}
      {points.length === 1 && <div className="paint-hint">Now the second {mode === "points" ? "point" : "face"}</div>}
      {result && mode === "points" && (
        <>
          <div className="placement-row measure-row measure-result">
            <span className="placement-label">Distance</span>
            <span>{fmt(result.distance)} mm</span>
          </div>
          <div className="placement-row measure-row">
            <span className="placement-label">Along</span>
            <span>
              X {fmt(Math.abs(result.delta.x))} · Y {fmt(Math.abs(result.delta.y))} · Z {fmt(Math.abs(result.delta.z))} mm
            </span>
          </div>
        </>
      )}
      {result && mode === "faces" && (
        <div className="placement-row measure-row measure-result">
          <span className="placement-label">{result.gap !== null ? "Apart" : "Angle"}</span>
          <span>
            {result.gap !== null
              ? `${fmt(result.gap)} mm (parallel faces)`
              : `${result.angle!.toFixed(1)}° between the faces · points ${fmt(result.distance)} mm apart`}
          </span>
        </div>
      )}
      {points.length === 2 && <div className="paint-hint">Click again to start over</div>}
    </div>
  );
}
