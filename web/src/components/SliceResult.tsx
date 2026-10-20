// What the Slice page shows after slicing: the job's progress while it
// slices, then the layer preview, the numbers, what the slicer warned
// about, the G-code check, and sending it to a printer.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { formatDuration, useJson } from "../api";
import { formatCost, packageVerdict, type Prices } from "../printers";
import { parseWarnings, sortWarnings } from "../slicerWarnings";
import { GcodeChip } from "./GcodeCheck";
import GcodePreview from "./preview/GcodePreview";
import SendDialog from "./SendDialog";
import type { BedShape } from "./ModelViewer";

interface ResultJob {
  id: string;
  model_name: string;
  status: string;
  progress: number;
  progress_message: string | null;
  print_time_sec: number | null;
  filament_used_g: number | null;
  estimated_cost: number | null;
  warnings: string | null;
  error: string | null;
  package_json: string | null;
}

/** How often to look at a job that's still slicing (ms). */
const POLL_MS = 1500;
/** Looks at a finished job before giving up on its package. */
const SETTLE_POLLS = 40;

export default function SliceResult({
  jobId,
  gcode,
  bed,
  onBack,
}: {
  jobId: string;
  /** Plate 1's G-code, when this browser sliced it (no download needed). */
  gcode?: Uint8Array | null;
  bed: BedShape | null;
  /** Back to the plate. */
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const [rev, setRev] = useState(0);
  const [sending, setSending] = useState(false);
  const [plateChoice, setPlateChoice] = useState(1);
  const job = useJson<ResultJob>(`/api/jobs/${jobId}`, rev).data;
  // A job with several plates: one tab each (their numbers from the package).
  const packageJson = job?.package_json ?? null;
  const plates = useMemo(() => {
    try {
      const pkg = packageJson ? JSON.parse(packageJson) : null;
      return (pkg?.plates ?? []) as { index: number; print_time_sec: number | null; weight_g: number | null }[];
    } catch {
      return [];
    }
  }, [packageJson]);
  const plate = plates.length > 1 ? (plates.find((p) => p.index === plateChoice) ?? plates[0]) : null;
  const plateIndex = plate?.index ?? 1;
  const several = plates.length > 1;
  const source = useMemo(
    () =>
      gcode && plateIndex === 1
        ? { data: gcode }
        : { url: `/api/jobs/${jobId}/gcode${several ? `?plate=${plateIndex}` : ""}` },
    [gcode, plateIndex, jobId, several],
  );
  const currency = useJson<Prices>("/api/prices").data?.currency ?? "$";
  const busy = !job || job.status === "queued" || job.status === "slicing";
  // The package lands after the G-code (its check runs): wait a little for
  // it too (a G-code that can't be one never gets one).
  const settling = job?.status === "done" && !job.package_json && rev < SETTLE_POLLS;

  useEffect(() => {
    if (!busy && !settling) return;
    const t = setTimeout(() => setRev((r) => r + 1), POLL_MS);
    return () => clearTimeout(t);
  }, [busy, settling, rev]);

  if (!job || busy) {
    return (
      <div className="slice-result slice-result-waiting">
        <p>{job?.status === "queued" ? "Waiting for the slicer…" : "Slicing…"}</p>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${job?.progress ?? 0}%` }} />
        </div>
        <p className="hint">{job?.progress_message ?? ""}</p>
        <button className="btn-sm" onClick={onBack}>
          Back to the plate
        </button>
      </div>
    );
  }

  if (job.status !== "done") {
    return (
      <div className="slice-result slice-result-waiting">
        <p className="login-error">
          {job.status === "cancelled" ? "The slice was cancelled." : `The slice failed: ${job.error ?? "unknown error"}`}
        </p>
        <button className="btn-sm" onClick={onBack}>
          Back to the plate
        </button>
      </div>
    );
  }

  const { support, other } = sortWarnings(parseWarnings(job.warnings));
  return (
    <div className="slice-result">
      <div className="slice-result-bar">
        <button className="btn-sm" onClick={onBack}>
          ← Plate
        </button>
        <span className="slice-result-stats">
          {plates.length > 1 && `${plates.length} plates: `}
          {formatDuration(job.print_time_sec)} · {(job.filament_used_g ?? 0).toFixed(1)} g ·{" "}
          {formatCost(job.estimated_cost, currency)}
        </span>
        {job.package_json && <GcodeChip {...packageVerdict(job.package_json)} />}
        <span className="slice-result-actions">
          <Link className="btn-sm" to={`/jobs/${jobId}`}>
            Job page
          </Link>
          {job.package_json && (
            <button className="btn-primary btn-inline" onClick={() => setSending(true)}>
              Send to printer…
            </button>
          )}
        </span>
      </div>
      {support.length > 0 && (
        <div className="slice-result-warning bad">
          {support.map((w) => (
            <p key={w}>{w}</p>
          ))}
          <p className="hint">Turn supports on or turn the part, then slice again.</p>
        </div>
      )}
      {other.length > 0 && (
        <details className="slice-result-warning">
          <summary>
            {other.length} slicer warning{other.length === 1 ? "" : "s"}
          </summary>
          {other.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </details>
      )}
      {plate && (
        <div className="job-plates" role="tablist" aria-label="Plates">
          {plates.map((p) => (
            <button
              key={p.index}
              role="tab"
              aria-selected={p.index === plate.index}
              className={p.index === plate.index ? "active" : ""}
              onClick={() => setPlateChoice(p.index)}
              title={`${formatDuration(p.print_time_sec)} · ${(p.weight_g ?? 0).toFixed(1)} g`}
            >
              Plate {p.index}
            </button>
          ))}
        </div>
      )}
      <div className="slice-result-preview">
        <GcodePreview key={plateIndex} source={source} bed={bed} />
      </div>
      {sending && (
        <SendDialog
          jobId={jobId}
          jobName={job.model_name}
          onClose={() => setSending(false)}
          onSent={() => {
            setSending(false);
            navigate("/prints");
          }}
        />
      )}
    </div>
  );
}
