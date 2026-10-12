import { useEffect, useState } from "react";
import { localDateTime, useJson } from "../api";
import PrintControls from "../components/PrintControls";
import { ACTIVE_PRINT, type PrintRecord } from "../printers";

const STATUS_LABELS: Record<PrintRecord["status"], string> = {
  uploading: "Uploading",
  starting: "Starting",
  printing: "Printing",
  paused: "Paused",
  finished: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Prints sent from FarmSlicer, newest first. */
export default function PrintsPage() {
  const [rev, setRev] = useState(0);
  const prints = useJson<PrintRecord[]>("/api/prints?limit=200", rev).data;

  // Poll while anything is in flight.
  const live = prints?.some((p) => ACTIVE_PRINT.includes(p.status));
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setRev((r) => r + 1), 3000);
    return () => clearInterval(t);
  }, [live]);

  return (
    <div className="page">
      <h2>Prints</h2>
      <p className="hint">
        Jobs sent to printers. Send one from the Jobs page; prints of jobs you can't see show only
        their printer and status.
      </p>
      {prints && prints.length === 0 && <p className="empty-state">Nothing has been printed yet.</p>}
      {prints && prints.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Print</th>
              <th>Printer</th>
              <th>By</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Sent</th>
              <th>Ended</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {prints.map((p) => (
              <tr key={p.id}>
                <td>
                  <div className="job-name">
                    {p.job_id && p.name && (
                      <img
                        className="job-thumb"
                        src={`/api/jobs/${p.job_id}/thumbnail?plate=${p.plate}`}
                        alt=""
                        loading="lazy"
                        onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                      />
                    )}
                    {p.name ?? <span className="hint">(not visible to you)</span>}
                    {p.name && p.plate > 1 && <span className="hint"> · plate {p.plate}</span>}
                  </div>
                </td>
                <td>{p.printer_name}</td>
                <td>{p.username ?? "—"}</td>
                <td>
                  <span className={`status-badge print-${p.status}`}>{STATUS_LABELS[p.status] ?? p.status}</span>
                  {p.error && <div className="printer-error">{p.error}</div>}
                </td>
                <td>
                  {ACTIVE_PRINT.includes(p.status) ? (
                    <div className="progress-bar" title={p.status === "uploading" ? "Upload" : "Print"}>
                      <div className="progress-fill" style={{ width: `${p.progress}%` }} />
                    </div>
                  ) : p.status === "finished" ? (
                    "100%"
                  ) : (
                    `${p.progress}%`
                  )}
                </td>
                <td>{localDateTime(p.created_at)}</td>
                <td>{localDateTime(p.finished_at)}</td>
                <td>
                  {p.can_control && ["printing", "paused"].includes(p.status) && (
                    <PrintControls print={p} onChange={() => setRev((r) => r + 1)} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
