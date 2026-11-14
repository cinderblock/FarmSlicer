// One job: what was sliced and how, what the slicer warned about, the
// G-code preview of each plate, its G-code check, and "Print…".
// `?plate=N&layer=K` (1-based) open a plate at a layer; both follow the view.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { formatDuration, localDateTime, useJson } from "../api";
import SendDialog from "../components/SendDialog";
import GcodeCheckDetails, { GcodeChip } from "../components/GcodeCheck";
import GcodePreview from "../components/preview/GcodePreview";
import NozzlePlanView from "../components/NozzlePlanView";
import JobProjects from "../components/JobProjects";
import QueueButton from "../components/QueueButton";
import { formatCost, packageVerdict, type NozzlePlan, type Plate, type Prices, type PrintRecord } from "../printers";
import { parseWarnings, sortWarnings } from "../slicerWarnings";
import { positiveParam, printPath } from "../links";
import { bedFromConfig, packagePlates, parseObject, plateColors } from "../jobConfig";

interface Job {
  id: string;
  model_name: string;
  status: string;
  progress: number;
  progress_message: string | null;
  printer_name: string | null;
  routing: string;
  print_time_sec: number | null;
  filament_used_g: number | null;
  error: string | null;
  warnings: string | null;
  source: "server" | "browser" | "upload";
  created_at: string;
  username: string | null;
  group_name: string | null;
  package_json: string | null;
  config_json: string | null;
  overrides_json: string | null;
  estimated_cost: number | null;
  /** Source models kept (on the server or in a browser): can be sliced again. */
  model_count: number;
  /** What the job was made from (profiles by name), when known. */
  inputs: { machine: string; process: string; filaments: string[] } | null;
  /** Dual-nozzle printers: which nozzle each filament was given, and why; null = the slicer chose. */
  nozzle_plan: NozzlePlan | null;
}

const SOURCES: Record<Job["source"], string> = {
  server: "Sliced on the server",
  browser: "Sliced in the browser",
  upload: "Uploaded",
};


const first = (v: unknown): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s ? s : null;
};

export default function JobPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [rev, setRev] = useState(0);
  const [sending, setSending] = useState(false);
  const [params, setParams] = useSearchParams();
  const plateChoice = positiveParam(params.get("plate"));
  // Read once per plate: the preview opens there, then reports where it is.
  const initialLayer = useMemo(() => positiveParam(params.get("layer")), [plateChoice]); // eslint-disable-line react-hooks/exhaustive-deps
  const layerTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(layerTimer.current), []);
  const onLayer = useCallback(
    (layer: number) => {
      clearTimeout(layerTimer.current);
      layerTimer.current = window.setTimeout(
        () =>
          setParams(
            (p) => {
              const next = new URLSearchParams(p);
              next.set("layer", String(layer + 1));
              return next;
            },
            { replace: true },
          ),
        300,
      );
    },
    [setParams],
  );
  const choosePlate = (index: number) => {
    clearTimeout(layerTimer.current);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set("plate", String(index));
        next.delete("layer");
        return next;
      },
      { replace: true },
    );
  };
  const { data: job, error, status } = useJson<Job>(`/api/jobs/${id}`, rev);
  const currency = useJson<Prices>("/api/prices").data?.currency ?? "$";
  // Prints of this job under way: watch them on their own page.
  const printing = (useJson<PrintRecord[]>("/api/prints?active=1").data ?? []).filter((p) => p.job_id === id && p.name);

  // Follow a job that is still slicing.
  const active = job?.status === "queued" || job?.status === "slicing";
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setRev((r) => r + 1), 2000);
    return () => clearInterval(t);
  }, [active]);

  const plates: Plate[] = useMemo(() => packagePlates(job?.package_json), [job?.package_json]);
  const config = useMemo(() => parseObject(job?.config_json ?? null), [job?.config_json]);
  const bed = useMemo(() => bedFromConfig(config), [config]);
  const plate = plates.find((p) => p.index === plateChoice) ?? plates[0] ?? null;
  const filamentColors = useMemo(() => plateColors(plate), [plate]);
  const source = useMemo(() => ({ url: `/api/jobs/${id}/gcode${plate ? `?plate=${plate.index}` : ""}` }), [id, plate]);

  if (!job) {
    return (
      <div className="page">
        <p className="breadcrumb">
          <Link to="/jobs">Jobs</Link>
        </p>
        {status === 404 ? (
          <p className="empty-state">This job doesn't exist, or you can't see it.</p>
        ) : error ? (
          <p className="login-error">{error}</p>
        ) : (
          <p className="hint">Loading…</p>
        )}
      </div>
    );
  }

  const { support, technical, other } = sortWarnings(parseWarnings(job.warnings));
  const overrides = parseObject(job.overrides_json);
  const profiles = (
    job.inputs
      ? [job.inputs.machine, job.inputs.process, ...job.inputs.filaments]
      : [first(config?.printer_settings_id), first(config?.print_settings_id), first(config?.filament_settings_id)]
  ).filter((s): s is string => !!s);
  const done = job.status === "done";
  const canReslice = job.model_count > 0 && job.source !== "upload" && !active;
  const reslice = () => navigate(`/slice?from=${job.id}`);
  const verdict = packageVerdict(job.package_json);
  const time = plate?.print_time_sec ?? job.print_time_sec;
  const weight = plate?.weight_g ?? job.filament_used_g;

  return (
    <div className="page job-page">
      <p className="breadcrumb">
        <Link to="/jobs">Jobs</Link> / {job.model_name}
      </p>
      <div className="job-header">
        <h2>{job.model_name}</h2>
        <span className={`status-badge status-${job.status}`}>{job.status}</span>
        {job.package_json && <GcodeChip {...verdict} />}
        <div className="job-actions">
          {done && job.package_json && (
            <button className="btn-primary" onClick={() => setSending(true)}>
              Print…
            </button>
          )}
          {done && job.package_json && <QueueButton jobId={job.id} plates={plates.map((p) => p.index)} />}
          {canReslice && (
            <button
              className="btn-sm"
              title="Open this job's models and settings on the Slice page, change what you like, and slice it as a new job"
              onClick={reslice}
            >
              {done && job.package_json ? "Re-slice" : "Slice"}
            </button>
          )}
          {done && (
            <a className="btn-sm" href={source.url} download>
              Download G-code
            </a>
          )}
        </div>
      </div>

      <dl className="job-facts">
        {profiles.length > 0 && (
          <div>
            <dt>Profiles</dt>
            <dd>{profiles.join(" · ")}</dd>
          </div>
        )}
        {overrides && Object.keys(overrides).length > 0 && (
          <div>
            <dt>Changed settings</dt>
            <dd>
              {Object.entries(overrides)
                .map(([k, v]) => `${k} = ${Array.isArray(v) ? v.join(",") : String(v)}`)
                .join(" · ")}
            </dd>
          </div>
        )}
        <div>
          <dt>Print time</dt>
          <dd>{time ? formatDuration(time) : "—"}</dd>
        </div>
        <div>
          <dt>Filament</dt>
          <dd>
            {weight ? `${weight.toFixed(1)} g` : "—"}
            {done && job.estimated_cost != null && ` · ${formatCost(job.estimated_cost, currency)}`}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{SOURCES[job.source] ?? job.source}</dd>
        </div>
        <div>
          <dt>By</dt>
          <dd>
            {job.username ?? "—"} · {job.group_name ?? "Personal"}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{localDateTime(job.created_at)}</dd>
        </div>
        {(job.printer_name || job.routing !== "auto") && (
          <div>
            <dt>Printer</dt>
            <dd>{job.printer_name ?? job.routing}</dd>
          </div>
        )}
      </dl>

      {printing.length > 0 && (
        <div className="job-alert job-alert-live" role="status">
          {printing.map((p) => (
            <div key={p.id}>
              {p.status === "printing" || p.status === "paused" ? "Printing" : "Starting"} on <strong>{p.printer_name}</strong>
              {plates.length > 1 && ` (plate ${p.plate})`}
              {" · "}
              <Link to={printPath(p.id)}>Watch it layer by layer</Link>
            </div>
          ))}
        </div>
      )}

      {job.nozzle_plan && job.inputs && (
        <NozzlePlanView plan={job.nozzle_plan} filaments={job.inputs.filaments} title="Nozzles (when sliced)" />
      )}

      {support.length > 0 && (
        <div className="job-alert job-alert-support" role="alert">
          <strong>Parts of this model would print in mid-air.</strong>
          <ul>
            {support.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <p>
            Turn supports on (or turn the part over) and slice it again, or the print will likely fail.
            {canReslice && (
              <>
                {" "}
                <button className="btn-sm" onClick={reslice}>
                  Re-slice…
                </button>
              </>
            )}
          </p>
        </div>
      )}
      {other.length > 0 && (
        <div className="job-alert" role="status">
          <strong>
            {other.length} warning{other.length === 1 ? "" : "s"} from the slicer
          </strong>
          <ul>
            {other.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {job.error && (
        <p className="login-error">
          <strong>Failed:</strong> {job.error}
        </p>
      )}

      {active && (
        <div className="job-progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${job.progress}%` }} />
          </div>
          <span className="hint">{job.progress_message ?? (job.status === "queued" ? "Waiting for the slicer…" : "Slicing…")}</span>
        </div>
      )}

      {done && (
        <>
          {plates.length > 1 && (
            <div className="job-plates" role="tablist" aria-label="Plates">
              {plates.map((p) => (
                <button
                  key={p.index}
                  role="tab"
                  aria-selected={p.index === plate?.index}
                  className={p.index === plate?.index ? "active" : ""}
                  onClick={() => choosePlate(p.index)}
                >
                  Plate {p.index}
                </button>
              ))}
            </div>
          )}
          <div className="job-preview">
            <GcodePreview
              source={source}
              initialLayer={initialLayer == null ? null : initialLayer - 1}
              onLayer={onLayer}
              bed={bed}
              filamentColors={filamentColors}
              showStats={new URLSearchParams(window.location.search).has("stats")}
            />
          </div>
          {plate?.check && <GcodeCheckDetails check={plate.check} open={plate.check.findings.length > 0} />}
        </>
      )}

      {!active && !(done && job.package_json) && (
        <div className="job-unsliced">
          <strong>Not sliced</strong>
          <p className="hint">
            {job.status === "failed"
              ? "Slicing failed, so there's no G-code to preview or print."
              : job.status === "cancelled"
                ? "Slicing was cancelled, so there's no G-code to preview or print."
                : "There's no G-code for this job to preview or print."}
            {!canReslice && job.model_count === 0 && " Its models aren't kept on the server, so it can't be sliced from here."}
          </p>
          {canReslice && (
            <button className="btn-primary btn-inline" onClick={reslice}>
              Slice it
            </button>
          )}
        </div>
      )}

      {done && <JobProjects jobId={job.id} />}

      {technical.length > 0 && (
        <details className="hint job-technical">
          <summary>Technical notes</summary>
          <ul>
            {technical.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      {sending && (
        <SendDialog
          jobId={job.id}
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
