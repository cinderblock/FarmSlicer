import { useState } from "react";
import { Link } from "react-router";
import { apiJson } from "../auth";
import { errorText, useJson } from "../api";
import type { JobPart, Project } from "../projects";

/** On a job's page: which project items its parts count for, and adding
 *  the job to a project (each part not counted yet becomes an item). */
export default function JobProjects({ jobId }: { jobId: string }) {
  const [rev, setRev] = useState(0);
  const parts = useJson<JobPart[]>(`/api/jobs/${jobId}/parts`, rev).data;
  const [adding, setAdding] = useState(false);
  const projects = useJson<Project[]>(adding ? "/api/projects?status=open,on_hold" : null).data?.filter((p) => p.can_edit);
  const [choice, setChoice] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  if (!parts || parts.length === 0) return null;
  const free = parts.filter((p) => !p.item);

  const add = async () => {
    setError("");
    try {
      let projectId = choice;
      if (choice === "new") {
        const made = await apiJson<Project>("/api/projects", "POST", { name: newName });
        projectId = made.id;
      }
      await apiJson(`/api/projects/${projectId}/jobs`, "POST", {
        job_id: jobId,
        items: free.map((p) => (p.model_idx !== null ? { model: p.model_idx } : { part: p.name })),
      });
      setAdding(false);
      setRev((r) => r + 1);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="job-projects">
      <h3>Projects</h3>
      <ul>
        {parts.map((p) => (
          <li key={p.key}>
            {p.copies}× {p.name}
            {p.plates.length > 1 && <span className="hint"> (on {p.plates.length} plates)</span>}:{" "}
            {p.item ? (
              <>
                counts for <Link to={`/projects/${p.item.project_id}`}>{p.item.project_name}</Link>
                {p.item.name !== p.name && ` (${p.item.name})`}
              </>
            ) : (
              <span className="hint">not for any project</span>
            )}
          </li>
        ))}
      </ul>
      {free.length > 0 && !adding && (
        <button className="btn-sm" onClick={() => setAdding(true)}>
          Add to a project…
        </button>
      )}
      {adding && (
        <div className="add-item">
          <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Project">
            <option value="">Choose a project…</option>
            <option value="new">New project…</option>
            {projects?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {choice === "new" && (
            <input placeholder="Project name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={200} aria-label="New project's name" />
          )}
          <button className="btn-sm" disabled={!choice || (choice === "new" && !newName.trim())} onClick={add}>
            Add
          </button>
          <button className="btn-sm" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      )}
      {error && <p className="printer-error">{error}</p>}
    </div>
  );
}
