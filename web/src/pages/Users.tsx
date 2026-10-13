import { useState } from "react";
import { Link } from "react-router";
import { apiJson, useAuth } from "../auth";
import type { User } from "../auth";
import { useJson } from "../api";
import { QuotaRulesEditor } from "../components/Quota";
import GcodeIncidents from "../components/GcodeIncidents";
import type { Rule } from "../groups";
import { ruleText } from "../groups";

interface AdminUser extends User {
  passkeys: number;
  invite_expires_at: string | null;
  /** Per-user limits; null = the site default for the account kind. */
  quotas: Rule[] | null;
  groups: { group_id: string; path: string; role: string; status: string }[];
  /** Their custom G-code that failed its check or a print. */
  gcode_incidents: number;
  last_gcode_incident: string | null;
}

/** Admin page: accounts and invite links. Admins cannot touch the owner; nobody can delete it. */
export default function UsersPage() {
  const { user: me } = useAuth();
  const [rev, setRev] = useState(0);
  const users = useJson<AdminUser[]>("/api/users", rev).data ?? [];
  const load = async () => setRev((r) => r + 1);
  const [editing, setEditing] = useState<string | null>(null);
  const [incidentsOf, setIncidentsOf] = useState<{ id: string; username: string } | null>(null);
  const [draft, setDraft] = useState<Rule[]>([]);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [busy, setBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState<{ username: string; url: string; expires: string } | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await apiJson<{ user: AdminUser; invite_url: string; expires_at: string }>(
        "/api/users",
        "POST",
        { username, role },
      );
      setInviteLink({ username: res.user.username, url: res.invite_url, expires: res.expires_at });
      setUsername("");
      setRole("user");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reissue = async (u: AdminUser) => {
    setError("");
    try {
      const res = await apiJson<{ invite_url: string; expires_at: string }>(
        `/api/users/${u.id}/invite`,
        "POST",
      );
      setInviteLink({ username: u.username, url: res.invite_url, expires: res.expires_at });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const setUserRole = async (u: AdminUser, newRole: string) => {
    setError("");
    try {
      await apiJson(`/api/users/${u.id}`, "PUT", { role: newRole });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveQuotas = async (u: AdminUser, quotas: Rule[] | null) => {
    setError("");
    try {
      await apiJson(`/api/users/${u.id}`, "PUT", { quotas });
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (u: AdminUser) => {
    if (!window.confirm(`Delete account "${u.username}"? Their passkeys and API keys stop working.`)) return;
    setError("");
    try {
      await apiJson(`/api/users/${u.id}`, "DELETE");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page">
      <h2>Users</h2>
      <p className="hint">
        Sign-in is passkey-only. Adding a user gives you an invite link; send it to them and
        they enrol their own passkey. Owner: the first account, fixed. Admins manage users and
        printers. Users slice and manage their own passkeys and API keys. Guests joined through a
        group's link without a passkey; they sign in with one-time codes and can't change printers,
        profiles or API keys. People can also join on their own through{" "}
        <Link to="/groups">group join links</Link>.
      </p>

      {inviteLink && (
        <div className="card api-key-reveal">
          <p>
            <strong>Invite link for {inviteLink.username}</strong> (valid until {inviteLink.expires} UTC,
            single use):
          </p>
          <code className="api-key-value">{inviteLink.url}</code>
          <p>
            <button
              className="btn-sm"
              onClick={() => navigator.clipboard?.writeText(inviteLink.url).catch(() => {})}
            >
              Copy
            </button>{" "}
            <button className="btn-sm" onClick={() => setInviteLink(null)}>
              Dismiss
            </button>
          </p>
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Passkeys</th>
            <th>Groups</th>
            <th>Limits</th>
            <th>Last login</th>
            <th>G-code incidents</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const locked = u.role === "owner" && u.id !== me?.id;
            return (
              <tr key={u.id}>
                <td>
                  {u.username}
                  {u.id === me?.id && <span className="hint"> (you)</span>}
                  {u.kind === "guest" && <span className="source-badge"> guest</span>}
                </td>
                <td>
                  {u.role === "owner" ? (
                    <span className="status-badge">owner</span>
                  ) : (
                    <select value={u.role} onChange={(e) => setUserRole(u, e.target.value)}>
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                  )}
                </td>
                <td>
                  {u.passkeys}
                  {u.passkeys === 0 && u.kind === "guest" && <span className="hint"> · signs in with codes</span>}
                  {u.passkeys === 0 && u.kind !== "guest" && (
                    <span className="hint">
                      {" "}
                      {u.invite_expires_at ? `· invite pending until ${u.invite_expires_at}` : "· no invite"}
                    </span>
                  )}
                </td>
                <td>
                  {u.groups.length === 0
                    ? "—"
                    : u.groups.map((g, i) => (
                        <span key={g.group_id}>
                          {i > 0 && ", "}
                          <Link to={`/groups/${g.group_id}`}>{g.path}</Link>
                          {g.role === "manager" ? " (manager)" : ""}
                          {g.status === "pending" ? " (pending)" : ""}
                        </span>
                      ))}
                </td>
                <td>
                  {editing === u.id ? (
                    <div>
                      <QuotaRulesEditor rules={draft} onChange={setDraft} />
                      <button className="btn-sm" onClick={() => saveQuotas(u, draft)}>
                        Save
                      </button>
                      <button className="btn-sm" onClick={() => saveQuotas(u, null)}>
                        Use site default
                      </button>
                      <button className="btn-sm" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="hint">{u.quotas ? u.quotas.map(ruleText).join("; ") || "none" : "site default"}</span>{" "}
                      <button
                        className="btn-sm"
                        disabled={locked}
                        onClick={() => {
                          setDraft(u.quotas ?? []);
                          setEditing(u.id);
                        }}
                      >
                        Customize
                      </button>
                    </>
                  )}
                </td>
                <td>{u.last_login ?? "—"}</td>
                <td>
                  {u.gcode_incidents > 0 ? (
                    <button className="btn-sm" onClick={() => setIncidentsOf({ id: u.id, username: u.username })}>
                      {u.gcode_incidents}
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <button className="btn-sm" onClick={() => reissue(u)} disabled={locked}>
                    New invite link
                  </button>{" "}
                  {u.role !== "owner" && u.id !== me?.id && (
                    <button className="btn-sm btn-danger" onClick={() => remove(u)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <GcodeIncidents user={incidentsOf} onClear={() => setIncidentsOf(null)} rev={rev} />

      <h3>Add user</h3>
      <form className="printer-form" onSubmit={create}>
        <label>
          Username
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create account and invite link"}
        </button>
      </form>
      {error && <p className="login-error">{error}</p>}
    </div>
  );
}
