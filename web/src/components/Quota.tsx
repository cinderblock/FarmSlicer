import { METRICS, PERIODS, formatAmount, metricLabel } from "../groups";
import type { Metric, Period, QuotaLine, Rule } from "../groups";

/** Edit a list of quota rules. Every rule is optional; an empty list = no limits. */
export function QuotaRulesEditor({
  rules,
  onChange,
  disabled,
}: {
  rules: Rule[];
  onChange: (rules: Rule[]) => void;
  disabled?: boolean;
}) {
  const update = (i: number, patch: Partial<Rule>) =>
    onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="quota-editor">
      {rules.length === 0 && <p className="hint">No limits.</p>}
      {rules.map((r, i) => (
        <div className="quota-rule" key={i}>
          <select
            value={r.metric}
            onChange={(e) => update(i, { metric: e.target.value as Metric })}
            disabled={disabled}
            aria-label="Metric"
          >
            {METRICS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
                {m.unit ? ` (${m.unit})` : ""}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={0}
            step="any"
            value={Number.isFinite(r.limit) ? r.limit : 0}
            onChange={(e) => update(i, { limit: Number(e.target.value) })}
            disabled={disabled}
            aria-label="Limit"
          />
          <select
            value={r.metric === "storage_mb" ? "total" : r.period}
            onChange={(e) => update(i, { period: e.target.value as Period })}
            disabled={disabled || r.metric === "storage_mb"}
            aria-label="Period"
            title={r.metric === "storage_mb" ? "Storage is a running total" : undefined}
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-sm btn-danger"
            onClick={() => onChange(rules.filter((_, j) => j !== i))}
            disabled={disabled}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn-sm"
        onClick={() => onChange([...rules, { metric: "filament_g", period: "month", limit: 1000 }])}
        disabled={disabled}
      >
        Add a limit
      </button>
    </div>
  );
}

const SCOPE_LABEL: Record<QuotaLine["scope"], string> = {
  user: "You",
  member: "Per member",
  pool: "Shared pool",
};

/** Quota usage: one row per applicable rule, with a fill bar. */
export function UsageLines({ lines, showGroup = true }: { lines: QuotaLine[]; showGroup?: boolean }) {
  if (lines.length === 0) return <p className="hint">No limits apply.</p>;
  return (
    <table className="data-table usage-table">
      <thead>
        <tr>
          <th>Limit</th>
          {showGroup && <th>Group</th>}
          <th>Used</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => {
          const pct = l.limit > 0 ? Math.min(100, (l.used / l.limit) * 100) : 100;
          const period = l.metric === "storage_mb" ? "in total" : PERIODS.find((p) => p.value === l.period)?.label;
          return (
            <tr key={i}>
              <td>
                {SCOPE_LABEL[l.scope]}: {metricLabel(l.metric)} {period}
              </td>
              {showGroup && <td>{l.group_name ?? "—"}</td>}
              <td>
                {formatAmount(l.metric, l.used)} of {formatAmount(l.metric, l.limit)}
              </td>
              <td className="usage-bar-cell">
                <div className="progress-bar">
                  <div
                    className={`progress-fill${l.used >= l.limit ? " progress-full" : ""}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
