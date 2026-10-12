import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useAuth } from "../auth";
import RecoveryCode from "../components/RecoveryCode";
import { browserSupportsWebAuthn, defaultKeyName, registerPasskey } from "../passkeys";

interface InviteInfo {
  username: string;
  role: string;
  expires_at: string;
  has_passkeys: boolean;
}

/** /invite/:token — enrol a passkey for an account an admin created. */
export default function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [info, setInfo] = useState<InviteInfo | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/auth/invite/${encodeURIComponent(token)}`)
      .then(async (r) => (r.ok ? ((await r.json()) as InviteInfo) : null))
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [token]);

  const enrol = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await registerPasskey<{ recovery_code: string }>(
        `/api/auth/invite/${encodeURIComponent(token)}/start`,
        {},
        `/api/auth/invite/${encodeURIComponent(token)}/finish`,
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
        {info === undefined && <p className="hint">Checking your invite…</p>}
        {info === null && (
          <p className="login-error">This invite link is invalid, already used, or expired.</p>
        )}
        {info && recoveryCode && (
          <>
            <p>Your passkey is registered. You're signed in as {info.username}.</p>
            <RecoveryCode code={recoveryCode} onDone={finish} />
          </>
        )}
        {info && !recoveryCode && (
          <>
            <p>
              You've been invited as <strong>{info.username}</strong> ({info.role}).
              {info.has_passkeys
                ? " This link enrols an additional passkey for the account."
                : " Create a passkey to finish setting up the account."}
            </p>
            <p className="hint">Link valid until {info.expires_at} UTC.</p>
            {!browserSupportsWebAuthn() && (
              <p className="login-error">This browser does not support passkeys.</p>
            )}
            <button
              className="btn-primary"
              onClick={enrol}
              disabled={busy || !browserSupportsWebAuthn()}
            >
              {busy ? "Waiting for your passkey…" : "Create my passkey"}
            </button>
            {error && <p className="login-error">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
