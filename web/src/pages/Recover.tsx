import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../auth";
import RecoveryCode from "../components/RecoveryCode";
import { browserSupportsWebAuthn, defaultKeyName, registerPasskey } from "../passkeys";

/** /recover — lost every passkey: enrol a new one with the recovery code. */
export default function RecoverPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await registerPasskey<{ recovery_code: string }>(
        "/api/auth/recover/start",
        { username, code },
        "/api/auth/recover/finish",
        defaultKeyName(),
      );
      setRecoveryCode(res.recovery_code);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    await refresh();
    navigate("/", { replace: true });
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>FarmSlicer</h1>
        {recoveryCode ? (
          <>
            <p>A new passkey is registered and you're signed in. The old recovery code is spent.</p>
            <RecoveryCode code={recoveryCode} onDone={finish} />
          </>
        ) : (
          <>
            <p className="hint">
              Enter your username and the recovery code you saved when you enrolled. Your
              device will then create a new passkey.
            </p>
            <form onSubmit={submit}>
              <label>
                Username
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
                  required
                />
              </label>
              <label>
                Recovery code
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
                  autoComplete="off"
                  required
                />
              </label>
              <button
                className="btn-primary"
                type="submit"
                disabled={busy || !browserSupportsWebAuthn()}
              >
                {busy ? "Waiting for your passkey…" : "Register a new passkey"}
              </button>
              {error && <p className="login-error">{error}</p>}
            </form>
            <p className="hint">
              <Link to="/">Back to sign in</Link>. No code either? An admin can issue you a new
              invite link.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
