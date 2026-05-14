import { useState, useMemo } from "react";
import SettingInput from "./SettingInput";
import type { SettingDef } from "./SettingInput";
import settingsSchema from "../data/settings-schema.json";

interface Props {
  resolvedConfig: Record<string, string> | null;
  overrides: Record<string, string>;
  onChange: (overrides: Record<string, string>) => void;
  disabled?: boolean;
  processName?: string;
  filamentName?: string;
}

const schema = settingsSchema as SettingDef[];

export default function OverridesPanel({
  resolvedConfig,
  overrides,
  onChange,
  disabled,
  processName,
  filamentName,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveType, setSaveType] = useState<"process" | "filament">("process");
  const [saveMsg, setSaveMsg] = useState("");

  const commonSettings = useMemo(
    () => schema.filter((s) => s.common),
    [],
  );

  const categories = useMemo(() => {
    const cats = new Map<string, SettingDef[]>();
    for (const s of commonSettings) {
      const list = cats.get(s.category) ?? [];
      list.push(s);
      cats.set(s.category, list);
    }
    return cats;
  }, [commonSettings]);

  const overrideCount = Object.keys(overrides).length;

  const handleSettingChange = (key: string, value: string | undefined) => {
    const next = { ...overrides };
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  };

  if (!resolvedConfig || disabled) return null;

  return (
    <div className="overrides-panel">
      <button
        className="overrides-toggle"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span>Quick Settings</span>
        {overrideCount > 0 && (
          <span className="override-badge">{overrideCount}</span>
        )}
        <span className={`chevron ${expanded ? "open" : ""}`}>&#9662;</span>
      </button>
      {expanded && (
        <div className="overrides-body">
          {[...categories.entries()].map(([cat, settings]) => (
            <div key={cat} className="overrides-category">
              <div className="overrides-category-label">{cat}</div>
              {settings.map((s) => (
                <SettingInput
                  key={s.key}
                  setting={s}
                  defaultValue={resolvedConfig[s.key]}
                  value={overrides[s.key]}
                  onChange={handleSettingChange}
                />
              ))}
            </div>
          ))}
          {overrideCount > 0 && (
            <div className="overrides-actions">
              <button
                className="btn-sm"
                onClick={() => onChange({})}
                type="button"
              >
                Reset All
              </button>
              <button
                className="btn-sm"
                onClick={() => {
                  setSaving(true);
                  setSaveName("");
                  setSaveType("process");
                  setSaveMsg("");
                }}
                type="button"
              >
                Save as Profile
              </button>
            </div>
          )}
          {saving && (
            <div className="save-profile-form">
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Profile name"
              />
              <select
                value={saveType}
                onChange={(e) =>
                  setSaveType(e.target.value as "process" | "filament")
                }
              >
                <option value="process">Process</option>
                <option value="filament">Filament</option>
              </select>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  className="btn-sm"
                  onClick={async () => {
                    if (!saveName.trim()) return;
                    const baseProfile =
                      saveType === "process" ? processName : filamentName;
                    const res = await fetch("/api/custom-profiles", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        name: saveName,
                        profile_type: saveType,
                        base_profile: baseProfile || "",
                        overrides: JSON.stringify(overrides),
                      }),
                    });
                    if (res.ok) {
                      setSaveMsg("Saved!");
                      setTimeout(() => setSaving(false), 1200);
                    } else {
                      const data = await res.json().catch(() => ({}));
                      setSaveMsg(data.error || "Failed to save");
                    }
                  }}
                >
                  Save
                </button>
                <button
                  className="btn-sm"
                  onClick={() => setSaving(false)}
                >
                  Cancel
                </button>
              </div>
              {saveMsg && (
                <p
                  className="hint"
                  style={{
                    color: saveMsg === "Saved!" ? "var(--success)" : "var(--error)",
                  }}
                >
                  {saveMsg}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
