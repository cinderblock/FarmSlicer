// /integrations: software around the farm. Keys for ordering tools (one
// group, optionally one client), webhooks that tell other tools what
// happened, and the usage report billing tools read.

import { useState } from "react";
import { apiJson, useAuth } from "../auth";
import { errorText, localDateTime, useJson } from "../api";
import type { GroupSummary } from "../groups";

interface IntegrationKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used: string | null;
  owner: string | null;
  group_id: string | null;
  group_name: string | null;
  client_ref: string | null;
  permissions: string[];
}

interface Webhook {
  id: string;
  url: string;
  events: string[];
  group_id: string | null;
  description: string;
  enabled: boolean;
  created_at: string;
  pending: number;
  failed: number;
}

interface Delivery {
  id: string;
  event: string;
  payload: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  response_status: number | null;
  created_at: string;
  delivered_at: string | null;
}

interface UsageRow {
  prints: number;
  printer_hours: number;
  grams: Record<string, number>;
  good: number;
  failed: number;
  estimated_cost: number;
}

interface UsageReport {
  currency: string;
  total: UsageRow;
  unassigned: UsageRow;
  projects: { project_id: string; name: string | null; client_ref: string | null; external_ref: string | null; usage: UsageRow }[];
}

const PERMISSIONS: [string, string][] = [
  ["projects:read", "Read its projects and their progress"],
  ["projects:write", "Create projects, upload sliced files, set fulfillment status"],
  ["usage:read", "Read usage (material, printer time, copies) for billing"],
];

export default function IntegrationsPage() {
  const { isAdmin } = useAuth();
  const groups = (useJson<GroupSummary[]>("/api/groups").data ?? []).filter((g) => isAdmin || g.can_manage);
  return (
    <div className="page">
      <h2>Integrations</h2>
      <p className="hint">
        Connect ordering, shipping and billing software. FarmSlicer keeps no customer records: projects carry the
        other tool's client and order references. The API is described in the README (API section).
      </p>
      <h3>Keys for ordering software</h3>
      <KeysSection groups={groups} isAdmin={isAdmin} />
      {isAdmin && (
        <>
          <h3>Webhooks</h3>
          <WebhooksSection groups={groups} />
        </>
      )}
      <h3>Usage</h3>
      <UsageSection groups={groups} isAdmin={isAdmin} />
    </div>
  );
}

function KeysSection({ groups, isAdmin }: { groups: GroupSummary[]; isAdmin: boolean }) {
  const [rev, setRev] = useState(0);
  const keys = useJson<IntegrationKey[]>("/api/integrations/keys", rev).data;
  const [form, setForm] = useState({ name: "", group_id: "", client_ref: "", permissions: ["projects:write"] });
  const [made, setMade] = useState("");
  const [error, setError] = useState("");

  const create = async () => {
    setError("");
    try {
      const r = await apiJson<{ key: string }>("/api/integrations/keys", "POST", { ...form, group_id: form.group_id || null });
      setMade(r.key);
      setForm({ ...form, name: "", client_ref: "" });
      setRev((x) => x + 1);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const revoke = async (k: IntegrationKey) => {
    if (!window.confirm(`Revoke ${k.name}? Software using it stops working.`)) return;
    try {
      await apiJson(`/api/integrations/keys/${k.id}`, "DELETE");
      setRev((x) => x + 1);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const toggle = (p: string) =>
    setForm((f) => ({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p] }));

  return (
    <>
      <p className="hint">
        A key reaches one group's projects (and, with a client reference, only that client's), creates them and follows
        their progress; it can't touch printers, the queue or anything else. Keys work on the local network only.
      </p>
      {keys && keys.length > 0 && (
        <table className="data-table cards">
          <thead>
            <tr>
              <th>Key</th>
              <th>Reaches</th>
              <th>May</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td className="cell-title">
                  {k.name}
                  <div className="hint">
                    {k.prefix} · by {k.owner ?? "?"}
                  </div>
                </td>
                <td data-label="Reaches">
                  {k.group_name ?? "Every group"}
                  {k.client_ref && <div className="hint">client {k.client_ref}</div>}
                </td>
                <td data-label="May">{k.permissions.join(", ")}</td>
                <td data-label="Last used">{localDateTime(k.last_used)}</td>
                <td className="cell-actions">
                  <button className="btn-sm btn-danger" onClick={() => revoke(k)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {made && (
        <div className="job-alert" role="status">
          <strong>Copy the key now; it won't be shown again:</strong>
          <pre className="secret-once">{made}</pre>
          <button className="btn-sm" onClick={() => setMade("")}>
            Done
          </button>
        </div>
      )}
      <div className="printer-form integration-form">
        <label>
          Name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Web shop" maxLength={100} />
        </label>
        <label>
          Group
          <select value={form.group_id} onChange={(e) => setForm({ ...form, group_id: e.target.value })}>
            {isAdmin ? <option value="">Every group</option> : <option value="">Choose…</option>}
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.path}
              </option>
            ))}
          </select>
        </label>
        <label>
          Client reference (optional)
          <input value={form.client_ref} onChange={(e) => setForm({ ...form, client_ref: e.target.value })} maxLength={200} />
        </label>
        <fieldset>
          <legend>May</legend>
          {PERMISSIONS.map(([p, label]) => (
            <label key={p} className="checkbox-label">
              <input type="checkbox" checked={form.permissions.includes(p)} onChange={() => toggle(p)} />
              {label}
            </label>
          ))}
        </fieldset>
        {error && <p className="login-error">{error}</p>}
        <button className="btn-sm" disabled={!form.name.trim() || form.permissions.length === 0} onClick={create}>
          Make key
        </button>
      </div>
    </>
  );
}

function WebhooksSection({ groups }: { groups: GroupSummary[] }) {
  const [rev, setRev] = useState(0);
  const data = useJson<{ webhooks: Webhook[]; events: string[] }>("/api/integrations/webhooks", rev).data;
  const [form, setForm] = useState({ url: "", events: ["*"], group_id: "", description: "" });
  const [secret, setSecret] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const reload = () => setRev((x) => x + 1);
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const create = () =>
    act(async () => {
      const r = await apiJson<{ secret: string }>("/api/integrations/webhooks", "POST", { ...form, group_id: form.group_id || null });
      setSecret(r.secret);
      setForm({ ...form, url: "", description: "" });
    });
  const toggleEvent = (e: string) =>
    setForm((f) => {
      if (e === "*") return { ...f, events: ["*"] };
      const rest = f.events.filter((x) => x !== "*");
      const events = rest.includes(e) ? rest.filter((x) => x !== e) : [...rest, e];
      return { ...f, events: events.length ? events : ["*"] };
    });

  return (
    <>
      <p className="hint">
        FarmSlicer POSTs each event as JSON, signed: <code>X-FarmSlicer-Signature: sha256=…</code> is the HMAC-SHA256 of{" "}
        <code>&lt;X-FarmSlicer-Timestamp&gt;.&lt;body&gt;</code> with the webhook's secret. Failed deliveries are retried for
        about 15 hours.
      </p>
      {error && <p className="login-error">{error}</p>}
      {secret && (
        <div className="job-alert" role="status">
          <strong>The webhook's secret (shown once):</strong>
          <pre className="secret-once">{secret}</pre>
          <button className="btn-sm" onClick={() => setSecret("")}>
            Done
          </button>
        </div>
      )}
      {data?.webhooks.map((h) => (
        <div key={h.id} className="pool-row webhook-row">
          <div className="webhook-main">
            <strong>{h.url}</strong>
            {!h.enabled && <span className="hint"> · paused</span>}
            <div className="hint">
              {h.events.join(", ")}
              {h.group_id && ` · ${groups.find((g) => g.id === h.group_id)?.path ?? "a group"} only`}
              {h.description && ` · ${h.description}`}
            </div>
            {(h.pending > 0 || h.failed > 0) && (
              <div className={h.failed ? "printer-error" : "hint"}>
                {h.pending} waiting · {h.failed} given up
              </div>
            )}
            {open === h.id && <Deliveries webhookId={h.id} />}
          </div>
          <span className="print-controls">
            <button className="btn-sm" onClick={() => setOpen(open === h.id ? null : h.id)}>
              {open === h.id ? "Hide log" : "Log"}
            </button>
            <button className="btn-sm" onClick={() => act(() => apiJson(`/api/integrations/webhooks/${h.id}/test`, "POST", {}))}>
              Test
            </button>
            <button className="btn-sm" onClick={() => act(() => apiJson(`/api/integrations/webhooks/${h.id}`, "PATCH", { enabled: !h.enabled }))}>
              {h.enabled ? "Pause" : "Resume"}
            </button>
            <button
              className="btn-sm"
              onClick={() =>
                window.confirm("Make a new secret? The old one stops working at once.") &&
                act(async () => {
                  const r = await apiJson<{ secret: string }>(`/api/integrations/webhooks/${h.id}`, "PATCH", { rotate_secret: true });
                  setSecret(r.secret);
                })
              }
            >
              New secret
            </button>
            <button className="btn-sm btn-danger" onClick={() => window.confirm(`Remove ${h.url}?`) && act(() => apiJson(`/api/integrations/webhooks/${h.id}`, "DELETE"))}>
              Remove
            </button>
          </span>
        </div>
      ))}
      <div className="printer-form integration-form">
        <label>
          URL
          <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://shop.example.com/farmslicer" />
        </label>
        <fieldset>
          <legend>Events</legend>
          {["*", ...(data?.events ?? []).filter((e) => e !== "ping")].map((e) => (
            <label key={e} className="checkbox-label">
              <input type="checkbox" checked={form.events.includes(e)} onChange={() => toggleEvent(e)} />
              {e === "*" ? "Every event" : e}
            </label>
          ))}
        </fieldset>
        <label>
          Only one group's events (optional)
          <select value={form.group_id} onChange={(e) => setForm({ ...form, group_id: e.target.value })}>
            <option value="">Every group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.path}
              </option>
            ))}
          </select>
        </label>
        <label>
          Description
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={500} />
        </label>
        <button className="btn-sm" disabled={!form.url.trim()} onClick={create}>
          Add webhook
        </button>
      </div>
    </>
  );
}

function Deliveries({ webhookId }: { webhookId: string }) {
  const [rev, setRev] = useState(0);
  const list = useJson<Delivery[]>(`/api/integrations/webhooks/${webhookId}/deliveries?limit=30`, rev).data;
  if (!list) return <p className="hint">Loading…</p>;
  if (list.length === 0) return <p className="hint">Nothing sent yet.</p>;
  return (
    <table className="data-table deliveries">
      <thead>
        <tr>
          <th>Event</th>
          <th>Status</th>
          <th>Tries</th>
          <th>When</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {list.map((d) => (
          <tr key={d.id}>
            <td title={d.payload}>{d.event}</td>
            <td className={d.status === "failed" ? "printer-error" : d.status === "pending" ? "hint" : ""}>
              {d.status}
              {d.response_status ? ` (${d.response_status})` : ""}
              {d.last_error && d.status !== "delivered" && <div className="hint">{d.last_error}</div>}
            </td>
            <td>{d.attempts}</td>
            <td>{localDateTime(d.delivered_at ?? d.created_at)}</td>
            <td>
              {d.status !== "delivered" && (
                <button className="btn-sm" onClick={() => apiJson(`/api/integrations/deliveries/${d.id}/retry`, "POST", {}).then(() => setRev((x) => x + 1))}>
                  Retry
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UsageSection({ groups, isAdmin }: { groups: GroupSummary[]; isAdmin: boolean }) {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const [from, setFrom] = useState(iso(first));
  const [to, setTo] = useState("");
  const [group, setGroup] = useState(isAdmin ? "" : (groups[0]?.id ?? ""));
  const [client, setClient] = useState("");
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (group) params.set("group", group);
  if (client.trim()) params.set("client_ref", client.trim());
  const report = useJson<UsageReport>(isAdmin || group ? `/api/usage/prints?${params}` : null);
  const grams = (g: Record<string, number>) =>
    Object.entries(g)
      .map(([m, v]) => `${v} g ${m}`)
      .join(", ") || "—";
  const row = (label: React.ReactNode, u: UsageRow, key: string, cur: string) => (
    <tr key={key}>
      <td className="cell-title">{label}</td>
      <td data-label="Prints">{u.prints}</td>
      <td data-label="Printer hours">{u.printer_hours}</td>
      <td data-label="Material">{grams(u.grams)}</td>
      <td data-label="Copies">
        {u.good} good{u.failed ? `, ${u.failed} failed` : ""}
      </td>
      <td data-label="Estimate">
        {cur}
        {u.estimated_cost.toFixed(2)}
      </td>
    </tr>
  );
  return (
    <>
      <p className="hint">
        What prints that ended in the period used, per project. A plate shared by several projects is split by copies;
        a failed print counts by how far it got. Billing tools read the same from <code>GET /api/usage/prints</code>.
      </p>
      <div className="filters">
        <label className="inline-label">
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline-label">
          before <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group">
          {isAdmin && <option value="">Every group</option>}
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.path}
            </option>
          ))}
        </select>
        <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="Client reference" aria-label="Client reference" />
      </div>
      {report.error && <p className="login-error">{report.error}</p>}
      {report.data && (
        <table className="data-table cards">
          <thead>
            <tr>
              <th>Project</th>
              <th>Prints</th>
              <th>Printer hours</th>
              <th>Material</th>
              <th>Copies</th>
              <th>Estimate</th>
            </tr>
          </thead>
          <tbody>
            {report.data.projects.map((p) =>
              row(
                <>
                  {p.name ?? p.project_id}
                  <div className="hint">{[p.client_ref, p.external_ref].filter(Boolean).join(" · ")}</div>
                </>,
                p.usage,
                p.project_id,
                report.data!.currency,
              ),
            )}
            {report.data.unassigned.prints > 0 && row(<span className="hint">Not for a project</span>, report.data.unassigned, "none", report.data.currency)}
            {row(<strong>Total</strong>, report.data.total, "total", report.data.currency)}
          </tbody>
        </table>
      )}
    </>
  );
}
