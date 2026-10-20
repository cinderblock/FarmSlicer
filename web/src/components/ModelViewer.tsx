import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { PlateLayout } from "../engine/types";
import Bed from "./viewer/Bed";
import { FaceTool, MoveGizmo, RotateGizmo } from "./viewer/Gizmo";
import { useBodyDrag, type GizmoProps, type Guide, type Tool } from "./viewer/drag";
import { arrange, arrangeOnPlates, fillCopies, findFreeSpot, overlapping } from "./viewer/layout";
import type { SupportCheck } from "./viewer/overhangs";
import { DEFAULT_BED, Part, PartShape, sceneBed, type Bed as BedShape, type Fit, type SceneBed } from "./viewer/part";

export type { Fit } from "./viewer/part";
export type { SupportCheck } from "./viewer/overhangs";
export type { BedShape };

/** Rotation fields: extrinsic X, then Y, then Z (libslic3r's convention). */
const EULER_ORDER = "ZYX";
/** How long a notice ("Added 12 copies") stays up (ms). */
const NOTICE_MS = 4000;

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
}

/** A model file and its shape, once per file however many copies there are. */
interface LoadedModel {
  file: File;
  shape: PartShape;
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
function plateState(parts: Part[], models: LoadedModel[], bed: SceneBed, plateCount: number): PlateState | null {
  if (parts.length === 0) return null;
  const { fit, clash } = plateStatus(parts, bed, plateCount);
  const used = models.filter((m) => parts.some((p) => p.shape === m.shape));
  const plates: PlateLayout[] = [];
  for (let i = 0; i < plateCount; i++) {
    const objects = parts
      .filter((p) => p.plate === i)
      .map((p) => ({ model: used.findIndex((m) => m.shape === p.shape), placement: p.placement() }));
    if (objects.length > 0) plates.push({ objects });
  }
  return { files: used.map((m) => m.file), plates, fit, overlaps: clash.size > 0 };
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

function PartView(props: GizmoProps & { tool: Tool; selected: boolean; onSelect: (part: Part) => void }) {
  const { part, tool, selected, onSelect } = props;
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
            onSelect(part);
            // On a touch screen the parts cover most of the view: a finger
            // landing on one orbits the camera and selects it; only a part
            // already selected is dragged.
            if (e.pointerType === "touch" && !selected) return;
            if (selected && tool === "flat") return;
            bodyDown(e);
          }}
        />
        {selected && tool === "flat" && <FaceTool {...props} />}
      </primitive>
      {selected && tool === "move" && <MoveGizmo {...props} />}
      {selected && tool === "rotate" && <RotateGizmo {...props} />}
    </>
  );
}

function Scene({
  parts,
  selected,
  bed,
  tool,
  onSelect,
  onChange,
  onCommit,
}: {
  parts: Part[];
  selected: Part | null;
  bed: SceneBed;
  tool: Tool;
  onSelect: (part: Part) => void;
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
      {parts.map((part) => (
        <PartView
          key={part.id}
          part={part}
          bed={bed}
          tool={tool}
          selected={part === selected}
          onSelect={onSelect}
          onChange={onChange}
          onCommit={onCommit}
          onGuides={setGuides}
        />
      ))}
      <Guides guides={guides} bed={bed} />
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

const MOUSE_HINTS: Record<Tool, string> = {
  none: "Click a part to select it · drag to move it",
  move: "Drag an arrow or the part · snaps to 1 mm, the bed's centre and edges · Shift: free",
  rotate: "Drag a ring · snaps to 15° · Shift: free",
  flat: "Click a face to put it on the plate",
};

/** Touch screens: no Shift, and a part is selected before it can be dragged. */
const TOUCH_HINTS: Record<Tool, string> = {
  none: "Tap a part to select it, then drag it · one finger turns the view, two pan and zoom",
  move: "Drag an arrow or the part · snaps to 1 mm, the bed's centre and edges",
  rotate: "Drag a ring · snaps to 15°",
  flat: "Tap a face to put it on the plate",
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
}) {
  const [models, setModels] = useState<LoadedModel[]>([]);
  // Every part on every plate (`Part.plate`); the view shows the active one.
  const [parts, setParts] = useState<Part[]>([]);
  const [plateCount, setPlateCount] = useState(1);
  const [active, setActive] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>("move");
  const [showOverhangs, setShowOverhangs] = useState(true);
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
      p.setLook(bad ? "error" : shown.length > 1 && p.id !== selectedId ? "idle" : "normal");
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

  /** A manipulation finished: tell the page what's on the plates. */
  const commit = useCallback(() => {
    refresh();
    setSettled((n) => n + 1);
    report.current?.(plateState(parts, models, shape, plateCount));
  }, [refresh, parts, models, shape, plateCount]);

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

  // New parts, plates, or a different printer's bed: report the plates again.
  useEffect(() => {
    report.current?.(plateState(parts, models, shape, plateCount));
  }, [parts, models, shape, plateCount]);

  // Free each part's GPU resources once it's off the plate.
  const live = useRef<Part[]>([]);
  useEffect(() => {
    for (const p of live.current) if (!parts.includes(p)) p.dispose();
    live.current = parts;
  }, [parts]);
  useEffect(() => () => live.current.forEach((p) => p.dispose()), []);

  /** Set the parts, forgetting models no part uses any more. */
  const setPlate = useCallback((next: Part[]) => {
    setParts(next);
    setModels((ms) => ms.filter((m) => next.some((p) => p.shape === m.shape)));
  }, []);

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
    [parts, active, plateCount],
  );

  /** Load model files onto the plate shown: one part each, placed in free space (centred on an empty plate). */
  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setError("");
      setLoading(true);
      try {
        const loaded: LoadedModel[] = [];
        const added: Part[] = [];
        const placed = [...shown];
        for (const file of files) {
          const s = PartShape.load(await file.arrayBuffer(), file.name);
          loaded.push({ file, shape: s });
          const part = new Part(s);
          part.setPlate(active);
          if (placed.length > 0) {
            const spot = findFreeSpot(part, placed, shape);
            if (spot) part.setCenter(spot.x, spot.y);
            else setNotice({ text: `No free room for ${file.name}: it's in the middle, overlapping`, bad: true });
          }
          added.push(part);
          placed.push(part);
        }
        setModels((ms) => [...ms, ...loaded]);
        setParts([...parts, ...added]);
        setSelectedId(added[added.length - 1].id);
        setTool("move");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load model");
      } finally {
        setLoading(false);
      }
    },
    [parts, shown, active, shape],
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
      const loaded: LoadedModel[] = [];
      for (const file of start.files) loaded.push({ file, shape: PartShape.load(await file.arrayBuffer(), file.name) });
      if (cancelled) return;
      const plates = start.plates ?? [{ objects: loaded.map((_, i) => ({ model: i, placement: null })) }];
      const next = plates.flatMap((plate, index) =>
        plate.objects
          .filter((o) => o.model < loaded.length)
          .map((o) => {
            const part = new Part(loaded[o.model].shape);
            if (o.placement) part.setPlacement(o.placement);
            part.setPlate(index);
            return part;
          }),
      );
      setModels(loaded);
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
  }, [initialKey]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      void addFiles([...e.dataTransfer.files]);
    },
    [addFiles],
  );

  const center = useCallback(() => {
    if (!selected) return;
    selected.setCenter(0, 0);
    commit();
  }, [selected, commit]);

  const resetOrientation = useCallback(() => {
    if (!selected) return;
    selected.setRotation(new THREE.Quaternion());
    commit();
  }, [selected, commit]);

  const duplicate = useCallback(() => {
    if (!selected) return;
    const copy = selected.clone();
    const spot = findFreeSpot(copy, shown, shape);
    if (!spot) {
      copy.dispose();
      setNotice({ text: "No free room on this plate for another copy: add a plate, or Arrange to spread over more", bad: true });
      return;
    }
    copy.setCenter(spot.x, spot.y);
    setParts([...parts, copy]);
    setSelectedId(copy.id);
  }, [selected, parts, shown, shape]);

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
    setParts([...parts, ...copies]);
    setNotice({ text: `Added ${copies.length} ${copies.length === 1 ? "copy" : "copies"} of ${selected.name}` });
  }, [selected, parts, shown, shape]);

  // Pack the plate shown; what doesn't fit goes onto new plates at the end.
  const arrangeAll = useCallback(() => {
    if (arrange(shown, shape)) {
      commit();
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
    setParts([...parts]);
    setNotice({ text: `They don't all fit: arranged onto ${groups.length} plates` });
  }, [shown, shape, commit, parts, active, plateCount]);

  const remove = useCallback(() => {
    if (!selected) return;
    const rest = parts.filter((p) => p !== selected);
    setPlate(rest);
    setSelectedId(rest.filter((p) => p.plate === active).at(-1)?.id ?? null);
  }, [selected, parts, active, setPlate]);

  const clear = useCallback(() => {
    setPlate([]);
    setPlateCount(1);
    setActive(0);
    setSelectedId(null);
  }, [setPlate]);

  const addPlate = useCallback(() => {
    setPlateCount(plateCount + 1);
    setActive(plateCount);
    setSelectedId(null);
  }, [plateCount]);

  /** Delete the plate shown and its parts; later plates move up. */
  const deletePlate = useCallback(() => {
    if (plateCount < 2) return;
    const rest = parts.filter((p) => p.plate !== active);
    for (const p of rest) if (p.plate > active) p.setPlate(p.plate - 1);
    setPlate(rest);
    setPlateCount(plateCount - 1);
    const next = Math.min(active, plateCount - 2);
    setActive(next);
    setSelectedId(rest.find((p) => p.plate === next)?.id ?? null);
  }, [parts, active, plateCount, setPlate]);

  /** Move the selected part to plate `target` (plateCount: a new one), in free space there; show it. */
  const moveToPlate = useCallback(
    (target: number) => {
      if (!selected || target === active) return;
      const there = parts.filter((p) => p.plate === target);
      selected.setPlate(target);
      const spot = there.length > 0 ? findFreeSpot(selected, there, shape) : new THREE.Vector2(0, 0);
      if (spot) selected.setCenter(spot.x, spot.y);
      else setNotice({ text: `No free room on plate ${target + 1}: it overlaps there`, bad: true });
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
      setParts([...parts]);
    },
    [selected, active, parts, shape, plateCount],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (parts.length === 0 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
        return;
      const key = e.key.toLowerCase();
      if (key === "escape") setTool("none");
      if (key === "delete" || key === "backspace") {
        e.preventDefault();
        remove();
        return;
      }
      if (key === "a") {
        arrangeAll();
        return;
      }
      const t = TOOLS.find((x) => x.key.toLowerCase() === key);
      if (t) setTool((cur) => (cur === t.tool ? "none" : t.tool));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [parts, remove, arrangeAll]);

  const select = useCallback((part: Part) => setSelectedId(part.id), []);

  // Panel values: absolute slicer coordinates, like the desktop slicers show.
  const box = selected?.worldBox();
  const sizeMm = box?.getSize(new THREE.Vector3());
  const euler = selected ? new THREE.Euler().setFromQuaternion(selected.quaternion, EULER_ORDER) : null;
  const setEuler = (axis: "x" | "y" | "z", degrees: number) => {
    if (!selected || !euler) return;
    const next = euler.clone();
    next[axis] = THREE.MathUtils.degToRad(degrees);
    selected.setRotation(new THREE.Quaternion().setFromEuler(next));
    commit();
  };
  const setPosition = (axis: 0 | 1, absolute: number) => {
    if (!selected) return;
    const v = absolute - (axis === 0 ? shape.center.x : shape.center.y);
    selected.setCenter(axis === 0 ? v : selected.center.x, axis === 1 ? v : selected.center.y);
    commit();
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
    >
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
            {TOOLS.map((t) => (
              <button
                key={t.tool}
                className={tool === t.tool ? "active" : ""}
                disabled={!selected}
                onClick={() => setTool(tool === t.tool ? "none" : t.tool)}
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
          </div>
          <div className="viewer-toolbar">
            <button onClick={() => inputRef.current?.click()} title="Load more model files onto this plate">
              {loading ? "Loading…" : "Add parts…"}
            </button>
            <button onClick={duplicate} disabled={!selected} title="Another copy of the selected part, in free space">
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
            <button onClick={remove} disabled={!selected} title="Remove the selected part">
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
                aria-label="Move the selected part to another plate"
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

      {selected && box && sizeMm && euler && (
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
          <div className="placement-size">
            Size {sizeMm.x.toFixed(1)} × {sizeMm.y.toFixed(1)} × {sizeMm.z.toFixed(1)} mm
          </div>
        </div>
      )}

      <Canvas camera={{ position: [0, -330, 260], up: [0, 0, 1], fov: 45, near: 1, far: 5000 }}>
        <Scene
          parts={shown}
          selected={selected}
          bed={shape}
          tool={tool}
          onSelect={select}
          onChange={refresh}
          onCommit={commit}
        />
      </Canvas>
    </div>
  );
}
