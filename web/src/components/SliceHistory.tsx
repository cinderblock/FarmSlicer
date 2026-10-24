// The Slice page's recent slices (kept in this browser, sliceCache.ts): each
// with what it changes from the slice on screen, its time and filament.
// Show one, compare it with the one on screen, take its settings back to
// the plate, forget it; and how many to keep.

import { useState } from "react";
import { formatDuration } from "../api";
import { clearSlices, deleteSlice, getLimits, setLimits } from "../sliceCache";
import { changeSummary, inputsDiff, type SliceEntry } from "../sliceHistory";
import { sliceTime } from "../useSliceHistory";

const GB = 1024 ** 3;

/** "0.5 MB", "12 MB". */
const megabytes = (bytes: number) => {
  const mb = bytes / 1024 ** 2;
  return `${mb < 10 ? mb.toFixed(1) : mb.toFixed(0)} MB`;
};

interface Props {
  entries: SliceEntry[];
  /** The job on screen. */
  current: string;
  /** The job it's compared with, if any. */
  comparing: string | null;
  onShow: (e: SliceEntry) => void;
  onCompare: (e: SliceEntry | null) => void;
  /** Put the slice's models and settings back on the plate. */
  onRestore: (e: SliceEntry) => void;
}

export default function SliceHistory({ entries, current, comparing, onShow, onCompare, onRestore }: Props) {
  const [limits, setLimitsState] = useState(getLimits);
  const shown = entries.find((e) => e.jobId === current);
  if (entries.length === 0) return null;
  const keep = entries.filter((e) => e.jobId === current || e.jobId === comparing).map((e) => e.key);
  const changeLimits = (next: typeof limits) => {
    setLimitsState(next);
    void setLimits(next, keep);
  };
  const bytes = entries.reduce((n, e) => n + e.gcodeBytes, 0);

  return (
    <details className="slice-history" open>
      <summary>
        Recent slices <span className="hint">({entries.length}, kept in this browser)</span>
      </summary>
      <ul>
        {entries.map((e) => {
          const isCurrent = e.jobId === current;
          const isCompared = e.jobId === comparing;
          const changes = shown && !isCurrent ? inputsDiff(shown.inputs, e.inputs) : [];
          const title = changes.map((c) => `${c.label}: ${c.a ?? "default"} → ${c.b ?? "default"}`).join("\n");
          return (
            <li key={e.key} className={`slice-history-row${isCurrent ? " current" : ""}${isCompared ? " compared" : ""}`}>
              <button className="slice-history-pick" onClick={() => onShow(e)} disabled={isCurrent} title={title || undefined}>
                <span className="slice-history-when">{sliceTime(e.createdAt)}</span>
                <span className="slice-history-what">
                  {isCurrent ? "on screen" : shown ? changeSummary(changes) : e.inputs.models.map((m) => m.name).join(", ")}
                </span>
                <span className="slice-history-stats">
                  {e.stats
                    ? `${formatDuration(e.stats.printTimeSec)} · ${(e.stats.filamentG ?? 0).toFixed(1)} g${e.stats.plates > 1 ? ` · ${e.stats.plates} plates` : ""}`
                    : "…"}
                </span>
              </button>
              <span className="slice-history-actions">
                {!isCurrent && (
                  <button
                    className={`btn-sm${isCompared ? " active" : ""}`}
                    aria-pressed={isCompared}
                    onClick={() => onCompare(isCompared ? null : e)}
                    disabled={!e.stats}
                    title={e.stats ? "Compare with the slice on screen" : "Still slicing"}
                  >
                    Compare
                  </button>
                )}
                <button className="btn-sm" onClick={() => onRestore(e)} title="Put this slice's models and settings back on the plate">
                  Settings
                </button>
                <button
                  className="btn-sm"
                  onClick={() => void deleteSlice(e.key)}
                  disabled={isCurrent || isCompared}
                  aria-label="Forget this slice"
                  title="Forget it here (the job stays on the server)"
                >
                  ×
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="hint slice-history-limits">
        Keep the last{" "}
        <input
          type="number"
          min={1}
          max={100}
          value={limits.count}
          onChange={(ev) => {
            const count = Math.max(1, Math.min(100, Math.round(Number(ev.target.value)) || 1));
            changeLimits({ ...limits, count });
          }}
          aria-label="Slices to keep"
        />{" "}
        slices, up to{" "}
        <input
          type="number"
          min={0.1}
          step={0.5}
          value={+(limits.bytes / GB).toFixed(1)}
          onChange={(ev) => {
            const gb = Math.max(0.1, Number(ev.target.value) || 0.1);
            changeLimits({ ...limits, bytes: Math.round(gb * GB) });
          }}
          aria-label="G-code to keep, GB"
        />{" "}
        GB of G-code ({megabytes(bytes)} now).{" "}
        <button className="btn-sm" onClick={() => void clearSlices()}>
          Forget them all
        </button>
      </p>
    </details>
  );
}
