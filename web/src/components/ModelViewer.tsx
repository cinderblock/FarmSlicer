import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { Placement } from "../engine/types";
import Bed from "./viewer/Bed";
import { FaceTool, MoveGizmo, RotateGizmo } from "./viewer/Gizmo";
import { useBodyDrag, type GizmoProps, type Guide, type Tool } from "./viewer/drag";
import { DEFAULT_BED, Part, sceneBed, type Bed as BedShape, type Fit, type SceneBed } from "./viewer/part";

export type { Fit } from "./viewer/part";
export type { BedShape };

/** Rotation fields: extrinsic X, then Y, then Z (libslic3r's convention). */
const EULER_ORDER = "ZYX";

/** A light that follows the camera, so every view is lit the same way. */
function HeadLight() {
  const light = useRef<THREE.DirectionalLight>(null);
  const { camera } = useThree();
  useFrame(() => light.current?.position.copy(camera.position));
  return <directionalLight ref={light} intensity={1.6} />;
}

/** Look at the whole bed from the front, above; again when the printer changes. */
function FrameBed({ bed }: { bed: SceneBed }) {
  const get = useThree((s) => s.get);
  const controls = useThree((s) => s.controls);
  useEffect(() => {
    const { camera } = get();
    const cam = camera as THREE.PerspectiveCamera;
    const span = Math.max(bed.max.x - bed.min.x, bed.max.y - bed.min.y, bed.height * 0.8);
    const distance = (span * 0.75) / Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 45) / 2);
    const target = new THREE.Vector3(0, 0, Math.min(bed.height, span) * 0.1);
    cam.position.copy(target).add(new THREE.Vector3(0, -0.78, 0.62).multiplyScalar(distance));
    cam.lookAt(target);
    const orbit = controls as unknown as { target: THREE.Vector3; update(): void } | null;
    orbit?.target.copy(target);
    orbit?.update();
  }, [bed, get, controls]);
  return null;
}

function Guides({ guides, bed }: { guides: Guide[]; bed: SceneBed }) {
  return (
    <>
      {guides.map((g) => {
        const a = g.axis === 0 ? [g.value, bed.min.y, 0.1] : [bed.min.x, g.value, 0.1];
        const b = g.axis === 0 ? [g.value, bed.max.y, 0.1] : [bed.max.x, g.value, 0.1];
        return (
          <Line
            key={`${g.axis}:${g.value}`}
            points={[a as [number, number, number], b as [number, number, number]]}
            color="#ffd23f"
            lineWidth={1.5}
            dashed
            dashSize={4}
            gapSize={3}
          />
        );
      })}
    </>
  );
}

function PartView(props: GizmoProps & { tool: Tool; guides: Guide[] }) {
  const { part, bed, tool, guides } = props;
  const bodyDown = useBodyDrag(props);
  return (
    <>
      <primitive object={part.root}>
        <primitive object={part.content} onPointerDown={tool === "flat" ? undefined : bodyDown} />
        {tool === "flat" && <FaceTool {...props} />}
      </primitive>
      {tool === "move" && <MoveGizmo {...props} />}
      {tool === "rotate" && <RotateGizmo {...props} />}
      <Guides guides={guides} bed={bed} />
    </>
  );
}

function Scene({
  part,
  bed,
  tool,
  onChange,
  onCommit,
}: {
  part: Part | null;
  bed: SceneBed;
  tool: Tool;
  onChange: () => void;
  onCommit: () => void;
}) {
  const [guides, setGuides] = useState<Guide[]>([]);
  return (
    <>
      <ambientLight intensity={0.35} />
      <hemisphereLight args={["#ffffff", "#30363d", 0.6]} position={[0, 0, 1]} />
      <HeadLight />
      <Bed bed={bed} />
      <FrameBed bed={bed} />
      {part && (
        <PartView
          part={part}
          bed={bed}
          tool={tool}
          guides={guides}
          onChange={onChange}
          onCommit={onCommit}
          onGuides={setGuides}
        />
      )}
      {/* Direct control, CAD style: no damping (it made the view drift on
          and lag behind the pointer). Left orbits, middle/right pan, the
          wheel zooms towards the pointer. */}
      <OrbitControls
        makeDefault
        enableDamping={false}
        zoomToCursor
        mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }}
      />
    </>
  );
}

/** A number input that shows `value` until edited, then commits on Enter or blur. */
function NumberField({
  value,
  digits,
  disabled,
  onCommit,
  label,
}: {
  value: number;
  digits: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
  label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (Object.is(Math.round(value * 10 ** digits), -0) ? 0 : value).toFixed(digits);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    setDraft(null);
    if (draft.trim() !== "" && Number.isFinite(v)) onCommit(v);
  };
  return (
    <label className="placement-field">
      <span>{label}</span>
      <input
        type="number"
        step="any"
        value={shown}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
          // Keep the viewer's tool keys out of the field.
          e.stopPropagation();
        }}
      />
    </label>
  );
}

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: "move", label: "Move", key: "M" },
  { tool: "rotate", label: "Rotate", key: "R" },
  { tool: "flat", label: "Lay on face", key: "F" },
];

const TOOL_HINTS: Record<Tool, string> = {
  none: "Drag the part to move it",
  move: "Drag an arrow or the part · snaps to 1 mm, the bed's centre and edges · Shift: free",
  rotate: "Drag a ring · snaps to 15° · Shift: free",
  flat: "Click a face to put it on the plate",
};

export default function ModelViewer({
  bed,
  onModelLoaded,
  onPlacementChange,
}: {
  /** The selected printer's bed; a 256 mm bed until there is one. */
  bed?: BedShape | null;
  onModelLoaded?: (file: File) => void;
  /** Where the part is (null: no part) and whether it fits the bed. */
  onPlacementChange?: (placement: Placement | null, fit: Fit) => void;
}) {
  const [part, setPart] = useState<Part | null>(null);
  const [tool, setTool] = useState<Tool>("move");
  const [fit, setFit] = useState<Fit>("inside");
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Re-render the placement panel while a drag moves the part.
  const [, setTick] = useState(0);
  const tickPending = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Keyed on the bed's numbers: the page hands over a new object whenever it
  // re-resolves the profile (a different filament), and a new bed reframes
  // the camera.
  const bedKey = JSON.stringify(bed && bed.area.length >= 3 ? bed : DEFAULT_BED);
  const shape = useMemo(() => sceneBed(JSON.parse(bedKey) as BedShape), [bedKey]);
  const report = useRef(onPlacementChange);
  useEffect(() => {
    report.current = onPlacementChange;
  }, [onPlacementChange]);

  const refresh = useCallback(() => {
    if (!part) return "inside" as Fit;
    const f = part.fit(shape);
    part.showError(f !== "inside");
    setFit(f);
    if (!tickPending.current) {
      tickPending.current = true;
      requestAnimationFrame(() => {
        tickPending.current = false;
        setTick((t) => t + 1);
      });
    }
    return f;
  }, [part, shape]);

  const commit = useCallback(() => {
    if (!part) return;
    report.current?.(part.placement(), refresh());
  }, [part, refresh]);

  // A new part, or a different printer's bed: check the fit again.
  useEffect(() => {
    if (part) commit();
    else report.current?.(null, "inside");
  }, [part, commit]);

  useEffect(() => () => part?.dispose(), [part]);

  const loadFile = useCallback(
    (file: File) => {
      setError("");
      setLoading(true);
      file
        .arrayBuffer()
        .then((data) => {
          const next = Part.load(data, file.name);
          setPart(next);
          setTool("move");
          onModelLoaded?.(file);
        })
        .catch((err) => setError(err instanceof Error ? err.message : "Failed to load model"))
        .finally(() => setLoading(false));
    },
    [onModelLoaded],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) loadFile(file);
    },
    [loadFile],
  );

  const center = useCallback(() => {
    if (!part) return;
    part.setCenter(0, 0);
    commit();
  }, [part, commit]);

  const resetOrientation = useCallback(() => {
    if (!part) return;
    part.setRotation(new THREE.Quaternion());
    commit();
  }, [part, commit]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!part || e.ctrlKey || e.metaKey || e.altKey) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
        return;
      const key = e.key.toLowerCase();
      if (key === "escape") setTool("none");
      const t = TOOLS.find((x) => x.key.toLowerCase() === key);
      if (t) setTool((cur) => (cur === t.tool ? "none" : t.tool));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [part]);

  // Panel values: absolute slicer coordinates, like the desktop slicers show.
  const box = part?.worldBox();
  const sizeMm = box?.getSize(new THREE.Vector3());
  const euler = part ? new THREE.Euler().setFromQuaternion(part.quaternion, EULER_ORDER) : null;
  const setEuler = (axis: "x" | "y" | "z", degrees: number) => {
    if (!part || !euler) return;
    const next = euler.clone();
    next[axis] = THREE.MathUtils.degToRad(degrees);
    part.setRotation(new THREE.Quaternion().setFromEuler(next));
    commit();
  };
  const setPosition = (axis: 0 | 1, absolute: number) => {
    if (!part) return;
    const v = absolute - (axis === 0 ? shape.center.x : shape.center.y);
    part.setCenter(axis === 0 ? v : part.center.x, axis === 1 ? v : part.center.y);
    commit();
  };

  return (
    <div
      className={`model-viewer ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".stl,.3mf"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) loadFile(file);
          e.target.value = "";
        }}
      />

      {!part && (
        <div className="drop-prompt" onClick={() => inputRef.current?.click()}>
          <p>{loading ? "Loading model…" : "Drop a model file here or click to browse"}</p>
          <p className="hint">STL, 3MF</p>
          {error && (
            <p className="hint" style={{ color: "var(--error)" }}>
              {error}
            </p>
          )}
        </div>
      )}

      {part && (
        <div className="viewer-top">
          <div className="viewer-toolbar">
            {TOOLS.map((t) => (
              <button
                key={t.tool}
                className={tool === t.tool ? "active" : ""}
                onClick={() => setTool(tool === t.tool ? "none" : t.tool)}
              >
                {t.label} <kbd>{t.key}</kbd>
              </button>
            ))}
            <span className="toolbar-sep" />
            <button onClick={center}>Center</button>
            <button onClick={resetOrientation}>Reset rotation</button>
            <button onClick={() => inputRef.current?.click()}>{loading ? "Loading…" : "Replace"}</button>
          </div>
          <div className="viewer-hint">{TOOL_HINTS[tool]}</div>
        </div>
      )}

      {part && fit !== "inside" && (
        <div className="viewer-fit-warning">
          {fit === "outside"
            ? "The part is off the build plate."
            : "The part extends beyond the printable area."}{" "}
          It can't be sliced like this.
          <button onClick={center}>Move to center</button>
        </div>
      )}

      {part && box && sizeMm && euler && (
        <div className="placement-panel">
          <div className="placement-row">
            <span className="placement-label">Position</span>
            <NumberField label="X" value={part.center.x + shape.center.x} digits={2} onCommit={(v) => setPosition(0, v)} />
            <NumberField label="Y" value={part.center.y + shape.center.y} digits={2} onCommit={(v) => setPosition(1, v)} />
            <span className="placement-unit">mm</span>
          </div>
          <div className="placement-row">
            <span className="placement-label">Rotation</span>
            {(["x", "y", "z"] as const).map((a) => (
              <NumberField
                key={a}
                label={a.toUpperCase()}
                value={THREE.MathUtils.radToDeg(euler[a])}
                digits={1}
                onCommit={(v) => setEuler(a, v)}
              />
            ))}
            <span className="placement-unit">°</span>
          </div>
          <div className="placement-size">
            Size {sizeMm.x.toFixed(1)} × {sizeMm.y.toFixed(1)} × {sizeMm.z.toFixed(1)} mm
          </div>
        </div>
      )}

      <Canvas camera={{ position: [0, -330, 260], up: [0, 0, 1], fov: 45, near: 1, far: 5000 }}>
        <Scene part={part} bed={shape} tool={tool} onChange={refresh} onCommit={commit} />
      </Canvas>
    </div>
  );
}
