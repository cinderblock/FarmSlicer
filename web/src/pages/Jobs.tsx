import { useState, useEffect, useCallback } from "react";

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
  source: "server" | "browser";
  created_at: string;
}

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
  const [jobs, setJobs] = useState<Job[]>([]);

  const fetchJobs = useCallback(async () => {
    const res = await fetch("/api/jobs");
    setJobs(await res.json());
  }, []);

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 3000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  const handleCancel = async (id: string) => {
    await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
    fetchJobs();
  };

  return (
    <div className="page">
      <h2>Jobs</h2>
      {jobs.length === 0 ? (
        <p className="empty-state">No jobs yet. Start by slicing a model.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Sliced on</th>
              <th>Printer</th>
              <th>Time</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const warnings = parseWarnings(job.warnings);
              return (
                <tr key={job.id}>
                  <td>{job.model_name}</td>
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
                    <span
                      className={`source-badge source-${job.source}`}
                      title={
                        job.source === "browser"
                          ? "Sliced by the WebAssembly engine in the user's browser; the model never reached the server."
                          : "Sliced by libslic3r on the server."
                      }
                    >
                      {job.source === "browser" ? "Browser" : "Server"}
                    </span>
                  </td>
                  <td>{job.printer_name ?? (job.routing === "auto" ? "Auto" : "—")}</td>
                  <td>
                    {job.print_time_sec ? formatTime(job.print_time_sec) : "—"}
                  </td>
                  <td>
                    {(job.status === "queued" || job.status === "slicing") && (
                      <button
                        className="btn-sm"
                        onClick={() => handleCancel(job.id)}
                      >
                        Cancel
                      </button>
                    )}
                    {job.error && (
                      <span className="hint" title={job.error}>
                        Error
                      </span>
                    )}
                    {warnings.length > 0 && (
                      <span className="hint" title={warnings.join("\n")}>
                        {warnings.length} warning{warnings.length === 1 ? "" : "s"}
                      </span>
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
