import { useState } from "react";
import { Link } from "react-router";
import { apiJson } from "../auth";
import { errorText } from "../api";

/** "Add to queue": a job's plates, each to be printed `count` times. */
export default function QueueButton({ jobId, plates }: { jobId: string; plates: number[] }) {
  const [open, setOpen] = useState(false);
  const [plate, setPlate] = useState<number | "all">("all");
  const [count, setCount] = useState(1);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const add = async () => {
    setError("");
    try {
      const added = await apiJson<unknown[]>("/api/queue", "POST", {
        job_id: jobId,
        ...(plate === "all" ? {} : { plate }),
        count,
      });
      setMessage(`${added.length} queued`);
      setOpen(false);
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!open)
    return (
      <>
        <button className="btn-sm" onClick={() => setOpen(true)}>
          Add to queue…
        </button>
        {message && (
          <span className="hint">
            {message} · <Link to="/queue">Queue</Link>
          </span>
        )}
      </>
    );
  return (
    <span className="add-item">
      {plates.length > 1 && (
        <select value={plate} onChange={(e) => setPlate(e.target.value === "all" ? "all" : Number(e.target.value))} aria-label="Plate">
          <option value="all">Every plate</option>
          {plates.map((p) => (
            <option key={p} value={p}>
              Plate {p}
            </option>
          ))}
        </select>
      )}
      <label className="inline-label">
        ×
        <input type="number" min={1} max={200} value={count} onChange={(e) => setCount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} aria-label="How many times" />
      </label>
      <button className="btn-sm" onClick={add}>
        Queue
      </button>
      <button className="btn-sm" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <span className="printer-error">{error}</span>}
    </span>
  );
}
