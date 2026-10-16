import { useEffect, useState } from "react";
import { apiJson, useAuth } from "../auth";
import { errorText, localDateTime, useJson } from "../api";
import {
  FEEDBACK_CHANGED,
  feedbackChanged,
  KIND_LABELS,
  KINDS,
  SOURCE_LABELS,
  STATUS_LABELS,
  STATUSES,
  type Counts,
  type FeedbackItem,
  type Status,
} from "../feedback";

type Tab = "manual" | "automatic";

/** Admins: every report and error, to triage. Everyone else: what they
 *  sent, the errors their browser reported, and what became of them. */
export default function FeedbackPage() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>("manual");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState(isAdmin ? "open" : "");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rev, setRev] = useState(0);

  const params = new URLSearchParams({ automatic: tab === "automatic" ? "1" : "0" });
  if (kind) params.set("kind", kind);
  if (status) params.set("status", status);
  const list = useJson<FeedbackItem[]>(`/api/feedback?${params}`, rev);
  const counts = useJson<Counts>("/api/feedback/counts", rev).data;
  const items = list.data ?? [];
  // Triage here and reports sent from the dialog both announce themselves.
  useEffect(() => {
    const reload = () => setRev((r) => r + 1);
    window.addEventListener(FEEDBACK_CHANGED, reload);
    return () => window.removeEventListener(FEEDBACK_CHANGED, reload);
  }, []);
  const changed = feedbackChanged;

  const tabLabel = (t: Tab) => {
    const base = t === "manual" ? (isAdmin ? "Reports" : "My reports") : isAdmin ? "Errors" : "Errors from my browser";
    const fresh = counts?.[t].new ?? 0;
    return (
      <>
        {base}
        {fresh > 0 && <span className="feedback-count">{fresh}</span>}
      </>
    );
  };

  return (
    <div className="page feedback-page">
      <h2>{isAdmin ? "Feedback" : "My feedback"}</h2>
      <p className="hint feedback-intro">
        {isAdmin
          ? "What people reported with the Feedback button, and errors reported automatically by browsers and the server (one entry per distinct error, with a count). Reporters see the status and your note."
          : "What you sent with the Feedback button, and errors your browser reported automatically. The admins set the status and may leave a note."}
      </p>

      <div className="profile-tabs">
        {(["manual", "automatic"] as Tab[]).map((t) => (
          <button
            key={t}
            className={`profile-tab ${tab === t ? "active" : ""}`}
            onClick={() => {
              setTab(t);
              setExpanded(null);
            }}
          >
            {tabLabel(t)}
          </button>
        ))}
      </div>

      <div className="browse-filters feedback-filters">
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All</option>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {KIND_LABELS[k.value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="open">Open (new or acknowledged)</option>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {list.error && <p className="printer-error">{list.error}</p>}
      {list.data && items.length === 0 && (
        <p className="empty-state">
          {tab === "manual" ? "No reports" : "No errors"}
          {kind || status ? " match these filters." : " yet."}
        </p>
      )}
      <ul className="feedback-list">
        {items.map((item) => (
          <FeedbackRow
            key={item.id}
            item={item}
            admin={isAdmin}
            open={expanded === item.id}
            onToggle={() => setExpanded(expanded === item.id ? null : item.id)}
            rev={rev}
            onChanged={changed}
          />
        ))}
      </ul>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  return <span className={`status-badge feedback-status-${status}`}>{STATUS_LABELS[status] ?? status}</span>;
}

function FeedbackRow({
  item,
  admin,
  open,
  onToggle,
  rev,
  onChanged,
}: {
  item: FeedbackItem;
  admin: boolean;
  open: boolean;
  onToggle: () => void;
  rev: number;
  onChanged: () => void;
}) {
  const when = item.automatic
    ? `${item.count}× · first ${localDateTime(item.created_at)} · last ${localDateTime(item.last_seen)}`
    : localDateTime(item.created_at);
  return (
    <li className={`feedback-item ${open ? "open" : ""}`}>
      <button className="feedback-summary" onClick={onToggle} aria-expanded={open}>
        <span className="feedback-badges">
          <StatusBadge status={item.status} />
          <span className="feedback-kind-badge">{KIND_LABELS[item.kind] ?? item.kind}</span>
          {item.automatic && <span className="feedback-source">{SOURCE_LABELS[item.source] ?? item.source}</span>}
        </span>
        <span className={`feedback-message-line ${item.automatic ? "mono" : ""}`}>{item.message}</span>
        <span className="hint feedback-meta">
          {when}
          {admin && item.automatic && item.affected_users > 0 && ` · ${item.affected_users} account${item.affected_users === 1 ? "" : "s"}`}
          {admin && !item.automatic && item.username && ` · ${item.username}`}
          {item.printer_name && ` · ${item.printer_name}`}
          {item.job_name && ` · ${item.job_name}`}
          {item.automatic && item.versions.length > 0 && ` · ${item.versions.length === 1 ? "version" : "versions"} ${item.versions.join(", ")}`}
        </span>
        {!admin && item.admin_note && <span className="feedback-reply">Admins: {item.admin_note}</span>}
      </button>
      {open && <FeedbackDetail id={item.id} admin={admin} rev={rev} onChanged={onChanged} />}
    </li>
  );
}

function FeedbackDetail({
  id,
  admin,
  rev,
  onChanged,
}: {
  id: string;
  admin: boolean;
  rev: number;
  onChanged: () => void;
}) {
  const detail = useJson<FeedbackItem>(`/api/feedback/${id}`, rev);
  const f = detail.data;
  if (detail.error) return <p className="printer-error">{detail.error}</p>;
  if (!f) return <p className="hint">Loading…</p>;
  return (
    <div className="feedback-detail">
      <p className={`feedback-full-message ${f.automatic ? "mono" : ""}`}>{f.message}</p>
      <dl className="feedback-facts">
        {!f.automatic && f.username && (
          <>
            <dt>From</dt>
            <dd>{f.username}</dd>
          </>
        )}
        {f.page_url && (
          <>
            <dt>Page</dt>
            <dd className="mono">{f.page_url}</dd>
          </>
        )}
        {f.version && (
          <>
            <dt>Version</dt>
            <dd className="mono">{f.version}</dd>
          </>
        )}
        {f.user_agent && (
          <>
            <dt>Browser</dt>
            <dd>{f.user_agent}</dd>
          </>
        )}
        {f.printer_name && (
          <>
            <dt>Printer</dt>
            <dd>{f.printer_name}</dd>
          </>
        )}
        {f.job_name && (
          <>
            <dt>Job</dt>
            <dd>{f.job_name}</dd>
          </>
        )}
        {f.updated_at !== f.created_at && (
          <>
            <dt>Updated</dt>
            <dd>{localDateTime(f.updated_at)}</dd>
          </>
        )}
      </dl>

      {!admin && f.admin_note && (
        <div className="feedback-reply">
          <strong>Note from the admins</strong>
          <p>{f.admin_note}</p>
        </div>
      )}

      {f.stack && (
        <details className="feedback-block" open={f.automatic}>
          <summary>Stack (latest)</summary>
          <pre>{f.stack}</pre>
        </details>
      )}

      {f.occurrences && f.occurrences.length > 0 && (
        <details className="feedback-block" open={admin}>
          <summary>{admin ? "Who hit it" : "When you hit it"}</summary>
          <table className="data-table feedback-occurrences">
            <thead>
              <tr>
                {admin && <th>Account</th>}
                <th>Version</th>
                <th>Count</th>
                <th>First</th>
                <th>Last</th>
                <th>Page</th>
              </tr>
            </thead>
            <tbody>
              {f.occurrences.map((o) => (
                <tr key={`${o.user_id}|${o.version}`}>
                  {admin && <td>{o.username ?? (o.user_id ? o.user_id : "server")}</td>}
                  <td className="mono">{o.version || "—"}</td>
                  <td>{o.count}</td>
                  <td>{localDateTime(o.first_seen)}</td>
                  <td>{localDateTime(o.last_seen)}</td>
                  <td className="mono">{o.page_url ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {f.context != null && (
        <details className="feedback-block">
          <summary>{f.automatic ? "Context (latest)" : "Diagnostics"}</summary>
          <pre>{JSON.stringify(f.context, null, 2)}</pre>
        </details>
      )}

      {admin && <Triage key={`${f.status}|${f.updated_at}`} item={f} onChanged={onChanged} />}
    </div>
  );
}

function Triage({ item, onChanged }: { item: FeedbackItem; onChanged: () => void }) {
  const [status, setStatus] = useState<Status>(item.status);
  const [note, setNote] = useState(item.admin_note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = status !== item.status || note !== item.admin_note;

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await apiJson(`/api/feedback/${item.id}`, "PUT", { status, admin_note: note });
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(item.automatic ? "Delete this error and its counts?" : "Delete this report?")) return;
    setBusy(true);
    setError("");
    try {
      await apiJson(`/api/feedback/${item.id}`, "DELETE");
      onChanged();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="feedback-triage">
      <label>
        Status
        <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label className="feedback-note">
        Note (the reporter sees it)
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={5000} />
      </label>
      {item.automatic && (
        <p className="hint">A resolved error that happens again opens again by itself.</p>
      )}
      {error && <p className="printer-error">{error}</p>}
      <div className="feedback-triage-actions">
        <button className="btn-primary btn-inline" disabled={busy || !dirty} onClick={save}>
          Save
        </button>
        <button className="btn-sm btn-danger" disabled={busy} onClick={remove}>
          Delete
        </button>
      </div>
    </div>
  );
}
