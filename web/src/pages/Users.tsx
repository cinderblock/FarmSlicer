import { useState } from "react";
import { Link } from "react-router";
import { apiJson, useAuth } from "../auth";
import type { User } from "../auth";
import { localDateTime, useJson } from "../api";
import { QuotaRulesEditor } from "../components/Quota";
import GcodeIncidents from "../components/GcodeIncidents";
import type { Rule } from "../groups";
import { ruleText } from "../groups";
import PageHeader from "../components/PageHeader";
import { assignableSiteRoles, roleName, useRoles } from "../roles";

interface AdminUser extends User {
  role_name: string;
  /** The caller may change this account (holds every permission it has). */
  manageable: boolean;
  suspended_by?: string | null;
  suspend_reason?: string;
  passkeys: number;
  invite_expires_at: string | null;
  /** Per-user limits; null = the site default for the account kind. */
  quotas: Rule[] | null;
  groups: { group_id: string; path: string; role: string; status: string }[];
  /** Their custom G-code that failed its check or a print. */
  gcode_incidents: number;
  last_gcode_incident: string | null;
}

/** Accounts, their roles and invite links. Only accounts with no permission the viewer lacks can be changed; nobody but the owner changes the owner. */
export default function UsersPage() {
  const { user: me, can } = useAuth();
  const manages = can("users.manage");
  const roles = useRoles().data?.roles;
  const assignable = assignableSiteRoles(roles, me);
  const [suspending, setSuspending] = useState<{ id: string; reason: string } | null>(null);
  const [rev, setRev] = useState(0);
  const users = useJson<AdminUser[]>("/api/users", rev).data ?? [];
  const load = async () => setRev((r) => r + 1);
  const [editing, setEditing] = useState<string | null>(null);
  const [incidentsOf, setIncidentsOf] = useState<{ id: string; username: string } | null>(null);
  const [draft, setDraft] = useState<Rule[]>([]);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState("user");
  const [remote, setRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState<{
    username: string;
    url: string;
    expires: string;
    remote: boolean;
  } | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await apiJson<{ user: AdminUser; invite_url: string; expires_at: string }>(
        "/api/users",
        "POST",
        { username, role, remote_access: remote },
      );
      setInviteLink({
        username: res.user.username,
        url: res.invite_url,
        expires: res.expires_at,
        remote: res.user.remote_access,
      });
      setUsername("");
      setRole("user");
      setRemote(false);
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
      setInviteLink({ username: u.username, url: res.invite_url, expires: res.expires_at, remote: u.remote_access });
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

  const setRemoteAccess = async (u: AdminUser, allowed: boolean) => {
    setError("");
    try {
      await apiJson(`/api/users/${u.id}`, "PUT", { remote_access: allowed });
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

  const setSuspended = async (u: AdminUser, suspended: boolean, reason = "") => {
    setError("");
    try {
      await apiJson(`/api/users/${u.id}`, "PUT", suspended ? { suspended, suspend_reason: reason } : { suspended });
      setSuspending(null);
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
      <PageHeader title="Users" icon="users">
        Sign-in is passkey-only. Adding a user gives you an invite link; send it to them and
        they enrol their own passkey. What each account may do comes from its{" "}
        <Link to="/roles">role</Link>: the owner (the first account, fixed) and admins do
        everything, users slice and print, and custom roles sit in between. You can change an
        account only when you hold every permission it has. Suspended accounts can't sign in,
        and their API keys stop working, until reinstated. Guests joined through a group's link
        without a passkey; they sign in with one-time codes and can't change printers, profiles
        or API keys. People can also join on their own through{" "}
        <Link to="/groups">group join links</Link>.
      </PageHeader>
      <p className="hint">
        Remote: the account may be used from outside the local network, signing in with a passkey
        only (no recovery codes, guest codes or API keys from there). Its invite link works from
        the internet too. Join links, recovery and setup stay local-only.
      </p>

      {inviteLink && (
        <div className="card api-key-reveal">
          <p>
            <strong>Invite link for {inviteLink.username}</strong> (valid until {inviteLink.expires} UTC,
            single use{inviteLink.remote ? ", works from the internet" : ", local network only"}):
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

      <table className="data-table cards">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Passkeys</th>
            <th>Remote</th>
            <th>Groups</th>
            <th>Limits</th>
            <th>Last login</th>
            <th>G-code incidents</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const locked = !u.manageable;
            const options = assignable.some((r) => r.id === u.role)
              ? assignable
              : [{ id: u.role, name: u.role_name }, ...assignable];
            return (
              <tr key={u.id}>
                <td className="cell-title">
                  {u.username}
                  {u.id === me?.id && <span className="hint"> (you)</span>}
                  {u.kind === "guest" && <span className="source-badge"> guest</span>}
                  {u.suspended_at && (
                    <div>
                      <span className="status-badge status-failed">suspended</span>{" "}
                      <span className="hint">
                        {localDateTime(u.suspended_at)}
                        {u.suspended_by ? ` by ${u.suspended_by}` : ""}
                        {u.suspend_reason ? `: ${u.suspend_reason}` : ""}
                      </span>
                    </div>
                  )}
                </td>
                <td data-label="Role">
                  {u.role === "owner" || locked || !manages ? (
                    <span className="status-badge">{u.role_name}</span>
                  ) : (
                    <select value={u.role} onChange={(e) => setUserRole(u, e.target.value)}>
                      {options.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td data-label="Passkeys">
                  {u.passkeys}
                  {u.passkeys === 0 && u.kind === "guest" && <span className="hint"> · signs in with codes</span>}
                  {u.passkeys === 0 && u.kind !== "guest" && (
                    <span className="hint">
                      {" "}
                      {u.invite_expires_at ? `· invite pending until ${u.invite_expires_at}` : "· no invite"}
                    </span>
                  )}
                </td>
                <td data-label="Remote">
                  {u.kind === "guest" ? (
                    <span className="hint">no passkey</span>
                  ) : (
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={u.remote_access}
                        disabled={locked}
                        onChange={(e) => setRemoteAccess(u, e.target.checked)}
                      />{" "}
                      {u.remote_access ? "allowed" : "local only"}
                    </label>
                  )}
                </td>
                <td data-label="Groups">
                  {u.groups.length === 0
                    ? "—"
                    : u.groups.map((g, i) => (
                        <span key={g.group_id}>
                          {i > 0 && ", "}
                          <Link to={`/groups/${g.group_id}`}>{g.path}</Link>
                          {g.role !== "member" ? ` (${roleName(roles, g.role).toLowerCase()})` : ""}
                          {g.status === "pending" ? " (pending)" : ""}
                        </span>
                      ))}
                </td>
                <td data-label="Limits">
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
                <td data-label="Last login">{u.last_login ?? "—"}</td>
                <td data-label="G-code incidents">
                  {u.gcode_incidents > 0 ? (
                    <button className="btn-sm" onClick={() => setIncidentsOf({ id: u.id, username: u.username })}>
                      {u.gcode_incidents}
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="cell-actions">
                  {suspending?.id === u.id ? (
                    <form
                      className="inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        setSuspended(u, true, suspending.reason);
                      }}
                    >
                      <input
                        type="text"
                        placeholder="Why (shown to admins)"
                        value={suspending.reason}
                        maxLength={500}
                        autoFocus
                        onChange={(e) => setSuspending({ id: u.id, reason: e.target.value })}
                      />{" "}
                      <button className="btn-sm btn-danger" type="submit">
                        Suspend
                      </button>{" "}
                      <button className="btn-sm" type="button" onClick={() => setSuspending(null)}>
                        Cancel
                      </button>
                    </form>
                  ) : (
                    !locked && (
                      <>
                        <button className="btn-sm" onClick={() => reissue(u)}>
                          New invite link
                        </button>{" "}
                        {u.role !== "owner" && u.id !== me?.id && (
                          <>
                            {u.suspended_at ? (
                              <button className="btn-sm" onClick={() => setSuspended(u, false)}>
                                Reinstate
                              </button>
                            ) : (
                              <button className="btn-sm" onClick={() => setSuspending({ id: u.id, reason: "" })}>
                                Suspend
                              </button>
                            )}{" "}
                            <button className="btn-sm btn-danger" onClick={() => remove(u)}>
                              Delete
                            </button>
                          </>
                        )}
                      </>
                    )
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <GcodeIncidents user={incidentsOf} onClear={() => setIncidentsOf(null)} rev={rev} />

      {manages && (
        <>
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
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {assignable.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
          Remote access (the invite link and passkey sign-in work from the internet)
        </label>
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create account and invite link"}
        </button>
      </form>
        </>
      )}
      {error && <p className="login-error">{error}</p>}
    </div>
  );
}
