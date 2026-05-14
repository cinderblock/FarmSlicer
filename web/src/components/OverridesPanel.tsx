import { useState, useMemo } from "react";
import SettingInput from "./SettingInput";
import type { SettingDef } from "./SettingInput";
import settingsSchema from "../data/settings-schema.json";

interface Props {
  resolvedConfig: Record<string, string> | null;
  overrides: Record<string, string>;
  onChange: (overrides: Record<string, string>) => void;
  disabled?: boolean;
}

const schema = settingsSchema as SettingDef[];

export default function OverridesPanel({
  resolvedConfig,
  overrides,
  onChange,
  disabled,
}: Props) {
  const [expanded, setExpanded] = useState(false);

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
            <button
              className="btn-sm"
              style={{ marginTop: "0.5rem" }}
              onClick={() => onChange({})}
              type="button"
            >
              Reset All
            </button>
          )}
        </div>
      )}
    </div>
  );
}
