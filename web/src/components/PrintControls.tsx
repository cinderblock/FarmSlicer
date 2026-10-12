import { useState } from "react";
import { apiJson } from "../auth";
import { errorText } from "../api";
import type { PrintRecord } from "../printers";

/** Pause / resume / stop for a print the viewer may control. `url` defaults
 * to the print's control endpoint; admins use the printer's for prints
 * started elsewhere. */
export default function PrintControls({
  print,
  url,
  state,
  onChange,
}: {
  print?: PrintRecord;
  url?: string;
  /** The printer's gcode_state, when known (decides pause vs resume). */
  state?: string | null;
  onChange?: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const endpoint = url ?? (print ? `/api/prints/${print.id}/control` : "");
  const paused = state ? state === "PAUSE" : print?.status === "paused";

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
      {paused ? (
        <button className="btn-sm" disabled={!!busy} onClick={() => act("resume")}>
          {busy === "resume" ? "Resuming…" : "Resume"}
        </button>
      ) : (
        <button className="btn-sm" disabled={!!busy} onClick={() => act("pause")}>
          {busy === "pause" ? "Pausing…" : "Pause"}
        </button>
      )}
      <button className="btn-sm btn-danger" disabled={!!busy} onClick={() => act("stop")}>
        {busy === "stop" ? "Stopping…" : "Stop"}
      </button>
      {error && <span className="printer-error">{error}</span>}
    </span>
  );
}
