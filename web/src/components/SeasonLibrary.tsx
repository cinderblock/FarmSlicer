import { formatDuration, localDate } from "../api";
import type { GroupLibrary, LibraryJob } from "../groups";

function JobRows({ jobs, showGroup }: { jobs: LibraryJob[]; showGroup: boolean }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Model</th>
          <th>By</th>
          {showGroup && <th>Group</th>}
          <th>Date</th>
          <th>Status</th>
          <th>Print time</th>
          <th>Filament</th>
          <th>Files</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id}>
            <td>{j.model_name}</td>
            <td>{j.username ?? "—"}</td>
            {showGroup && <td>{j.group_name ?? "—"}</td>}
            <td>{localDate(j.created_at)}</td>
            <td>
              <span className={`status-badge status-${j.status}`}>{j.status}</span>
            </td>
            <td>{formatDuration(j.print_time_sec)}</td>
            <td>{j.filament_used_g != null ? `${j.filament_used_g.toFixed(1)} g` : "—"}</td>
            <td>
              {j.has_model && (
                <a className="btn-sm" href={`/api/jobs/${j.id}/model`} download>
                  Model
                </a>
              )}
              {j.slice_id && (
                <a className="btn-sm" href={`/api/slices/${j.slice_id}/download`} download>
                  G-code
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A group's jobs: this season first, earlier seasons collapsed underneath. */
export default function SeasonLibrary({ library, groupId }: { library: GroupLibrary; groupId: string }) {
  const showGroup = library.jobs.some((j) => j.group_id !== groupId);
  const bySeason = (year: number) => library.jobs.filter((j) => j.season === year);
  const current = library.seasons.find((s) => s.current);
  const past = library.seasons.filter((s) => !s.current && bySeason(s.year).length > 0);
  const currentJobs = current ? bySeason(current.year) : [];
  return (
    <div className="season-library">
      <h4>This season{current ? ` (${current.label})` : ""}</h4>
      {currentJobs.length === 0 ? (
        <p className="hint">Nothing yet this season.</p>
      ) : (
        <JobRows jobs={currentJobs} showGroup={showGroup} />
      )}
      {past.map((s) => (
        <details key={s.year} className="past-season">
          <summary>
            {s.label} season · {bySeason(s.year).length} job{bySeason(s.year).length === 1 ? "" : "s"}
          </summary>
          <JobRows jobs={bySeason(s.year)} showGroup={showGroup} />
        </details>
      ))}
      <p className="hint">Seasons start on {library.season_start} (month-day).</p>
    </div>
  );
}
