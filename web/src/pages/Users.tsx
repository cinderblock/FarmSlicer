import { useCallback, useEffect, useState } from "react";
import { apiJson, useAuth } from "../auth";
import type { User } from "../auth";

/** Admin page: accounts. Admins cannot touch the owner; nobody can delete it. */
export default function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [busy, setBusy] = useState(false);

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
      await apiJson("/api/users", "POST", { username, password, role });
      setUsername("");
      setPassword("");
      setRole("user");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const setUserRole = async (u: User, newRole: string) => {
    setError("");
    try {
      await apiJson(`/api/users/${u.id}`, "PUT", { role: newRole });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const resetPassword = async (u: User) => {
    const pw = window.prompt(`New password for ${u.username} (at least 8 characters):`);
    if (!pw) return;
    setError("");
    try {
      await apiJson(`/api/users/${u.id}`, "PUT", { password: pw });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (u: User) => {
    if (!window.confirm(`Delete account "${u.username}"? Their API keys stop working.`)) return;
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
        Owner: the first account, fixed. Admins manage users and printers. Users slice and
        manage their own API keys.
      </p>

      <table className="data-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Created</th>
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
                    <select
                      value={u.role}
                      onChange={(e) => setUserRole(u, e.target.value)}
                      disabled={locked}
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                  )}
                </td>
                <td>{u.created_at}</td>
                <td>{u.last_login ?? "—"}</td>
                <td>
                  <button className="btn-sm" onClick={() => resetPassword(u)} disabled={locked}>
                    Reset password
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
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
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
          {busy ? "Adding…" : "Add user"}
        </button>
      </form>
      {error && <p className="login-error">{error}</p>}
    </div>
  );
}
