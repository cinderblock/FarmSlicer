// Two slices compared (plans/slice-history-and-diff.md): A, the slice on
// screen, and B, one picked from the recent slices.
//
// - Overlay: both in one view. "Differences" draws A in amber, then B
//   twice: with an equal-depth test in grey (where B's path lands exactly on
//   A's visible one, both have it), then with a less-than test in blue
//   (where B is in front: only B has it). Identical paths make identical
//   triangles from the same shader, so their depths match exactly; what's
//   left amber only A has. "A" / "B" show one of them in its own colours.
// - Side by side: one view each, one camera (moving either moves both).
//
// Heights are matched by Z, not by layer number: one slider over every
// layer height of either slice, each view showing its layers up to there
// (comparing layer heights is common). Next to the views: the numbers (time,
// filament, layers, time per feature) and the settings that differ.

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { useJson } from "../../api";
import { configDiff, firstLayerFrom, heightStops, layerAtZ, percentChange, type Change } from "../../sliceHistory";
import { useSliceGcode, type SliceGcode } from "../sliceGcode";
import Bed from "../viewer/Bed";
import { DEFAULT_BED, sceneBed, type Bed as BedShape, type SceneBed } from "../viewer/part";
import { COLOR_MODES, RANGE_COLORS, gradientRange, toolColors, unionRange, type ColorMode } from "./colors";
import { formatSeconds } from "./format";
import { GcodeLoading } from "./GcodePreview";
import { useGcode } from "./useGcode";
import LayerSlider from "./LayerSlider";
import { autoMode, Toolpaths, type RenderMode, type ViewRange } from "./scene";
import type { ParsedGcode } from "./types";

export interface CompareSide {
  jobId: string;
  /** What the side is called in the view ("12:41 PM"). */
  label: string;
  /** Plate 1's bytes, when this page just sliced them. */
  fresh?: Uint8Array | null;
}

interface Props {
  a: CompareSide;
  b: CompareSide;
  plate: number;
  /** The printer's bed, for files whose header has none. */
  bed?: BedShape | null;
  onSwap: () => void;
  onClose: () => void;
}

/** Overlay colours: only in A, in both, only in B. */
const ONLY_A = "#f0a030";
const BOTH = "#8b949e";
const ONLY_B = "#3d8bfd";

const LOADING = { status: "loading", progress: null } as const;

export default function SliceCompare({ a, b, plate, ...rest }: Props) {
  // Plate 1 is the job's own G-code file; the others are read from its package.
  const srcA = useSliceGcode(a.jobId, plate, plate > 1, a.fresh);
  const srcB = useSliceGcode(b.jobId, plate, plate > 1, b.fresh);
  if (!srcA || !srcB) return <GcodeLoading load={LOADING} />;
  return <CompareLoad srcA={srcA} srcB={srcB} a={a} b={b} plate={plate} {...rest} />;
}

function CompareLoad({ srcA, srcB, ...props }: Props & { srcA: SliceGcode; srcB: SliceGcode }) {
  const la = useGcode(srcA.source, { cacheKey: srcA.cacheKey, onBytes: srcA.onBytes });
  const lb = useGcode(srcB.source, { cacheKey: srcB.cacheKey, onBytes: srcB.onBytes });
  if (la.status !== "ready") return <GcodeLoading load={la} />;
  if (lb.status !== "ready") return <GcodeLoading load={lb} />;
  return <CompareView key={`${la.id}-${lb.id}`} pa={la.parsed} pb={lb.parsed} {...props} />;
}

// ---- the view ---------------------------------------------------------------------------

type Mode = "overlay" | "side";
type Show = "both" | "a" | "b";

const NOTHING_HIDDEN: ReadonlySet<number> = new Set();

/** What a file shows between two heights: its layers whose tops are in [zBottom, zTop]. */
function viewAt(p: ParsedGcode, zBottom: number, zTop: number, travel: boolean): ViewRange {
  const { layers } = p;
  const view = { hidden: NOTHING_HIDDEN, travel, retractions: false, dim: false };
  // Nothing of this file is that low (its first layer is thicker): an empty range.
  if (layers.count === 0 || layers.z[0] > zTop + 1e-3) return { ...view, bottom: 0, top: 0, upTo: 0 };
  const top = layerAtZ(layers.z, layers.count, zTop);
  const bottom = Math.min(top, firstLayerFrom(layers.z, layers.count, zBottom));
  return { ...view, bottom, top, upTo: layers.extrusionStart[top + 1] };
}

/** Both files' model bounds on the bed (scene coordinates). */
function sceneBox(parts: { p: ParsedGcode; bed: SceneBed }[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const { p, bed } of parts) {
    const b = p.info.modelBounds ?? p.info.bounds;
    if (!b) continue;
    const shift = new THREE.Vector3(-bed.center.x, -bed.center.y, 0);
    box.union(new THREE.Box3(new THREE.Vector3(...b.min).add(shift), new THREE.Vector3(...b.max).add(shift)));
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(-20, -20, 0), new THREE.Vector3(20, 20, 10));
  return box;
}

interface ViewProps extends Omit<Props, "plate"> {
  pa: ParsedGcode;
  pb: ParsedGcode;
}

function CompareView({ pa, pb, a, b, bed, onSwap, onClose }: ViewProps) {
  const [mode, setMode] = useState<Mode>("overlay");
  const [show, setShow] = useState<Show>("both");
  const [colorMode, setColorMode] = useState<ColorMode>("feature");
  const [travel, setTravel] = useState(false);
  const stops = useMemo(() => heightStops(pa.layers.z, pa.layers.count, pb.layers.z, pb.layers.count), [pa, pb]);
  const last = Math.max(0, stops.length - 1);
  const [range, setRange] = useState({ bottom: 0, top: last });

  // One way of drawing for both (the overlay compares their triangles).
  const renderMode: RenderMode = autoMode(pa.extrusions.count) === "lines" || autoMode(pb.extrusions.count) === "lines" ? "lines" : "beads";
  const ta = useMemo(() => new Toolpaths(pa, renderMode), [pa, renderMode]);
  const tb = useMemo(() => new Toolpaths(pb, renderMode), [pb, renderMode]);
  useEffect(() => () => ta.dispose(), [ta]);
  useEffect(() => () => tb.dispose(), [tb]);

  const bedA = useMemo(() => sceneBed(pa.info.bed ?? bed ?? DEFAULT_BED), [pa, bed]);
  const bedB = useMemo(() => sceneBed(pb.info.bed ?? bed ?? DEFAULT_BED), [pb, bed]);
  const box = useMemo(() => sceneBox([{ p: pa, bed: bedA }, { p: pb, bed: bedB }]), [pa, pb, bedA, bedB]);

  // Their own colours, gradients on one scale.
  useEffect(() => {
    const gradient = unionRange(gradientRange(pa, colorMode), gradientRange(pb, colorMode)) ?? undefined;
    ta.recolor(colorMode, toolColors(pa), gradient);
    tb.recolor(colorMode, toolColors(pb), gradient);
  }, [ta, tb, pa, pb, colorMode]);

  const zBottom = stops[range.bottom] ?? 0;
  const zTop = stops[range.top] ?? 0;
  const diffing = mode === "overlay" && show === "both";
  const viewA = useMemo(() => viewAt(pa, zBottom, zTop, travel && !diffing), [pa, zBottom, zTop, travel, diffing]);
  const viewB = useMemo(() => viewAt(pb, zBottom, zTop, travel && !diffing), [pb, zBottom, zTop, travel, diffing]);
  useEffect(() => ta.setView(viewA), [ta, viewA]);
  useEffect(() => tb.setView(viewB), [tb, viewB]);
  // What the canvases draw changed: they draw again when this does.
  const version = `${zBottom}:${zTop}:${travel}:${colorMode}:${show}:${mode}`;

  const setLayers = (bottom: number, top: number) => {
    const lo = Math.max(0, Math.min(last, bottom));
    setRange({ bottom: lo, top: Math.max(lo, Math.min(last, top)) });
  };
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowUp") setLayers(range.bottom, range.top + step);
    else if (e.key === "ArrowDown") setLayers(range.bottom, range.top - step);
    else if (e.key === "1") setShow("a");
    else if (e.key === "2") setShow("b");
    else if (e.key === "3") setShow("both");
    else return;
    e.preventDefault();
  };
  const layerOf = (p: ParsedGcode, v: ViewRange) =>
    p.layers.count === 0 || p.layers.z[0] > zTop + 1e-3 ? "no layer yet" : `layer ${v.top + 1} / ${p.layers.count}`;

  return (
    <div className="gcode-preview slice-compare">
      <div className="gp-viewport" tabIndex={0} onKeyDown={key} aria-label="Comparing two slices: arrow keys change the height; 1, 2, 3 show A, B, the differences">
        {mode === "overlay" ? (
          <Canvas frameloop="demand" camera={{ position: [0, -330, 260], up: [0, 0, 1], fov: 45, near: 0.5, far: 5000 }} dpr={[1, 2]}>
            <OverlayScene ta={ta} tb={tb} bedA={bedA} bedB={bedB} show={show} box={box} version={version} />
          </Canvas>
        ) : (
          <SideBySide ta={ta} tb={tb} bedA={bedA} bedB={bedB} box={box} version={version} labels={[a.label, b.label]} />
        )}
        <div className="gp-readout">
          <strong>Z {zTop.toFixed(2)} mm</strong>
          <span className="cmp-a">A: {layerOf(pa, viewA)}</span>
          <span className="cmp-b">B: {layerOf(pb, viewB)}</span>
        </div>
        {stops.length > 0 && (
          <LayerSlider count={stops.length} bottom={range.bottom} top={range.top} onChange={setLayers} label={(i) => `${stops[i]?.toFixed(2)} mm`} />
        )}
      </div>

      <aside className="gp-side">
        <section className="cmp-controls">
          <div className="cmp-sides">
            <span className="cmp-a">A · {a.label}</span>
            <button className="btn-sm" onClick={onSwap} title="Swap A and B">
              ⇄
            </button>
            <span className="cmp-b">B · {b.label}</span>
          </div>
          <div className="cmp-buttons" role="group" aria-label="Layout">
            <button className={`btn-sm${mode === "overlay" ? " active" : ""}`} aria-pressed={mode === "overlay"} onClick={() => setMode("overlay")}>
              Overlay
            </button>
            <button className={`btn-sm${mode === "side" ? " active" : ""}`} aria-pressed={mode === "side"} onClick={() => setMode("side")}>
              Side by side
            </button>
          </div>
          {mode === "overlay" && (
            <div className="cmp-buttons" role="group" aria-label="Show">
              {(
                [
                  ["both", "Differences", "3"],
                  ["a", "A", "1"],
                  ["b", "B", "2"],
                ] as const
              ).map(([value, label, k]) => (
                <button key={value} className={`btn-sm${show === value ? " active" : ""}`} aria-pressed={show === value} onClick={() => setShow(value)} title={`Key ${k}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {diffing ? (
            <ul className="gp-legend-list">
              <li className="gp-legend-item static">
                <span className="gp-swatch" style={{ background: BOTH }} /> In both
              </li>
              <li className="gp-legend-item static">
                <span className="gp-swatch" style={{ background: ONLY_A }} /> Only in A
              </li>
              <li className="gp-legend-item static">
                <span className="gp-swatch" style={{ background: ONLY_B }} /> Only in B
              </li>
            </ul>
          ) : (
            <>
              <label className="gp-color-mode">
                Colour by{" "}
                <select value={colorMode} onChange={(e) => setColorMode(e.target.value as ColorMode)}>
                  {COLOR_MODES.map((m) => (
                    <option key={m.mode} value={m.mode}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              {(colorMode === "speed" || colorMode === "layerTime") && (
                <div className="gp-gradient-bar" style={{ background: `linear-gradient(to right, ${RANGE_COLORS.join(", ")})` }} title="One scale for both" />
              )}
              <label>
                <input type="checkbox" checked={travel} onChange={(e) => setTravel(e.target.checked)} /> Travel moves
              </label>
            </>
          )}
          <button className="btn-sm" onClick={onClose}>
            Stop comparing
          </button>
        </section>
        <Numbers pa={pa} pb={pb} />
        <SettingsDiff a={a.jobId} b={b.jobId} />
      </aside>
    </div>
  );
}

// ---- inside the canvases --------------------------------------------------------------------

/** Point the camera at the box from the front, above (as the single preview does). */
function useFraming(box: THREE.Box3, bedSpan: number) {
  const get = useThree((s) => s.get);
  const controls = useThree((s) => s.controls);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const cam = get().camera as THREE.PerspectiveCamera;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius * 1.2, bedSpan * 0.3, 20);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2));
    cam.position.copy(sphere.center).add(new THREE.Vector3(0, -0.78, 0.62).multiplyScalar(distance));
    cam.lookAt(sphere.center);
    const orbit = controls as unknown as { target: THREE.Vector3; update(): void } | null;
    orbit?.target.copy(sphere.center);
    orbit?.update();
    invalidate();
  }, [box, bedSpan, get, controls, invalidate]);
}

const span = (bed: SceneBed) => Math.max(bed.max.x - bed.min.x, bed.max.y - bed.min.y);

function Lights() {
  return (
    <>
      <ambientLight intensity={0.35} />
      <hemisphereLight args={["#ffffff", "#30363d", 0.6]} position={[0, 0, 1]} />
      <directionalLight position={[0, -300, 400]} intensity={1.2} />
    </>
  );
}

function Controls({ onChange }: { onChange?: () => void }) {
  // Direct control, CAD style, as in the other views: no damping.
  return (
    <OrbitControls
      makeDefault
      enableDamping={false}
      zoomToCursor
      mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }}
      onChange={onChange}
    />
  );
}

interface OverlayProps {
  ta: Toolpaths;
  tb: Toolpaths;
  bedA: SceneBed;
  bedB: SceneBed;
  show: Show;
  box: THREE.Box3;
  version: string;
}

function OverlayScene({ ta, tb, bedA, bedB, show, box, version }: OverlayProps) {
  const invalidate = useThree((s) => s.invalidate);
  useFraming(box, span(bedA));
  // What the main scene holds (the bed, A or B), and B on its own for the
  // passes drawn over it.
  const holder = useMemo(() => new THREE.Group(), []);
  const overB = useMemo(() => new THREE.Scene(), []);

  useEffect(() => {
    ta.group.position.set(-bedA.center.x, -bedA.center.y, 0);
    tb.group.position.set(-bedB.center.x, -bedB.center.y, 0);
    holder.add(show === "b" ? tb.group : ta.group);
    if (show === "both") overB.add(tb.group);
    ta.setTint(show === "both" ? ONLY_A : null);
    invalidate();
    return () => {
      holder.clear();
      overB.clear();
      ta.setTint(null);
      tb.setTint(null);
      tb.setDepth(THREE.LessEqualDepth, true);
    };
  }, [ta, tb, bedA, bedB, show, holder, overB, invalidate]);
  useEffect(() => invalidate(), [version, invalidate]);

  // Priority 1: this draws the frame (react-three-fiber leaves it to us).
  useFrame(({ gl, scene, camera }) => {
    gl.autoClear = false;
    gl.clear();
    gl.render(scene, camera);
    if (show !== "both") return;
    tb.setTint(BOTH);
    tb.setDepth(THREE.EqualDepth, false);
    gl.render(overB, camera);
    tb.setTint(ONLY_B);
    tb.setDepth(THREE.LessDepth, true);
    gl.render(overB, camera);
    tb.setDepth(THREE.LessEqualDepth, true);
  }, 1);

  return (
    <>
      <Lights />
      <Bed bed={bedA} />
      <primitive object={holder} />
      <Controls />
    </>
  );
}

/** Two views moving as one: what one camera does, the other copies. */
class CameraLink {
  private views = new Set<{ camera: THREE.Camera; controls: { target: THREE.Vector3; update(): void }; invalidate: () => void }>();
  private busy = false;

  join(v: { camera: THREE.Camera; controls: { target: THREE.Vector3; update(): void }; invalidate: () => void }): () => void {
    this.views.add(v);
    return () => this.views.delete(v);
  }

  moved(camera: THREE.Camera): void {
    if (this.busy) return;
    const from = [...this.views].find((v) => v.camera === camera);
    if (!from) return;
    this.busy = true;
    for (const v of this.views) {
      if (v === from) continue;
      v.camera.position.copy(from.camera.position);
      v.camera.up.copy(from.camera.up);
      v.controls.target.copy(from.controls.target);
      v.controls.update();
      v.invalidate();
    }
    this.busy = false;
  }
}

interface SideProps {
  ta: Toolpaths;
  tb: Toolpaths;
  bedA: SceneBed;
  bedB: SceneBed;
  box: THREE.Box3;
  version: string;
  labels: [string, string];
}

function SideBySide({ ta, tb, bedA, bedB, box, version, labels }: SideProps) {
  const link = useMemo(() => new CameraLink(), []);
  return (
    <div className="cmp-side-by-side">
      {(
        [
          [ta, bedA, "A", labels[0]],
          [tb, bedB, "B", labels[1]],
        ] as const
      ).map(([t, bed, side, label]) => (
        <div key={side} className="cmp-pane">
          <Canvas frameloop="demand" camera={{ position: [0, -330, 260], up: [0, 0, 1], fov: 45, near: 0.5, far: 5000 }} dpr={[1, 2]}>
            <LinkedScene toolpaths={t} bed={bed} box={box} link={link} version={version} />
          </Canvas>
          <span className={`cmp-pane-label cmp-${side.toLowerCase()}`}>
            {side} · {label}
          </span>
        </div>
      ))}
    </div>
  );
}

function LinkedScene({ toolpaths, bed, box, link, version }: { toolpaths: Toolpaths; bed: SceneBed; box: THREE.Box3; link: CameraLink; version: string }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update(): void } | null;
  const invalidate = useThree((s) => s.invalidate);
  useFraming(box, span(bed));
  useEffect(() => {
    if (!controls) return;
    return link.join({ camera, controls, invalidate });
  }, [link, camera, controls, invalidate]);
  useEffect(() => {
    toolpaths.group.position.set(-bed.center.x, -bed.center.y, 0);
    invalidate();
  }, [toolpaths, bed, invalidate]);
  useEffect(() => invalidate(), [version, invalidate]);
  return (
    <>
      <Lights />
      <Bed bed={bed} />
      <primitive object={toolpaths.group} />
      <Controls onChange={() => link.moved(camera)} />
    </>
  );
}

// ---- numbers and settings ------------------------------------------------------------------------

/** Seconds per feature name (indexes differ between files), travel included. */
function featureTimes(p: ParsedGcode): Map<string, number> {
  const m = new Map<string, number>();
  p.info.features.forEach((name, i) => {
    const t = p.info.featureTime[i] ?? 0;
    if (t > 0) m.set(name, (m.get(name) ?? 0) + t);
  });
  if (p.info.travelTime > 0) m.set("Travel", p.info.travelTime);
  return m;
}

const grams = (p: ParsedGcode) => {
  const known = p.info.filament.filter((f) => f.g !== null);
  return known.length ? known.reduce((n, f) => n + (f.g ?? 0), 0) : null;
};
const metres = (p: ParsedGcode) => p.info.filament.reduce((n, f) => n + f.mm, 0) / 1000;
const height = (p: ParsedGcode) => p.info.bounds?.max[2] ?? 0;

function Numbers({ pa, pb }: { pa: ParsedGcode; pb: ParsedGcode }) {
  const rows = useMemo(() => {
    // `cost`: more is worse (coloured).
    const out: { label: string; a: number | null; b: number | null; fmt: (v: number) => string; sub?: boolean; cost?: boolean }[] = [
      { label: "Print time", a: pa.info.totalTime, b: pb.info.totalTime, fmt: formatSeconds, cost: true },
      { label: "Filament", a: grams(pa), b: grams(pb), fmt: (v) => `${v.toFixed(1)} g`, cost: true },
      { label: "Filament length", a: metres(pa), b: metres(pb), fmt: (v) => `${v.toFixed(2)} m`, cost: true },
      { label: "Layers", a: pa.layers.count, b: pb.layers.count, fmt: (v) => String(v) },
      { label: "Height", a: height(pa), b: height(pb), fmt: (v) => `${v.toFixed(2)} mm` },
    ];
    const fa = featureTimes(pa);
    const fb = featureTimes(pb);
    for (const name of new Set([...fa.keys(), ...fb.keys()]))
      out.push({ label: name, a: fa.get(name) ?? 0, b: fb.get(name) ?? 0, fmt: formatSeconds, sub: true });
    return out;
  }, [pa, pb]);
  return (
    <section className="cmp-numbers">
      <h4>Numbers</h4>
      <table>
        <thead>
          <tr>
            <th />
            <th className="cmp-a">A</th>
            <th className="cmp-b">B</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={r.sub ? "cmp-sub" : undefined}>
              <th scope="row">{r.label}</th>
              <td>{r.a === null ? "—" : r.fmt(r.a)}</td>
              <td>{r.b === null ? "—" : r.fmt(r.b)}</td>
              <td className={r.cost && r.a !== null && r.b !== null && r.b !== r.a ? (r.b > r.a ? "cmp-more" : "cmp-less") : undefined}>
                {r.a === null || r.b === null ? "" : r.a === r.b ? "same" : percentChange(r.a, r.b)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Time per feature as the G-code says (the slicer's estimate, spread over its moves).</p>
    </section>
  );
}

/** Settings shown before "N more". */
const FIRST_SETTINGS = 10;

function ChangeRow({ c }: { c: Change }) {
  const cut = (v: string | null) => (v === null ? "—" : v.length > 48 ? `${v.slice(0, 47)}…` : v);
  return (
    <li title={`${c.key}\nA: ${c.a ?? "(not set)"}\nB: ${c.b ?? "(not set)"}`}>
      <span className="cmp-setting">{c.label}</span>
      <span className="cmp-a">{cut(c.a)}</span>
      <span aria-hidden="true">→</span>
      <span className="cmp-b">{cut(c.b)}</span>
    </li>
  );
}

function SettingsDiff({ a, b }: { a: string; b: string }) {
  const ja = useJson<{ config_json: string | null }>(`/api/jobs/${a}`).data;
  const jb = useJson<{ config_json: string | null }>(`/api/jobs/${b}`).data;
  const changes = useMemo(() => {
    if (!ja || !jb) return null;
    const parse = (s: string | null): Record<string, unknown> => {
      try {
        return s ? JSON.parse(s) : {};
      } catch {
        return {};
      }
    };
    return configDiff(parse(ja.config_json), parse(jb.config_json));
  }, [ja, jb]);
  return (
    <section className="cmp-settings">
      <h4>Settings that differ</h4>
      {changes === null ? (
        <p className="hint">Reading the jobs…</p>
      ) : changes.length === 0 ? (
        <p className="hint">None: the same settings (the plate or the models differ).</p>
      ) : (
        <>
          <ul>
            {changes.slice(0, FIRST_SETTINGS).map((c) => (
              <ChangeRow key={c.key} c={c} />
            ))}
          </ul>
          {changes.length > FIRST_SETTINGS && (
            <details>
              <summary>{changes.length - FIRST_SETTINGS} more</summary>
              <ul>
                {changes.slice(FIRST_SETTINGS).map((c) => (
                  <ChangeRow key={c.key} c={c} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
