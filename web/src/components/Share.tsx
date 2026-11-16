// Sharing a job, project, folder or group library (src/shares.rs): a
// button that appears for those who may share it, and its dialog.
import { useEffect, useState } from "react";
import { apiJson } from "../auth";
import { errorText, localDate, useJson } from "../api";
import type { GroupSummary } from "../groups";
import Icon from "./Icon";

export type ShareKind = "job" | "project" | "folder" | "library";
type Level = "view" | "use" | "edit";

interface Share {
  id: string;
  principal_kind: "user" | "group" | "link";
  who: string;
  level: Level;
  expires_at: string | null;
  url?: string;
}

interface SharesOn {
  shares: Share[];
  public_links: boolean;
}

const LEVELS: [Level, string, string][] = [
  ["view", "View", "See it, its plates and preview"],
  ["use", "Use", "Also print it, queue it, download the model and slice it again"],
  ["edit", "Edit", "Also label and file it (deleting and sharing stay with its owners)"],
];

/** "Share" for whoever may share this (hidden for everyone else). */
export function ShareButton({ kind, id, name, small = true }: { kind: ShareKind; id: string; name: string; small?: boolean }) {
  const [rev, setRev] = useState(0);
  const data = useJson<SharesOn>(`/api/shares?kind=${kind}&id=${encodeURIComponent(id)}`, rev);
  const [open, setOpen] = useState(false);
  if (!data.data) return null;
  const n = data.data.shares.length;
  return (
    <>
      <button
        className={small ? "btn-sm" : "btn-sm btn-accent"}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title={n ? `Shared ${n === 1 ? "once" : `${n} times`}` : "Share"}
      >
        <Icon name="users" size={14} /> Share{n ? ` (${n})` : ""}
      </button>
      {open && (
        <ShareDialog
          kind={kind}
          id={id}
          name={name}
          data={data.data}
          onChange={() => setRev((r) => r + 1)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ShareDialog({
  kind,
  id,
  name,
  data,
  onChange,
  onClose,
}: {
  kind: ShareKind;
  id: string;
  name: string;
  data: SharesOn;
  onChange: () => void;
  onClose: () => void;
}) {
  const groups = useJson<GroupSummary[]>("/api/groups").data ?? [];
  const [withKind, setWithKind] = useState<"user" | "group" | "link">("user");
  const [who, setWho] = useState("");
  const [level, setLevel] = useState<Level>("view");
  const [days, setDays] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    act(async () => {
      await apiJson("/api/shares", "POST", {
        kind,
        target_id: id,
        with: { kind: withKind, id: withKind === "link" ? "" : who },
        level: withKind === "link" ? "view" : level,
        expires_days: days.trim() ? Number(days) : null,
      });
      setWho("");
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal share-dialog" role="dialog" aria-label={`Share ${name}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Share {name}</h3>
          <button className="btn-sm btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <p className="hint">
          {kind === "folder"
            ? "Everything filed in this folder and its subfolders, as it is now and as it changes."
            : kind === "library"
              ? "Everything charged to this group and its subgroups."
              : "Only this " + kind + "."}{" "}
          Prints still follow the printers' access rules and the sender's own limits.
        </p>

        {data.shares.length === 0 ? (
          <p className="hint">Not shared with anyone yet.</p>
        ) : (
          <ul className="share-list">
            {data.shares.map((s) => (
              <li key={s.id}>
                <span>
                  <strong>{s.who}</strong> <span className="status-badge">{s.level}</span>
                  {s.expires_at && <span className="hint"> until {localDate(s.expires_at)}</span>}
                  {s.url && (
                    <span className="share-url">
                      <code>{s.url}</code>
                      <button className="btn-sm btn-ghost" onClick={() => navigator.clipboard?.writeText(s.url!).catch(() => {})}>
                        Copy
                      </button>
                    </span>
                  )}
                </span>
                <button className="btn-sm btn-danger" disabled={busy} onClick={() => act(() => apiJson(`/api/shares/${s.id}`, "DELETE"))}>
                  Stop sharing
                </button>
              </li>
            ))}
          </ul>
        )}

        <form className="access-form" onSubmit={add}>
          <div className="access-form-row">
            <label>
              With
              <select
                value={withKind}
                onChange={(e) => {
                  setWithKind(e.target.value as typeof withKind);
                  setWho("");
                }}
              >
                <option value="user">A person</option>
                <option value="group">A group (and its subgroups)</option>
                {data.public_links && <option value="link">Anyone with a link</option>}
              </select>
              {!data.public_links && kind !== "library" && (
                <span className="hint">Public links are off here (the group's settings, or the site's).</span>
              )}
            </label>
            {withKind === "user" && (
              <label>
                Username
                <input value={who} onChange={(e) => setWho(e.target.value)} required autoComplete="off" />
              </label>
            )}
            {withKind === "group" && (
              <label>
                Group
                <select value={who} onChange={(e) => setWho(e.target.value)} required>
                  <option value="">Choose…</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.path}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {withKind === "link" ? (
            <p className="hint">
              A link anyone can open, even from outside, without an account: names, facts and plate pictures only,
              no files.
            </p>
          ) : (
            <fieldset className="share-levels">
              <legend>They may</legend>
              {LEVELS.map(([l, label, help]) => (
                <label key={l} className="checkbox-label">
                  <input type="radio" name="level" checked={level === l} onChange={() => setLevel(l)} />
                  <span>
                    <strong>{label}</strong> <span className="hint">{help}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <label>
            For how long (days, empty = until you stop it)
            <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          {error && <p className="printer-error">{error}</p>}
          <div className="modal-actions">
            <button className="btn-sm" type="button" onClick={onClose}>
              Done
            </button>
            <button className="btn-primary btn-inline" type="submit" disabled={busy}>
              {withKind === "link" ? "Make a link" : "Share"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
