interface SettingDef {
  key: string;
  label: string;
  type: "float" | "int" | "bool" | "enum" | "percent";
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  category: string;
  common: boolean;
}

interface Props {
  setting: SettingDef;
  defaultValue: unknown;
  value: string | undefined;
  onChange: (key: string, value: string | undefined) => void;
}

function parseOrcaValue(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") {
    if (Array.isArray(raw)) return String(raw[0] ?? "");
    return String(raw);
  }
  if (raw.startsWith("[")) {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? String(arr[0] ?? "") : raw;
    } catch {
      return raw;
    }
  }
  return raw;
}

export default function SettingInput({ setting, defaultValue, value, onChange }: Props) {
  const resolved = value ?? parseOrcaValue(defaultValue);
  const isOverridden = value !== undefined;

  const handleChange = (newVal: string) => {
    const parsed = parseOrcaValue(defaultValue);
    if (newVal === parsed) {
      onChange(setting.key, undefined);
    } else {
      onChange(setting.key, newVal);
    }
  };

  const reset = () => onChange(setting.key, undefined);

  return (
    <div className={`setting-row${isOverridden ? " setting-modified" : ""}`}>
      <div className="setting-label">
        <span>{setting.label}</span>
        {setting.unit && <span className="setting-unit">{setting.unit}</span>}
      </div>
      <div className="setting-control">
        {setting.type === "bool" ? (
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={resolved === "1" || resolved === "true"}
              onChange={(e) => handleChange(e.target.checked ? "1" : "0")}
            />
            <span>{resolved === "1" || resolved === "true" ? "On" : "Off"}</span>
          </label>
        ) : setting.type === "enum" ? (
          <select
            value={resolved}
            onChange={(e) => handleChange(e.target.value)}
          >
            {setting.options?.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="number"
            value={resolved.replace("%", "")}
            min={setting.min}
            max={setting.max}
            step={setting.step}
            placeholder={parseOrcaValue(defaultValue).replace("%", "")}
            onChange={(e) => {
              const v = e.target.value;
              handleChange(setting.type === "percent" ? `${v}%` : v);
            }}
          />
        )}
        {isOverridden && (
          <button className="btn-reset" onClick={reset} title="Reset to default">
            &times;
          </button>
        )}
      </div>
    </div>
  );
}

export type { SettingDef };
