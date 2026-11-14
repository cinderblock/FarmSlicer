// The models on the plate and what they're made of: each model's name,
// filament and settings, and its volumes (parts, modifiers, negative
// volumes, support enforcers and blockers) with theirs. Edits go through
// `onEdit`, which makes a new model (undoable) for every copy.

import { useMemo, useState } from "react";
import settingsSchema from "../../data/settings-schema.json";
import type { SettingDef } from "../SettingInput";
import { makeVolume, objectBounds, VOLUME_SUBTYPE, type ModelObject, type Volume, type VolumeType } from "../../model/document";
import { meshBounds, multiply, translation, scaling, type Mat4 } from "../../model/mesh";
import { PRIMITIVES, primitive, type Primitive } from "../../model/primitives";
import { filamentColor, type PartShape } from "./part";

const schema = settingsSchema as SettingDef[];

/** Settings libslic3r takes per object (and, for modifiers, per region). */
const OBJECT_CATEGORIES = new Set(["Quality", "Walls", "Infill", "Speed", "Support", "Adhesion"]);
/** Print-wide settings in those categories: no use on one object. */
const PRINT_WIDE = new Set([
  "spiral_mode",
  "initial_layer_print_height",
  "initial_layer_line_width",
  "travel_speed",
  "initial_layer_speed",
  "initial_layer_infill_speed",
  "skirt_loops",
  "skirt_distance",
]);
const OBJECT_SETTINGS = schema.filter((s) => OBJECT_CATEGORIES.has(s.category) && !PRINT_WIDE.has(s.key));

const TYPE_LABEL: Record<VolumeType, string> = {
  part: "Part",
  modifier: "Modifier",
  negative: "Negative volume",
  enforcer: "Support enforcer",
  blocker: "Support blocker",
};

export interface ObjectPanelProps {
  /** Every model on the plates, with how many copies. */
  models: { shape: PartShape; copies: number }[];
  selected: PartShape | null;
  volumeId: string | null;
  colors: string[];
  filamentCount: number;
  onSelect: (shape: PartShape) => void;
  onSelectVolume: (id: string | null) => void;
  onEdit: (shape: PartShape, label: string, change: (o: ModelObject) => ModelObject) => void;
}

function FilamentPick({
  value,
  count,
  colors,
  allowDefault,
  onChange,
  label,
}: {
  value: number;
  count: number;
  colors: string[];
  allowDefault?: boolean;
  onChange: (n: number) => void;
  label: string;
}) {
  return (
    <span className="object-filament">
      <select value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label}>
        {allowDefault && <option value={0}>Model's</option>}
        {Array.from({ length: Math.max(count, value) }, (_, i) => (
          <option key={i} value={i + 1}>
            {i + 1}
          </option>
        ))}
      </select>
      {value > 0 && <span className="filament-swatch" style={{ background: filamentColor(colors, value) }} aria-hidden />}
    </span>
  );
}

/** Profile settings of a model or a volume: the set ones, and adding another. */
function SettingsList({
  settings,
  onChange,
}: {
  settings: Record<string, string>;
  onChange: (next: Record<string, string>, label: string) => void;
}) {
  const [adding, setAdding] = useState("");
  const set = Object.entries(settings);
  return (
    <div className="object-settings">
      {set.map(([key, value]) => {
        const def = schema.find((s) => s.key === key);
        return (
          <div className="object-setting" key={key}>
            <span title={key}>{def?.label ?? key}</span>
            {def?.type === "bool" ? (
              <input
                type="checkbox"
                checked={value === "1"}
                onChange={(e) => onChange({ ...settings, [key]: e.target.checked ? "1" : "0" }, `Set ${def.label}`)}
              />
            ) : def?.type === "enum" ? (
              <select value={value} onChange={(e) => onChange({ ...settings, [key]: e.target.value }, `Set ${def.label}`)}>
                {(def.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                defaultValue={value}
                onBlur={(e) => e.target.value !== value && onChange({ ...settings, [key]: e.target.value }, `Set ${def?.label ?? key}`)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
            )}
            {def?.unit && <span className="placement-unit">{def.unit}</span>}
            <button
              className="btn-sm btn-ghost"
              title="Use the job's setting"
              onClick={() => {
                const next = { ...settings };
                delete next[key];
                onChange(next, `Unset ${def?.label ?? key}`);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <select
        value={adding}
        aria-label="Add a setting"
        onChange={(e) => {
          const def = OBJECT_SETTINGS.find((s) => s.key === e.target.value);
          setAdding("");
          if (!def) return;
          const start = def.type === "bool" ? "1" : def.type === "enum" ? (def.options?.[0] ?? "") : String(def.min ?? 0);
          onChange({ ...settings, [def.key]: start }, `Set ${def.label}`);
        }}
      >
        <option value="">+ Setting…</option>
        {[...new Set(OBJECT_SETTINGS.map((s) => s.category))].map((cat) => (
          <optgroup key={cat} label={cat}>
            {OBJECT_SETTINGS.filter((s) => s.category === cat && !(s.key in settings)).map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

/** Numbers in a row that commit on Enter or blur. */
function Vec3Field({ label, value, onCommit }: { label: string; value: [number, number, number]; onCommit: (v: [number, number, number]) => void }) {
  return (
    <div className="placement-row">
      <span className="placement-label">{label}</span>
      {value.map((x, i) => (
        <input
          key={`${i}:${x.toFixed(2)}`}
          className="object-number"
          type="number"
          step="any"
          defaultValue={x.toFixed(2)}
          aria-label={`${label} ${"XYZ"[i]}`}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n) || Math.abs(n - x) < 1e-6) return;
            const next = [...value] as [number, number, number];
            next[i] = n;
            onCommit(next);
          }}
        />
      ))}
      <span className="placement-unit">mm</span>
    </div>
  );
}

function volumeBox(v: Volume) {
  const b = meshBounds(v.mesh, v.matrix);
  const center: [number, number, number] = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2) as [number, number, number];
  const size: [number, number, number] = [0, 1, 2].map((k) => b.max[k] - b.min[k]) as [number, number, number];
  return { center, size };
}

export default function ObjectPanel(props: ObjectPanelProps) {
  const { models, selected, volumeId, colors, filamentCount, onSelect, onSelectVolume, onEdit } = props;
  // Open on wide screens; on phones it would cover the plate until asked for.
  const [open, setOpen] = useState(() => !window.matchMedia("(max-width: 800px)").matches);
  const [addType, setAddType] = useState<VolumeType>("modifier");
  const [addShape, setAddShape] = useState<Primitive>("box");
  const object = selected?.object ?? null;
  const volume = object?.volumes.find((v) => v.id === volumeId) ?? null;
  const edit = (label: string, change: (o: ModelObject) => ModelObject) => selected && onEdit(selected, label, change);
  const editVolume = (label: string, change: (v: Volume) => Volume) =>
    volume && edit(label, (o) => ({ ...o, volumes: o.volumes.map((v) => (v.id === volume.id ? change(v) : v)) }));
  const partCount = useMemo(() => object?.volumes.filter((v) => v.type === "part").length ?? 0, [object]);

  if (models.length === 0) return null;
  return (
    <div className={`object-panel ${open ? "" : "collapsed"}`}>
      <button className="object-panel-toggle btn-sm btn-ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "Objects ▾" : `Objects (${models.length}) ▸`}
      </button>
      {open && (
        <>
          <ul className="object-list">
            {models.map(({ shape, copies }) => (
              <li key={shape.object.id} className={shape === selected ? "selected" : ""}>
                <button className="object-name" onClick={() => onSelect(shape)} title={shape.name}>
                  {shape.name}
                  {copies > 1 && <span className="plate-count">×{copies}</span>}
                </button>
                <FilamentPick
                  value={shape.object.extruder}
                  count={filamentCount}
                  colors={colors}
                  label={`${shape.name}'s filament`}
                  onChange={(n) => onEdit(shape, `Filament ${n}`, (o) => ({ ...o, extruder: n }))}
                />
              </li>
            ))}
          </ul>

          {object && (
            <div className="object-detail">
              <label className="object-rename">
                <span>Name</span>
                <input
                  key={object.id}
                  defaultValue={object.name}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== object.name) edit("Rename", (o) => ({ ...o, name }));
                  }}
                />
              </label>

              <div className="object-section-title">Parts</div>
              <ul className="volume-list">
                {object.volumes.map((v) => (
                  <li key={v.id} className={`${v.id === volumeId ? "selected" : ""} volume-${v.type}`}>
                    <button className="object-name" onClick={() => onSelectVolume(v.id === volumeId ? null : v.id)}>
                      {v.name || TYPE_LABEL[v.type]}
                      <span className="volume-type">{TYPE_LABEL[v.type]}</span>
                    </button>
                    {(v.type === "part" || v.type === "modifier") && (
                      <FilamentPick
                        value={v.extruder}
                        count={filamentCount}
                        colors={colors}
                        allowDefault
                        label={`${v.name}'s filament`}
                        onChange={(n) =>
                          edit(n ? `Filament ${n}` : "Model's filament", (o) => ({
                            ...o,
                            volumes: o.volumes.map((x) => (x.id === v.id ? { ...x, extruder: n } : x)),
                          }))
                        }
                      />
                    )}
                    <button
                      className="btn-sm btn-ghost"
                      disabled={v.type === "part" && partCount <= 1}
                      title={v.type === "part" && partCount <= 1 ? "A model needs a part" : `Delete ${v.name || TYPE_LABEL[v.type]}`}
                      onClick={() => {
                        if (v.id === volumeId) onSelectVolume(null);
                        edit("Delete part", (o) => ({ ...o, volumes: o.volumes.filter((x) => x.id !== v.id) }));
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>

              <div className="object-add">
                <select value={addType} onChange={(e) => setAddType(e.target.value as VolumeType)} aria-label="What to add">
                  {(Object.keys(VOLUME_SUBTYPE) as VolumeType[]).map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
                <select value={addShape} onChange={(e) => setAddShape(e.target.value as Primitive)} aria-label="Its shape">
                  {PRIMITIVES.map((p) => (
                    <option key={p.kind} value={p.kind}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <button
                  className="btn-sm"
                  onClick={() =>
                    edit(`Add ${TYPE_LABEL[addType].toLowerCase()}`, (o) => {
                      const b = objectBounds(o);
                      const size = [0, 1, 2].map((k) => Math.max(1, (b.max[k] - b.min[k]) / 2)) as [number, number, number];
                      const center = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
                      const v = makeVolume(primitive(addShape, size), {
                        name: `${TYPE_LABEL[addType]} ${o.volumes.filter((x) => x.type === addType).length + 1}`,
                        type: addType,
                        matrix: translation(center[0], center[1], center[2]),
                      });
                      return { ...o, volumes: [...o.volumes, v] };
                    })
                  }
                >
                  Add
                </button>
              </div>

              {volume && (
                <div className="object-volume">
                  <div className="object-section-title">{volume.name || TYPE_LABEL[volume.type]}</div>
                  <label className="object-rename">
                    <span>Type</span>
                    <select
                      value={volume.type}
                      disabled={volume.type === "part" && partCount <= 1}
                      onChange={(e) => editVolume("Change type", (v) => ({ ...v, type: e.target.value as VolumeType }))}
                    >
                      {(Object.keys(VOLUME_SUBTYPE) as VolumeType[]).map((t) => (
                        <option key={t} value={t}>
                          {TYPE_LABEL[t]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {(() => {
                    const { center, size } = volumeBox(volume);
                    const move = (to: [number, number, number]) =>
                      editVolume("Move part", (v) => ({
                        ...v,
                        matrix: multiply(translation(to[0] - center[0], to[1] - center[1], to[2] - center[2]), v.matrix),
                      }));
                    const resize = (to: [number, number, number]) =>
                      editVolume("Resize part", (v) => {
                        const k = to.map((x, i) => (size[i] > 0 && x > 0 ? x / size[i] : 1));
                        // Scale about the volume's centre, along the model's axes.
                        const about: Mat4 = multiply(
                          translation(center[0], center[1], center[2]),
                          multiply(scaling(k[0], k[1], k[2]), translation(-center[0], -center[1], -center[2])),
                        );
                        return { ...v, matrix: multiply(about, v.matrix) };
                      });
                    return (
                      <>
                        <Vec3Field label="Centre" value={center} onCommit={move} />
                        <Vec3Field label="Size" value={size} onCommit={resize} />
                      </>
                    );
                  })()}
                  {volume.type === "modifier" && (
                    <SettingsList settings={volume.settings} onChange={(settings, label) => editVolume(label, (v) => ({ ...v, settings }))} />
                  )}
                </div>
              )}

              {!volume && (
                <>
                  <div className="object-section-title">Settings for this model</div>
                  <SettingsList settings={object.settings} onChange={(settings, label) => edit(label, (o) => ({ ...o, settings }))} />
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
