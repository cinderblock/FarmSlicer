// /labels: make, rename, recolour and delete labels (src/labels.rs).
// Labels go on jobs, projects, printers and groups from their own lists.
import { useState } from "react";
import { errorText } from "../api";
import { LabelChip } from "../components/Labels";
import PageHeader, { EmptyState } from "../components/PageHeader";
import type { Label, LabelScope } from "../labels";
import { createLabel, deleteLabel, updateLabel, useLabels } from "../labels";

export default function LabelsPage() {
  const d = useLabels();
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState("blue");
  const [where, setWhere] = useState("user");
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const sections: [string, Label[]][] = [
    ["Yours (only you see them)", (d?.labels ?? []).filter((l) => l.scope === "user")],
    ["Groups' (their members see them)", (d?.labels ?? []).filter((l) => l.scope === "group")],
    ["Everyone's", (d?.labels ?? []).filter((l) => l.scope === "site")],
  ];

  return (
    <div className="page page-narrow">
      <PageHeader title="Labels" icon="tag">
        Labels sort jobs, projects, printers and groups: put them on with the tag button in each list, and filter
        lists by them. Your own labels are yours alone and go on anything you can see. A group's labels are seen by its
        members (and its subgroups'), everyone's by everyone; those go on what you're allowed to change.
      </PageHeader>
      {error && <p className="login-error">{error}</p>}

      <form
        className="card access-form"
        onSubmit={(e) => {
          e.preventDefault();
          const [scope, group] = where.split(":") as [LabelScope, string | undefined];
          run(async () => {
            await createLabel({ name, color, scope, group_id: group });
            setName("");
          });
        }}
      >
        <h4>New label</h4>
        <div className="access-form-row">
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
          </label>
          <label>
            Who sees it
            <select value={where} onChange={(e) => setWhere(e.target.value)}>
              <option value="user">Only me</option>
              {d?.groups.map((g) => (
                <option key={g.id} value={`group:${g.id}`}>
                  {g.path}
                </option>
              ))}
              {d?.can_make_site && <option value="site">Everyone</option>}
            </select>
          </label>
        </div>
        <ColorPicker colors={d?.colors ?? []} value={color} onChange={setColor} />
        <button className="btn-primary btn-inline" type="submit">
          Create label
        </button>
      </form>

      {d && d.labels.length === 0 && (
        <EmptyState icon="tag" title="No labels yet">
          Make one above, or straight from the tag button in a list.
        </EmptyState>
      )}
      {sections
        .filter(([, list]) => list.length > 0)
        .map(([title, list]) => (
          <section key={title}>
            <h3>{title}</h3>
            <ul className="label-list">
              {list.map((l) => (
                <LabelRow key={l.id} label={l} colors={d?.colors ?? []} run={run} />
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

function ColorPicker({ colors, value, onChange }: { colors: string[]; value: string; onChange: (c: string) => void }) {
  return (
    <div className="label-colors" role="radiogroup" aria-label="Colour">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          title={c}
          className={`label-swatch label-${c}${value === c ? " is-selected" : ""}`}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

function LabelRow({ label, colors, run }: { label: Label; colors: string[]; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color);
  if (editing) {
    return (
      <li className="label-row">
        <form
          className="access-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await updateLabel(label.id, { name, color });
              setEditing(false);
            });
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoFocus />
          <ColorPicker colors={colors} value={color} onChange={setColor} />
          <span className="role-editor-actions">
            <button className="btn-sm btn-accent" type="submit">
              Save
            </button>
            <button className="btn-sm" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </span>
        </form>
      </li>
    );
  }
  return (
    <li className="label-row">
      <LabelChip label={label} />
      {label.owner_name && <span className="hint">{label.owner_name}</span>}
      {label.can_manage && (
        <span className="role-card-actions">
          <button className="btn-sm" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            className="btn-sm btn-danger"
            onClick={() => {
              if (window.confirm(`Delete the label "${label.name}"? It comes off everything it's on.`))
                run(() => deleteLabel(label.id));
            }}
          >
            Delete
          </button>
        </span>
      )}
    </li>
  );
}
