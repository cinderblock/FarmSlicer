// The slice taking shape while it's sliced (plans/live-slice-preview.md):
// each object's outlines, then walls, infill and supports as libslic3r
// finishes them (liveSlice.ts builds what to draw), on the printer's bed,
// with the progress. While the G-code is written, the layers it has reached
// show in full and the rest faintly. The finished slice's G-code preview
// takes its place.
//
// Frames come from the browser engine (the page hands them in) or, for a
// server slice, from `GET /api/jobs/{id}/live` (useLiveSlice.ts).

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import Bed from "../viewer/Bed";
import { DEFAULT_BED, sceneBed, type Bed as BedShape, type SceneBed } from "../viewer/part";
import { toolColors } from "./colors";
import { STEP_NAMES, exportLayer, messagePlate, type LiveSlice } from "./liveSlice";
import { Toolpaths, type ViewRange } from "./scene";
import type { ParsedGcode } from "./types";

/** Rebuilds of the view at most this often while frames pour in (ms). */
const REBUILD_MS = 250;

/** `value`, changing at most every `ms` (the last change always lands). */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = last.current + ms - performance.now();
    const t = window.setTimeout(
      () => {
        last.current = performance.now();
        setShown(value);
      },
      Math.max(0, wait),
    );
    return () => clearTimeout(t);
  }, [value, ms]);
  return shown;
}

export interface LiveSlicePreviewProps {
  /** The frames so far (useLiveSlice.ts). */
  live: LiveSlice;
  bed?: BedShape | null;
  /** The slice's progress (percent, message). */
  percent: number;
  message: string | null;
  /** "Waiting for the slicer…" etc. */
  title: string;
  filamentColors?: string[];
  className?: string;
}

export default function LiveSlicePreview({ live: latest, bed, percent, message, title, filamentColors, className }: LiveSlicePreviewProps) {
  const live = useThrottled(latest, REBUILD_MS);
  const plates = useMemo(() => live.plates(), [live]);
  // The plate being sliced (its message says), else the last with frames.
  const said = messagePlate(message);
  const plate = plates.includes(said) ? said : (plates[plates.length - 1] ?? said);
  const parsed = useMemo(() => live.build(plate), [live, plate]);
  const { objects, steps } = useMemo(() => live.steps(plate), [live, plate]);
  const shape = useMemo(() => sceneBed(bed ?? DEFAULT_BED), [bed]);
  const exporting = exportLayer(message);

  return (
    <div className={`live-slice ${className ?? ""}`}>
      <div className="gp-viewport live-slice-viewport">
        <Canvas frameloop="demand" camera={{ position: [0, -330, 260], up: [0, 0, 1], fov: 45, near: 0.5, far: 5000 }} dpr={[1, 2]}>
          <LiveScene parsed={parsed} bed={shape} exporting={exporting} filamentColors={filamentColors} />
        </Canvas>
        <div className="gp-readout">
          <strong>{title}</strong>
          {plates.length > 1 && <span>Plate {plate}</span>}
          {parsed && <span>{parsed.layers.count} layers</span>}
        </div>
        <ul className="live-slice-steps" aria-label="What's been sliced">
          {steps.map((s) => {
            const done = objects > 0 && s.done >= objects;
            const label = STEP_NAMES[s.step];
            return (
              <li key={s.step} className={done ? "done" : s.done > 0 ? "partial" : ""}>
                <span className="live-slice-mark" aria-hidden>
                  {done ? "✓" : s.done > 0 ? "…" : "·"}
                </span>{" "}
                {label}
                {objects > 1 && s.done > 0 && !done && ` (${s.done}/${objects})`}
                {s.skipped > 0 && <span className="hint"> too detailed to show live</span>}
              </li>
            );
          })}
        </ul>
        <div className="live-slice-progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
          </div>
          <span className="hint">
            {Math.round(percent)}%{message ? ` · ${message}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

function HeadLight() {
  const light = useRef<THREE.DirectionalLight>(null);
  const { camera } = useThree();
  useFrame(() => light.current?.position.copy(camera.position));
  return <directionalLight ref={light} intensity={1.6} />;
}

function LiveScene({
  parsed,
  bed,
  exporting,
  filamentColors,
}: {
  parsed: ParsedGcode | null;
  bed: SceneBed;
  exporting: number | null;
  filamentColors?: string[];
}) {
  const invalidate = useThree((s) => s.invalidate);
  const get = useThree((s) => s.get);
  const controls = useThree((s) => s.controls);
  const toolpaths = useMemo(() => (parsed && parsed.extrusions.count > 0 ? new Toolpaths(parsed) : null), [parsed]);
  useEffect(() => () => toolpaths?.dispose(), [toolpaths]);

  const tools = useMemo(() => (parsed ? toolColors(parsed, filamentColors) : []), [parsed, filamentColors]);
  const count = parsed?.layers.count ?? 0;
  const top = exporting === null ? count - 1 : Math.max(0, Math.min(count - 1, exporting));
  useEffect(() => {
    if (!toolpaths || !parsed) return;
    toolpaths.recolor("feature", tools);
    const view: ViewRange = {
      bottom: 0,
      top,
      upTo: parsed.layers.extrusionStart[top + 1] ?? parsed.extrusions.count,
      hidden: new Set(),
      travel: false,
      retractions: false,
      dim: false,
      ghost: exporting !== null,
    };
    toolpaths.setView(view);
    invalidate();
  }, [toolpaths, parsed, tools, top, exporting, invalidate]);

  // Frame the parts once, when the first of them arrives (later frames
  // only add to them); before that, the whole bed.
  const framed = useRef(false);
  const bounds = parsed?.info.modelBounds ?? null;
  useEffect(() => {
    if (framed.current && bounds) return;
    const { camera } = get();
    const cam = camera as THREE.PerspectiveCamera;
    const box = bounds
      ? new THREE.Box3(new THREE.Vector3(...bounds.min), new THREE.Vector3(...bounds.max)).translate(new THREE.Vector3(-bed.center.x, -bed.center.y, 0))
      : new THREE.Box3(new THREE.Vector3(bed.min.x, bed.min.y, 0), new THREE.Vector3(bed.max.x, bed.max.y, 10));
    if (bounds) {
      // The first layers are low: allow for the part's height to come.
      box.max.z = Math.max(box.max.z, Math.max(box.max.x - box.min.x, box.max.y - box.min.y) * 0.5);
      framed.current = true;
    }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const span = Math.max(bed.max.x - bed.min.x, bed.max.y - bed.min.y);
    const radius = Math.max(sphere.radius * 1.2, span * 0.3, 20);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2));
    cam.position.copy(sphere.center).add(new THREE.Vector3(0, -0.78, 0.62).multiplyScalar(distance));
    cam.lookAt(sphere.center);
    const orbit = controls as unknown as { target: THREE.Vector3; update(): void } | null;
    orbit?.target.copy(sphere.center);
    orbit?.update();
    invalidate();
  }, [bounds, bed, get, controls, invalidate]);

  return (
    <>
      <ambientLight intensity={0.35} />
      <hemisphereLight args={["#ffffff", "#30363d", 0.6]} position={[0, 0, 1]} />
      <HeadLight />
      <Bed bed={bed} />
      {toolpaths && <primitive object={toolpaths.group} position={[-bed.center.x, -bed.center.y, 0]} />}
      <OrbitControls
        makeDefault
        enableDamping={false}
        zoomToCursor
        mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }}
      />
    </>
  );
}
