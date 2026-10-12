import { useState } from "react";
import { Link } from "react-router";
import { formatDuration, formatSize, localDate, useJson } from "../api";

interface SliceRecord {
  id: string;
  job_id: string;
  model_name: string;
  print_time_sec: number;
  filament_used_g: number;
  file_size: number;
  created_at: string;
  username: string | null;
  group_id: string | null;
  group_name: string | null;
  has_model: boolean;
}

interface MyGroups {
  groups: { group_id: string; path: string; status: string }[];
}

/** Every slice the caller can see: their own and their groups'. Groups' pages split theirs by season. */
export default function LibraryPage() {
  const [scope, setScope] = useState("");
  const groups = (useJson<MyGroups>("/api/me").data?.groups ?? []).filter((g) => g.status === "active");
  const query = scope === "mine" ? "?mine=1" : scope ? `?group=${encodeURIComponent(scope)}` : "";
  const slices = useJson<SliceRecord[]>(`/api/slices${query}`).data;

  return (
    <div className="page">
      <h2>Slice Library</h2>
      <div className="browse-filters">
        <label>
          Show{" "}
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">Everything I can see</option>
            <option value="mine">Only mine</option>
            {groups.map((g) => (
              <option key={g.group_id} value={g.group_id}>
                {g.path}
              </option>
            ))}
          </select>
        </label>
        {scope && scope !== "mine" && (
          <Link to={`/groups/${scope}`} className="hint">
            Open the group's library (by season)
          </Link>
        )}
      </div>
      {slices === undefined ? (
        <p className="hint">Loading…</p>
      ) : slices.length === 0 ? (
        <p className="empty-state">No slices yet. Completed slice jobs will appear here.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>By</th>
              <th>Group</th>
              <th>Date</th>
              <th>Print Time</th>
              <th>Filament</th>
              <th>Size</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {slices.map((s) => (
              <tr key={s.id}>
                <td>{s.model_name}</td>
                <td>{s.username ?? "—"}</td>
                <td>{s.group_id ? <Link to={`/groups/${s.group_id}`}>{s.group_name}</Link> : "Personal"}</td>
                <td>{localDate(s.created_at)}</td>
                <td>{formatDuration(s.print_time_sec)}</td>
                <td>{s.filament_used_g.toFixed(1)}g</td>
                <td>{formatSize(s.file_size)}</td>
                <td>
                  <a className="btn-sm" href={`/api/slices/${s.id}/download`} download>
                    G-code
                  </a>
                  {s.has_model && (
                    <a className="btn-sm" href={`/api/jobs/${s.job_id}/model`} download>
                      Model
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
