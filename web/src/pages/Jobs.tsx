import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { apiJson, useAuth } from "../auth";
import { errorText, useJson } from "../api";
import SendDialog from "../components/SendDialog";
import { GcodeChip } from "../components/GcodeCheck";
import { formatCost, packageVerdict, type Prices } from "../printers";

interface Job {
  id: string;
  model_name: string;
  status: string;
  progress: number;
  printer_id: string | null;
  printer_name: string | null;
  routing: string;
  print_time_sec: number | null;
  filament_used_g: number | null;
  error: string | null;
  progress_message: string | null;
  warnings: string | null;
  source: "server" | "browser" | "upload";
  created_at: string;
  user_id: string | null;
  username: string | null;
  group_id: string | null;
  group_name: string | null;
  /** The printable package's contents (JSON); set = can be sent to a printer. */
  package_json: string | null;
  estimated_cost: number | null;
  /** Source models, and how many of them stayed in the slicing browser. */
  model_count: number;
  local_models: number;
}

const finished = (job: Job) => job.status !== "queued" && job.status !== "slicing";

function hasThumbnail(job: Job): boolean {
  try {
    return !!JSON.parse(job.package_json ?? "null")?.plates?.[0]?.has_thumbnail;
  } catch {
    return false;
  }
}

const SOURCE_LABELS: Record<Job["source"], [string, string]> = {
  server: ["Server", "Sliced by libslic3r on the server."],
  browser: [
    "Browser",
    "Sliced by the WebAssembly engine in the user's browser.",
  ],
  upload: ["Uploaded", "Sliced elsewhere and uploaded (a .gcode.3mf for Bambu printers, G-code for others)."],
};

function parseWarnings(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function JobsPage() {
  const { user, isAdmin } = useAuth();
  const [rev, setRev] = useState(0);
  const [error, setError] = useState("");
  const [sending, setSending] = useState<Job | null>(null);
  const [uploadGroup, setUploadGroup] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const jobs = useJson<Job[]>("/api/jobs", rev).data ?? [];
  const chargeable = useJson<{ chargeable: { id: string; path: string }[] }>("/api/me").data?.chargeable ?? [];
  const currency = useJson<Prices>("/api/prices").data?.currency ?? "$";

  const upload = async (file: File) => {
    setError("");
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    if (uploadGroup) form.append("group_id", uploadGroup);
    try {
      const res = await fetch("/api/uploads", { method: "POST", body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setRev((r) => r + 1);
      setSending(body as Job);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  // Poll while the page is open.
  useEffect(() => {
    const interval = setInterval(() => setRev((r) => r + 1), 3000);
    return () => clearInterval(interval);
  }, []);

  const handleCancel = async (id: string) => {
    await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
    setRev((r) => r + 1);
  };

  /** Delete jobs (after asking); reports the ones the server refused. */
  const deleteJobs = async (ids: string[]) => {
    if (ids.length === 0) return;
    const what = ids.length === 1 ? (jobs.find((j) => j.id === ids[0])?.model_name ?? "this job") : `${ids.length} jobs`;
    if (!window.confirm(`Delete ${what}? The G-code and the stored models go too; prints keep their history.`)) return;
    setError("");
    setDeleting(true);
    try {
      const res = await apiJson<{ deleted: string[]; refused: { id: string; error: string }[] }>(
        "/api/jobs/delete",
        "POST",
        { ids },
      );
      setSelected((sel) => new Set([...sel].filter((id) => !res.deleted.includes(id))));
      if (res.refused.length > 0) {
        const name = (id: string) => jobs.find((j) => j.id === id)?.model_name ?? id;
        setError(`Not deleted: ${res.refused.map((r) => `${name(r.id)} (${r.error})`).join("; ")}`);
      }
      setRev((r) => r + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDeleting(false);
    }
  };

  const toggle = (id: string, on: boolean) =>
    setSelected((sel) => {
      const next = new Set(sel);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  // What the user may usually delete (managers of a group may delete more;
  // the server decides).
  const deletable = jobs.filter((j) => finished(j) && (isAdmin || j.user_id === user?.id));
  const selectedJobs = jobs.filter((j) => selected.has(j.id));

  const moveJob = async (id: string, groupId: string) => {
    setError("");
    try {
      await apiJson(`/api/jobs/${id}`, "PUT", { group_id: groupId || null });
      setRev((r) => r + 1);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="page">
      <h2>Jobs</h2>
      <p className="hint">Your jobs, and the jobs of groups whose library you can see.</p>
      <div className="page-actions upload-row">
        <button
          className="btn-primary"
          style={{ width: "auto" }}
          disabled={uploading}
          onClick={() => fileInput.current?.click()}
        >
          {uploading ? "Uploading…" : "Upload a sliced file"}
        </button>
        {chargeable.length > 0 && (
          <select value={uploadGroup} onChange={(e) => setUploadGroup(e.target.value)} aria-label="Group to charge the upload to">
            <option value="">Personal</option>
            {chargeable.map((g) => (
              <option key={g.id} value={g.id}>
                {g.path}
              </option>
            ))}
          </select>
        )}
        <span className="hint">
          A plate sliced elsewhere: a .gcode.3mf from Bambu Studio or OrcaSlicer for Bambu printers, a .gcode file
          for others. Its G-code is checked before it can be printed.
        </span>
        <input
          ref={fileInput}
          type="file"
          accept=".3mf,.gcode,.gco,.g"
          hidden
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        />
      </div>
      {deletable.length > 0 && (
        <div className="page-actions job-selection">
          <span className="hint">Select:</span>
          <button className="btn-sm" onClick={() => setSelected(new Set(deletable.map((j) => j.id)))}>
            All
          </button>
          <button
            className="btn-sm"
            onClick={() => setSelected(new Set(deletable.filter((j) => j.status === "failed" || j.status === "cancelled").map((j) => j.id)))}
          >
            Failed and cancelled
          </button>
          <button className="btn-sm" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
            None
          </button>
          <button
            className="btn-sm btn-danger"
            disabled={selectedJobs.length === 0 || deleting}
            onClick={() => deleteJobs(selectedJobs.map((j) => j.id))}
          >
            {deleting ? "Deleting…" : `Delete selected (${selectedJobs.length})`}
          </button>
        </div>
      )}
      {error && <p className="login-error">{error}</p>}
      {sending && (
        <SendDialog
          jobId={sending.id}
          jobName={sending.model_name}
          onClose={() => setSending(null)}
          onSent={() => {
            setSending(null);
            navigate("/prints");
          }}
        />
      )}
      {jobs.length === 0 ? (
        <p className="empty-state">No jobs yet. Start by slicing a model.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th aria-label="Select" />
              <th>Model</th>
              <th>By</th>
              <th>Group</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Sliced on</th>
              <th>Printer</th>
              <th>Time</th>
              <th>Cost</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const warnings = parseWarnings(job.warnings);
              return (
                <tr key={job.id} className={selected.has(job.id) ? "selected" : undefined}>
                  <td>
                    {finished(job) && (
                      <input
                        type="checkbox"
                        checked={selected.has(job.id)}
                        onChange={(e) => toggle(job.id, e.target.checked)}
                        aria-label={`Select ${job.model_name}`}
                      />
                    )}
                  </td>
                  <td>
                    <div className="job-name">
                      {hasThumbnail(job) && (
                        <img className="job-thumb" src={`/api/jobs/${job.id}/thumbnail`} alt="" loading="lazy" />
                      )}
                      {job.model_name}
                    </div>
                  </td>
                  <td>{job.username ?? "—"}</td>
                  <td>
                    {job.user_id === user?.id ? (
                      <select
                        value={job.group_id ?? ""}
                        onChange={(e) => moveJob(job.id, e.target.value)}
                        aria-label="Move this job to one of your groups"
                      >
                        <option value="">Personal</option>
                        {job.group_id && !chargeable.some((g) => g.id === job.group_id) && (
                          <option value={job.group_id}>{job.group_name}</option>
                        )}
                        {chargeable.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.path}
                          </option>
                        ))}
                      </select>
                    ) : (
                      (job.group_name ?? "Personal")
                    )}
                  </td>
                  <td>
                    <span className={`status-badge status-${job.status}`}>
                      {job.status}
                    </span>
                  </td>
                  <td>
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{ width: `${job.progress}%` }}
                      />
                    </div>
                    {job.status === "slicing" && job.progress_message && (
                      <span className="hint">{job.progress_message}</span>
                    )}
                  </td>
                  <td>
                    <span className={`source-badge source-${job.source}`}>
                      {SOURCE_LABELS[job.source]?.[0] ?? job.source}
                    </span>
                    {job.local_models > 0 && (
                      <span
                        className="source-badge source-local"
                        title="The model stayed in the browser that sliced it: only that browser can slice this job again."
                      >
                        local
                      </span>
                    )}
                    {job.package_json && (
                      <div>
                        <GcodeChip {...packageVerdict(job.package_json)} />
                      </div>
                    )}
                  </td>
                  <td>{job.printer_name ?? (job.routing === "auto" ? "Auto" : "—")}</td>
                  <td>
                    {job.print_time_sec ? formatTime(job.print_time_sec) : "—"}
                  </td>
                  <td>{job.status === "done" ? formatCost(job.estimated_cost, currency) : "—"}</td>
                  <td>
                    {job.status === "done" && job.package_json && (
                      <button className="btn-sm" onClick={() => setSending(job)}>
                        Print…
                      </button>
                    )}
                    {(job.status === "queued" || job.status === "slicing") && (
                      <button
                        className="btn-sm"
                        onClick={() => handleCancel(job.id)}
                      >
                        Cancel
                      </button>
                    )}
                    {finished(job) && (isAdmin || job.user_id === user?.id) && (
                      <button className="btn-sm btn-danger" disabled={deleting} onClick={() => deleteJobs([job.id])}>
                        Delete
                      </button>
                    )}
                    {job.error && (
                      <details className="hint">
                        <summary>Error</summary>
                        {job.error}
                      </details>
                    )}
                    {warnings.length > 0 && (
                      <details className="hint">
                        <summary>
                          {warnings.length} warning{warnings.length === 1 ? "" : "s"}
                        </summary>
                        <ul>
                          {warnings.map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
