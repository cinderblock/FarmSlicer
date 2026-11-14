import { useRef, useState, useCallback, useEffect, useMemo, type SetStateAction } from "react";
import { Canvas, useFrame, useThree, type RootState, type ThreeEvent } from "@react-three/fiber";
import { Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { PlateLayout } from "../engine/types";
import Bed from "./viewer/Bed";
import { FaceTool, MoveGizmo, RotateGizmo } from "./viewer/Gizmo";
import { useBodyDrag, type GizmoProps, type Guide, type Tool } from "./viewer/drag";
import { arrange, arrangeOnPlates, fillCopies, findFreeSpot, overlapping } from "./viewer/layout";

/** Room kept round a piece cut to fit (mm): the skirt, a brim. */
const FIT_MARGIN = 6;
import type { SupportCheck } from "./viewer/overhangs";
import { DEFAULT_BED, Part, PartShape, sceneBed, type Bed as BedShape, type Fit, type SceneBed } from "./viewer/part";
import { applyPaint, History, restore, sameSnapshot, snapshot, type Change, type PlateSnapshot } from "./viewer/history";
import { loadModel, mergeObjects, modelFile } from "../model/load";
import { usedFilaments, type ModelObject } from "../model/document";
import ObjectPanel from "./viewer/ObjectPanel";
import { PaintControls, PaintSurface } from "./viewer/PaintTool";
import { CutControls, CutPlane } from "./viewer/CutTool";
import { MeasureControls, MeasureMarks } from "./viewer/MeasureTool";
import { useMeasurePick, type MeasureMode, type MeasurePoint } from "./viewer/measure";
import { cutNormal, cutPivot, DEFAULT_CUT, type CutSettings } from "./viewer/cutSettings";
import {
  addConnectors,
  connectorPoints,
  cutIntoPieces,
  cutObject,
  cutSection,
  fitPlanes,
  planeInFrame,
  type Plane,
} from "../model/cut";
import { mergeInto, splitToObjects } from "../model/ops";
import { bestOrientation } from "../model/orient";
import { DEFAULT_PAINT, PAINT_TOOLS, type PaintSettings } from "./viewer/paintSettings";
import { ENFORCER, type PaintKind } from "../model/paint";
import type { PaintChange } from "./viewer/history";

export type { Fit } from "./viewer/part";
export type { SupportCheck } from "./viewer/overhangs";
export type { BedShape };

/** Rotation fields: extrinsic X, then Y, then Z (libslic3r's convention). */
const EULER_ORDER = "ZYX";
/** How long a notice ("Added 12 copies") stays up (ms). */
const NOTICE_MS = 4000;
/** A copy's scale limits (src/placement.rs). */
const MIN_SCALE = 0.001;
const MAX_SCALE = 1000;

/** What's on the plates, for the page: the model files and every part on them. */
export interface PlateState {
  /** The models in the order `plates[].objects[].model` indexes them. */
  files: File[];
  /** Every plate with parts, in order (empty plates are left out). */
  plates: PlateLayout[];
  /** The worst of the parts: any part off its plate makes it "outside". */
  fit: Fit;
  /** Some parts overlap each other (on the same plate). */
  overlaps: boolean;
  /** The highest filament any model names (its parts' or painted colours): the job needs at least this many. */
  filaments: number;
}

/** Each model's upload, made again only when the model changed. */
const exported = new WeakMap<PartShape, { version: number; file: File }>();

/** What the job uploads for a model: its STL while untouched, else a 3MF of it as edited. */
function shapeFile(shape: PartShape): File {
  const hit = exported.get(shape);
  if (hit && hit.version === shape.version) return hit.file;
  const file = modelFile(shape.object, shape.source);
  exported.set(shape, { version: shape.version, file });
  return file;
}

/** The worse of two fits. */
function worse(a: Fit, b: Fit): Fit {
  return a === "outside" || b === "outside" ? "outside" : a === "partly" || b === "partly" ? "partly" : "inside";
}

/** How one plate stands. */
interface PlateFacts {
  parts: number;
  fit: Fit;
  overlaps: boolean;
}

/** Every part against the bed and the others on its plate. */
function plateStatus(
  parts: Part[],
  bed: SceneBed,
  plateCount: number,
): { fit: Fit; clash: Set<Part>; fits: Map<Part, Fit>; plates: PlateFacts[] } {
  const clash = new Set<Part>();
  const fits = new Map<Part, Fit>();
  const plates: PlateFacts[] = [];
  let fit: Fit = "inside";
  for (let i = 0; i < plateCount; i++) {
    const on = parts.filter((p) => p.plate === i);
    const overlaps = overlapping(on);
    overlaps.forEach((p) => clash.add(p));
    let plateFit: Fit = "inside";
    for (const p of on) {
      const f = p.fit(bed);
      fits.set(p, f);
      plateFit = worse(plateFit, f);
    }
    plates.push({ parts: on.length, fit: plateFit, overlaps: overlaps.size > 0 });
    fit = worse(fit, plateFit);
  }
  return { fit, clash, fits, plates };
}

/** What the page gets: the models in use, in order, and every part on every plate that has some. */
function plateState(parts: Part[], bed: SceneBed, plateCount: number): PlateState | null {
  if (parts.length === 0) return null;
  const { fit, clash } = plateStatus(parts, bed, plateCount);
  const used: PartShape[] = [];
  for (const p of parts) if (!used.includes(p.shape)) used.push(p.shape);
  const plates: PlateLayout[] = [];
  for (let i = 0; i < plateCount; i++) {
    const objects = parts
      .filter((p) => p.plate === i)
      .map((p) => ({ model: used.indexOf(p.shape), placement: p.placement() }));
    if (objects.length > 0) plates.push({ objects });
  }
  let filaments = 1;
  for (const shape of used) for (const f of usedFilaments(shape.object)) filaments = Math.max(filaments, f);
  return { files: used.map(shapeFile), plates, fit, overlaps: clash.size > 0, filaments };
}

/** A file name without its extension. */
function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/** What's wrong with a plate, in a few words (null: nothing). */
function plateProblem(facts: PlateFacts, many: boolean): string | null {
  if (facts.fit === "outside") return many ? "A part is off the build plate." : "The part is off the build plate.";
  if (facts.fit === "partly")
    return many ? "A part extends beyond the printable area." : "The part extends beyond the printable area.";
  if (facts.overlaps) return "Parts overlap.";
  return null;
}

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

/** The outline of a multiple selection: one box round all of it, on the plate. */
function GroupBox({ parts }: { parts: Part[] }) {
  const line = useRef<THREE.LineSegments>(null);
  useFrame(() => {
    if (!line.current) return;
    const box = new THREE.Box3();
    for (const p of parts) box.union(p.worldBox());
    const size = box.getSize(new THREE.Vector3());
    line.current.position.copy(box.getCenter(new THREE.Vector3()));
    line.current.scale.set(Math.max(size.x, 0.01) + 2, Math.max(size.y, 0.01) + 2, Math.max(size.z, 0.01) + 2);
  });
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), []);
  return (
    <lineSegments ref={line} geometry={edges} renderOrder={20}>
      <lineBasicMaterial color="#58a6ff" depthTest={false} transparent opacity={0.9} />
    </lineSegments>
  );
}

function PartView(
  props: GizmoProps & {
    tool: Tool;
    /** The part the tools act on. */
    selected: boolean;
    painting: boolean;
    /** `additive`: Ctrl/Cmd-click, which adds the part to the selection or takes it out. */
    onSelect: (part: Part, additive: boolean) => void;
    onMeasure: (e: ThreeEvent<PointerEvent>) => void;
  },
) {
  const { part, tool, selected, painting, onSelect, onMeasure } = props;
  const bodyDown = useBodyDrag(props);
  return (
    <>
      <primitive object={part.root}>
        <primitive
          object={part.content}
          onPointerDown={(e: Parameters<typeof bodyDown>[0]) => {
            if (e.button !== 0) return;
            // The nearest part takes the click, not the ones behind it.
            if (e.intersections[0]?.object !== e.object) return;
            if (tool === "measure" && !painting) {
              onMeasure(e);
              return;
            }
            const additive = e.nativeEvent.ctrlKey || e.nativeEvent.metaKey;
            onSelect(part, additive);
            // Painting: a click picks the part to paint, nothing moves.
            if (painting || additive) return;
            // On a touch screen the parts cover most of the view: a finger
            // landing on one orbits the camera and selects it; only a part
            // already selected is dragged.
            if (e.pointerType === "touch" && !selected) return;
            if (selected && tool === "flat") return;
            bodyDown(e);
          }}
        />
        {selected && !painting && tool === "flat" && <FaceTool {...props} />}
      </primitive>
      {selected && !painting && tool === "move" && <MoveGizmo {...props} />}
      {selected && !painting && tool === "rotate" && <RotateGizmo {...props} />}
    </>
  );
}

function Scene({
  parts,
  selected,
  group,
  bed,
  tool,
  paint,
  paintNow,
  cut,
  heightMarks,
  onSelect,
  onChange,
  onCommit,
  onStroke,
  onCutSettings,
  measure,
  onMeasure,
  stateRef,
}: {
  parts: Part[];
  selected: Part | null;
  /** Every selected part (the selected one first). */
  group: Part[];
  bed: SceneBed;
  tool: Tool;
  /** Painting with these settings (null: not painting). */
  paint: PaintSettings | null;
  paintNow: { readonly current: PaintSettings };
  /** Cutting: the plane's settings and where the connectors would go. */
  cut: { settings: CutSettings; points: THREE.Vector3[] } | null;
  heightMarks: { z: number; color: string }[];
  onSelect: (part: Part, additive: boolean) => void;
  onChange: () => void;
  onCommit: () => void;
  onStroke: (change: PaintChange) => void;
  onCutSettings: (s: CutSettings) => void;
  /** Measuring: the mode and the points so far (null: not measuring). */
  measure: { mode: MeasureMode; points: MeasurePoint[] } | null;
  onMeasure: (p: MeasurePoint) => void;
  /** The viewer's way into the scene (box select picks parts by their place on screen). */
  stateRef: { current: (() => RootState) | null };
}) {
  const [guides, setGuides] = useState<Guide[]>([]);
  const pick = useMeasurePick();
  const get = useThree((s) => s.get);
  useEffect(() => {
    stateRef.current = get;
  }, [get, stateRef]);
  const measureMode = measure?.mode ?? "points";
  const onMeasureDown = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const p = pick(e, measureMode === "points" && !e.nativeEvent.shiftKey);
      if (p) onMeasure(p);
    },
    [pick, measureMode, onMeasure],
  );
  return (
    <>
      <ambientLight intensity={0.35} />
      <hemisphereLight args={["#ffffff", "#30363d", 0.6]} position={[0, 0, 1]} />
      <HeadLight />
      <Bed bed={bed} />
      <FrameBed bed={bed} />
      {parts.map((part) => (
        <PartView
          key={part.id}
          part={part}
          bed={bed}
          tool={tool}
          selected={part === selected}
          painting={paint !== null}
          onSelect={onSelect}
          onMeasure={onMeasureDown}
          onChange={onChange}
          onCommit={onCommit}
          onGuides={setGuides}
        />
      ))}
      <Guides guides={guides} bed={bed} />
      {group.length > 1 && <GroupBox parts={group} />}
      {measure && <MeasureMarks points={measure.points} mode={measure.mode} />}
      {cut && selected && <CutPlane part={selected} settings={cut.settings} points={cut.points} onSettings={onCutSettings} />}
      {heightMarks.map((m, i) => (
        <mesh key={i} position={[(bed.min.x + bed.max.x) / 2, (bed.min.y + bed.max.y) / 2, m.z]} renderOrder={14}>
          <planeGeometry args={[bed.max.x - bed.min.x, bed.max.y - bed.min.y]} />
          <meshBasicMaterial color={m.color} transparent opacity={0.12} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      ))}
      {paint && selected && (
        <PaintSurface key={selected.id} part={selected} settings={paint} current={paintNow} onStroke={onStroke} />
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
  { tool: "cut", label: "Cut", key: "C" },
  { tool: "measure", label: "Measure", key: "U" },
];

const MOUSE_HINTS: Record<Tool, string> = {
  none: "Click a part to select it · drag to move it · Ctrl+click or Ctrl+drag selects several · Ctrl+A: all",
  move: "Drag an arrow or the part · snaps to 1 mm, the bed's centre and edges · Shift: free",
  rotate: "Drag a ring · snaps to 15° · Shift: free",
  flat: "Click a face to put it on the plate",
  cut: "Drag the arrow or the rings, or set the numbers, then Cut · the plane cuts every copy of the model",
  measure: "Click two points (snaps to corners · Shift: free), or two faces in Faces mode",
};

/** Touch screens: no Shift, and a part is selected before it can be dragged. */
const TOUCH_HINTS: Record<Tool, string> = {
  none: "Tap a part to select it, then drag it · one finger turns the view, two pan and zoom",
  move: "Drag an arrow or the part · snaps to 1 mm, the bed's centre and edges",
  rotate: "Drag a ring · snaps to 15°",
  flat: "Tap a face to put it on the plate",
  cut: "Drag the arrow or the rings, or set the numbers, then Cut",
  measure: "Tap two points, or two faces in Faces mode",
};

const TOOL_HINTS = window.matchMedia("(hover: none)").matches ? TOUCH_HINTS : MOUSE_HINTS;

const MODEL_TYPES = ".stl,.3mf";

export default function ModelViewer({
  bed,
  onPlateChange,
  initial,
  supportThreshold = 0,
  supportsOn = true,
  onSupportCheck,
  colors = [],
  filamentCount = 1,
  onPalette,
  heightMarks = [],
}: {
  /** The selected printer's bed; a 256 mm bed until there is one. */
  bed?: BedShape | null;
  /** What's on the plates now (null: nothing). */
  onPlateChange?: (state: PlateState | null) => void;
  /** Models and plates to start from (a job being sliced again); loaded whenever `key` changes. */
  initial?: { key: string; files: File[]; plates: PlateLayout[] | null } | null;
  /** The process's `support_threshold_angle` (0 = auto). */
  supportThreshold?: number;
  /** Will the slicer generate supports? (Overhangs show amber, else red.) */
  supportsOn?: boolean;
  /** What would print in the air on the plate (null: no parts). */
  onSupportCheck?: (check: SupportCheck | null) => void;
  /** Each filament's colour (filament 1 first): parts and colour paint show in them. */
  colors?: string[];
  /** How many filaments the job has (the choices for a model's filament). */
  filamentCount?: number;
  /** A loaded file named its own colours for filaments 1..N. */
  onPalette?: (colors: string[]) => void;
  /** Heights (mm) to show across the bed: the job's changes by height (`plate`: only on that one, 1-based). */
  heightMarks?: { z: number; color: string; plate?: number }[];
}) {
  // Every part on every plate (`Part.plate`); the view shows the active one.
  const [parts, setParts] = useState<Part[]>([]);
  const [plateCount, setPlateCount] = useState(1);
  const [active, setActive] = useState(0);
  // The selected part (the one the tools act on), and the others selected
  // with it (Ctrl+click, Ctrl+drag, Ctrl+A).
  const [selectedId, setPrimaryId] = useState<number | null>(null);
  const [alsoIds, setAlsoIds] = useState<number[]>([]);
  /** Select one part (or none): the rest of a multiple selection is dropped. */
  const setSelectedId = useCallback((id: SetStateAction<number | null>) => {
    setAlsoIds([]);
    setPrimaryId(id);
  }, []);
  // Measuring: the mode and the points picked so far.
  const [measureMode, setMeasureMode] = useState<MeasureMode>("points");
  const [measurePoints, setMeasurePoints] = useState<MeasurePoint[]>([]);
  const sceneState = useRef<(() => RootState) | null>(null);
  const [selectBox, setSelectBox] = useState<{ x0: number; y0: number; x1: number; y1: number; ox: number; oy: number } | null>(
    null,
  );
  // The volume picked in the object panel (its settings and size show).
  const [volumeId, setVolumeId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("move");
  const [showOverhangs, setShowOverhangs] = useState(true);
  const [uniformScale, setUniformScale] = useState(true);
  // Painting: which kind and how (null: not painting).
  const [painting, setPainting] = useState<PaintKind | null>(null);
  const [paintSettings, setPaintSettings] = useState<PaintSettings>(DEFAULT_PAINT);
  // The same, for the paint tool's pointer handlers (see PaintSurface).
  const paintNow = useRef<PaintSettings>(DEFAULT_PAINT);
  const [cutSettings, setCutSettings] = useState<CutSettings>(DEFAULT_CUT);
  useEffect(() => {
    paintNow.current = painting ? { ...paintSettings, kind: painting } : paintSettings;
  });
  // Bumped when a manipulation ends: overhangs are found again then (not
  // on every frame of a drag).
  const [settled, setSettled] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  // Re-render the placement panel while a drag moves the part.
  const [, setTick] = useState(0);
  const tickPending = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Undo/redo: what the plate was after the last change, and what changed.
  const history = useRef(new History());
  const committed = useRef<PlateSnapshot>(snapshot([], 1));
  /** What the next recorded change is called ("Move", "Delete", ...). */
  const pendingLabel = useRef("Edit");
  /** The next state is a new start (a job's models loaded): forget the history. */
  const resetHistory = useRef(false);
  // What the Undo and Redo buttons show (the stacks live in `history`).
  const [undoable, setUndoable] = useState<{ undo?: string; redo?: string }>({});
  const syncHistory = useCallback(
    () => setUndoable({ undo: history.current.undoLabel, redo: history.current.redoLabel }),
    [],
  );
  const colorsKey = colors.join(",");
  const colorsRef = useRef(colors);
  useEffect(() => {
    colorsRef.current = colors;
  });
  const paletteRef = useRef(onPalette);
  useEffect(() => {
    paletteRef.current = onPalette;
  });
  // Keyed on the bed's numbers: the page hands over a new object whenever it
  // re-resolves the profile (a different filament), and a new bed reframes
  // the camera.
  const bedKey = JSON.stringify(bed && bed.area.length >= 3 ? bed : DEFAULT_BED);
  const shape = useMemo(() => sceneBed(JSON.parse(bedKey) as BedShape), [bedKey]);
  const report = useRef(onPlateChange);
  useEffect(() => {
    report.current = onPlateChange;
  }, [onPlateChange]);
  const shown = useMemo(() => parts.filter((p) => p.plate === active), [parts, active]);
  const selected = shown.find((p) => p.id === selectedId) ?? null;
  /** Every selected part on the plate shown, the selected one first. */
  const group = selected ? [selected, ...shown.filter((p) => p !== selected && alsoIds.includes(p.id))] : [];
  const groupKey = group.map((p) => p.id).join(",");

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  // Fit and overlaps follow the parts as they move (drags re-render through
  // `refresh`); the colours follow in an effect.
  const status = plateStatus(parts, shape, plateCount);
  const here = status.plates[active] ?? { parts: 0, fit: "inside" as Fit, overlaps: false };
  const elsewhere = status.plates.findIndex((f, i) => i !== active && plateProblem(f, true) !== null);
  useEffect(() => {
    for (const p of parts) {
      const bad = status.fits.get(p) !== "inside" || status.clash.has(p);
      p.setLook(bad ? "error" : shown.length > 1 && !group.includes(p) ? "idle" : "normal");
    }
  });

  /** A part moved (during a drag too): draw again. */
  const refresh = useCallback(() => {
    if (tickPending.current) return;
    tickPending.current = true;
    requestAnimationFrame(() => {
      tickPending.current = false;
      setTick((t) => t + 1);
    });
  }, []);

  // A multiple selection moves together: where each part was when the
  // selection or the plate last settled, and how far the others have been
  // moved since (the part being dragged is the one that moved otherwise).
  const anchors = useRef<{ at: Map<Part, THREE.Vector2>; moved: THREE.Vector2 }>({ at: new Map(), moved: new THREE.Vector2() });
  useEffect(() => {
    anchors.current = { at: new Map(group.map((p) => [p, p.center.clone()])), moved: new THREE.Vector2() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey, settled, parts]);
  const followGroup = useCallback(() => {
    const { at, moved } = anchors.current;
    if (at.size < 2) return;
    for (const [p, c] of at) {
      const d = p.center.clone().sub(c);
      if (d.distanceToSquared(moved) < 1e-12) continue;
      // `p` is being dragged: the rest follow it.
      for (const [q, cq] of at) if (q !== p) q.setCenter(cq.x + d.x, cq.y + d.y);
      anchors.current.moved = d;
      return;
    }
  }, []);

  /** Record the plate as it is now, if it changed since the last record. */
  const record = useCallback(
    (label: string, now: Part[], count: number) => {
      const after = snapshot(now, count);
      if (resetHistory.current) {
        resetHistory.current = false;
        history.current.clear();
        committed.current = after;
        syncHistory();
        return;
      }
      if (sameSnapshot(committed.current, after)) return;
      history.current.push({ label, change: { kind: "plate", before: committed.current, after } });
      committed.current = after;
      syncHistory();
    },
    [syncHistory],
  );

  /** A manipulation finished: record it and tell the page what's on the plates. */
  const commit = useCallback(
    (label = "Move") => {
      refresh();
      setSettled((n) => n + 1);
      record(label, parts, plateCount);
      report.current?.(plateState(parts, shape, plateCount));
    },
    [refresh, parts, shape, plateCount, record],
  );

  // What would print in the air: painted on the parts, totalled for the page.
  const reportCheck = useRef(onSupportCheck);
  useEffect(() => {
    reportCheck.current = onSupportCheck;
  }, [onSupportCheck]);
  useEffect(() => {
    if (parts.length === 0) {
      reportCheck.current?.(null);
      return;
    }
    let overhangArea = 0;
    let floating = 0;
    for (const p of parts) {
      const o = p.updateOverhangs(supportThreshold, supportsOn, showOverhangs);
      overhangArea += o.area;
      floating += o.floating;
    }
    reportCheck.current?.({ overhangArea, floating });
  }, [parts, settled, supportThreshold, supportsOn, showOverhangs]);

  // New parts or plates: record the change (undo), report the plates.
  useEffect(() => {
    record(pendingLabel.current, parts, plateCount);
    pendingLabel.current = "Edit";
  }, [parts, plateCount, record]);
  useEffect(() => {
    report.current?.(plateState(parts, shape, plateCount));
  }, [parts, shape, plateCount]);

  // New filament colours: every model shows them.
  useEffect(() => {
    for (const s of new Set(parts.map((p) => p.shape))) s.setColors(colorsRef.current);
  }, [parts, colorsKey]);

  // Free each part's GPU resources once it's off the plate (an undo step
  // that still refers to it can bring it back).
  const live = useRef(new Set<Part>());
  useEffect(() => {
    for (const p of parts) live.current.add(p);
    const keep = history.current.referencedParts();
    for (const p of live.current)
      if (!parts.includes(p)) {
        p.dispose();
        if (!keep.has(p)) live.current.delete(p);
      }
  }, [parts]);
  useEffect(() => () => live.current.forEach((p) => p.dispose()), []);

  /** Set the parts (a change worth an undo step called `label`). */
  const setPlate = useCallback((next: Part[], label = "Edit") => {
    pendingLabel.current = label;
    setParts(next);
  }, []);

  /** Put the plate (or a model's paint) back as a recorded change has it. */
  const applyChange = useCallback(
    (change: Change, which: "before" | "after") => {
      if (change.kind === "paint") {
        applyPaint(change, which);
        for (const p of parts) if (p.shape !== change.shape) p.shape.refreshAllPaint();
        refresh();
        report.current?.(plateState(parts, shape, plateCount));
        return;
      }
      const state = change[which];
      const next = restore(state);
      for (const s of new Set(next.map((p) => p.shape))) {
        s.setColors(colorsRef.current);
        s.refreshAllPaint();
      }
      committed.current = state;
      setParts([...next]);
      setPlateCount(state.plateCount);
      setActive((a) => Math.min(a, state.plateCount - 1));
      setSelectedId((id) => (next.some((p) => p.id === id) ? id : null));
      setSettled((n) => n + 1);
      refresh();
    },
    [parts, shape, plateCount, refresh, setSelectedId],
  );

  const undo = useCallback(() => {
    const e = history.current.undo();
    if (e) applyChange(e.change, "before");
    syncHistory();
  }, [applyChange, syncHistory]);

  const redo = useCallback(() => {
    const e = history.current.redo();
    if (e) applyChange(e.change, "after");
    syncHistory();
  }, [applyChange, syncHistory]);

  // While painting, every copy shows that kind of paint; else the colours.
  useEffect(() => {
    for (const p of parts) p.setPaintView(painting ?? "color");
  }, [parts, painting]);

  /** Start (or stop) painting `kind`, with a sensible thing to paint. */
  const togglePaint = useCallback((kind: PaintKind) => {
    setPainting((cur) => (cur === kind ? null : kind));
    setPaintSettings((s) =>
      s.kind === kind
        ? s
        : {
            ...s,
            kind,
            state: kind === "color" ? 1 : ENFORCER,
            brush: kind !== "color" && s.brush === "height" ? "circle" : s.brush,
          },
    );
  }, []);

  /** A paint stroke ended: one undo step; the model's upload is made again. */
  const recordPaint = useCallback(
    (change: PaintChange, label = "Paint") => {
      if (change.layers.length === 0) return;
      change.shape.version++;
      history.current.push({ label, change: { kind: "paint", ...change } });
      syncHistory();
      setSettled((n) => n + 1);
      report.current?.(plateState(parts, shape, plateCount));
    },
    [syncHistory, parts, shape, plateCount],
  );

  /** Take this kind of paint off the selected model. */
  const clearPaint = useCallback(() => {
    if (!selected || !painting) return;
    const s = selected.shape;
    const layers = s.object.volumes
      .filter((v) => v.paint[painting] && !v.paint[painting]!.empty)
      .map((v) => {
        const before = v.paint[painting]!.clone();
        delete v.paint[painting];
        s.refreshPaint(v.id, painting);
        return { volumeId: v.id, kind: painting, before, after: undefined };
      });
    recordPaint({ shape: s, layers }, "Clear paint");
  }, [selected, painting, recordPaint]);

  const addMeasurePoint = useCallback((p: MeasurePoint) => setMeasurePoints((pts) => (pts.length >= 2 ? [p] : [...pts, p])), []);

  /** The cut tool opens: the plane level, half way up the selected part. */
  const startCut = useCallback(() => {
    if (!selected) return;
    const h = selected.worldBox().max.z;
    setCutSettings((s) => ({ ...s, height: Math.round((h / 2) * 10) / 10, tiltX: 0, tiltY: 0, shift: 0 }));
  }, [selected]);

  /** The world matrix of a part's model frame (the object's own coordinates). */
  const objectFrame = (p: Part) => {
    p.root.updateMatrixWorld(true);
    p.content.updateMatrix();
    return new THREE.Matrix4().multiplyMatrices(p.root.matrixWorld, p.content.matrix);
  };
  /** The cut plane in the selected part's model frame. */
  const cutPlane = useCallback(
    (p: Part, s: CutSettings): Plane => {
      const n = cutNormal(s);
      const at = cutPivot(s, p.center.x, p.center.y);
      return planeInFrame(
        { point: [at.x, at.y, at.z], normal: [n.x, n.y, n.z] },
        Float64Array.from(objectFrame(p).elements),
      );
    },
    [],
  );
  // Where the connectors would go (scene coordinates), as settings change.
  const cutPreview = useMemo(() => {
    // Again whenever the part moved (`settled`).
    void settled;
    if (tool !== "cut" || !selected || painting) return null;
    const points: THREE.Vector3[] = [];
    if (cutSettings.count > 0 && cutSettings.keep === "both") {
      const plane = cutPlane(selected, cutSettings);
      const section = cutSection(selected.shape.object, plane);
      if (section) {
        const frame = objectFrame(selected);
        for (const q of connectorPoints(section, plane, cutSettings.count, cutSettings.connector.kind))
          points.push(new THREE.Vector3(q[0], q[1], q[2]).applyMatrix4(frame));
      }
    }
    return { settings: cutSettings, points };
  }, [tool, selected, painting, cutSettings, cutPlane, settled]);

  /**
   * Put new models where every copy of `old` was: each copy becomes a copy
   * of each new model (same turn and scale), where its pieces were.
   */
  const replaceModel = useCallback(
    (old: PartShape, objects: ModelObject[], label: string, drop: Part[] = []) => {
      const shapes = objects.map((o) => new PartShape(o, null, colorsRef.current));
      const copies = parts.filter((p) => p.shape === old);
      const added: Part[] = [];
      for (const copy of copies) {
        const frame = objectFrame(copy);
        for (const s of shapes) {
          const part = new Part(s);
          part.setScale(copy.scale.clone());
          part.setRotation(copy.quaternion.clone());
          part.setPlate(copy.plate);
          const mid = s.offset.clone().negate().applyMatrix4(frame);
          part.setCenter(mid.x, mid.y);
          added.push(part);
        }
      }
      setPlate([...parts.filter((p) => p.shape !== old && !drop.includes(p)), ...added], label);
      setSelectedId(added[0]?.id ?? null);
      setVolumeId(null);
      setSettled((n) => n + 1);
    },
    [parts, setPlate, setSelectedId],
  );

  const splitModel = useCallback(
    (s: PartShape) => {
      const objects = splitToObjects(s.object);
      if (objects.length > 1) replaceModel(s, objects, "Split to models");
    },
    [replaceModel],
  );

  /** `other` joins `s`: one copy of it (on the same plate, if any), as it sits now. */
  const mergeModels = useCallback(
    (s: PartShape, other: PartShape) => {
      const here = (selected?.shape === s ? selected : null) ?? parts.find((p) => p.shape === s);
      if (!here) return;
      const there = parts.find((p) => p.shape === other && p.plate === here.plate) ?? parts.find((p) => p.shape === other);
      if (!there) return;
      const toA = objectFrame(here).invert().multiply(objectFrame(there));
      replaceModel(s, [mergeInto(s.object, other.object, Float64Array.from(toA.elements))], "Merge", [there]);
    },
    [selected, parts, replaceModel],
  );

  /** How long a piece may be along each scene axis to fit the printer (room left for plugs). */
  const fitLimits = useCallback((): [number, number, number] => {
    // Everything but dowels stands out of its piece by its depth.
    const plug = cutSettings.connector.kind === "dowel" ? 0 : cutSettings.connector.depth;
    const w = shape.max.x - shape.min.x - FIT_MARGIN - plug;
    const d = shape.max.y - shape.min.y - FIT_MARGIN - plug;
    const h = shape.height > 0 ? shape.height - 1 - plug : Infinity;
    return [w, d, h];
  }, [shape, cutSettings]);

  /** Does the part need cutting to fit the printer at all? */
  const tooBig = useCallback(
    (p: Part) => {
      const size = p.worldBox().getSize(new THREE.Vector3());
      const [w, d, h] = fitLimits();
      return size.x > w || size.y > d || size.z > h;
    },
    [fitLimits],
  );

  /**
   * Cut the part (this copy) into as few pieces as fit the printer, joined
   * by the cut tool's connectors (one per cut at least: plugs unless it
   * says dowels), and pack them onto plates of their own.
   */
  const cutToFit = useCallback(
    (part: Part) => {
      const frame = objectFrame(part);
      const planes = fitPlanes(part.shape.object, Float64Array.from(frame.elements), fitLimits());
      if (planes.length === 0) {
        setNotice({ text: "It fits the printer as it is" });
        return;
      }
      // The pieces always get connectors (the cut tool's kind and number, one at least).
      const connector = { spec: cutSettings.connector, count: Math.max(1, cutSettings.count) };
      const { pieces, pins, openLoops } = cutIntoPieces(part.shape.object, planes, connector);
      const made: Part[] = [];
      for (const o of [...pieces, ...pins]) {
        const s = new PartShape(o, null, colorsRef.current);
        const p = new Part(s);
        if (pieces.includes(o)) {
          p.setScale(part.scale.clone());
          p.setRotation(part.quaternion.clone());
          const mid = s.offset.clone().negate().applyMatrix4(frame);
          p.setCenter(mid.x, mid.y);
        }
        made.push(p);
      }
      const groups = arrangeOnPlates(made, shape);
      if (!groups) {
        setNotice({ text: "A piece still doesn't fit: turn the part, or cut it by hand", bad: true });
        return;
      }
      const rest = parts.filter((p) => p !== part);
      // The pieces' plates: the part's own if nothing else is on it, then new ones.
      const alone = !rest.some((p) => p.plate === part.plate);
      let next = plateCount;
      groups.forEach((group, i) => {
        const plate = i === 0 && alone ? part.plate : next++;
        for (const p of group) p.setPlate(plate);
      });
      setPlateCount(next);
      setPlate([...rest, ...made], "Cut to fit");
      setActive(groups[0][0]?.plate ?? active);
      setSelectedId(made[0]?.id ?? null);
      setTool("none");
      setSettled((n) => n + 1);
      setNotice({
        text:
          `Cut into ${pieces.length} pieces${pins.length ? " and dowel pins" : ""}, on ${groups.length} ${groups.length === 1 ? "plate" : "plates"}` +
          (openLoops ? " (the model isn't closed: some cut faces have holes)" : ""),
        bad: openLoops > 0,
      });
    },
    [fitLimits, cutSettings, shape, parts, plateCount, active, setPlate, setSelectedId],
  );

  /** Cut every copy of the selected part's model; the halves take their place. */
  const doCut = useCallback(() => {
    if (!selected) return;
    const shapeBefore = selected.shape;
    const plane = cutPlane(selected, cutSettings);
    const cut = cutObject(shapeBefore.object, plane);
    let { upper, lower } = cut;
    const { openLoops } = cut;
    let pins: ModelObject | null = null;
    if (cutSettings.keep === "both" && cutSettings.count > 0 && upper && lower) {
      const section = cutSection(shapeBefore.object, plane);
      if (section)
        ({ upper, lower, pins } = addConnectors(
          { upper, lower },
          plane,
          connectorPoints(section, plane, cutSettings.count, cutSettings.connector.kind),
          cutSettings.connector,
          section,
        ));
    }
    if (cutSettings.keep === "upper") lower = null;
    if (cutSettings.keep === "lower") upper = null;
    if (!upper && !lower) {
      setNotice({ text: "The plane misses the model", bad: true });
      return;
    }
    if (!upper || !lower) {
      if (cutSettings.keep === "both") {
        setNotice({ text: "The plane doesn't cross the model: move it into the part", bad: true });
        return;
      }
    }
    const upperShape = upper ? new PartShape(upper, null, colorsRef.current) : null;
    const lowerShape = lower ? new PartShape(lower, null, colorsRef.current) : null;
    const pinShape = pins ? new PartShape(pins, null, colorsRef.current) : null;
    const copies = parts.filter((p) => p.shape === shapeBefore);
    const rest = parts.filter((p) => p.shape !== shapeBefore);
    const added: Part[] = [];
    const down = new THREE.Vector3(0, 0, -1);
    for (const copy of copies) {
      const frame = objectFrame(copy);
      const normal = new THREE.Vector3(...plane.normal).transformDirection(frame);
      for (const [s, isUpper] of [
        [upperShape, true],
        [lowerShape, false],
      ] as const) {
        if (!s) continue;
        const part = new Part(s);
        part.setScale(copy.scale.clone());
        part.setRotation(copy.quaternion.clone());
        part.setPlate(copy.plate);
        // Where the half is now, in the scene.
        const mid = s.offset.clone().negate().applyMatrix4(frame);
        part.setCenter(mid.x, mid.y);
        if (isUpper && cutSettings.layUpper) {
          // Its cut face (facing -normal) down onto the plate.
          const turn = new THREE.Quaternion().setFromUnitVectors(normal.clone().negate(), down);
          part.setRotation(turn.multiply(copy.quaternion.clone()));
        }
        added.push(part);
      }
      if (pinShape && copy === copies[0]) {
        const pin = new Part(pinShape);
        pin.setPlate(copy.plate);
        added.push(pin);
      }
    }
    // Each new part in free space on its plate (the lower half stays put).
    const placed = [...rest];
    for (const p of added) {
      const others = placed.filter((q) => q.plate === p.plate);
      if (overlapping([...others, p]).has(p)) {
        const spot = findFreeSpot(p, others, shape);
        if (spot) p.setCenter(spot.x, spot.y);
      }
      placed.push(p);
    }
    setPlate([...rest, ...added], "Cut");
    setSelectedId(added[0]?.id ?? null);
    setTool("none");
    setSettled((n) => n + 1);
    setNotice({
      text:
        openLoops > 0
          ? "Cut, but the model isn't closed: some cut faces have holes (check the model in the preview)"
          : `Cut into ${[upper, lower].filter(Boolean).length} ${pins ? "halves and dowel pins" : upper && lower ? "halves" : "half"}`,
      bad: openLoops > 0,
    });
  }, [selected, cutSettings, cutPlane, parts, shape, setPlate, setSelectedId]);

  /**
   * Show plate `index`, selecting its first part. Leaving an empty plate
   * drops it (later plates move up), so the tabs number the plates as the
   * job will.
   */
  const showPlate = useCallback(
    (index: number) => {
      let target = index;
      if (index !== active && plateCount > 1 && !parts.some((p) => p.plate === active)) {
        for (const p of parts) if (p.plate > active) p.setPlate(p.plate - 1);
        if (target > active) target--;
        setPlateCount(plateCount - 1);
        setParts([...parts]);
      }
      setActive(target);
      setSelectedId(parts.find((p) => p.plate === target)?.id ?? null);
    },
    [parts, active, plateCount, setSelectedId],
  );

  /** Load model files onto the plate shown: one part each, placed in free space (centred on an empty plate). */
  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setError("");
      setLoading(true);
      try {
        const added: Part[] = [];
        const placed = [...shown];
        for (const file of files) {
          const loaded = loadModel(file.name, await file.arrayBuffer());
          if (loaded.palette.length) paletteRef.current?.(loaded.palette);
          const stl = /\.stl$/i.test(file.name) ? file : null;
          // Each object of the file, each instance where the file put it
          // (relative to the others, centred on the plate when it's empty).
          const fromFile: { part: Part; at: THREE.Vector3 }[] = [];
          for (const { object, items } of loaded.objects) {
            const s = new PartShape(object, stl, colorsRef.current);
            const mid = s.offset.clone().negate();
            for (const item of items) {
              const part = new Part(s);
              const m = new THREE.Matrix4().fromArray(item);
              const q = new THREE.Quaternion();
              const sc = new THREE.Vector3();
              m.decompose(new THREE.Vector3(), q, sc);
              part.setScale(sc);
              part.setRotation(q);
              part.setPlate(active);
              fromFile.push({ part, at: mid.clone().applyMatrix4(m) });
            }
          }
          const box = new THREE.Box3();
          for (const f of fromFile) box.expandByPoint(f.at);
          const groupMid = box.getCenter(new THREE.Vector3());
          for (const { part, at } of fromFile) {
            if (placed.length > 0) {
              const spot = findFreeSpot(part, placed, shape);
              if (spot) part.setCenter(spot.x, spot.y);
              else setNotice({ text: `No free room for ${part.name}: it's in the middle, overlapping`, bad: true });
            } else part.setCenter(at.x - groupMid.x, at.y - groupMid.y);
            added.push(part);
          }
          // The file's own layout counts as placed once all of it is down.
          placed.push(...fromFile.map((f) => f.part));
          for (const w of loaded.warnings) setNotice({ text: `${file.name}: ${w}` });
        }
        setPlate([...parts, ...added], files.length > 1 ? "Add parts" : `Add ${files[0].name}`);
        setSelectedId(added[added.length - 1].id);
        setTool("move");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load model");
      } finally {
        setLoading(false);
      }
    },
    [parts, shown, active, shape, setPlate, setSelectedId],
  );

  // A job's models and plates (re-slicing): replace them all.
  const initialKey = initial?.key;
  const loadInitial = useRef(initial);
  useEffect(() => {
    loadInitial.current = initial;
  });
  useEffect(() => {
    const start = loadInitial.current;
    if (!initialKey || !start) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    (async () => {
      // One model per file, as the job placed them (a file of several
      // objects was one rigid part).
      const loaded: PartShape[] = [];
      for (const file of start.files) {
        const { objects, palette } = loadModel(file.name, await file.arrayBuffer());
        if (palette.length) paletteRef.current?.(palette);
        const stl = /\.stl$/i.test(file.name) ? file : null;
        loaded.push(new PartShape(mergeObjects(objects, baseName(file.name)), stl, colorsRef.current));
      }
      if (cancelled) return;
      const plates = start.plates ?? [{ objects: loaded.map((_, i) => ({ model: i, placement: null })) }];
      const next = plates.flatMap((plate, index) =>
        plate.objects
          .filter((o) => o.model < loaded.length)
          .map((o) => {
            const part = new Part(loaded[o.model]);
            if (o.placement) part.setPlacement(o.placement);
            part.setPlate(index);
            return part;
          }),
      );
      resetHistory.current = true;
      setParts(next);
      setPlateCount(Math.max(1, plates.length));
      setActive(0);
      setSelectedId(next[0]?.id ?? null);
    })()
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load the job's models"))
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [initialKey, setSelectedId]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      void addFiles([...e.dataTransfer.files]);
    },
    [addFiles],
  );

  /** The box round every selected part, on the plate. */
  const groupBox = () => {
    const box = new THREE.Box3();
    for (const p of group) box.union(p.worldBox());
    return box;
  };
  /** Move every selected part by (dx, dy). */
  const moveGroup = (dx: number, dy: number) => {
    for (const p of group) p.setCenter(p.center.x + dx, p.center.y + dy);
  };
  /** Select these parts, the first the one the tools act on. */
  const selectParts = useCallback((ps: Part[]) => {
    setPrimaryId(ps[0]?.id ?? null);
    setAlsoIds(ps.slice(1).map((p) => p.id));
  }, []);

  const center = () => {
    if (!selected) return;
    const mid = groupBox().getCenter(new THREE.Vector3());
    moveGroup(-mid.x, -mid.y);
    commit("Center");
  };

  const resetOrientation = () => {
    if (!selected) return;
    for (const p of group) p.setRotation(new THREE.Quaternion());
    commit("Reset rotation");
  };

  /** Turn the selected parts the way they print best (least overhang, most on the plate). */
  const autoOrient = useCallback(() => {
    if (!selected) return;
    let left = 0;
    for (const p of group) {
      const best = bestOrientation(p.shape.object, supportThreshold);
      if (!best) continue;
      // A face's direction under the copy's scale: divided by it.
      const down = new THREE.Vector3(...best.down).divide(p.scale).normalize();
      p.setRotation(new THREE.Quaternion().setFromUnitVectors(down, new THREE.Vector3(0, 0, -1)));
      left += best.overhang;
    }
    commit("Auto orient");
    setNotice({
      text: left > 1 ? `Turned: ${Math.round(left)} mm² still overhangs` : "Turned so nothing overhangs",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, groupKey, supportThreshold, commit]);

  // Copy and paste (Ctrl+C, Ctrl+V): more copies of the selected parts, onto the plate shown.
  const clipboard = useRef<{ shape: PartShape; quaternion: THREE.Quaternion; scale: THREE.Vector3 }[]>([]);
  const copySelected = useCallback(() => {
    if (!selected) return;
    clipboard.current = group.map((p) => ({ shape: p.shape, quaternion: p.quaternion.clone(), scale: p.scale.clone() }));
    setNotice({
      text: `Copied ${group.length > 1 ? `${group.length} parts` : selected.name}: Ctrl+V puts more on the plate shown`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, groupKey]);
  /** Copies of `items` in free room on the plate shown (null: no room for them all). */
  const placeCopies = useCallback(
    (items: { shape: PartShape; quaternion: THREE.Quaternion; scale: THREE.Vector3 }[]) => {
      const placed = [...shown];
      const made: Part[] = [];
      for (const c of items) {
        const part = new Part(c.shape);
        part.setScale(c.scale.clone());
        part.setRotation(c.quaternion.clone());
        part.setPlate(active);
        if (placed.length > 0) {
          const spot = findFreeSpot(part, placed, shape);
          if (!spot) {
            part.dispose();
            made.forEach((m) => m.dispose());
            return null;
          }
          part.setCenter(spot.x, spot.y);
        }
        placed.push(part);
        made.push(part);
      }
      return made;
    },
    [shown, active, shape],
  );
  const paste = useCallback(() => {
    if (clipboard.current.length === 0) return;
    const made = placeCopies(clipboard.current);
    if (!made) {
      setNotice({ text: "No free room on this plate: add a plate, or Arrange", bad: true });
      return;
    }
    setPlate([...parts, ...made], "Paste");
    selectParts(made);
  }, [placeCopies, parts, setPlate, selectParts]);

  /** Mirror the selected part along a scene axis (it stays where it is). */
  const mirror = useCallback(
    (axis: 0 | 1 | 2) => {
      if (!selected) return;
      // D·R·S = (D·R·E)·(E·S): D mirrors the scene axis, E the model's X;
      // D·R·E is a rotation again, E·S a scale.
      const d = new THREE.Matrix4().makeScale(axis === 0 ? -1 : 1, axis === 1 ? -1 : 1, axis === 2 ? -1 : 1);
      const e = new THREE.Matrix4().makeScale(-1, 1, 1);
      const r = new THREE.Matrix4().makeRotationFromQuaternion(selected.quaternion);
      const turned = new THREE.Matrix4().multiplyMatrices(d, r).multiply(e);
      const s = selected.scale.clone();
      s.x = -s.x;
      selected.setScale(s);
      selected.setRotation(new THREE.Quaternion().setFromRotationMatrix(turned));
      commit(`Mirror ${"XYZ"[axis]}`);
    },
    [selected, commit],
  );

  /**
   * Change a model: every copy of it shows the new one (an undo step
   * brings the old one back).
   */
  const editShape = useCallback(
    (old: PartShape, label: string, change: (o: ModelObject) => ModelObject) => {
      const next = new PartShape(change(old.object), old.source, colorsRef.current);
      for (const p of parts) if (p.shape === old) p.setShape(next);
      setPlate([...parts], label);
      setSettled((n) => n + 1);
    },
    [parts, setPlate],
  );

  // The models on the plates (each once, with its copies), for the object panel.
  const modelsOnPlates = useMemo(() => {
    const out: { shape: PartShape; copies: number }[] = [];
    for (const p of parts) {
      const hit = out.find((m) => m.shape === p.shape);
      if (hit) hit.copies++;
      else out.push({ shape: p.shape, copies: 1 });
    }
    return out;
  }, [parts]);
  /** Select a copy of `s`: on the plate shown if it has one, else the first plate that does. */
  const selectShape = useCallback(
    (s: PartShape) => {
      const here = parts.find((p) => p.shape === s && p.plate === active) ?? parts.find((p) => p.shape === s);
      if (!here) return;
      if (here.plate !== active) setActive(here.plate);
      setSelectedId(here.id);
      setVolumeId(null);
    },
    [parts, active, setSelectedId],
  );

  const duplicate = () => {
    if (!selected) return;
    const made = placeCopies(group.map((p) => ({ shape: p.shape, quaternion: p.quaternion.clone(), scale: p.scale.clone() })));
    if (!made) {
      setNotice({ text: "No free room on this plate for more copies: add a plate, or Arrange to spread over more", bad: true });
      return;
    }
    setPlate([...parts, ...made], "Duplicate");
    selectParts(made);
  };

  /** The selected parts become one model (the first one's, the rest as its parts), where they are. */
  const mergeSelected = () => {
    if (group.length < 2) return;
    const [lead, ...others] = group;
    const frame = objectFrame(lead);
    const toLead = frame.clone().invert();
    let object = lead.shape.object;
    for (const p of others)
      object = mergeInto(object, p.shape.object, Float64Array.from(toLead.clone().multiply(objectFrame(p)).elements));
    const s = new PartShape(object, null, colorsRef.current);
    const part = new Part(s);
    part.setScale(lead.scale.clone());
    part.setRotation(lead.quaternion.clone());
    part.setPlate(lead.plate);
    const mid = s.offset.clone().negate().applyMatrix4(frame);
    part.setCenter(mid.x, mid.y);
    setPlate([...parts.filter((p) => !group.includes(p)), part], "Merge");
    setSelectedId(part.id);
    setSettled((n) => n + 1);
  };

  const fill = useCallback(() => {
    if (!selected) return;
    const copies = fillCopies(
      selected,
      shown.filter((p) => p !== selected),
      shape,
    );
    if (copies.length === 0) {
      setNotice({ text: "No free room on this plate for another copy", bad: true });
      return;
    }
    setPlate([...parts, ...copies], "Fill plate");
    setNotice({ text: `Added ${copies.length} ${copies.length === 1 ? "copy" : "copies"} of ${selected.name}` });
  }, [selected, parts, shown, shape, setPlate]);

  // Pack the plate shown; what doesn't fit goes onto new plates at the end.
  const arrangeAll = useCallback(() => {
    if (arrange(shown, shape)) {
      commit("Arrange");
      setNotice({ text: "Arranged" });
      return;
    }
    const groups = arrangeOnPlates(shown, shape);
    if (!groups) {
      setNotice({ text: "A part is too big for this printer's plate, even on its own", bad: true });
      return;
    }
    groups.forEach((group, i) => group.forEach((p) => p.setPlate(i === 0 ? active : plateCount + i - 1)));
    setPlateCount(plateCount + groups.length - 1);
    setPlate([...parts], "Arrange");
    setNotice({ text: `They don't all fit: arranged onto ${groups.length} plates` });
  }, [shown, shape, commit, parts, active, plateCount, setPlate]);

  const remove = useCallback(() => {
    if (!selected) return;
    const rest = parts.filter((p) => !group.includes(p));
    setPlate(rest, "Delete");
    setSelectedId(rest.filter((p) => p.plate === active).at(-1)?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, groupKey, parts, active, setPlate, setSelectedId]);

  const clear = useCallback(() => {
    setPlate([], "Clear");
    setPlateCount(1);
    setActive(0);
    setSelectedId(null);
  }, [setPlate, setSelectedId]);

  const addPlate = useCallback(() => {
    setPlateCount(plateCount + 1);
    setActive(plateCount);
    setSelectedId(null);
  }, [plateCount, setSelectedId]);

  /** Delete the plate shown and its parts; later plates move up. */
  const deletePlate = useCallback(() => {
    if (plateCount < 2) return;
    const rest = parts.filter((p) => p.plate !== active);
    for (const p of rest) if (p.plate > active) p.setPlate(p.plate - 1);
    setPlate(rest, "Delete plate");
    setPlateCount(plateCount - 1);
    const next = Math.min(active, plateCount - 2);
    setActive(next);
    setSelectedId(rest.find((p) => p.plate === next)?.id ?? null);
  }, [parts, active, plateCount, setPlate, setSelectedId]);

  /** Move the selected parts to plate `target` (plateCount: a new one), in free space there; show it. */
  const moveToPlate = useCallback(
    (target: number) => {
      if (!selected || target === active) return;
      const there = parts.filter((p) => p.plate === target);
      for (const p of group) {
        p.setPlate(target);
        const spot = there.length > 0 ? findFreeSpot(p, there, shape) : new THREE.Vector2(0, 0);
        if (spot) p.setCenter(spot.x, spot.y);
        else setNotice({ text: `No free room on plate ${target + 1}: it overlaps there`, bad: true });
        there.push(p);
      }
      let count = Math.max(plateCount, target + 1);
      let next = target;
      // The part was the plate's last: drop the plate (later plates move up).
      if (!parts.some((p) => p.plate === active)) {
        for (const p of parts) if (p.plate > active) p.setPlate(p.plate - 1);
        count--;
        if (next > active) next--;
      }
      setPlateCount(count);
      setActive(next);
      setPlate([...parts], `Move to plate ${target + 1}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, groupKey, active, parts, shape, plateCount, setPlate],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
        return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === "z" || key === "y")) {
        e.preventDefault();
        if (key === "y" || e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && key === "a" && shown.length > 0) {
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        selectParts(selected ? [selected, ...shown.filter((p) => p !== selected)] : shown);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (key === "c" || key === "v")) {
        // Leave the page's own copy alone when text is selected.
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        if (key === "c") copySelected();
        else paste();
        return;
      }
      if (parts.length === 0 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (key === "escape") {
        setTool("none");
        setPainting(null);
      }
      const paintTool = PAINT_TOOLS.find((x) => x.key.toLowerCase() === key);
      if (paintTool) {
        togglePaint(paintTool.kind);
        return;
      }
      if (key === "delete" || key === "backspace") {
        e.preventDefault();
        remove();
        return;
      }
      if (key === "a") {
        arrangeAll();
        return;
      }
      if (key === "o") {
        autoOrient();
        return;
      }
      const t = TOOLS.find((x) => x.key.toLowerCase() === key);
      if (t) {
        setPainting(null);
        if (t.tool === "measure") setMeasurePoints([]);
        setTool((cur) => (cur === t.tool ? "none" : t.tool));
        if (t.tool === "cut") startCut();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [parts, shown, selected, selectParts, remove, arrangeAll, undo, redo, togglePaint, startCut, copySelected, paste, autoOrient]);

  /**
   * A part clicked: it becomes the one the tools act on. A plain click on
   * a part outside the selection selects just it; Ctrl/Cmd-click adds it
   * to the selection or takes it out.
   */
  const select = useCallback(
    (part: Part, additive: boolean) => {
      if (additive) {
        if (part.id === selectedId) {
          setPrimaryId(alsoIds.at(-1) ?? null);
          setAlsoIds(alsoIds.slice(0, -1));
        } else if (alsoIds.includes(part.id)) setAlsoIds(alsoIds.filter((id) => id !== part.id));
        else {
          if (selectedId !== null) setAlsoIds([...alsoIds, selectedId]);
          setPrimaryId(part.id);
        }
        return;
      }
      if (part.id === selectedId) return;
      if (alsoIds.includes(part.id) && selectedId !== null) {
        setAlsoIds([...alsoIds.filter((id) => id !== part.id), selectedId]);
        setPrimaryId(part.id);
        return;
      }
      setSelectedId(part.id);
    },
    [selectedId, alsoIds, setSelectedId],
  );

  /**
   * Ctrl/Cmd-drag on empty space draws a box: the parts whose middles fall
   * in it join the selection. Caught before the camera controls see it.
   */
  const startBoxSelect = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !(e.ctrlKey || e.metaKey) || painting || tool === "measure") return;
    const get = sceneState.current;
    if (!get || !(e.target instanceof HTMLCanvasElement)) return;
    const { camera, gl } = get();
    const rect = gl.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    // On a part: Ctrl-click toggles it (PartView).
    if (ray.intersectObjects(shown.map((p) => p.content), true).length > 0) return;
    e.stopPropagation();
    e.preventDefault();
    // The box is drawn in the viewer; parts are tested against the canvas.
    const outer = e.currentTarget.getBoundingClientRect();
    const ox = rect.left - outer.left;
    const oy = rect.top - outer.top;
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    let last = { x0, y0, x1: x0, y1: y0, ox, oy };
    setSelectBox(last);
    const onMove = (ev: PointerEvent) => {
      last = { x0, y0, x1: ev.clientX - rect.left, y1: ev.clientY - rect.top, ox, oy };
      setSelectBox(last);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setSelectBox(null);
      const [lx, hx] = [Math.min(last.x0, last.x1), Math.max(last.x0, last.x1)];
      const [ly, hy] = [Math.min(last.y0, last.y1), Math.max(last.y0, last.y1)];
      if (hx - lx < 3 && hy - ly < 3) return;
      const inside = shown.filter((p) => {
        const c = p.worldBox().getCenter(new THREE.Vector3()).project(camera);
        const sx = ((c.x + 1) / 2) * rect.width;
        const sy = ((1 - c.y) / 2) * rect.height;
        return c.z < 1 && sx >= lx && sx <= hx && sy >= ly && sy <= hy;
      });
      if (inside.length === 0) return;
      selectParts([...group, ...inside.filter((p) => !group.includes(p))]);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Panel values: absolute slicer coordinates, like the desktop slicers show.
  const box = selected?.worldBox();
  const sizeMm = box?.getSize(new THREE.Vector3());
  const euler = selected ? new THREE.Euler().setFromQuaternion(selected.quaternion, EULER_ORDER) : null;
  const setEuler = (axis: "x" | "y" | "z", degrees: number) => {
    if (!selected || !euler) return;
    const next = euler.clone();
    next[axis] = THREE.MathUtils.degToRad(degrees);
    selected.setRotation(new THREE.Quaternion().setFromEuler(next));
    commit("Rotate");
  };
  const setPosition = (axis: 0 | 1, absolute: number) => {
    if (!selected) return;
    const v = absolute - (axis === 0 ? shape.center.x : shape.center.y);
    selected.setCenter(axis === 0 ? v : selected.center.x, axis === 1 ? v : selected.center.y);
    commit("Move");
  };
  /** Move the whole selection so its box's middle is at `absolute` (slicer coordinates). */
  const setGroupPosition = (axis: 0 | 1, absolute: number) => {
    const mid = groupBox().getCenter(new THREE.Vector3());
    const v = absolute - (axis === 0 ? shape.center.x : shape.center.y) - (axis === 0 ? mid.x : mid.y);
    moveGroup(axis === 0 ? v : 0, axis === 1 ? v : 0);
    commit("Move");
  };
  /** Scale along a model axis to `factor` (1 = as loaded); with `uniform`, every axis by the same ratio. */
  const setScale = (axis: 0 | 1 | 2, factor: number) => {
    if (!selected) return;
    const f = THREE.MathUtils.clamp(Math.abs(factor), MIN_SCALE, MAX_SCALE);
    const s = selected.scale.clone();
    const current = Math.abs(s.getComponent(axis)) || 1;
    if (uniformScale) {
      const ratio = f / current;
      for (const a of [0, 1, 2] as const)
        s.setComponent(a, Math.sign(s.getComponent(a)) * THREE.MathUtils.clamp(Math.abs(s.getComponent(a)) * ratio, MIN_SCALE, MAX_SCALE));
    } else s.setComponent(axis, Math.sign(s.getComponent(axis)) * f);
    selected.setScale(s);
    commit("Scale");
  };
  /**
   * Make the part `mm` long along a scene axis: uniformly, or by scaling
   * the model axis that lies most along it.
   */
  const setSize = (axis: 0 | 1 | 2, mm: number) => {
    if (!selected || !sizeMm || mm <= 0) return;
    const ratio = mm / (sizeMm.getComponent(axis) || 1);
    if (uniformScale) {
      setScale(0, Math.abs(selected.scale.x) * ratio);
      return;
    }
    const r = new THREE.Matrix4().makeRotationFromQuaternion(selected.quaternion).elements;
    // Column j of R is model axis j in the scene; its component on `axis` is r[j*4 + axis].
    let best: 0 | 1 | 2 = 0;
    for (const j of [1, 2] as const) if (Math.abs(r[j * 4 + axis]) > Math.abs(r[best * 4 + axis])) best = j;
    setScale(best, Math.abs(selected.scale.getComponent(best)) * ratio);
  };
  const copiesOfSelected = selected ? parts.filter((p) => p.shape === selected.shape).length : 0;
  const problemHere = plateProblem(here, shown.length > 1);

  return (
    <div
      className={`model-viewer ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onPointerDownCapture={startBoxSelect}
    >
      {selectBox && (
        <div
          className="select-box"
          style={{
            left: selectBox.ox + Math.min(selectBox.x0, selectBox.x1),
            top: selectBox.oy + Math.min(selectBox.y0, selectBox.y1),
            width: Math.abs(selectBox.x1 - selectBox.x0),
            height: Math.abs(selectBox.y1 - selectBox.y0),
          }}
        />
      )}
      <input
        ref={inputRef}
        type="file"
        accept={MODEL_TYPES}
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          void addFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />

      {parts.length === 0 && (
        <div className="drop-prompt" onClick={() => inputRef.current?.click()}>
          <p>{loading ? "Loading model…" : "Drop model files here or click to browse"}</p>
          <p className="hint">STL, 3MF · several files make several parts on one plate; add plates for more</p>
          {error && (
            <p className="hint" style={{ color: "var(--error)" }}>
              {error}
            </p>
          )}
        </div>
      )}

      {parts.length > 0 && (
        <div className="viewer-top">
          <div className="viewer-toolbar">
            <button onClick={undo} disabled={!undoable.undo} title={undoable.undo ? `Undo ${undoable.undo} (Ctrl+Z)` : "Undo (Ctrl+Z)"}>
              Undo
            </button>
            <button onClick={redo} disabled={!undoable.redo} title={undoable.redo ? `Redo ${undoable.redo} (Ctrl+Shift+Z)` : "Redo (Ctrl+Shift+Z)"}>
              Redo
            </button>
            <span className="toolbar-sep" />
            {TOOLS.map((t) => (
              <button
                key={t.tool}
                className={tool === t.tool && !painting ? "active" : ""}
                disabled={!selected && t.tool !== "measure"}
                onClick={() => {
                  setPainting(null);
                  if (t.tool === "measure") setMeasurePoints([]);
                  setTool(tool === t.tool && !painting ? "none" : t.tool);
                  if (t.tool === "cut") startCut();
                }}
              >
                {t.label} <kbd>{t.key}</kbd>
              </button>
            ))}
            <span className="toolbar-sep" />
            <button onClick={center} disabled={!selected}>
              Center
            </button>
            <button onClick={resetOrientation} disabled={!selected}>
              Reset rotation
            </button>
            <button onClick={autoOrient} disabled={!selected} title="Turn it the way it prints best: least overhang, most on the plate">
              Auto orient <kbd>O</kbd>
            </button>
            <span className="toolbar-sep" />
            {PAINT_TOOLS.map((t) => (
              <button
                key={t.kind}
                className={painting === t.kind ? "active" : ""}
                disabled={!selected}
                onClick={() => togglePaint(t.kind)}
                title={`Paint ${t.label.toLowerCase()} on the selected model`}
              >
                {t.label} <kbd>{t.key}</kbd>
              </button>
            ))}
          </div>
          <div className="viewer-toolbar">
            <button onClick={() => inputRef.current?.click()} title="Load more model files onto this plate">
              {loading ? "Loading…" : "Add parts…"}
            </button>
            <button onClick={duplicate} disabled={!selected} title="Another copy of the selected parts, in free space">
              Duplicate
            </button>
            <button onClick={fill} disabled={!selected} title="As many copies of the selected part as fit">
              Fill plate
            </button>
            <button onClick={arrangeAll} title="Pack every part on this plate; what doesn't fit goes onto new plates">
              Arrange <kbd>A</kbd>
            </button>
            <button
              className={showOverhangs ? "active" : ""}
              onClick={() => setShowOverhangs((v) => !v)}
              title="Paint what hangs over nothing: amber where supports will hold it, red where it would print in the air"
            >
              Overhangs
            </button>
            <span className="toolbar-sep" />
            <button onClick={remove} disabled={!selected} title="Remove the selected parts">
              Delete <kbd>Del</kbd>
            </button>
            <button onClick={clear} title="Remove every part from every plate">
              Clear
            </button>
          </div>
          <div className="viewer-toolbar plate-tabs" role="tablist" aria-label="Plates">
            {status.plates.map((facts, i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === active}
                className={`${i === active ? "active" : ""} ${plateProblem(facts, true) ? "plate-bad" : ""}`}
                onClick={() => showPlate(i)}
                title={`Plate ${i + 1}: ${facts.parts} ${facts.parts === 1 ? "part" : "parts"}${plateProblem(facts, true) ? ` · ${plateProblem(facts, facts.parts > 1)}` : ""}`}
              >
                Plate {i + 1}
                {facts.parts > 0 ? <span className="plate-count">{facts.parts}</span> : <span className="plate-count">empty</span>}
              </button>
            ))}
            <button onClick={addPlate} title="Another plate (sliced and sent with the others)">
              + Plate
            </button>
            {selected && (plateCount > 1 || shown.length > 1) && (
              <select
                className="plate-move"
                value=""
                aria-label="Move the selected parts to another plate"
                onChange={(e) => moveToPlate(Number(e.target.value))}
              >
                <option value="" disabled>
                  Move to…
                </option>
                {status.plates.map((_, i) =>
                  i === active ? null : (
                    <option key={i} value={i}>
                      Plate {i + 1}
                    </option>
                  ),
                )}
                <option value={plateCount}>A new plate</option>
              </select>
            )}
            {plateCount > 1 && (
              <button onClick={deletePlate} title="Delete this plate and its parts">
                Delete plate
              </button>
            )}
          </div>
          <div className="viewer-hint">
            {plateCount > 1 && `Plate ${active + 1} of ${plateCount} · `}
            {shown.length > 1 && `${shown.length} parts · `}
            {shown.length === 0 ? "This plate is empty: add parts, or move a part here" : TOOL_HINTS[tool]}
          </div>
          {error && <div className="viewer-hint viewer-hint-error">{error}</div>}
          {problemHere ? (
            <div className="viewer-fit-warning">
              {problemHere} It can't be sliced like this.
              {(() => {
                const big = shown.find((p) => tooBig(p));
                return big ? (
                  <button onClick={() => cutToFit(big)} title="Cut it into as few pieces as fit, with plugs to join them">
                    Cut to fit
                  </button>
                ) : null;
              })()}
              {shown.length > 1 ? (
                <button onClick={arrangeAll}>Arrange</button>
              ) : (
                <button onClick={center}>Move to center</button>
              )}
            </div>
          ) : (
            elsewhere >= 0 && (
              <div className="viewer-fit-warning">
                Plate {elsewhere + 1}: {plateProblem(status.plates[elsewhere], status.plates[elsewhere].parts > 1)}
                <button onClick={() => showPlate(elsewhere)}>Show plate {elsewhere + 1}</button>
              </div>
            )
          )}
        </div>
      )}

      {notice && <div className={`viewer-notice ${notice.bad ? "bad" : ""}`}>{notice.text}</div>}

      {selected && painting && (
        <PaintControls
          settings={paintSettings}
          onChange={setPaintSettings}
          colors={colors}
          filamentCount={filamentCount}
          onClear={clearPaint}
        />
      )}

      {selected && !painting && tool === "cut" && (
        <CutControls
          settings={cutSettings}
          onChange={setCutSettings}
          maxHeight={selected.worldBox().max.z}
          onCut={doCut}
          onCutToFit={tooBig(selected) ? () => cutToFit(selected) : null}
          canConnect={cutSettings.keep === "both"}
        />
      )}

      {tool === "measure" && !painting && (
        <MeasureControls
          points={measurePoints}
          mode={measureMode}
          onMode={(m) => {
            setMeasureMode(m);
            setMeasurePoints([]);
          }}
          onClear={() => setMeasurePoints([])}
          origin={shape.center}
        />
      )}

      {group.length > 1 && !painting && tool !== "cut" && tool !== "measure" && (
        <div className="placement-panel">
          <div className="placement-size">
            {group.length} parts selected · Ctrl+click adds or takes one out · the tools turn {selected?.name}
          </div>
          {(() => {
            const b = groupBox();
            const mid = b.getCenter(new THREE.Vector3());
            const size = b.getSize(new THREE.Vector3());
            return (
              <>
                <div className="placement-row">
                  <span className="placement-label">Position</span>
                  <NumberField label="X" value={mid.x + shape.center.x} digits={2} onCommit={(v) => setGroupPosition(0, v)} />
                  <NumberField label="Y" value={mid.y + shape.center.y} digits={2} onCommit={(v) => setGroupPosition(1, v)} />
                  <span className="placement-unit">mm</span>
                </div>
                <div className="placement-row">
                  <span className="placement-label">Size</span>
                  <span>
                    {size.x.toFixed(1)} × {size.y.toFixed(1)} × {size.z.toFixed(1)} mm
                  </span>
                </div>
              </>
            );
          })()}
          <div className="placement-row">
            <button className="btn-sm" onClick={duplicate} title="Another copy of each, in free space">
              Duplicate
            </button>
            <button className="btn-sm" onClick={mergeSelected} title="Make them one model, its parts where they are">
              Merge into one model
            </button>
            <button className="btn-sm btn-danger" onClick={remove}>
              Delete
            </button>
          </div>
        </div>
      )}

      {selected && group.length === 1 && !painting && tool !== "cut" && tool !== "measure" && box && sizeMm && euler && (
        <div className="placement-panel">
          {(shown.length > 1 || copiesOfSelected > 1) && (
            <div className="placement-size">
              {selected.name}
              {copiesOfSelected > 1 && ` (${copiesOfSelected} copies)`}
            </div>
          )}
          <div className="placement-row">
            <span className="placement-label">Position</span>
            <NumberField label="X" value={selected.center.x + shape.center.x} digits={2} onCommit={(v) => setPosition(0, v)} />
            <NumberField label="Y" value={selected.center.y + shape.center.y} digits={2} onCommit={(v) => setPosition(1, v)} />
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
          <div className="placement-row">
            <span className="placement-label">Scale</span>
            {([0, 1, 2] as const).map((a) => (
              <NumberField
                key={a}
                label={"XYZ"[a]}
                value={Math.abs(selected.scale.getComponent(a)) * 100}
                digits={1}
                onCommit={(v) => setScale(a, v / 100)}
              />
            ))}
            <span className="placement-unit">%</span>
            <label className="placement-check" title="Scale every axis together">
              <input type="checkbox" checked={uniformScale} onChange={(e) => setUniformScale(e.target.checked)} />
              Uniform
            </label>
          </div>
          <div className="placement-row">
            <span className="placement-label">Size</span>
            {([0, 1, 2] as const).map((a) => (
              <NumberField key={a} label={"XYZ"[a]} value={sizeMm.getComponent(a)} digits={1} onCommit={(v) => setSize(a, v)} />
            ))}
            <span className="placement-unit">mm</span>
          </div>
          <div className="placement-row">
            <span className="placement-label">Mirror</span>
            {([0, 1, 2] as const).map((a) => (
              <button key={a} className="btn-sm" onClick={() => mirror(a)} title={`Mirror along ${"XYZ"[a]}`}>
                {"XYZ"[a]}
              </button>
            ))}
          </div>
        </div>
      )}

      <ObjectPanel
        models={modelsOnPlates}
        selected={selected?.shape ?? null}
        volumeId={volumeId}
        colors={colors}
        filamentCount={filamentCount}
        onSelect={selectShape}
        onSelectVolume={setVolumeId}
        onEdit={editShape}
        onSplit={splitModel}
        onMerge={mergeModels}
      />

      <Canvas
        camera={{ position: [0, -330, 260], up: [0, 0, 1], fov: 45, near: 1, far: 5000 }}
        onPointerMissed={(e) => {
          // A click on empty space (not a drag of the view) lets go of the selection.
          if (e.button !== 0 || e.ctrlKey || e.metaKey || painting || tool === "measure" || tool === "cut") return;
          setSelectedId(null);
        }}
      >
        <Scene
          parts={shown}
          selected={selected}
          group={group}
          measure={tool === "measure" && !painting ? { mode: measureMode, points: measurePoints } : null}
          onMeasure={addMeasurePoint}
          stateRef={sceneState}
          bed={shape}
          tool={tool}
          paint={painting ? paintSettings : null}
          paintNow={paintNow}
          cut={cutPreview}
          heightMarks={heightMarks.filter((m) => !m.plate || m.plate === active + 1)}
          onSelect={select}
          onStroke={recordPaint}
          onCutSettings={setCutSettings}
          onChange={() => {
            followGroup();
            refresh();
          }}
          onCommit={() => commit(tool === "rotate" ? "Rotate" : tool === "flat" ? "Lay on face" : "Move")}
        />
      </Canvas>
    </div>
  );
}
