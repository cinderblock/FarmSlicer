import { useMemo } from "react";
import { baseCandidates, interfaceCandidates, type FilamentOption, type SupportMaterials } from "../supports";
import type { SupportCheck } from "./viewer/overhangs";

/** The Slice page's support settings (sent as overrides, plus the filaments they use). */
export interface SupportSettings {
  enabled: boolean;
  /** `support_type`; null = the process profile's. */
  type: string | null;
  /** `support_on_build_plate_only`; null = the profile's. */
  buildPlateOnly: boolean | null;
}

const TYPES: [string, string][] = [
  ["normal(auto)", "Normal"],
  ["tree(auto)", "Tree"],
];

const filamentLabel = (name: string) => name.replace(/@.*$/, "").trim();

/**
 * Supports: on or off (on by default; libslic3r only adds them where the
 * parts need them), their style, and which filaments print them.
 */
export default function SupportsPanel({
  settings,
  onSettings,
  materials,
  onMaterials,
  part,
  filaments,
  profileType,
  profileBuildPlateOnly,
  loaded,
  multiMaterial,
  check,
  disabled,
}: {
  settings: SupportSettings;
  onSettings: (s: SupportSettings) => void;
  /** The choice in effect (the user's, else the default). */
  materials: SupportMaterials;
  onMaterials: (m: SupportMaterials) => void;
  /** The part's filament. */
  part: FilamentOption | undefined;
  /** Every filament the machine offers. */
  filaments: FilamentOption[];
  /** The process profile's values, shown when nothing is overridden. */
  profileType: string | undefined;
  profileBuildPlateOnly: boolean | undefined;
  /** Materials loaded on the printers in question ("PLA-S", ...). */
  loaded: Set<string>;
  /** Can those printers load more than one filament (an AMS)? */
  multiMaterial: boolean;
  /** What the viewer found on the plate (null: nothing loaded). */
  check: SupportCheck | null;
  disabled?: boolean;
}) {
  const interfaces = useMemo(() => (part ? interfaceCandidates(part, filaments, loaded) : []), [part, filaments, loaded]);
  const bases = useMemo(() => (part ? baseCandidates(part, filaments) : []), [part, filaments]);
  const type = settings.type ?? profileType ?? "normal(auto)";
  const buildPlateOnly = settings.buildPlateOnly ?? profileBuildPlateOnly ?? false;
  const needs = check && (check.overhangArea > 1 || check.floating > 0);

  const notLoaded = (name: string) => {
    const f = filaments.find((x) => x.name === name);
    return loaded.size > 0 && f?.tray_material && !loaded.has(f.tray_material.toUpperCase());
  };

  return (
    <div className="supports-panel">
      <div className="supports-title">Supports</div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={disabled}
          onChange={(e) => onSettings({ ...settings, enabled: e.target.checked })}
        />
        Generate supports where needed
      </label>

      {check && (
        <p className={`hint support-check ${needs && !settings.enabled ? "bad" : ""}`}>
          {!needs
            ? "The parts don't overhang: no supports will be generated."
            : `${describe(check)} ${
                settings.enabled
                  ? "Supports will hold them up."
                  : "Without supports they print in the air: turn supports on or turn the parts."
              }`}
        </p>
      )}

      {settings.enabled && (
        <>
          <div className="supports-row">
            <label>
              Style
              <select value={type} disabled={disabled} onChange={(e) => onSettings({ ...settings, type: e.target.value })}>
                {TYPES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
                {!TYPES.some(([v]) => v === type) && <option value={type}>{type}</option>}
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={buildPlateOnly}
                disabled={disabled}
                onChange={(e) => onSettings({ ...settings, buildPlateOnly: e.target.checked })}
              />
              Only from the plate
            </label>
          </div>

          <label>
            Support material
            <select
              value={materials.mode}
              disabled={disabled || interfaces.length === 0}
              onChange={(e) =>
                onMaterials(
                  e.target.value === "same" || !part || interfaces.length === 0
                    ? { mode: "same" }
                    : { mode: "separate", interface: interfaces[0].name, base: part.name },
                )
              }
            >
              <option value="same">Same as the part</option>
              <option value="separate" disabled={interfaces.length === 0}>
                Support material for the interface
              </option>
            </select>
          </label>
          {interfaces.length === 0 && part && (
            <p className="hint">No support material suits {filamentLabel(part.name)}: supports print in the part's filament.</p>
          )}
          {!multiMaterial && materials.mode === "separate" && (
            <p className="hint warn">These printers report no AMS: a second filament means swapping spools by hand.</p>
          )}

          {materials.mode === "separate" && part && (
            <>
              <label>
                Interface (touches the part)
                <select
                  value={materials.interface}
                  disabled={disabled}
                  onChange={(e) => onMaterials({ ...materials, interface: e.target.value })}
                >
                  {interfaces.map((f) => (
                    <option key={f.name} value={f.name}>
                      {filamentLabel(f.name)}
                      {notLoaded(f.name) ? " (not loaded)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Base (under the interface)
                <select
                  value={materials.base}
                  disabled={disabled}
                  onChange={(e) => onMaterials({ ...materials, base: e.target.value })}
                >
                  {bases.map((f) => (
                    <option key={f.name} value={f.name}>
                      {filamentLabel(f.name)}
                      {f.name === part.name ? " (the part's)" : " (changes filament every support layer)"}
                      {notLoaded(f.name) ? " (not loaded)" : ""}
                    </option>
                  ))}
                  {!bases.some((f) => f.name === materials.base) && (
                    <option value={materials.base}>{filamentLabel(materials.base)}</option>
                  )}
                </select>
              </label>
              <p className="hint">
                The interface peels off cleanly, and the filament changes only on the few layers where supports meet the
                part. A base in another filament changes it on every layer with supports: cheaper filament, but much
                longer prints.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

function describe(check: SupportCheck): string {
  const parts: string[] = [];
  if (check.overhangArea > 1) parts.push(`${Math.round(check.overhangArea)} mm² of overhang`);
  if (check.floating > 0)
    parts.push(`${check.floating} ${check.floating === 1 ? "point" : "points"} that would start in mid-air`);
  return `The plate has ${parts.join(" and ")}.`;
}
