import { useState } from "react";
import { useJson } from "../api";

interface SettingStat {
  key: string;
  label: string;
  /** Jobs with a proposal for this setting. */
  jobs: number;
  /** Jobs that changed it. */
  changed: number;
  /** What they changed it to, most common first: [value, jobs]. */
  to: [string, number][];
}

interface DefaultsReport {
  days: number;
  jobs: number;
  settings: SettingStat[];
}

const PERIODS: [number, string][] = [
  [30, "Last 30 days"],
  [90, "Last 90 days"],
  [365, "Last year"],
  [0, "All time"],
];

/** /reports (admins): which of the Slice page's defaults people change, and to what. */
export default function ReportsPage() {
  const [days, setDays] = useState(90);
  const report = useJson<DefaultsReport>(`/api/reports/defaults?days=${days}`);
  const data = report.data;
  return (
    <div className="page">
      <h2>Reports</h2>
      <h3>Defaults people change</h3>
      <p className="hint">
        For jobs made on the Slice page: what the page proposed (profiles, plate, supports, support materials) against
        what the job was sliced with. Quick Settings count every job: each one set is a change from the profile.
        Settings changed often are worth a better default.
      </p>
      <div className="page-actions">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          {PERIODS.map(([d, label]) => (
            <option key={d} value={d}>
              {label}
            </option>
          ))}
        </select>
        {data && <span className="hint">{data.jobs} jobs</span>}
      </div>
      {report.error && <p className="login-error">{report.error}</p>}
      {data && data.settings.length === 0 && <p className="empty-state">No jobs with proposals in this period.</p>}
      {data && data.settings.length > 0 && (
        <table className="data-table defaults-report">
          <thead>
            <tr>
              <th>Setting</th>
              <th>Changed</th>
              <th>Changed to</th>
            </tr>
          </thead>
          <tbody>
            {data.settings.map((s) => {
              const share = s.jobs > 0 ? s.changed / s.jobs : 0;
              return (
                <tr key={s.key}>
                  <td>
                    {s.label}
                    {s.label !== s.key && <span className="hint"> · {s.key}</span>}
                  </td>
                  <td>
                    <div className="share-bar" title={`${s.changed} of ${s.jobs} jobs`}>
                      <div className="share-fill" style={{ width: `${Math.round(share * 100)}%` }} />
                    </div>
                    <span className="hint">
                      {Math.round(share * 100)}% · {s.changed} of {s.jobs}
                    </span>
                  </td>
                  <td>
                    {s.to.length === 0
                      ? "—"
                      : s.to.map(([value, n]) => (
                          <div key={value}>
                            {value} <span className="hint">×{n}</span>
                          </div>
                        ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
