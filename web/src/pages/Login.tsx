import { useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../auth";
import { browserSupportsWebAuthn, signInWithPasskey } from "../passkeys";

export default function LoginPage() {
  const { refresh } = useAuth();
  const [username, setUsername] = useState("");
  const [showUsername, setShowUsername] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const signIn = async (name?: string) => {
    setError("");
    setBusy(true);
    try {
      await signInWithPasskey(name);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>FarmSlicer</h1>
        {!browserSupportsWebAuthn() && (
          <p className="login-error">This browser does not support passkeys.</p>
        )}
        <button
          className="btn-primary"
          onClick={() => signIn()}
          disabled={busy || !browserSupportsWebAuthn()}
        >
          {busy ? "Waiting for your passkey…" : "Sign in with a passkey"}
        </button>

        {showUsername ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              signIn(username);
            }}
          >
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
            <button className="btn-sm" type="submit" disabled={busy}>
              Use this account's passkey
            </button>
          </form>
        ) : (
          <p className="hint">
            <button className="link-button" onClick={() => setShowUsername(true)}>
              Sign in with a username instead
            </button>
          </p>
        )}

        {error && <p className="login-error">{error}</p>}
        <p className="hint">
          Lost every passkey? <Link to="/recover">Recover with your recovery code</Link>.
        </p>
      </div>
    </div>
  );
}
