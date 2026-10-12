import { useCallback, useEffect, useState } from "react";
import { apiJson, useAuth } from "../auth";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used: string | null;
}

/** The signed-in user's own settings: password and API keys. */
export default function AccountPage() {
  const { user } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [keyName, setKeyName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwMessage, setPwMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [keyError, setKeyError] = useState("");

  const loadKeys = useCallback(async () => {
    const res = await fetch("/api/me/api-keys");
    if (res.ok) setKeys(await res.json());
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMessage(null);
    if (newPassword !== confirm) {
      setPwMessage({ ok: false, text: "New passwords do not match" });
      return;
    }
    try {
      await apiJson("/api/me/password", "POST", {
        current_password: currentPassword,
        new_password: newPassword,
      });
      setPwMessage({ ok: true, text: "Password changed" });
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
    } catch (err) {
      setPwMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const createKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setKeyError("");
    try {
      const data = await apiJson<{ key: string }>("/api/me/api-keys", "POST", { name: keyName });
      setNewKey(data.key);
      setKeyName("");
      await loadKeys();
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    }
  };

  const revoke = async (k: ApiKey) => {
    if (!window.confirm(`Revoke API key "${k.name}"?`)) return;
    await apiJson(`/api/me/api-keys/${k.id}`, "DELETE");
    await loadKeys();
  };

  return (
    <div className="page">
      <h2>Account</h2>
      <p>
        Signed in as <strong>{user?.username}</strong> ({user?.role}).
      </p>

      <h3>Change password</h3>
      <form className="printer-form" onSubmit={changePassword}>
        <label>
          Current password
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          New password
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <button className="btn-primary" type="submit">
          Change password
        </button>
        {pwMessage && (
          <p className="hint" style={{ color: pwMessage.ok ? "var(--success)" : "var(--error)" }}>
            {pwMessage.text}
          </p>
        )}
      </form>

      <h3>API keys</h3>
      <p className="hint">
        For scripts and other machines: send <code>Authorization: Bearer fsk_…</code> with any
        API request. A key has the same permissions as your account. The key is shown once.
      </p>
      {newKey && (
        <div className="card api-key-reveal">
          <p>
            <strong>New key, copy it now:</strong>
          </p>
          <code className="api-key-value">{newKey}</code>
          <p>
            <button className="btn-sm" onClick={() => setNewKey(null)}>
              I have copied it
            </button>
          </p>
        </div>
      )}
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Created</th>
            <th>Last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {keys.length === 0 && (
            <tr>
              <td colSpan={5} className="hint">
                No API keys yet.
              </td>
            </tr>
          )}
          {keys.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td>
                <code>{k.prefix}</code>
              </td>
              <td>{k.created_at}</td>
              <td>{k.last_used ?? "never"}</td>
              <td>
                <button className="btn-sm btn-danger" onClick={() => revoke(k)}>
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="printer-form" onSubmit={createKey}>
        <label>
          New key name
          <input
            type="text"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="e.g. print-farm-script"
            required
          />
        </label>
        <button className="btn-primary" type="submit">
          Create API key
        </button>
        {keyError && <p className="login-error">{keyError}</p>}
      </form>
    </div>
  );
}
