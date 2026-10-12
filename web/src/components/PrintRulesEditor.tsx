import type { PrintRules } from "../printers";

/** Max print time + allowed materials. Empty fields = no limit. */
export default function PrintRulesEditor({
  rules,
  onChange,
}: {
  rules: PrintRules;
  onChange: (rules: PrintRules) => void;
}) {
  const hours = rules.max_minutes != null ? String(+(rules.max_minutes / 60).toFixed(2)) : "";
  return (
    <div className="rules-editor">
      <label>
        Longest print without approval (hours)
        <input
          type="number"
          min={0.25}
          step={0.25}
          value={hours}
          placeholder="No limit"
          onChange={(e) => {
            const h = parseFloat(e.target.value);
            onChange({ ...rules, max_minutes: Number.isFinite(h) && h > 0 ? Math.round(h * 60) : undefined });
          }}
        />
      </label>
      <label>
        Materials allowed without approval
        <input
          value={(rules.materials ?? []).join(", ")}
          placeholder="Any material"
          onChange={(e) => {
            const list = e.target.value
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean);
            onChange({ ...rules, materials: list.length > 0 ? list : undefined });
          }}
        />
        <span className="hint">
          As printers name them, comma-separated: <code>PLA, PLA-CF</code>. Prints outside the rules wait
          for an admin or a manager of the group to approve them.
        </span>
      </label>
    </div>
  );
}
