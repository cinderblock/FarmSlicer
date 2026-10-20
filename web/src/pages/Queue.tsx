// /queue: the operator's view. Each printer and what it would take next
// ("Send next"), the plates waiting in order, and finished prints nobody
// has checked yet.

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { apiJson } from "../auth";
import { errorText, formatDuration, localDateTime, useJson } from "../api";
import OutcomeDialog from "../components/OutcomeDialog";
import { linesText, overdue, type QueueEntry, type QueueView } from "../projects";
import type { PrintRecord } from "../printers";

type Show = "queued" | "sent" | "done";

export default function QueuePage() {
  const [rev, setRev] = useState(0);
  const [show, setShow] = useState<Show>("queued");
  const [printer, setPrinter] = useState("");
  const [pool, setPool] = useState("");
  const pools = useJson<{ pools: { id: string; name: string }[] }>("/api/pools").data?.pools ?? [];
  const params = new URLSearchParams({ status: show });
  if (printer) params.set("printer", printer);
  if (pool) params.set("pool", pool);
  const queue = useJson<QueueView>(`/api/queue?${params}`, rev);
  const unchecked = useJson<PrintRecord[]>("/api/prints?unchecked=1&limit=50", rev).data;
  const [checking, setChecking] = useState<PrintRecord | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const reload = () => setRev((r) => r + 1);

  // Printers come free and prints end: keep it current.
  useEffect(() => {
    const t = setInterval(() => setRev((r) => r + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setError("");
    setBusyId(id);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId("");
      reload();
    }
  };
  const setMode = (printerId: string, name: string, mode: string) => {
    if (mode === "yolo" && !window.confirm(`YOLO: ${name} will start the next plate as soon as it is free, with nobody checking the bed. Only for printers that clear their own bed (or when you accept the risk). After a failed print it waits for you.`)) return;
    act(printerId, () => apiJson(`/api/printers/${printerId}/send-mode`, "POST", { mode, acknowledge: mode === "yolo" }));
  };
  const bedClear = (printerId: string) => act(printerId, () => apiJson(`/api/printers/${printerId}/bed-clear`, "POST", {}));
  const sendNext = (printerId: string) => act(printerId, () => apiJson(`/api/printers/${printerId}/send-next`, "POST", {}));
  const sendTo = (entry: QueueEntry, printerId: string) =>
    act(entry.id, () => apiJson(`/api/queue/${entry.id}/send`, "POST", { printer_id: printerId }));

  const view = queue.data;
  const printers = view?.printers ?? [];
  const nameOf = (id: string | null) => printers.find((p) => p.printer_id === id)?.name ?? "another printer";

  return (
    <div className="page">
      <div className="page-header">
        <h2>Queue</h2>
        <span className="hint">
          {view?.counts.queued ?? 0} waiting · {view?.counts.sent ?? 0} on printers
        </span>
      </div>
      <p className="hint">
        Plates waiting for a printer, most urgent first: an entry's priority, then its project's priority and due
        date, then age. Queue a job's plates from its page, or a project's missing parts from the project.
      </p>
      {error && <p className="login-error">{error}</p>}

      {printers.length > 0 && show === "queued" && (
        <div className="queue-printers">
          {printers.map((p) => {
            const next = view?.entries.find((e) => e.id === p.next);
            return (
              <div key={p.printer_id} className={`queue-printer${p.busy ? " busy" : ""}`}>
                <div className="queue-printer-name">
                  {p.name}
                  {p.send_mode === "yolo" && <span className="send-mode-yolo" title="Sends the next plate by itself, without asking">YOLO</span>}
                </div>
                {p.operates ? (
                  <select
                    className="send-mode-select"
                    value={p.send_mode}
                    aria-label={`How ${p.name} takes the queue`}
                    onChange={(e) => setMode(p.printer_id, p.name, e.target.value)}
                  >
                    <option value="manual">Send by hand</option>
                    <option value="confirm">Send when the bed is cleared</option>
                    <option value="yolo">YOLO: send as soon as it's free</option>
                  </select>
                ) : (
                  p.send_mode !== "manual" && <div className="hint">{p.send_mode === "yolo" ? "Sends by itself" : "Sends when the bed is cleared"}</div>
                )}
                {p.dispatch?.waiting_for === "bed" && (
                  <div className="queue-bed">
                    Waiting for the bed to be cleared
                    {p.operates && (
                      <button className="btn-sm" disabled={busyId === p.printer_id} onClick={() => bedClear(p.printer_id)}>
                        Bed is clear
                      </button>
                    )}
                  </div>
                )}
                <div className="hint">{p.busy ?? "Free"}</div>
                <div className="queue-printer-next">
                  {next ? <>Next: {next.visible ? `${next.name} · plate ${next.plate}` : "a plate you can't see"}</> : <span className="hint">Nothing in the queue fits</span>}
                </div>
                {p.operates && (
                  <button className="btn-sm" disabled={!!p.busy || !next || busyId === p.printer_id} onClick={() => sendNext(p.printer_id)}>
                    Send next
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {unchecked && unchecked.length > 0 && (
        <div className="queue-unchecked">
          <h3>Finished, not checked yet</h3>
          <ul>
            {unchecked.map((p) => (
              <li key={p.id}>
                {p.name ?? "A print"} on {p.printer_name}
                {p.plate > 1 && ` (plate ${p.plate})`} · {localDateTime(p.finished_at)}{" "}
                {p.can_record_outcome && (
                  <button className="btn-sm" onClick={() => setChecking(p)}>
                    How did it go?
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {checking && (
        <OutcomeDialog
          print={checking}
          onClose={() => setChecking(null)}
          onSaved={() => {
            setChecking(null);
            reload();
          }}
        />
      )}

      <div className="filters">
        <div className="job-plates" role="tablist" aria-label="Which entries">
          {(["queued", "sent", "done"] as Show[]).map((s) => (
            <button key={s} role="tab" aria-selected={show === s} className={show === s ? "active" : ""} onClick={() => setShow(s)}>
              {s === "queued" ? "Waiting" : s === "sent" ? "On printers" : "Done"}
            </button>
          ))}
        </div>
        {pools.length > 0 && (
          <select value={pool} onChange={(e) => setPool(e.target.value)} aria-label="Pool">
            <option value="">Every pool</option>
            {pools.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <select value={printer} onChange={(e) => setPrinter(e.target.value)} aria-label="Printer">
          <option value="">Every printer</option>
          {printers.map((p) => (
            <option key={p.printer_id} value={p.printer_id}>
              Fits {p.name}
            </option>
          ))}
        </select>
      </div>

      {queue.error && <p className="login-error">{queue.error}</p>}
      {view && view.entries.length === 0 && <p className="empty-state">{show === "queued" ? "Nothing waiting." : "Nothing here."}</p>}
      {view && view.entries.length > 0 && (
        <table className="data-table cards queue-table">
          <thead>
            <tr>
              <th>Plate</th>
              <th>For</th>
              <th>Priority</th>
              <th>{show === "queued" ? "Fits" : "Status"}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {view.entries.map((e, i) => (
              <EntryRow
                key={e.id}
                entry={e}
                position={i + 1}
                show={show}
                printerName={nameOf}
                busy={busyId === e.id}
                onSend={(pid) => sendTo(e, pid)}
                onChange={reload}
                onError={setError}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EntryRow({
  entry: e,
  position,
  show,
  printerName,
  busy,
  onSend,
  onChange,
  onError,
}: {
  entry: QueueEntry;
  position: number;
  show: Show;
  printerName: (id: string | null) => string;
  busy: boolean;
  onSend: (printerId: string) => void;
  onChange: () => void;
  onError: (e: string) => void;
}) {
  const [target, setTarget] = useState("");
  const patch = async (body: object) => {
    try {
      await apiJson(`/api/queue/${e.id}`, "PATCH", body);
      onChange();
    } catch (err) {
      onError(errorText(err));
    }
  };
  const remove = async () => {
    try {
      await apiJson(`/api/queue/${e.id}`, "DELETE");
      onChange();
    } catch (err) {
      onError(errorText(err));
    }
  };
  if (!e.visible) {
    return (
      <tr className="row-disabled">
        <td className="cell-title">
          {show === "queued" && <span className="hint">#{position} </span>}
          <span className="hint">A plate you can't see</span>
        </td>
        <td data-label="For">—</td>
        <td data-label="Priority">{e.priority}</td>
        <td data-label="Status">{e.status}</td>
        <td />
      </tr>
    );
  }
  const fits = (e.fits ?? []).filter((f) => !f.refused);
  const free = fits.filter((f) => !f.busy);
  return (
    <tr className={e.held ? "row-disabled" : ""}>
      <td className="cell-title">
        <div className="job-name">
          {e.has_thumbnail && <img className="job-thumb" src={`/api/jobs/${e.job_id}/thumbnail?plate=${e.plate}`} alt="" loading="lazy" />}
          <div>
            {show === "queued" && <span className="hint">#{position} </span>}
            <Link to={`/jobs/${e.job_id}`}>{e.name}</Link>
            <span className="hint"> · plate {e.plate}</span>
            <div className="hint">
              {linesText(e.lines)}
              {e.print_time_sec ? ` · ${formatDuration(e.print_time_sec)}` : ""}
              {e.weight_g ? ` · ${e.weight_g.toFixed(0)} g` : ""}
            </div>
            {e.note && <div className="hint">{e.note}</div>}
          </div>
        </div>
      </td>
      <td data-label="For">
        {(e.projects ?? []).map((p) => (
          <div key={p.id}>
            <Link to={`/projects/${p.id}`}>{p.name}</Link>
            {p.due_at && <span className={overdue(p.due_at, p.status) ? "printer-error" : "hint"}> · due {p.due_at.slice(0, 10)}</span>}
            {p.status === "on_hold" && <span className="hint"> · on hold</span>}
          </div>
        ))}
        {(e.projects ?? []).length === 0 && <span className="hint">{e.created_by_name ?? "—"}</span>}
      </td>
      <td data-label="Priority">
        {e.can_manage && show === "queued" ? (
          <span className="queue-priority">
            <input
              type="number"
              min={-100}
              max={100}
              defaultValue={e.priority}
              aria-label="Priority"
              onBlur={(ev) => Number(ev.target.value) !== e.priority && patch({ priority: Number(ev.target.value) })}
            />
            {position > 1 && (
              <button className="btn-sm" title="Ahead of everything else" onClick={() => patch({ position: "top" })}>
                Top
              </button>
            )}
          </span>
        ) : (
          e.priority
        )}
      </td>
      <td data-label={show === "queued" ? "Fits" : "Status"}>
        {show === "queued" ? (
          <>
            {e.printer_id && <div className="hint">Only {printerName(e.printer_id)}</div>}
            {fits.length === 0 ? (
              <span className="printer-error" title={(e.fits ?? []).map((f) => `${printerName(f.printer_id)}: ${f.refused}`).join("\n")}>
                No printer fits
              </span>
            ) : (
              <span title={fits.map((f) => `${printerName(f.printer_id)}: ${f.busy ?? "free"}${f.problems.length ? ` (${f.problems.join("; ")})` : ""}`).join("\n")}>
                {fits.map((f) => printerName(f.printer_id)).join(", ")}
              </span>
            )}
            {e.held && <div className="hint">Waiting: its project is on hold</div>}
          </>
        ) : (
          <>
            <span className={`status-badge queue-${e.status}`}>{e.status}</span>
            {e.sent_at && <div className="hint">{localDateTime(e.sent_at)}</div>}
          </>
        )}
      </td>
      <td className="cell-actions">
        {show === "queued" && free.length > 0 && !e.held && (
          <span className="print-controls">
            <select value={target} onChange={(ev) => setTarget(ev.target.value)} aria-label="Send to">
              <option value="">Send to…</option>
              {free.map((f) => (
                <option key={f.printer_id} value={f.printer_id}>
                  {printerName(f.printer_id)}
                  {f.problems.length ? " (change filament)" : ""}
                </option>
              ))}
            </select>
            <button className="btn-sm" disabled={!target || busy} onClick={() => onSend(target)}>
              Send
            </button>
          </span>
        )}
        {e.can_manage && show === "queued" && (
          <button className="btn-sm btn-danger" onClick={remove}>
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}
