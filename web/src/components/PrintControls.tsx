import { useState } from "react";
import { apiJson } from "../auth";
import { errorText } from "../api";
import type { Capabilities, PrinterStatus, PrintRecord } from "../printers";

/** Pause / resume / stop / speed for a print the viewer may control, as far
 * as the printer can do them. `url` defaults to the print's control endpoint;
 * admins use the printer's for prints started elsewhere. */
export default function PrintControls({
  print,
  url,
  capabilities,
  status,
  onChange,
}: {
  print?: PrintRecord;
  url?: string;
  /** What the printer can do; unknown = everything. */
  capabilities?: Capabilities | null;
  /** The printer's live status, when known (pause vs resume, current speed). */
  status?: PrinterStatus | null;
  onChange?: () => void;
}) {
  const state = status?.state;
  const speed = status?.speed_level;
  const canPause = capabilities?.pause ?? true;
  const canStop = capabilities?.stop ?? true;
  const speedControl = capabilities === undefined ? "levels" : capabilities?.speed;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const endpoint = url ?? (print ? `/api/prints/${print.id}/control` : "");
  const paused = state ? state === "PAUSE" : print?.status === "paused";

  const setSpeed = async (level: number) => {
    setBusy("speed");
    setError("");
    try {
      await apiJson(endpoint, "POST", { action: "speed", level });
      onChange?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const act = async (action: "pause" | "resume" | "stop") => {
    if (action === "stop" && !confirm(`Stop ${print?.name ?? "this print"}? It can't be resumed.`)) return;
    setBusy(action);
    setError("");
    try {
      await apiJson(endpoint, "POST", { action });
      onChange?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  if (!endpoint) return null;
  return (
    <span className="print-controls">
      {canPause &&
        (paused ? (
          <button className="btn-sm" disabled={!!busy} onClick={() => act("resume")}>
            {busy === "resume" ? "Resuming…" : "Resume"}
          </button>
        ) : (
          <button className="btn-sm" disabled={!!busy} onClick={() => act("pause")}>
            {busy === "pause" ? "Pausing…" : "Pause"}
          </button>
        ))}
      {canStop && (
        <button className="btn-sm btn-danger" disabled={!!busy} onClick={() => act("stop")}>
          {busy === "stop" ? "Stopping…" : "Stop"}
        </button>
      )}
      {speedControl === "levels" && (
        <select
          className="speed-select"
          value={speed ?? 2}
          disabled={!!busy}
          onChange={(e) => setSpeed(Number(e.target.value))}
          title="Print speed"
        >
          <option value={1}>Silent</option>
          <option value={2}>Standard</option>
          <option value={3}>Sport</option>
          <option value={4}>Ludicrous</option>
        </select>
      )}
      {error && <span className="printer-error">{error}</span>}
    </span>
  );
}
