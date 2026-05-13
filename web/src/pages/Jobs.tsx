export default function JobsPage() {
  // TODO: fetch from /api/jobs, wire up WebSocket for live updates
  const jobs: {
    id: string;
    status: string;
    model: string;
    progress: number;
    printer: string | null;
  }[] = [];

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
              <th>Printer</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.model}</td>
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
                </td>
                <td>{job.printer ?? "Auto"}</td>
                <td>
                  <button className="btn-sm">Cancel</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
