// One print: its plate's G-code preview following the printer while it
// prints (components/preview/live.ts says how close that can be per
// printer), with the printer's status, camera and controls beside it.

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { formatDuration, localDateTime, useJson } from "../api";
import CameraView from "../components/CameraView";
import Icon from "../components/Icon";
import OutcomeDialog from "../components/OutcomeDialog";
import PrintControls from "../components/PrintControls";
import GcodePreview, { type PrintProgress } from "../components/preview/GcodePreview";
import { bedFromConfig, packagePlates, parseObject, plateColors } from "../jobConfig";
import { previewPath } from "../links";
import { ACTIVE_PRINT, outcomeText, usePrinterStatuses, type Printer, type PrintRecord } from "../printers";

interface PrintJob {
  id: string;
  model_name: string;
  config_json: string | null;
  package_json: string | null;
}

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

export default function PrintPage() {
  const { id = "" } = useParams();
  const [rev, setRev] = useState(0);
  const [recording, setRecording] = useState(false);
  const [camera, setCamera] = useState(false);
  const { data: print, error, status: httpStatus } = useJson<PrintRecord>(`/api/prints/${id}`, rev);
  const active = !!print && (ACTIVE_PRINT.includes(print.status) || print.status === "pending_approval");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setRev((r) => r + 1), 5000);
    return () => clearInterval(t);
  }, [active]);

  const job = useJson<PrintJob>(print?.job_id && print.name ? `/api/jobs/${print.job_id}` : null).data;
  const printers = useJson<Printer[]>("/api/printers").data;
  const printer = printers?.find((p) => p.id === print?.printer_id) ?? null;
  const statuses = usePrinterStatuses();
  const status = print?.printer_id ? statuses[print.printer_id] : undefined;

  const plates = useMemo(() => packagePlates(job?.package_json), [job?.package_json]);
  const plate = plates.find((p) => p.index === print?.plate) ?? null;
  const bed = useMemo(() => bedFromConfig(parseObject(job?.config_json)), [job?.config_json]);
  const filamentColors = useMemo(() => plateColors(plate), [plate]);
  const jobId = print?.job_id ?? null;
  const plateIndex = print?.plate ?? 1;
  const source = useMemo(() => (jobId ? { url: `/api/jobs/${jobId}/gcode?plate=${plateIndex}` } : null), [jobId, plateIndex]);

  // What the preview follows: the printer while this print runs on it, where
  // it stopped once it has ended.
  const printing = print?.status === "printing" || print?.status === "paused";
  const live: PrintProgress | null = (() => {
    if (!print) return null;
    if (print.status === "finished") return { done: true };
    if (printing && status?.online) {
      if (status.layer == null && status.percent == null) return null;
      return {
        layer: status.layer,
        totalLayers: status.total_layers,
        percent: status.percent,
        speedPercent: status.speed_percent,
        paused: print.status === "paused",
      };
    }
    if ((print.status === "failed" || print.status === "cancelled") && print.started_at && print.progress > 0) {
      return { percent: print.progress, ended: true };
    }
    if (printing) return { percent: print.progress };
    return null;
  })();

  if (!print) {
    return (
      <div className="page">
        <p className="breadcrumb">
          <Link to="/prints">Prints</Link>
        </p>
        {httpStatus === 404 ? (
          <p className="empty-state">This print doesn't exist, or you can't see it.</p>
        ) : error ? (
          <p className="login-error">{error}</p>
        ) : (
          <p className="hint">Loading…</p>
        )}
      </div>
    );
  }

  const name = print.name ?? "A print you can't see";
  const remaining = printing ? status?.remaining_minutes : null;

  return (
    <div className="page job-page">
      <p className="breadcrumb">
        <Link to="/prints">Prints</Link> / {name}
        {print.plate > 1 && ` · plate ${print.plate}`}
      </p>
      <div className="job-header">
        <h2>
          {name}
          {print.plate > 1 && <span className="hint"> · plate {print.plate}</span>}
        </h2>
        <span className={`status-badge print-${print.status}`}>{STATUS_LABELS[print.status] ?? print.status}</span>
        <div className="job-actions">
          {print.can_control && printing && (
            <PrintControls print={print} capabilities={printer?.capabilities} status={status} onChange={() => setRev((r) => r + 1)} />
          )}
          {print.can_record_outcome && (
            <button className="btn-sm" onClick={() => setRecording(true)}>
              {print.outcome ? "Change outcome" : "How did it go?"}
            </button>
          )}
          {printer?.capabilities?.camera && printing && (
            <button className="btn-sm" onClick={() => setCamera((c) => !c)} aria-pressed={camera}>
              <Icon name="camera" /> Camera
            </button>
          )}
          {print.job_id && print.name && (
            <Link className="btn-sm" to={previewPath(print.job_id, print.plate)}>
              Job details
            </Link>
          )}
        </div>
      </div>

      <dl className="job-facts">
        <div>
          <dt>Printer</dt>
          <dd>{print.printer_name}</dd>
        </div>
        <div>
          <dt>Progress</dt>
          <dd>
            {print.status === "finished" ? "100%" : `${printing && status?.percent != null ? status.percent : print.progress}%`}
            {printing && status?.layer != null && status.total_layers ? ` · layer ${status.layer} of ${status.total_layers}` : ""}
          </dd>
        </div>
        {remaining != null && (
          <div>
            <dt>Left</dt>
            <dd>{formatDuration(remaining * 60)}</dd>
          </div>
        )}
        <div>
          <dt>By</dt>
          <dd>{print.username ?? "—"}</dd>
        </div>
        <div>
          <dt>Sent</dt>
          <dd>{localDateTime(print.created_at)}</dd>
        </div>
        {print.started_at && (
          <div>
            <dt>Started</dt>
            <dd>{localDateTime(print.started_at)}</dd>
          </div>
        )}
        {print.finished_at && (
          <div>
            <dt>Ended</dt>
            <dd>{localDateTime(print.finished_at)}</dd>
          </div>
        )}
        {(print.outcome || print.status === "finished") && (
          <div>
            <dt>Outcome</dt>
            <dd>{outcomeText(print)}</dd>
          </div>
        )}
      </dl>

      {print.error && <p className="login-error">{print.error}</p>}

      {camera && print.printer_id && (
        <div className="print-camera">
          <CameraView printerId={print.printer_id} />
        </div>
      )}

      {source ? (
        <div className="job-preview">
          <GcodePreview source={source} bed={bed} filamentColors={filamentColors} live={live} />
        </div>
      ) : (
        <p className="hint">{print.name ? "This print has no G-code to show." : "You can't see this print's G-code."}</p>
      )}

      {recording && (
        <OutcomeDialog
          print={print}
          onClose={() => setRecording(false)}
          onSaved={() => {
            setRecording(false);
            setRev((r) => r + 1);
          }}
        />
      )}
    </div>
  );
}
