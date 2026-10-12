import { useState, useMemo, useEffect } from "react";
import SettingInput from "./SettingInput";
import type { SettingDef } from "./SettingInput";
import settingsSchema from "../data/settings-schema.json";

const schema = settingsSchema as SettingDef[];

interface Props {
  baseProfile: string;
  profileType: string;
  overrides: Record<string, string>;
  onChange: (overrides: Record<string, string>) => void;
  readOnly?: boolean;
}

type Tab = "settings" | "json";

export default function ProfileEditor({
  baseProfile,
  overrides,
  onChange,
  readOnly,
}: Props) {
  const [tab, setTab] = useState<Tab>("settings");
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("");
  const [baseConfig, setBaseConfig] = useState<Record<string, string> | null>(
    null,
  );
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");

  useEffect(() => {
    if (!baseProfile) return;
    fetch(
      `/api/profiles/resolve-single?name=${encodeURIComponent(baseProfile)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setBaseConfig(data))
      .catch(() => setBaseConfig(null));
  }, [baseProfile]);

  useEffect(() => {
    setJsonText(JSON.stringify(overrides, null, 2));
    setJsonError("");
  }, [overrides]);

  const categories = useMemo(() => {
    const cats: string[] = [];
    for (const s of schema) {
      if (!cats.includes(s.category)) cats.push(s.category);
    }
    return cats;
  }, []);

  useEffect(() => {
    if (!activeCategory && categories.length > 0) {
      setActiveCategory(categories[0]);
    }
  }, [categories, activeCategory]);

  const filteredSettings = useMemo(() => {
    if (search.trim()) {
      const q = search.toLowerCase();
      return schema.filter(
        (s) =>
          s.label.toLowerCase().includes(q) ||
          s.key.toLowerCase().includes(q),
      );
    }
    return schema.filter((s) => s.category === activeCategory);
  }, [search, activeCategory]);

  const groupedFiltered = useMemo(() => {
    if (!search.trim()) return null;
    const groups = new Map<string, SettingDef[]>();
    for (const s of filteredSettings) {
      const list = groups.get(s.category) ?? [];
      list.push(s);
      groups.set(s.category, list);
    }
    return groups;
  }, [search, filteredSettings]);

  const overrideCount = Object.keys(overrides).length;
  const changedKeys = useMemo(
    () => new Set(Object.keys(overrides)),
    [overrides],
  );

  const handleSettingChange = (key: string, value: string | undefined) => {
    if (readOnly) return;
    const next = { ...overrides };
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  };

  const handleJsonSave = () => {
    try {
      const parsed = JSON.parse(jsonText);
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        setJsonError("Must be a JSON object");
        return;
      }
      const asStrings: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        asStrings[k] = String(v);
      }
      onChange(asStrings);
      setJsonError("");
    } catch {
      setJsonError("Invalid JSON");
    }
  };

  return (
    <div className="profile-editor">
      <div className="editor-tabs">
        <button
          className={`editor-tab ${tab === "settings" ? "active" : ""}`}
          onClick={() => setTab("settings")}
        >
          Settings
        </button>
        <button
          className={`editor-tab ${tab === "json" ? "active" : ""}`}
          onClick={() => setTab("json")}
        >
          Raw JSON
          {overrideCount > 0 && (
            <span className="override-badge">{overrideCount}</span>
          )}
        </button>
      </div>

      {tab === "settings" && (
        <div className="editor-settings">
          <input
            type="text"
            className="editor-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search settings..."
          />

          {!search.trim() && (
            <div className="editor-categories">
              {categories.map((cat) => {
                const catOverrides = schema.filter(
                  (s) => s.category === cat && changedKeys.has(s.key),
                ).length;
                return (
                  <button
                    key={cat}
                    className={`editor-cat-btn ${activeCategory === cat ? "active" : ""}`}
                    onClick={() => setActiveCategory(cat)}
                  >
                    {cat}
                    {catOverrides > 0 && (
                      <span className="override-badge">{catOverrides}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <div className="editor-settings-list">
            {groupedFiltered
              ? [...groupedFiltered.entries()].map(([cat, settings]) => (
                  <div key={cat} className="overrides-category">
                    <div className="overrides-category-label">{cat}</div>
                    {settings.map((s) => (
                      <SettingInput
                        key={s.key}
                        setting={s}
                        defaultValue={baseConfig?.[s.key]}
                        value={overrides[s.key]}
                        onChange={handleSettingChange}
                      />
                    ))}
                  </div>
                ))
              : filteredSettings.map((s) => (
                  <SettingInput
                    key={s.key}
                    setting={s}
                    defaultValue={baseConfig?.[s.key]}
                    value={overrides[s.key]}
                    onChange={handleSettingChange}
                  />
                ))}
            {filteredSettings.length === 0 && (
              <p className="hint" style={{ padding: "0.5rem 0" }}>
                No matching settings.
              </p>
            )}
          </div>

          {overrideCount > 0 && !readOnly && (
            <div className="editor-diff">
              <div className="overrides-category-label">
                Modified ({overrideCount})
              </div>
              {Object.entries(overrides).map(([key, val]) => {
                const def = schema.find((s) => s.key === key);
                return (
                  <div key={key} className="diff-row">
                    <span className="diff-key">
                      {def?.label ?? key}
                    </span>
                    <span className="diff-val">{val}</span>
                    <button
                      className="btn-reset"
                      onClick={() => handleSettingChange(key, undefined)}
                      title="Remove override"
                    >
                      &times;
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "json" && (
        <div className="editor-json">
          <textarea
            className="json-editor"
            value={jsonText}
            onChange={(e) => {
              setJsonText(e.target.value);
              setJsonError("");
            }}
            rows={16}
            readOnly={readOnly}
            spellCheck={false}
          />
          {jsonError && (
            <p style={{ color: "var(--error)", fontSize: "0.85rem" }}>
              {jsonError}
            </p>
          )}
          {!readOnly && (
            <button
              className="btn-sm"
              onClick={handleJsonSave}
              style={{ marginTop: "0.5rem" }}
            >
              Apply JSON
            </button>
          )}
        </div>
      )}
    </div>
  );
}
