import { useState } from "react";
import { apiJson } from "../auth";
import { errorText, useJson } from "../api";
import type { Printer } from "../printers";

export interface Pool {
  id: string;
  name: string;
  settings: { mixing?: "none" | "group" | "any" };
  printer_ids: string[];
  operators: { id: string; username: string }[];
}

interface UserRow {
  id: string;
  username: string;
  kind: string;
}

/** Settings page (admins): printer pools and who operates them. */
export default function PoolsEditor() {
  const [rev, setRev] = useState(0);
  const pools = useJson<{ pools: Pool[] }>("/api/pools", rev).data?.pools;
  const printers = useJson<Printer[]>("/api/printers").data ?? [];
  const users = (useJson<UserRow[]>("/api/users").data ?? []).filter((u) => u.kind === "full");
  const [editing, setEditing] = useState<string | null>(null);
  const reload = () => {
    setEditing(null);
    setRev((r) => r + 1);
  };

  return (
    <div className="pools-editor">
      <p className="hint">
        A pool is a set of printers and the people who run them. Operators see the queue for their pools' printers,
        send plates to them, control their prints and say how they came out. Without pools, admins run every
        printer.
      </p>
      {pools?.length === 0 && editing !== "new" && <p className="hint">No pools.</p>}
      {pools?.map((p) =>
        editing === p.id ? (
          <PoolForm key={p.id} pool={p} printers={printers} users={users} onDone={reload} onCancel={() => setEditing(null)} />
        ) : (
          <div key={p.id} className="pool-row">
            <div>
              <strong>{p.name}</strong>
              <div className="hint">
                {p.printer_ids.map((id) => printers.find((x) => x.id === id)?.name ?? "?").join(", ") || "no printers"} ·{" "}
                {p.operators.map((o) => o.username).join(", ") || "no operators"}
                {p.settings.mixing && ` · mixing: ${p.settings.mixing}`}
              </div>
            </div>
            <button type="button" className="btn-sm" onClick={() => setEditing(p.id)}>
              Edit
            </button>
          </div>
        ),
      )}
      {editing === "new" ? (
        <PoolForm printers={printers} users={users} onDone={reload} onCancel={() => setEditing(null)} />
      ) : (
        <button type="button" className="btn-sm" onClick={() => setEditing("new")}>
          New pool
        </button>
      )}
    </div>
  );
}

function PoolForm({
  pool,
  printers,
  users,
  onDone,
  onCancel,
}: {
  pool?: Pool;
  printers: Printer[];
  users: UserRow[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(pool?.name ?? "");
  const [printerIds, setPrinterIds] = useState<string[]>(pool?.printer_ids ?? []);
  const [operatorIds, setOperatorIds] = useState<string[]>(pool?.operators.map((o) => o.id) ?? []);
  const [mixing, setMixing] = useState(pool?.settings.mixing ?? "");
  const [error, setError] = useState("");
  const toggle = (list: string[], set: (l: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const save = async () => {
    setError("");
    const body = { name, printer_ids: printerIds, operator_ids: operatorIds, settings: mixing ? { mixing } : {} };
    try {
      if (pool) await apiJson(`/api/pools/${pool.id}`, "PATCH", body);
      else await apiJson("/api/pools", "POST", body);
      onDone();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const remove = async () => {
    if (!pool || !window.confirm(`Delete ${pool.name}? Plates queued for it may then go to any printer.`)) return;
    try {
      await apiJson(`/api/pools/${pool.id}`, "DELETE");
      onDone();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="pool-form">
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      </label>
      <fieldset>
        <legend>Printers</legend>
        {printers.map((p) => (
          <label key={p.id} className="checkbox-label">
            <input type="checkbox" checked={printerIds.includes(p.id)} onChange={() => toggle(printerIds, setPrinterIds, p.id)} />
            {p.name}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Operators</legend>
        {users.length === 0 && <span className="hint">No accounts to choose from (guests can't operate printers).</span>}
        {users.map((u) => (
          <label key={u.id} className="checkbox-label">
            <input type="checkbox" checked={operatorIds.includes(u.id)} onChange={() => toggle(operatorIds, setOperatorIds, u.id)} />
            {u.username}
          </label>
        ))}
      </fieldset>
      <label>
        Parts of different projects on one plate
        <select value={mixing} onChange={(e) => setMixing(e.target.value as typeof mixing)}>
          <option value="">As the site says</option>
          <option value="none">Never</option>
          <option value="group">Same group and client only</option>
          <option value="any">Any</option>
        </select>
      </label>
      {error && <p className="login-error">{error}</p>}
      <div className="modal-actions">
        {pool && (
          <button type="button" className="btn-sm btn-danger" onClick={remove}>
            Delete pool
          </button>
        )}
        <button type="button" className="btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn-sm" disabled={!name.trim()} onClick={save}>
          Save pool
        </button>
      </div>
    </div>
  );
}
