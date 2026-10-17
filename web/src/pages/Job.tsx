// One job: what was sliced and how, what the slicer warned about, the
// G-code preview of each plate, its G-code check, and "Print…".

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { formatDuration, localDateTime, useJson } from "../api";
import SendDialog from "../components/SendDialog";
import GcodeCheckDetails, { GcodeChip } from "../components/GcodeCheck";
import GcodePreview from "../components/preview/GcodePreview";
import NozzlePlanView from "../components/NozzlePlanView";
import type { BedShape } from "../components/ModelViewer";
import { formatCost, packageVerdict, type NozzlePlan, type Plate, type Prices } from "../printers";
import { parseWarnings, sortWarnings } from "../slicerWarnings";

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


function parseObject(raw: string | null): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** The bed from the job's config: `printable_area` ("0x0", ...) and `printable_height`. */
function bedFromConfig(config: Record<string, unknown> | null): BedShape | null {
  if (!config) return null;
  const raw = config.printable_area;
  const points = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [])
    .map((p) => String(p).split("x").map(Number))
    .filter((p): p is [number, number] => p.length === 2 && p.every(Number.isFinite));
  if (points.length < 3) return null;
  const height = Number(Array.isArray(config.printable_height) ? config.printable_height[0] : config.printable_height);
  return { area: points, height: Number.isFinite(height) && height > 0 ? height : 0 };
}

const first = (v: unknown): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s ? s : null;
};

export default function JobPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [rev, setRev] = useState(0);
  const [sending, setSending] = useState(false);
  const [plateChoice, setPlateChoice] = useState<number | null>(null);
  const { data: job, error, status } = useJson<Job>(`/api/jobs/${id}`, rev);
  const currency = useJson<Prices>("/api/prices").data?.currency ?? "$";

  // Follow a job that is still slicing.
  const active = job?.status === "queued" || job?.status === "slicing";
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setRev((r) => r + 1), 2000);
    return () => clearInterval(t);
  }, [active]);

  const plates: Plate[] = useMemo(() => parseObject(job?.package_json ?? null)?.plates as Plate[] ?? [], [job?.package_json]);
  const config = useMemo(() => parseObject(job?.config_json ?? null), [job?.config_json]);
  const bed = useMemo(() => bedFromConfig(config), [config]);
  const plate = plates.find((p) => p.index === plateChoice) ?? plates[0] ?? null;
  const filamentColors = useMemo(() => {
    const colors: string[] = [];
    for (const f of plate?.filaments ?? []) if (f.id > 0) colors[f.id - 1] = f.color;
    return colors;
  }, [plate]);
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
          {canReslice && (
            <button
              className="btn-sm"
              title="Open this job's models and settings on the Slice page, change what you like, and slice it as a new job"
              onClick={reslice}
            >
              Re-slice
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
                  onClick={() => setPlateChoice(p.index)}
                >
                  Plate {p.index}
                </button>
              ))}
            </div>
          )}
          <div className="job-preview">
            <GcodePreview
              source={source}
              bed={bed}
              filamentColors={filamentColors}
              showStats={new URLSearchParams(window.location.search).has("stats")}
            />
          </div>
          {plate?.check && <GcodeCheckDetails check={plate.check} open={plate.check.findings.length > 0} />}
        </>
      )}

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
