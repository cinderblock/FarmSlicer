// /projects: what people need printed, most urgent first, and a form for a
// new one.

import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { apiJson } from "../auth";
import { errorText, localDate, useJson } from "../api";
import ProgressBar from "../components/ProgressBar";
import { STATUS_LABELS, overdue, progressText, type Project } from "../projects";

interface MeGroups {
  chargeable: { id: string; path: string }[];
}

export default function ProjectsPage() {
  const [show, setShow] = useState<"active" | "all">("active");
  const [search, setSearch] = useState("");
  const [rev, setRev] = useState(0);
  const params = new URLSearchParams();
  if (show === "active") params.set("status", "active");
  if (search.trim()) params.set("q", search.trim());
  const projects = useJson<Project[]>(`/api/projects?${params}`, rev);
  const [creating, setCreating] = useState(false);

  return (
    <div className="page">
      <div className="page-header">
        <h2>Projects</h2>
        <button className="btn-sm" onClick={() => setCreating((c) => !c)}>
          {creating ? "Cancel" : "New project"}
        </button>
      </div>
      <p className="hint">
        What needs printing, part by part, and how far each part has got: good copies, copies on a printer or
        waiting to be checked, and copies that failed and need printing again. Slice a part for a project from the
        Slice page (Project), or add an existing job from its page.
      </p>
      {creating && <NewProject onCreated={() => setRev((r) => r + 1)} />}
      <div className="filters">
        <select value={show} onChange={(e) => setShow(e.target.value as "active" | "all")} aria-label="Which projects">
          <option value="active">Not shipped or cancelled</option>
          <option value="all">All</option>
        </select>
        <input
          type="search"
          placeholder="Search name, client, order…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search projects"
        />
      </div>
      {projects.error && <p className="login-error">{projects.error}</p>}
      {projects.data?.length === 0 && <p className="empty-state">No projects{show === "active" ? " in progress" : ""}.</p>}
      {projects.data && projects.data.length > 0 && (
        <table className="data-table cards">
          <thead>
            <tr>
              <th>Project</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Due</th>
              <th>For</th>
            </tr>
          </thead>
          <tbody>
            {projects.data.map((p) => (
              <tr key={p.id}>
                <td className="cell-title">
                  <Link to={`/projects/${p.id}`}>{p.name}</Link>
                  {p.priority !== 0 && <span className="hint"> · priority {p.priority}</span>}
                  {p.external_ref && <div className="hint">{p.external_ref}</div>}
                </td>
                <td data-label="Status">
                  <span className={`status-badge project-${p.status}`}>{STATUS_LABELS[p.status]}</span>
                </td>
                <td data-label="Progress" className="project-progress-cell">
                  <ProgressBar progress={p.summary} wanted={p.summary.wanted} />
                  <span className="hint">
                    {p.summary.items_done}/{p.summary.items} parts done · {progressText(p.summary)}
                  </span>
                </td>
                <td data-label="Due" className={overdue(p.due_at, p.status) ? "printer-error" : ""}>
                  {p.due_at ? localDate(p.due_at.length === 10 ? `${p.due_at} 12:00:00` : p.due_at) : "—"}
                </td>
                <td data-label="For">
                  {p.client_ref ?? p.group_name ?? p.username ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewProject({ onCreated }: { onCreated: () => void }) {
  const navigate = useNavigate();
  const groups = useJson<MeGroups>("/api/me").data?.chargeable ?? [];
  const [form, setForm] = useState({ name: "", group_id: "", client_ref: "", external_ref: "", due_at: "", priority: 0, notes: "" });
  const [error, setError] = useState("");
  const set = (k: keyof typeof form, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const p = await apiJson<Project>("/api/projects", "POST", {
        ...form,
        group_id: form.group_id || null,
        due_at: form.due_at || null,
      });
      onCreated();
      navigate(`/projects/${p.id}`);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <form className="printer-form project-form" onSubmit={create}>
      <label>
        Name
        <input value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={200} />
      </label>
      {groups.length > 0 && (
        <label>
          Group
          <select value={form.group_id} onChange={(e) => set("group_id", e.target.value)}>
            <option value="">Personal</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.path}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Client reference (optional)
        <input value={form.client_ref} onChange={(e) => set("client_ref", e.target.value)} maxLength={200} />
        <span className="hint">Whoever it's for, as your own records name them. FarmSlicer keeps no customer details.</span>
      </label>
      <label>
        Order number (optional)
        <input value={form.external_ref} onChange={(e) => set("external_ref", e.target.value)} maxLength={200} />
      </label>
      <label>
        Due (optional)
        <input type="date" value={form.due_at} onChange={(e) => set("due_at", e.target.value)} />
      </label>
      <label>
        Priority
        <input type="number" min={-100} max={100} value={form.priority} onChange={(e) => set("priority", Number(e.target.value))} />
        <span className="hint">Higher goes first in the queue.</span>
      </label>
      <label>
        Notes
        <textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>
      {error && <p className="login-error">{error}</p>}
      <button className="btn-primary" type="submit" style={{ width: "auto" }}>
        Create project
      </button>
    </form>
  );
}
