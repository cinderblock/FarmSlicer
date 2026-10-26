import { useState } from "react";
import { useAuth } from "../auth";
import RecoveryCode from "../components/RecoveryCode";
import SourceFooter from "../components/SourceFooter";
import { browserSupportsWebAuthn, defaultKeyName, registerPasskey } from "../passkeys";

/** First run: no accounts exist, so whoever gets here creates the owner with a passkey. */
export default function SetupPage() {
  const { refresh } = useAuth();
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await registerPasskey<{ recovery_code: string }>(
        "/api/auth/setup/start",
        { username },
        "/api/auth/setup/finish",
        defaultKeyName(),
      );
      setRecoveryCode(res.recovery_code);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (recoveryCode) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>FarmSlicer</h1>
          <p>Owner account created and your passkey is registered.</p>
          <RecoveryCode code={recoveryCode} onDone={() => refresh()} />
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>FarmSlicer</h1>
        <p className="hint">
          First run. Create the owner account. Sign-in is passkey-only: your device will
          ask you to create one (Windows Hello, Touch ID, a phone, or a security key).
        </p>
        {!browserSupportsWebAuthn() && (
          <p className="login-error">This browser does not support passkeys.</p>
        )}
        <form onSubmit={submit}>
          <label>
            Username
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username webauthn"
              autoFocus
              required
            />
          </label>
          <button className="btn-primary" type="submit" disabled={busy || !browserSupportsWebAuthn()}>
            {busy ? "Waiting for your passkey…" : "Create owner account with a passkey"}
          </button>
          {error && <p className="login-error">{error}</p>}
        </form>
      </div>
      <SourceFooter />
    </div>
  );
}
