// G-code preview, like the desktop slicers' Preview tab: the toolpaths in
// 3D on the printer's bed, a layer range slider, a move scrubber for the top
// layer, colours by feature / filament / speed / layer time with a legend
// that hides feature types, travel and retraction toggles, and a summary.
//
//   <GcodePreview source={{ url: `/api/jobs/${id}/gcode?plate=1` }} />
//   <GcodePreview source={{ data: slicedBytes }} bed={bed} />  // in memory
//
// The file is downloaded and parsed in a worker (load.ts, parser.ts); the
// scene objects are in scene.ts. Coordinates: the scene is the slicer's,
// Z up, origin at the bed centre, like the Slice page's viewer; the
// toolpaths (absolute G-code coordinates) are shifted by the bed centre.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import Bed from "../viewer/Bed";
import { DEFAULT_BED, sceneBed, type Bed as BedShape, type SceneBed } from "../viewer/part";
import LayerSlider from "./LayerSlider";
import type { GcodeSource } from "./load";
import { useGcode, type GcodeLoad } from "./useGcode";
import { BEAD_BUDGET, Toolpaths, type RenderMode, type ViewRange } from "./scene";
import { COLOR_MODES, RANGE_COLORS, gradientRange, toolColors, type ColorMode } from "./colors";
import { featureColors, featureOrder } from "./features";
import { formatMegabytes as mb, formatSeconds } from "./format";
import { GAP, type GcodeInfo, type ParsedGcode } from "./types";

export type { GcodeSource } from "./load";
export type { GcodeInfo } from "./types";
export type { GcodeLoad } from "./useGcode";

export interface GcodePreviewProps {
  /**
   * The G-code: a URL (`/api/jobs/{id}/gcode?plate=N`), or text / bytes /
   * a Blob the page already holds (a browser slice). A different URL or
   * data object loads again; the same one doesn't.
   */
  source: GcodeSource;
  /**
   * Names the file: kept parsed in memory under it (load.ts), and a new
   * `source` under the same key (the bytes kept after a download) doesn't
   * load again.
   */
  cacheKey?: string;
  /** A URL's bytes, once read (for the page to keep). */
  onBytes?: (bytes: Blob) => void;
  /** The printer's bed, when the G-code's header doesn't carry `printable_area`. */
  bed?: BedShape | null;
  /** Filament colours (`#rrggbb` by slot) when the header has none. */
  filamentColors?: string[];
  /** Called once the file is read, with what the summary shows. */
  onLoaded?: (info: GcodeInfo) => void;
  /** Show the frame rate (renders continuously while shown). */
  showStats?: boolean;
  className?: string;
}

export default function GcodePreview({ source, cacheKey, onBytes, bed, filamentColors, onLoaded, showStats, className }: GcodePreviewProps) {
  const load = useGcode(source, { cacheKey, onBytes });
  const parsed = load.status === "ready" ? load.parsed : null;
  useEffect(() => {
    if (parsed) onLoaded?.(parsed.info);
  }, [parsed, onLoaded]);

  if (load.status === "ready") {
    return (
      <PreviewView
        key={load.id}
        parsed={load.parsed}
        parseMs={load.ms}
        bed={bed}
        filamentColors={filamentColors}
        showStats={showStats}
        className={className}
      />
    );
  }
  return <GcodeLoading load={load} className={className} />;
}

/** What shows while a file loads, or why it can't. */
export function GcodeLoading({ load, className }: { load: GcodeLoad; className?: string }) {
  return (
    <div className={`gcode-preview ${className ?? ""}`}>
      <div className="gp-viewport gp-status">
        {load.status === "loading" ? (
          <div className="gp-loading">
            <p>Reading the G-code…</p>
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: load.progress?.total ? `${Math.min(100, (load.progress.done / load.progress.total) * 100)}%` : "0%",
                }}
              />
            </div>
            <p className="hint">
              {load.progress
                ? load.progress.total
                  ? `${mb(load.progress.done)} of ${mb(load.progress.total)}`
                  : mb(load.progress.done)
                : "Starting…"}
            </p>
          </div>
        ) : load.status === "error" ? (
          <p className="login-error">Can't show the G-code: {load.message}</p>
        ) : null}
      </div>
    </div>
  );
}

// ---- the loaded preview ---------------------------------------------------------

interface ViewProps {
  parsed: ParsedGcode;
  parseMs: number;
  bed?: BedShape | null;
  filamentColors?: string[];
  showStats?: boolean;
  className?: string;
}

function PreviewView({ parsed, parseMs, bed, filamentColors, showStats, className }: ViewProps) {
  const { info, layers, extrusions } = parsed;
  const last = Math.max(0, layers.count - 1);
  const [range, setRange] = useState({ bottom: 0, top: last });
  /** Scrubbed position in the top layer (segment index, exclusive); null = all of it. */
  const [upTo, setUpTo] = useState<number | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>("feature");
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());
  const [travel, setTravel] = useState(false);
  const [retractions, setRetractions] = useState(false);
  const [dim, setDim] = useState(true);
  const [forceLines, setForceLines] = useState(false);

  const toolpaths = useMemo(() => new Toolpaths(parsed), [parsed]);
  useEffect(() => () => toolpaths.dispose(), [toolpaths]);
  const mode: RenderMode = forceLines ? "lines" : toolpaths.auto;
  const tooBig = toolpaths.auto === "lines";

  const shape = useMemo(() => sceneBed(info.bed ?? bed ?? DEFAULT_BED), [info.bed, bed]);
  const tools = useMemo(() => toolColors(parsed, filamentColors), [parsed, filamentColors]);

  const topStart = layers.extrusionStart[range.top] ?? 0;
  const topEnd = layers.extrusionStart[range.top + 1] ?? 0;
  const scrub = upTo === null ? topEnd : Math.max(topStart, Math.min(upTo, topEnd));
  const view: ViewRange = useMemo(
    () => ({ bottom: range.bottom, top: range.top, upTo: scrub, hidden, travel, retractions, dim }),
    [range, scrub, hidden, travel, retractions, dim],
  );

  const setLayers = (bottom: number, top: number) => {
    const b = Math.max(0, Math.min(last, bottom));
    const t = Math.max(b, Math.min(last, top));
    if (b === range.bottom && t === range.top) return;
    setRange({ bottom: b, top: t });
    if (t !== range.top) setUpTo(null);
  };
  const setScrub = (v: number) => setUpTo(v >= topEnd ? null : Math.max(topStart, v));

  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowUp") setLayers(range.bottom, range.top + step);
    else if (e.key === "ArrowDown") setLayers(range.bottom, range.top - step);
    else if (e.key === "ArrowRight") setScrub(scrub + step);
    else if (e.key === "ArrowLeft") setScrub(scrub - step);
    else return;
    e.preventDefault();
  };

  const at = scrub > topStart ? toolpaths.segmentAt(scrub - 1, topStart) : null;
  const zLabel = (l: number) => `${layers.z[l]?.toFixed(2) ?? "?"} mm`;

  return (
    <div className={`gcode-preview ${className ?? ""}`}>
      <div className="gp-viewport" tabIndex={0} onKeyDown={key} aria-label="G-code preview: arrow keys change the layer and the move">
        <Canvas frameloop="demand" camera={{ position: [0, -330, 260], up: [0, 0, 1], fov: 45, near: 0.5, far: 5000 }} dpr={[1, 2]}>
          <PreviewScene toolpaths={toolpaths} parsed={parsed} bed={shape} view={view} colorMode={colorMode} tools={tools} mode={mode} />
          {showStats && <Stats />}
        </Canvas>

        <div className="gp-readout">
          <strong>
            Layer {range.top + 1} / {layers.count}
          </strong>
          <span>Z {zLabel(range.top)}</span>
          <span>{layers.height[range.top]?.toFixed(2)} mm thick</span>
          <span>{formatSeconds(layers.time[range.top])}</span>
          {range.bottom > 0 && <span className="hint">from layer {range.bottom + 1}</span>}
        </div>
        {mode === "lines" && (
          <div className="gp-notice">
            {tooBig
              ? `Drawn as lines: ${(extrusions.count / 1e6).toFixed(1)} million moves is more than the 3D view's budget (${BEAD_BUDGET / 1e6} million).`
              : "Drawn as lines."}
          </div>
        )}
        {showStats && <div className="gp-stats" id="gp-stats" />}

        {layers.count > 0 && (
          <LayerSlider count={layers.count} bottom={range.bottom} top={range.top} onChange={setLayers} label={zLabel} />
        )}
        {topEnd > topStart && (
          <div className="gp-scrub">
            <input
              type="range"
              min={topStart}
              max={topEnd}
              value={scrub}
              onChange={(e) => setScrub(Number(e.target.value))}
              aria-label="Moves within the top layer"
            />
            <span className="gp-scrub-label">
              {scrub - topStart} / {topEnd - topStart}
              {at && (
                <>
                  {" · "}
                  {info.features[at.feature]} · {Math.round(at.speed)} mm/s · {at.width.toFixed(2)} × {at.height.toFixed(2)} mm
                  {info.toolCount > 1 && ` · T${at.tool}`}
                </>
              )}
            </span>
          </div>
        )}
      </div>

      <aside className="gp-side">
        <Legend
          parsed={parsed}
          colorMode={colorMode}
          onColorMode={setColorMode}
          hidden={hidden}
          onHidden={setHidden}
          tools={tools}
          travel={travel}
          onTravel={setTravel}
        />
        <section className="gp-options">
          <label>
            <input type="checkbox" checked={travel} onChange={(e) => setTravel(e.target.checked)} /> Travel moves
          </label>
          <label>
            <input type="checkbox" checked={retractions} onChange={(e) => setRetractions(e.target.checked)} /> Retractions
          </label>
          <label>
            <input type="checkbox" checked={dim} onChange={(e) => setDim(e.target.checked)} /> Dim layers below the top one
          </label>
          <label title={tooBig ? "This file is too big for the 3D view" : "Faster on slow graphics"}>
            <input
              type="checkbox"
              checked={mode === "lines"}
              disabled={tooBig}
              onChange={(e) => setForceLines(e.target.checked)}
            />{" "}
            Lines instead of 3D
          </label>
        </section>
        <Summary parsed={parsed} tools={tools} parseMs={parseMs} />
      </aside>
    </div>
  );
}

// ---- inside the canvas ------------------------------------------------------------

function HeadLight() {
  const light = useRef<THREE.DirectionalLight>(null);
  const { camera } = useThree();
  useFrame(() => light.current?.position.copy(camera.position));
  return <directionalLight ref={light} intensity={1.6} />;
}

interface SceneProps {
  toolpaths: Toolpaths;
  parsed: ParsedGcode;
  bed: SceneBed;
  view: ViewRange;
  colorMode: ColorMode;
  tools: string[];
  mode: RenderMode;
}

function PreviewScene({ toolpaths, parsed, bed, view, colorMode, tools, mode }: SceneProps) {
  const invalidate = useThree((s) => s.invalidate);
  const get = useThree((s) => s.get);
  const controls = useThree((s) => s.controls);
  const settle = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(settle.current), []);

  useEffect(() => {
    toolpaths.setMode(mode);
    toolpaths.recolor(colorMode, tools);
    invalidate();
  }, [toolpaths, mode, colorMode, tools, invalidate]);
  useEffect(() => {
    toolpaths.setView(view);
    invalidate();
  }, [toolpaths, view, mode, invalidate]);

  // Frame the print (not the purge lines at the bed's edge) from the front, above.
  useEffect(() => {
    const { camera } = get();
    const cam = camera as THREE.PerspectiveCamera;
    const b = parsed.info.modelBounds;
    const box = b
      ? new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)).translate(new THREE.Vector3(-bed.center.x, -bed.center.y, 0))
      : new THREE.Box3(new THREE.Vector3(bed.min.x, bed.min.y, 0), new THREE.Vector3(bed.max.x, bed.max.y, 10));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    // Small prints with some of the bed around them, for scale.
    const span = Math.max(bed.max.x - bed.min.x, bed.max.y - bed.min.y);
    const radius = Math.max(sphere.radius * 1.2, span * 0.3, 20);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2));
    cam.position.copy(sphere.center).add(new THREE.Vector3(0, -0.78, 0.62).multiplyScalar(distance));
    cam.lookAt(sphere.center);
    const orbit = controls as unknown as { target: THREE.Vector3; update(): void } | null;
    orbit?.target.copy(sphere.center);
    orbit?.update();
    invalidate();
  }, [parsed, bed, get, controls, invalidate]);

  return (
    <>
      <ambientLight intensity={0.35} />
      <hemisphereLight args={["#ffffff", "#30363d", 0.6]} position={[0, 0, 1]} />
      <HeadLight />
      <Bed bed={bed} />
      <primitive object={toolpaths.group} position={[-bed.center.x, -bed.center.y, 0]} />
      {/* Direct control, CAD style, as in the Slice page's viewer: no damping. */}
      <OrbitControls
        makeDefault
        enableDamping={false}
        zoomToCursor
        mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }}
        onStart={() => {
          clearTimeout(settle.current);
          if (toolpaths.setMoving(true)) invalidate();
        }}
        onEnd={() => {
          // The wheel ends every notch: wait for it to settle.
          clearTimeout(settle.current);
          settle.current = window.setTimeout(() => toolpaths.setMoving(false) && invalidate(), 250);
        }}
      />
    </>
  );
}

/** Frame rate and frame time, rendering continuously. */
function Stats() {
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);
  const frames = useRef<number[]>([]);
  useFrame(() => {
    const now = performance.now();
    const f = frames.current;
    f.push(now);
    while (f.length > 0 && now - f[0] > 1000) f.shift();
    const el = document.getElementById("gp-stats");
    if (el && f.length > 1) {
      const fps = ((f.length - 1) * 1000) / (now - f[0]);
      el.textContent = `${fps.toFixed(0)} fps · ${gl.info.render.calls} draws · ${(gl.info.render.triangles / 1e6).toFixed(1)} M triangles`;
    }
    invalidate();
  });
  return null;
}

// ---- legend and summary -------------------------------------------------------------

interface LegendProps {
  parsed: ParsedGcode;
  colorMode: ColorMode;
  onColorMode: (m: ColorMode) => void;
  hidden: ReadonlySet<number>;
  onHidden: (h: ReadonlySet<number>) => void;
  tools: string[];
  travel: boolean;
  onTravel: (v: boolean) => void;
}

function Legend({ parsed, colorMode, onColorMode, hidden, onHidden, tools, travel, onTravel }: LegendProps) {
  const { info } = parsed;
  // Segments per feature: which feature types the file has at all.
  const counts = useMemo(() => {
    const c = new Uint32Array(256);
    const f = parsed.extrusions.feature;
    for (let i = 0; i < f.length; i++) c[f[i]]++;
    return c;
  }, [parsed]);
  const colors = useMemo(() => featureColors(info.features), [info.features]);
  const modelTime = info.featureTime.reduce((a, b) => a + b, 0) + info.travelTime;
  const toggle = (f: number) => {
    const next = new Set(hidden);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    onHidden(next);
  };
  const range = gradientRange(parsed, colorMode);

  return (
    <section className="gp-legend">
      <label className="gp-color-mode">
        Colour by{" "}
        <select value={colorMode} onChange={(e) => onColorMode(e.target.value as ColorMode)}>
          {COLOR_MODES.map((m) => (
            <option key={m.mode} value={m.mode}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      {colorMode === "feature" && (
        <ul className="gp-legend-list">
          {featureOrder(info.features)
            .filter((f) => f !== GAP && counts[f] > 0)
            .map((f) => (
              <li key={f}>
                <button
                  className={hidden.has(f) ? "gp-legend-item off" : "gp-legend-item"}
                  onClick={() => toggle(f)}
                  aria-pressed={!hidden.has(f)}
                  title={hidden.has(f) ? "Show" : "Hide"}
                >
                  <span className="gp-swatch" style={{ background: colors[f] }} />
                  <span className="gp-legend-name">{info.features[f]}</span>
                  <span className="gp-legend-time">{formatSeconds(info.featureTime[f])}</span>
                  <span className="gp-legend-pct">
                    {modelTime > 0 ? `${((info.featureTime[f] / modelTime) * 100).toFixed(0)}%` : ""}
                  </span>
                </button>
              </li>
            ))}
          <li>
            <button
              className={travel ? "gp-legend-item" : "gp-legend-item off"}
              onClick={() => onTravel(!travel)}
              aria-pressed={travel}
              title={travel ? "Hide travel moves" : "Show travel moves"}
            >
              <span className="gp-swatch" style={{ background: "#38489b" }} />
              <span className="gp-legend-name">Travel</span>
              <span className="gp-legend-time">{formatSeconds(info.travelTime)}</span>
              <span className="gp-legend-pct">{modelTime > 0 ? `${((info.travelTime / modelTime) * 100).toFixed(0)}%` : ""}</span>
            </button>
          </li>
        </ul>
      )}
      {colorMode === "tool" && (
        <ul className="gp-legend-list">
          {tools.slice(0, Math.max(1, info.toolCount)).map((c, t) => (
            <li key={t} className="gp-legend-item static">
              <span className="gp-swatch" style={{ background: c }} />
              <span className="gp-legend-name">
                Filament {t + 1}
                {info.filamentTypes[t] ? ` · ${info.filamentTypes[t]}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {range && (
        <div className="gp-gradient">
          <div className="gp-gradient-bar" style={{ background: `linear-gradient(to right, ${RANGE_COLORS.join(", ")})` }} />
          <div className="gp-gradient-labels">
            <span>{colorMode === "speed" ? `${Math.round(range.min)} mm/s` : formatSeconds(range.min)}</span>
            <span>{colorMode === "speed" ? `${Math.round(range.max)} mm/s` : formatSeconds(range.max)}</span>
          </div>
        </div>
      )}
    </section>
  );
}

function Summary({ parsed, tools, parseMs }: { parsed: ParsedGcode; tools: string[]; parseMs: number }) {
  const { info, layers, extrusions } = parsed;
  const source = { slicer: "the slicer's estimate", layers: "from the file's layer times", estimate: "estimated from the moves" }[
    info.timeSource
  ];
  return (
    <section className="gp-summary">
      <h4>Summary</h4>
      <dl>
        <dt>Print time</dt>
        <dd>
          {formatSeconds(info.totalTime)} <span className="hint">({source})</span>
        </dd>
        {info.prepareTime > 1 && (
          <>
            <dt>Start sequence</dt>
            <dd>{formatSeconds(info.prepareTime)}</dd>
          </>
        )}
        <dt>Layers</dt>
        <dd>
          {layers.count}
          {info.bounds && ` · ${info.bounds.max[2].toFixed(2)} mm tall`}
        </dd>
        {info.filament.map((f) => (
          <FilamentRow key={f.tool} color={tools[f.tool]} label={info.filament.length > 1 || info.toolCount > 1 ? `Filament ${f.tool + 1}` : "Filament"} type={info.filamentTypes[f.tool]} mm={f.mm} g={f.g} />
        ))}
        {info.generator && (
          <>
            <dt>Sliced by</dt>
            <dd>{info.generator}</dd>
          </>
        )}
      </dl>
      <p className="hint">
        {(info.bytes / 1e6).toFixed(1)} MB, {info.lines.toLocaleString()} lines, {extrusions.count.toLocaleString()} segments; read in{" "}
        {(parseMs / 1000).toFixed(1)} s.
      </p>
    </section>
  );
}

function FilamentRow({ color, label, type, mm, g }: { color: string; label: string; type?: string; mm: number; g: number | null }) {
  return (
    <>
      <dt>
        <span className="gp-swatch" style={{ background: color }} /> {label}
      </dt>
      <dd>
        {(mm / 1000).toFixed(2)} m{g !== null && ` · ${g.toFixed(1)} g`}
        {type ? ` · ${type}` : ""}
      </dd>
    </>
  );
}
