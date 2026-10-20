// /projects/:id: one project, its items and how far each has got, the job
// plates carrying them and their prints, and fulfillment.

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { apiJson } from "../auth";
import { errorText, localDate, localDateTime, useJson } from "../api";
import ProgressBar from "../components/ProgressBar";
import { STATUS_LABELS, overdue, progressText, type Item, type ProjectDetail, type ProjectStatus } from "../projects";

/** What people can move a project to from each status. */
const NEXT: Record<ProjectStatus, [ProjectStatus, string][]> = {
  open: [["on_hold", "Hold"], ["cancelled", "Cancel"]],
  printed: [["ready", "Packed: ready"], ["shipped", "Shipped"], ["on_hold", "Hold"]],
  ready: [["shipped", "Shipped / picked up"], ["open", "Reopen"]],
  shipped: [["open", "Reopen"]],
  on_hold: [["open", "Resume"], ["cancelled", "Cancel"]],
  cancelled: [["open", "Reopen"]],
};

const OUTCOME: Record<string, string> = { good: "good", partial: "partly good", failed: "failed" };

export default function ProjectPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [rev, setRev] = useState(0);
  const loaded = useJson<ProjectDetail>(`/api/projects/${id}`, rev);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const p = loaded.data;
  const reload = () => setRev((r) => r + 1);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      reload();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (loaded.error) return <div className="page"><p className="login-error">{loaded.error}</p></div>;
  if (!p) return <div className="page"><p className="hint">Loading…</p></div>;

  const setStatus = (status: ProjectStatus) => {
    const note = status === "shipped" || status === "ready" || status === "on_hold" ? window.prompt("Note (tracking number, shelf, why…; optional)") : "";
    if (note === null) return;
    act(() => apiJson(`/api/projects/${p.id}/status`, "POST", { status, note }));
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${p.name}? Its jobs and prints stay.`)) return;
    await act(() => apiJson(`/api/projects/${p.id}`, "DELETE"));
    navigate("/projects");
  };

  return (
    <div className="page">
      <p className="hint">
        <Link to="/projects">Projects</Link>
      </p>
      <div className="page-header">
        <h2>
          {p.name} <span className={`status-badge project-${p.status}`}>{STATUS_LABELS[p.status]}</span>
        </h2>
        {p.can_edit && (
          <span className="print-controls">
            {NEXT[p.status].map(([s, label]) => (
              <button key={s} className={s === "cancelled" ? "btn-sm btn-danger" : "btn-sm"} onClick={() => setStatus(s)}>
                {label}
              </button>
            ))}
            <button className="btn-sm" onClick={() => setEditing((e) => !e)}>
              {editing ? "Done" : "Edit"}
            </button>
          </span>
        )}
      </div>
      {error && <p className="login-error">{error}</p>}
      {p.status_note && <p className="hint">{p.status_note}</p>}

      {editing ? (
        <EditProject project={p} onSaved={() => { setEditing(false); reload(); }} onDelete={remove} />
      ) : (
        <dl className="job-facts">
          <div>
            <dt>Progress</dt>
            <dd>
              {p.summary.items_done}/{p.summary.items} parts done
            </dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd className={overdue(p.due_at, p.status) ? "printer-error" : ""}>
              {p.due_at ? localDate(p.due_at.length === 10 ? `${p.due_at} 12:00:00` : p.due_at) : "—"}
            </dd>
          </div>
          {p.client_ref && (
            <div>
              <dt>For</dt>
              <dd>{p.client_ref}</dd>
            </div>
          )}
          {p.external_ref && (
            <div>
              <dt>Order</dt>
              <dd>{p.external_ref}</dd>
            </div>
          )}
          <div>
            <dt>Priority</dt>
            <dd>{p.priority}</dd>
          </div>
          <div>
            <dt>By</dt>
            <dd>
              {p.username ?? "—"} · {p.group_name ?? "Personal"}
            </dd>
          </div>
          {p.printed_at && (
            <div>
              <dt>Printed</dt>
              <dd>{localDateTime(p.printed_at)}</dd>
            </div>
          )}
          {p.shipped_at && (
            <div>
              <dt>Shipped</dt>
              <dd>{localDateTime(p.shipped_at)}</dd>
            </div>
          )}
        </dl>
      )}
      {p.notes && !editing && <p className="project-notes">{p.notes}</p>}

      <h3>Parts</h3>
      {p.items.length === 0 && <p className="empty-state">No parts yet.</p>}
      {p.items.length > 0 && (
        <table className="data-table cards">
          <thead>
            <tr>
              <th>Part</th>
              <th>Wanted</th>
              <th>Progress</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {p.items.map((item) => (
              <ItemRow key={item.id} project={p} item={item} onChange={reload} onError={setError} />
            ))}
          </tbody>
        </table>
      )}
      {p.can_edit && <AddItem projectId={p.id} onAdded={reload} />}

      <h3>Plates</h3>
      {p.jobs.length === 0 && (
        <p className="empty-state">
          No job carries these parts yet. Slice them on the <Link to="/slice">Slice</Link> page with this project
          chosen, or add a job from its page.
        </p>
      )}
      {p.jobs.map((j) => (
        <div key={j.job_id} className="project-job">
          <div className="page-header">
            <h4>
              {j.visible ? <Link to={`/jobs/${j.job_id}`}>{j.name}</Link> : j.name}
              {!j.sendable && <span className="hint"> · {j.status === "done" ? "nothing printable" : j.status}</span>}
            </h4>
            {p.can_edit && (
              <button
                className="btn-sm"
                onClick={() =>
                  window.confirm(`Stop counting ${j.name} for this project? Prints already made stop counting too.`) &&
                  act(() => apiJson(`/api/projects/${p.id}/jobs/${j.job_id}`, "DELETE"))
                }
              >
                Remove
              </button>
            )}
          </div>
          <ul className="project-plates">
            {j.plates.map((n) => {
              const parts = j.parts.filter((x) => x.plate === n);
              const prints = j.prints.filter((x) => x.plate === n);
              if (parts.length === 0) return null;
              return (
                <li key={n}>
                  {j.sendable && (
                    <img className="job-thumb" src={`/api/jobs/${j.job_id}/thumbnail?plate=${n}`} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                  )}
                  <div>
                    <strong>Plate {n}</strong>:{" "}
                    {parts.map((x) => `${x.copies}× ${p.items.find((i) => i.id === x.item_id)?.name ?? x.name}`).join(", ")}
                    <div className="hint">
                      {prints.length === 0
                        ? "Not printed yet"
                        : prints
                            .map((x) => `${x.printer_name}: ${x.outcome ? OUTCOME[x.outcome] : x.status === "finished" ? "unchecked" : x.status}`)
                            .join(" · ")}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ItemRow({ project, item, onChange, onError }: { project: ProjectDetail; item: Item; onChange: () => void; onError: (e: string) => void }) {
  const [quantity, setQuantity] = useState(item.quantity);
  const save = async (q: number) => {
    try {
      await apiJson(`/api/projects/${project.id}/items/${item.id}`, "PATCH", { quantity: q });
      onChange();
    } catch (e) {
      onError(errorText(e));
    }
  };
  const remove = async () => {
    if (!window.confirm(`Remove ${item.name} from the project?`)) return;
    try {
      await apiJson(`/api/projects/${project.id}/items/${item.id}`, "DELETE");
      onChange();
    } catch (e) {
      onError(errorText(e));
    }
  };
  return (
    <tr className={item.done ? "item-done" : ""}>
      <td className="cell-title">
        {item.name}
        {item.job_id && <div className="hint">from <Link to={`/jobs/${item.job_id}`}>its job</Link></div>}
        {item.notes && <div className="hint">{item.notes}</div>}
      </td>
      <td data-label="Wanted">
        {project.can_edit ? (
          <input
            type="number"
            className="item-quantity"
            min={1}
            value={quantity}
            aria-label={`${item.name}: how many`}
            onChange={(e) => setQuantity(Math.max(1, Math.round(Number(e.target.value) || 1)))}
            onBlur={() => quantity !== item.quantity && save(quantity)}
          />
        ) : (
          item.quantity
        )}
      </td>
      <td data-label="Progress" className="project-progress-cell">
        <ProgressBar progress={item} wanted={item.quantity} />
        <span className="hint">{progressText(item)}</span>
        {item.missing > 0 && item.failed > 0 && (
          <div className="item-reprint">{item.missing} to print again</div>
        )}
      </td>
      <td className="cell-actions">
        {project.can_edit && (
          <button className="btn-sm btn-danger" onClick={remove}>
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

function AddItem({ projectId, onAdded }: { projectId: string; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState("");
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await apiJson(`/api/projects/${projectId}/items`, "POST", { name, quantity });
      setName("");
      setQuantity(1);
      onAdded();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <form className="add-item" onSubmit={add}>
      <input placeholder="A part not sliced yet…" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} aria-label="Part name" />
      <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))} aria-label="How many" />
      <button className="btn-sm" type="submit">
        Add part
      </button>
      {error && <span className="printer-error">{error}</span>}
    </form>
  );
}

function EditProject({ project, onSaved, onDelete }: { project: ProjectDetail; onSaved: () => void; onDelete: () => void }) {
  const [form, setForm] = useState({
    name: project.name,
    client_ref: project.client_ref ?? "",
    external_ref: project.external_ref ?? "",
    due_at: project.due_at?.slice(0, 10) ?? "",
    priority: project.priority,
    notes: project.notes,
  });
  const [error, setError] = useState("");
  const set = (k: keyof typeof form, v: string | number) => setForm((f) => ({ ...f, [k]: v }));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await apiJson(`/api/projects/${project.id}`, "PATCH", {
        ...form,
        client_ref: form.client_ref || null,
        external_ref: form.external_ref || null,
        due_at: form.due_at || null,
      });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <form className="printer-form project-form" onSubmit={save}>
      <label>
        Name
        <input value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={200} />
      </label>
      <label>
        Client reference
        <input value={form.client_ref} onChange={(e) => set("client_ref", e.target.value)} maxLength={200} />
      </label>
      <label>
        Order number
        <input value={form.external_ref} onChange={(e) => set("external_ref", e.target.value)} maxLength={200} />
      </label>
      <label>
        Due
        <input type="date" value={form.due_at} onChange={(e) => set("due_at", e.target.value)} />
      </label>
      <label>
        Priority
        <input type="number" min={-100} max={100} value={form.priority} onChange={(e) => set("priority", Number(e.target.value))} />
      </label>
      <label>
        Notes
        <textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>
      {error && <p className="login-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn-sm btn-danger" onClick={onDelete}>
          Delete project
        </button>
        <button className="btn-primary" type="submit" style={{ width: "auto" }}>
          Save
        </button>
      </div>
    </form>
  );
}
