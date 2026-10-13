import { localDateTime, useJson } from "../api";

/** Custom G-code that failed its check or a print (src/incidents.rs). */
export interface GcodeIncident {
  id: string;
  created_at: string;
  user_id: string | null;
  username: string | null;
  sent_by: string | null;
  sent_by_username: string | null;
  job_id: string | null;
  print_id: string | null;
  job_name: string;
  printer_name: string | null;
  source: "upload" | "browser" | "server";
  kind: "check" | "print_failed" | "printer_error";
  severity: "block" | "review" | "error";
  summary: string;
}

const KINDS: Record<GcodeIncident["kind"], string> = {
  check: "Failed its check",
  print_failed: "Print failed",
  printer_error: "Printer error",
};

const SOURCES: Record<GcodeIncident["source"], string> = {
  upload: "uploaded",
  browser: "sliced in a browser",
  server: "custom settings",
};

/**
 * Admins: whose custom G-code failed its check or a print, newest first;
 * `user` narrows to one person's.
 */
export default function GcodeIncidents({ user, onClear, rev = 0 }: { user: { id: string; username: string } | null; onClear: () => void; rev?: number }) {
  const list = useJson<GcodeIncident[]>(`/api/gcode-incidents${user ? `?user=${encodeURIComponent(user.id)}` : ""}`, rev);
  return (
    <section>
      <h3>G-code incidents</h3>
      <p className="hint">
        Custom G-code (uploaded files, settings beyond the Slice page's, or anything its check held) that failed
        its check, failed on the printer, or made the printer raise an error.
        {user && (
          <>
            {" "}
            Showing {user.username}'s.{" "}
            <button className="btn-sm" onClick={onClear}>
              Show everyone's
            </button>
          </>
        )}
      </p>
      {list.error && <p className="login-error">{list.error}</p>}
      {list.data && list.data.length === 0 && <p className="empty-state">None.</p>}
      {list.data && list.data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Whose G-code</th>
              <th>Job</th>
              <th>What happened</th>
              <th>Printer</th>
              <th>Sent by</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((i) => (
              <tr key={i.id}>
                <td>{localDateTime(i.created_at)}</td>
                <td>{i.username ?? "—"}</td>
                <td>
                  {i.job_name}
                  <span className="hint"> · {SOURCES[i.source] ?? i.source}</span>
                </td>
                <td>
                  <span className={`gcode-chip ${i.severity === "review" ? "gcode-review" : "gcode-block"}`}>{KINDS[i.kind] ?? i.kind}</span>{" "}
                  {i.summary}
                </td>
                <td>{i.printer_name ?? "—"}</td>
                <td>{i.sent_by_username ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
