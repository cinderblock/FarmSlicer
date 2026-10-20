import { useState } from "react";
import { apiJson } from "../auth";
import { errorText, useJson } from "../api";
import type { OutcomeReason, PrintRecord } from "../printers";

interface Props {
  print: PrintRecord;
  onClose: () => void;
  onSaved: (print: PrintRecord) => void;
}

interface Row {
  good: number;
  reason: string;
}

/** Say how a print came out: good and failed copies per kind of part, and
 *  why copies failed (src/outcomes.rs). */
export default function OutcomeDialog({ print, onClose, onSaved }: Props) {
  const reasons = useJson<OutcomeReason[]>("/api/outcome-reasons").data ?? [];
  const lines = print.lines ?? [];
  const [rows, setRows] = useState<Row[]>(() =>
    lines.map((l) => ({
      // Unrecorded: a finished print starts at all good, an ended one at none.
      good: l.good ?? (print.status === "finished" ? l.planned : 0),
      reason: l.reason ?? (print.status === "cancelled" ? "cancelled" : print.status === "failed" ? "printer_error" : ""),
    })),
  );
  const [note, setNote] = useState(print.outcome_note ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const setRow = (i: number, change: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...change } : r)));
  const setAll = (good: boolean) =>
    setRows((rs) => rs.map((r, i) => ({ ...r, good: good ? lines[i].planned : 0 })));
  const missingReason = rows.some((r, i) => r.good < lines[i].planned && !r.reason);

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      const saved = await apiJson<PrintRecord>(`/api/prints/${print.id}/outcome`, "POST", {
        lines: rows.map((r, i) => ({
          line: lines[i].line,
          good: r.good,
          failed: lines[i].planned - r.good,
          reason: r.good < lines[i].planned ? r.reason : null,
        })),
        note,
      });
      onSaved(saved);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal outcome-dialog" role="dialog" aria-label="How did it come out?" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>How did {print.name ?? "it"} come out?</h3>
          <button className="btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="send-plate">
          {print.job_id && (
            <img className="plate-thumb" src={`/api/jobs/${print.job_id}/thumbnail?plate=${print.plate}`} alt="" />
          )}
          <div>
            <div>
              {print.printer_name}
              {print.plate > 1 && <span className="hint"> · plate {print.plate}</span>}
            </div>
            <div className="hint">
              The printer says: {print.status}
              {print.error ? ` (${print.error})` : ""}
            </div>
            {print.outcome_by && (
              <div className="hint">
                Recorded by {print.outcome_by === "printer" ? "the printer" : print.outcome_by}
              </div>
            )}
          </div>
        </div>
        <div className="outcome-quick">
          <button className="btn-sm" onClick={() => setAll(true)}>
            All good
          </button>
          <button className="btn-sm" onClick={() => setAll(false)}>
            All failed
          </button>
        </div>
        <table className="data-table outcome-lines">
          <thead>
            <tr>
              <th>Part</th>
              <th>Good</th>
              <th>Failed</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const failed = l.planned - rows[i].good;
              return (
                <tr key={l.line}>
                  <td>
                    {l.name}
                    {l.planned > 1 && <span className="hint"> ×{l.planned}</span>}
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={l.planned}
                      value={rows[i].good}
                      aria-label={`${l.name}: good copies`}
                      onChange={(e) => setRow(i, { good: Math.max(0, Math.min(l.planned, Math.round(Number(e.target.value) || 0))) })}
                    />
                  </td>
                  <td className={failed > 0 ? "printer-error" : "hint"}>{failed}</td>
                  <td>
                    {failed > 0 && (
                      <select
                        value={rows[i].reason}
                        aria-label={`${l.name}: why they failed`}
                        onChange={(e) => setRow(i, { reason: e.target.value })}
                      >
                        <option value="">Choose…</option>
                        {reasons.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <label>
          Note (optional)
          <textarea rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <p className="printer-error">{error}</p>}
        <div className="modal-actions">
          <button className="btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" style={{ width: "auto" }} disabled={saving || missingReason} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
