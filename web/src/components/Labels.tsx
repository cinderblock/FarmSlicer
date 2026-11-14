// Label chips, the picker that puts labels on an item, and the label
// filter for lists (web/src/labels.ts, src/labels.rs).
import { useEffect, useRef, useState } from "react";
import { errorText } from "../api";
import type { Label, LabelKind } from "../labels";
import { createLabel, labelsOn, scopeText, setLabel, useLabels } from "../labels";
import Icon from "./Icon";

export function LabelChip({ label, onRemove }: { label: Label; onRemove?: () => void }) {
  return (
    <span className={`label-chip label-${label.color}`} title={`${label.name} (${scopeText(label)})`}>
      {label.name}
      {onRemove && (
        <button
          type="button"
          className="label-chip-x"
          aria-label={`Remove ${label.name}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

/** The labels on an item, and (unless `readOnly`) a button to change them. */
export function ItemLabels({ kind, id, readOnly = false }: { kind: LabelKind; id: string; readOnly?: boolean }) {
  const d = useLabels();
  const on = labelsOn(d, kind, id);
  if (readOnly && on.length === 0) return null;
  return (
    <span className="item-labels">
      {on.map((l) => (
        <LabelChip key={l.id} label={l} />
      ))}
      {!readOnly && <LabelPicker kind={kind} id={id} />}
    </span>
  );
}

/** A small menu of every label this account sees, ticked when on the item. */
export function LabelPicker({ kind, id }: { kind: LabelKind; id: string }) {
  const d = useLabels();
  const ref = useRef<HTMLDetailsElement>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const on = new Set(labelsOn(d, kind, id).map((l) => l.id));

  // Close on a click elsewhere or Escape.
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  const toggle = async (l: Label) => {
    setError("");
    try {
      await setLabel(l.id, kind, id, !on.has(l.id));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const make = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const made = await createLabel({ name: name.trim(), color: "gray", scope: "user" });
      await setLabel(made.id, kind, id, true);
      setName("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="label-picker" ref={ref} onClick={(e) => e.stopPropagation()}>
      <summary className="btn-sm btn-ghost btn-icon" title="Labels" aria-label="Labels">
        <Icon name="tag" size={14} />
      </summary>
      <div className="label-menu" role="menu">
        {(d?.labels ?? []).length === 0 && <p className="hint">No labels yet.</p>}
        {(d?.labels ?? []).map((l) => (
          <label key={l.id} className="label-menu-item">
            <input type="checkbox" checked={on.has(l.id)} onChange={() => toggle(l)} />
            <LabelChip label={l} />
            <span className="hint">{scopeText(l)}</span>
          </label>
        ))}
        <form className="label-menu-new" onSubmit={make}>
          <input
            placeholder="New label (only you)"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn-sm" type="submit" disabled={busy || !name.trim()}>
            Add
          </button>
        </form>
        {error && <p className="printer-error">{error}</p>}
      </div>
    </details>
  );
}

/** Pick labels to show only items carrying all of them. */
export function LabelFilter({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const d = useLabels();
  const labels = d?.labels ?? [];
  if (labels.length === 0) return null;
  const chosen = labels.filter((l) => value.includes(l.id));
  const rest = labels.filter((l) => !value.includes(l.id));
  return (
    <span className="label-filter">
      {chosen.map((l) => (
        <LabelChip key={l.id} label={l} onRemove={() => onChange(value.filter((v) => v !== l.id))} />
      ))}
      {rest.length > 0 && (
        <select
          className="select-sm"
          value=""
          aria-label="Filter by label"
          onChange={(e) => e.target.value && onChange([...value, e.target.value])}
        >
          <option value="">{chosen.length ? "+ label" : "Label…"}</option>
          {rest.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}
