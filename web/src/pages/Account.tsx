import { useCallback, useEffect, useState } from "react";
import { apiJson, useAuth } from "../auth";
import RecoveryCode from "../components/RecoveryCode";
import { browserSupportsWebAuthn, defaultKeyName, registerPasskey } from "../passkeys";

interface PasskeyInfo {
  id: string;
  name: string;
  created_at: string;
  last_used: string | null;
}

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used: string | null;
}

/** The signed-in user's own settings: passkeys, recovery code, API keys. */
export default function AccountPage() {
  const { user } = useAuth();
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [passkeyError, setPasskeyError] = useState("");
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [apiKeyName, setApiKeyName] = useState("");
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [apiKeyError, setApiKeyError] = useState("");

  const load = useCallback(async () => {
    const [p, k] = await Promise.all([fetch("/api/me/passkeys"), fetch("/api/me/api-keys")]);
    if (p.ok) setPasskeys(await p.json());
    if (k.ok) setKeys(await k.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const addPasskey = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasskeyError("");
    setPasskeyBusy(true);
    try {
      await registerPasskey("/api/me/passkeys/start", {}, "/api/me/passkeys/finish", newKeyName || defaultKeyName());
      setNewKeyName("");
      await load();
    } catch (err) {
      setPasskeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasskeyBusy(false);
    }
  };

  const renamePasskey = async (k: PasskeyInfo) => {
    const name = window.prompt("New name for this passkey:", k.name);
    if (!name || name === k.name) return;
    await apiJson(`/api/me/passkeys/${k.id}`, "PUT", { name });
    await load();
  };

  const removePasskey = async (k: PasskeyInfo) => {
    if (!window.confirm(`Remove passkey "${k.name}"? Make sure you can still sign in another way.`)) return;
    setPasskeyError("");
    try {
      await apiJson(`/api/me/passkeys/${k.id}`, "DELETE");
      await load();
    } catch (err) {
      setPasskeyError(err instanceof Error ? err.message : String(err));
    }
  };

  const regenerateRecovery = async () => {
    if (!window.confirm("Generate a new recovery code? The previous one stops working.")) return;
    const res = await apiJson<{ recovery_code: string }>("/api/me/recovery-code", "POST");
    setRecoveryCode(res.recovery_code);
  };

  const createApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setApiKeyError("");
    try {
      const data = await apiJson<{ key: string }>("/api/me/api-keys", "POST", { name: apiKeyName });
      setNewApiKey(data.key);
      setApiKeyName("");
      await load();
    } catch (err) {
      setApiKeyError(err instanceof Error ? err.message : String(err));
    }
  };

  const revokeApiKey = async (k: ApiKey) => {
    if (!window.confirm(`Revoke API key "${k.name}"?`)) return;
    await apiJson(`/api/me/api-keys/${k.id}`, "DELETE");
    await load();
  };

  return (
    <div className="page">
      <h2>Account</h2>
      <p>
        Signed in as <strong>{user?.username}</strong> ({user?.role}).
      </p>

      <h3>Passkeys</h3>
      <p className="hint">
        Each device or password manager you sign in from gets its own passkey. Keep at least
        one, or a saved recovery code, or an admin will have to send you a new invite link.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Created</th>
            <th>Last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {passkeys.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td>{k.created_at}</td>
              <td>{k.last_used ?? "never"}</td>
              <td>
                <button className="btn-sm" onClick={() => renamePasskey(k)}>
                  Rename
                </button>{" "}
                <button
                  className="btn-sm btn-danger"
                  onClick={() => removePasskey(k)}
                  disabled={passkeys.length <= 1}
                  title={passkeys.length <= 1 ? "Add another passkey before removing this one" : undefined}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="printer-form" onSubmit={addPasskey}>
        <label>
          New passkey name
          <input
            type="text"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder={defaultKeyName()}
          />
        </label>
        <button className="btn-primary" type="submit" disabled={passkeyBusy || !browserSupportsWebAuthn()}>
          {passkeyBusy ? "Waiting for your passkey…" : "Add a passkey on this device"}
        </button>
        {passkeyError && <p className="login-error">{passkeyError}</p>}
      </form>

      <h3>Recovery code</h3>
      {recoveryCode ? (
        <RecoveryCode
          code={recoveryCode}
          onDone={() => setRecoveryCode(null)}
          intro="This replaces your previous code. It lets you enrol a new passkey if you lose all of them."
        />
      ) : (
        <p>
          <button className="btn-sm" onClick={regenerateRecovery}>
            Generate a new recovery code
          </button>{" "}
          <span className="hint">(invalidates the old one; shown once)</span>
        </p>
      )}

      <h3>API keys</h3>
      <p className="hint">
        For scripts and other machines: send <code>Authorization: Bearer fsk_…</code> with any
        API request. A key has the same permissions as your account. The key is shown once.
      </p>
      {newApiKey && (
        <div className="card api-key-reveal">
          <p>
            <strong>New key, copy it now:</strong>
          </p>
          <code className="api-key-value">{newApiKey}</code>
          <p>
            <button className="btn-sm" onClick={() => setNewApiKey(null)}>
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
                <button className="btn-sm btn-danger" onClick={() => revokeApiKey(k)}>
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="printer-form" onSubmit={createApiKey}>
        <label>
          New key name
          <input
            type="text"
            value={apiKeyName}
            onChange={(e) => setApiKeyName(e.target.value)}
            placeholder="e.g. print-farm-script"
            required
          />
        </label>
        <button className="btn-primary" type="submit">
          Create API key
        </button>
        {apiKeyError && <p className="login-error">{apiKeyError}</p>}
      </form>
    </div>
  );
}
