// /audit: who changed accounts, roles, groups and site settings
// (src/audit.rs). Newest first, filtered by kind of change, paged.
import { useState } from "react";
import { Link } from "react-router";
import { errorText, localDateTime, useJson } from "../api";
import PageHeader, { EmptyState } from "../components/PageHeader";

interface Entry {
  id: number;
  at: string;
  actor_id: string | null;
  actor_name: string;
  action: string;
  target_kind: string;
  target_id: string;
  target_name: string;
  detail: Record<string, unknown> | null;
}

const ACTIONS: Record<string, string> = {
  "user.create": "added the account",
  "user.invite": "issued an invite link for",
  "user.role": "changed the role of",
  "user.quotas": "changed the limits of",
  "user.remote_access": "changed remote access for",
  "user.suspend": "suspended",
  "user.reinstate": "reinstated",
  "user.delete": "deleted the account",
  "role.create": "created the role",
  "role.update": "changed the role",
  "role.delete": "deleted the role",
  "group.create": "created the group",
  "group.update": "changed the group",
  "group.delete": "deleted the group",
  "group.member.add": "added a member to",
  "group.member.role": "changed a member's role in",
  "group.member.quotas": "changed a member's limits in",
  "group.member.approve": "approved a member of",
  "group.member.unapprove": "unapproved a member of",
  "group.member.remove": "removed a member from",
  "group.member.leave": "left",
  "settings.update": "changed site settings",
};

const FAMILIES: [string, string][] = [
  ["", "Everything"],
  ["user.", "Accounts"],
  ["role.", "Roles"],
  ["group.", "Groups"],
  ["settings.", "Site settings"],
];

const PAGE = 100;

function utc(sqlite: string): string {
  return `${sqlite.replace(" ", "T")}Z`;
}

function show(v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (typeof v === "string") return v || "''";
  return JSON.stringify(v);
}

/** One line per changed field: `name: from → to`, or `key: value`. */
function details(detail: Entry["detail"]): string[] {
  if (!detail || typeof detail !== "object") return [];
  const out: string[] = [];
  if ("from" in detail || "to" in detail) {
    out.push(`${"from" in detail ? `${show(detail.from)} → ` : ""}${show(detail.to)}`);
  }
  for (const [k, v] of Object.entries(detail)) {
    if (k === "from" || k === "to") continue;
    if (v && typeof v === "object" && ("from" in v || "to" in v)) {
      const c = v as { from?: unknown; to?: unknown };
      out.push(`${k}: ${"from" in c ? `${show(c.from)} → ` : ""}${show(c.to)}`);
    } else {
      out.push(`${k}: ${show(v)}`);
    }
  }
  return out;
}

function targetLink(e: Entry) {
  if (e.target_kind === "group" && e.target_id) return <Link to={`/groups/${e.target_id}`}>{e.target_name}</Link>;
  if (e.target_kind === "role") return <Link to="/roles">{e.target_name}</Link>;
  if (e.target_kind === "user") return <Link to="/users">{e.target_name}</Link>;
  return e.target_kind === "site" ? null : <span>{e.target_name}</span>;
}

interface Page {
  entries?: Entry[];
  next_before?: number | null;
}

export default function AuditPage() {
  const [family, setFamily] = useState("");
  const query = (before?: number) => {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (family) q.set("action", family);
    if (before !== undefined) q.set("before", String(before));
    return `/api/audit?${q}`;
  };
  // The newest page follows the filter; older pages are added on request,
  // kept with the filter they were fetched for.
  const first = useJson<Page>(query());
  const [older, setOlder] = useState<{ family: string; entries: Entry[]; next: number | null } | null>(null);
  const [moreError, setMoreError] = useState("");
  const [loading, setLoading] = useState(false);
  const extra = older?.family === family ? older : null;
  const entries = [...(first.data?.entries ?? []), ...(extra?.entries ?? [])];
  const next = extra ? extra.next : (first.data?.next_before ?? null);
  const error = first.error || moreError;

  const loadOlder = async (before: number) => {
    setLoading(true);
    setMoreError("");
    try {
      const res = await fetch(query(before));
      const data = (await res.json()) as Page & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setOlder({ family, entries: [...(extra?.entries ?? []), ...(data.entries ?? [])], next: data.next_before ?? null });
    } catch (err) {
      setMoreError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <PageHeader title="Audit log" icon="history">
        Who changed accounts, roles, groups and site settings, newest first. Times are in your time zone; hover for UTC.
      </PageHeader>
      <div className="list-toolbar">
        <div className="segmented" role="tablist">
          {FAMILIES.map(([id, label]) => (
            <button key={id} className={family === id ? "active" : ""} onClick={() => setFamily(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="login-error">{error}</p>}
      {entries.length === 0 && first.data ? (
        <EmptyState icon="history" title="Nothing recorded yet">
          Changes to accounts, roles, groups and settings show up here as they happen.
        </EmptyState>
      ) : (
        <table className="data-table cards">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td data-label="When" title={`${e.at} UTC`}>
                  <time dateTime={utc(e.at)}>{localDateTime(e.at)}</time>
                </td>
                <td className="cell-title" data-label="Who">
                  {e.actor_name || "—"}
                </td>
                <td data-label="What">
                  {ACTIONS[e.action] ?? e.action} {targetLink(e)}
                </td>
                <td data-label="Details" className="audit-detail">
                  {details(e.detail).map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next !== null && (
        <button className="btn-sm" disabled={loading} onClick={() => loadOlder(next)}>
          {loading ? "Loading…" : "Older entries"}
        </button>
      )}
    </div>
  );
}
