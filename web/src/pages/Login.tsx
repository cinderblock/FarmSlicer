import { useState } from "react";
import { Link } from "react-router";
import { apiJson, useAuth } from "../auth";
import RecoveryCode from "../components/RecoveryCode";
import { browserSupportsWebAuthn, signInWithPasskey } from "../passkeys";

export default function LoginPage() {
  const { refresh, status, logout } = useAuth();
  // From the internet only passkey sign-in works (approved accounts).
  const remote = status?.remote ?? false;
  const [username, setUsername] = useState("");
  const [showUsername, setShowUsername] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showGuest, setShowGuest] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [guestCode, setGuestCode] = useState("");
  // The next one-time code, shown before entering the app.
  const [nextCode, setNextCode] = useState<string | null>(null);

  const guestSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await apiJson<{ signin_code: string }>("/api/auth/guest/signin", "POST", {
        username: guestName,
        code: guestCode,
      });
      setNextCode(res.signin_code);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (nextCode) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>FarmSlicer</h1>
          <RecoveryCode
            code={nextCode}
            onDone={() => refresh()}
            title="Your next sign-in code."
            intro="The code you used is spent. Use this one next time you sign in on another device."
          />
        </div>
      </div>
    );
  }

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
        {remote && (
          <p className="hint">
            You're outside the local network. Only accounts approved for remote access can sign in
            from here, with their passkey.
          </p>
        )}
        {status?.remote_refused && (
          <p className="login-error">
            Signed in, but {status.remote_refused}.{" "}
            <button className="link-button" onClick={() => logout()}>
              Sign out
            </button>
          </p>
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

        {remote ? null : showGuest ? (
          <form onSubmit={guestSignIn}>
            <label>
              Guest username
              <input type="text" value={guestName} onChange={(e) => setGuestName(e.target.value)} autoComplete="username" required />
            </label>
            <label>
              Sign-in code
              <input type="text" value={guestCode} onChange={(e) => setGuestCode(e.target.value)} autoComplete="off" required />
            </label>
            <button className="btn-sm" type="submit" disabled={busy}>
              Sign in as a guest
            </button>
          </form>
        ) : (
          <p className="hint">
            <button className="link-button" onClick={() => setShowGuest(true)}>
              Guest account? Sign in with your code
            </button>
          </p>
        )}

        {error && <p className="login-error">{error}</p>}
        <p className="hint">
          Lost every passkey?{" "}
          {remote ? (
            "Recover with your recovery code on the local network, or ask an admin for a new invite link."
          ) : (
            <>
              <Link to="/recover">Recover with your recovery code</Link>.
            </>
          )}
        </p>
        {(status?.join_groups ?? []).length > 0 && (
          <div className="login-join">
            <p className="hint">New here?</p>
            {status?.join_groups.map((g) => (
              <Link key={g.id} className="btn-sm join-option" to={`/join/group/${g.id}`}>
                Join {g.name}
                {g.description && <span className="hint"> · {g.description}</span>}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
