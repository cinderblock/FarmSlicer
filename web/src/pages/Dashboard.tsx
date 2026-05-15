import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router";

interface Printer {
  id: string;
  name: string;
  machine_profile: string;
  nozzle_diameter: string;
  protocol: string;
  address: string;
  status: string;
  current_job: string | null;
}

interface Job {
  id: string;
  model_name: string;
  status: string;
  progress: number;
  printer_id: string | null;
  printer_name: string | null;
  print_time_sec: number | null;
  filament_used_g: number | null;
  created_at: string;
  updated_at: string;
}

const STATE_LABELS: Record<string, string> = {
  offline: "Offline",
  idle: "Idle",
  printing: "Printing",
  paused: "Paused",
  error: "Error",
};

const STATE_CLASSES: Record<string, string> = {
  offline: "state-offline",
  idle: "state-idle",
  printing: "state-printing",
  paused: "state-paused",
  error: "state-error",
};

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function Dashboard() {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);

  const fetchData = useCallback(async () => {
    try {
      const [pRes, jRes] = await Promise.all([
        fetch("/api/printers"),
        fetch("/api/jobs"),
      ]);
      setPrinters(await pRes.json());
      setJobs(await jRes.json());
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const activeJobs = jobs.filter(
    (j) => j.status === "slicing" || j.status === "queued",
  );
  const recentDone = jobs
    .filter((j) => j.status === "done")
    .slice(0, 3);

  const jobForPrinter = (printerId: string): Job | undefined =>
    jobs.find(
      (j) =>
        j.printer_id === printerId &&
        (j.status === "slicing" || j.status === "queued"),
    );

  if (printers.length === 0) {
    return (
      <div className="page">
        <h2>Dashboard</h2>
        <div className="empty-state-card">
          <h3>Welcome to FarmSlicer</h3>
          <p>
            Get started by adding a printer, then upload a model to slice.
          </p>
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
            <Link to="/printers" className="btn-primary" style={{ textDecoration: "none", padding: "0.5rem 1rem", borderRadius: "6px" }}>
              Add Printer
            </Link>
            <Link to="/slice" className="btn-sm" style={{ textDecoration: "none", padding: "0.5rem 1rem" }}>
              Slice a Model
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <h2>Dashboard</h2>

      <div className="dashboard-grid">
        {printers.map((printer) => {
          const job = jobForPrinter(printer.id);
          const isActive = !!job;
          const stateLabel =
            STATE_LABELS[printer.status] || printer.status;
          const stateClass =
            STATE_CLASSES[printer.status] || "state-offline";

          return (
            <div
              key={printer.id}
              className={`dash-card ${printer.status === "offline" ? "dash-offline" : ""}`}
            >
              <div className="dash-header">
                <h3>{printer.name}</h3>
                <span className={`dash-state ${stateClass}`}>
                  {stateLabel}
                </span>
              </div>

              {printer.machine_profile && (
                <p className="dash-model">
                  {printer.machine_profile}
                  {printer.nozzle_diameter &&
                    ` · ${printer.nozzle_diameter}mm`}
                </p>
              )}

              {printer.address && (
                <p className="dash-address">{printer.address}</p>
              )}

              {isActive && job && (
                <div className="dash-job">
                  <p className="dash-job-name">{job.model_name}</p>
                  <div className="dash-progress">
                    <div className="dash-progress-bar">
                      <div
                        className="dash-progress-fill"
                        style={{ width: `${job.progress}%` }}
                      />
                    </div>
                    <span className="dash-progress-text">
                      {job.progress}%
                    </span>
                  </div>
                  <dl className="dash-details">
                    <dt>Status</dt>
                    <dd>{job.status}</dd>
                    {job.print_time_sec != null && job.print_time_sec > 0 && (
                      <>
                        <dt>Est. Time</dt>
                        <dd>{formatDuration(job.print_time_sec)}</dd>
                      </>
                    )}
                  </dl>
                </div>
              )}

              {!isActive && printer.status !== "offline" && (
                <p className="dash-idle-hint">Ready</p>
              )}
            </div>
          );
        })}
      </div>

      {activeJobs.length > 0 && (
        <div className="dash-section">
          <h3>Active Jobs</h3>
          <div className="dash-job-list">
            {activeJobs.map((j) => (
              <div key={j.id} className="dash-job-row">
                <span className="dash-job-name">{j.model_name}</span>
                <span className={`dash-state ${j.status === "slicing" ? "state-printing" : "state-idle"}`}>
                  {j.status}
                </span>
                <div className="dash-progress" style={{ flex: 1, maxWidth: 200 }}>
                  <div className="dash-progress-bar">
                    <div
                      className="dash-progress-fill"
                      style={{ width: `${j.progress}%` }}
                    />
                  </div>
                  <span className="dash-progress-text">{j.progress}%</span>
                </div>
                {j.printer_name && (
                  <span className="hint">{j.printer_name}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {recentDone.length > 0 && (
        <div className="dash-section">
          <h3>Recent Slices</h3>
          <div className="dash-job-list">
            {recentDone.map((j) => (
              <div key={j.id} className="dash-job-row">
                <span className="dash-job-name">{j.model_name}</span>
                <span className="dash-state state-idle">done</span>
                {j.print_time_sec != null && j.print_time_sec > 0 && (
                  <span className="hint">
                    {formatDuration(j.print_time_sec)}
                  </span>
                )}
                {j.filament_used_g != null && j.filament_used_g > 0 && (
                  <span className="hint">
                    {j.filament_used_g.toFixed(1)}g
                  </span>
                )}
              </div>
            ))}
          </div>
          <Link to="/jobs" className="hint" style={{ display: "inline-block", marginTop: "0.5rem" }}>
            View all jobs →
          </Link>
        </div>
      )}
    </div>
  );
}
