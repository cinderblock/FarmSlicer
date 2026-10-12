import { useCallback, useEffect, useState } from "react";
import { apiJson, useAuth } from "../auth";
import type { User } from "../auth";

interface AdminUser extends User {
  passkeys: number;
  invite_expires_at: string | null;
}

/** Admin page: accounts and invite links. Admins cannot touch the owner; nobody can delete it. */
export default function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [busy, setBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState<{ username: string; url: string; expires: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/users");
    if (res.ok) setUsers(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
        printers. Users slice and manage their own passkeys and API keys.
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
            <th>Last login</th>
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
                  {u.passkeys === 0 && (
                    <span className="hint">
                      {" "}
                      {u.invite_expires_at ? `· invite pending until ${u.invite_expires_at}` : "· no invite"}
                    </span>
                  )}
                </td>
                <td>{u.last_login ?? "—"}</td>
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
