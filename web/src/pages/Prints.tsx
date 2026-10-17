import { useEffect, useState } from "react";
import { apiJson } from "../auth";
import { errorText, localDateTime, useJson } from "../api";
import PrintControls from "../components/PrintControls";
import { ACTIVE_PRINT, formatCost, type Prices, type Printer, type PrintRecord } from "../printers";

const STATUS_LABELS: Record<PrintRecord["status"], string> = {
  pending_approval: "Waiting for approval",
  rejected: "Not approved",
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
  const currency = useJson<Prices>("/api/prices").data?.currency ?? "$";
  const printers = useJson<Printer[]>("/api/printers").data;
  const capabilitiesOf = (p: PrintRecord) => printers?.find((x) => x.id === p.printer_id)?.capabilities;
  const [error, setError] = useState("");

  // Poll while anything is in flight or waiting.
  const live = prints?.some((p) => ACTIVE_PRINT.includes(p.status) || p.status === "pending_approval");

  const decide = async (p: PrintRecord, approve: boolean) => {
    setError("");
    try {
      if (approve) {
        await apiJson(`/api/prints/${p.id}/approve`, "POST", {});
      } else {
        const own = !p.can_approve;
        const note = own ? "" : (window.prompt(`Why not? (shown to ${p.username ?? "the sender"}; optional)`) ?? null);
        if (note === null) return;
        await apiJson(`/api/prints/${p.id}/reject`, "POST", { note });
      }
    } catch (err) {
      setError(errorText(err));
    }
    setRev((r) => r + 1);
  };
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
      {error && <p className="login-error">{error}</p>}
      {prints && prints.length === 0 && <p className="empty-state">Nothing has been printed yet.</p>}
      {prints && prints.length > 0 && (
        <table className="data-table cards">
          <thead>
            <tr>
              <th>Print</th>
              <th>Printer</th>
              <th>By</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Cost</th>
              <th>Sent</th>
              <th>Ended</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {prints.map((p) => (
              <tr key={p.id}>
                <td className="cell-title">
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
                <td data-label="Printer">{p.printer_name}</td>
                <td data-label="By">{p.username ?? "—"}</td>
                <td data-label="Status">
                  <span className={`status-badge print-${p.status}`}>{STATUS_LABELS[p.status] ?? p.status}</span>
                  {p.status === "pending_approval" && p.safety_review && (
                    <div>
                      <span className="gcode-chip gcode-review">G-code review: admins only</span>
                    </div>
                  )}
                  {p.status === "pending_approval" && p.approval_reason && (
                    <div className="hint">{p.approval_reason}</div>
                  )}
                  {p.status !== "pending_approval" && p.safety_review && p.decided_by && (
                    <div className="hint">
                      G-code reviewed by {p.decided_by}: {p.approval_reason?.replace(/^G-code review: /, "")}
                    </div>
                  )}
                  {p.error && <div className="printer-error">{p.error}</div>}
                </td>
                <td data-label="Progress">
                  {ACTIVE_PRINT.includes(p.status) ? (
                    <>
                      <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${p.progress}%` }} />
                      </div>
                      <span className="hint">{p.status === "uploading" ? "Upload" : "Print"}</span>
                    </>
                  ) : p.status === "finished" ? (
                    "100%"
                  ) : p.status === "pending_approval" || p.status === "rejected" ? (
                    "—"
                  ) : (
                    `${p.progress}%`
                  )}
                </td>
                <td data-label="Cost">{formatCost(p.estimated_cost, currency)}</td>
                <td data-label="Sent">{localDateTime(p.created_at)}</td>
                <td data-label="Ended">{localDateTime(p.finished_at)}</td>
                <td className="cell-actions">
                  {p.can_control && ["printing", "paused"].includes(p.status) && (
                    <PrintControls print={p} capabilities={capabilitiesOf(p)} onChange={() => setRev((r) => r + 1)} />
                  )}
                  {p.status === "pending_approval" && (
                    <span className="print-controls">
                      {p.can_approve && (
                        <button className="btn-sm" onClick={() => decide(p, true)}>
                          Approve &amp; send
                        </button>
                      )}
                      {(p.can_approve || p.can_control) && (
                        <button className="btn-sm btn-danger" onClick={() => decide(p, false)}>
                          {p.can_approve ? "Reject" : "Withdraw"}
                        </button>
                      )}
                    </span>
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
