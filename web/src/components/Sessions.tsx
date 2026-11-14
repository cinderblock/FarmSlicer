// Signed-in devices (src/sessions_api.rs): your own on the Account page,
// and a person's sessions, passkeys and API keys on the Users page.
import { useState } from "react";
import { apiJson } from "../auth";
import { errorText, localDateTime, useJson } from "../api";

interface Session {
  id: string;
  method: string | null;
  created_at: string;
  last_seen: string | null;
  device: string | null;
  current: boolean;
}

interface Credential {
  id: string;
  name: string;
  created_at: string;
  last_used: string | null;
  prefix?: string;
  integration?: boolean;
}

interface Access {
  sessions: Session[];
  passkeys: Credential[];
  api_keys: Credential[];
}

function SessionList({ sessions, onEnd }: { sessions: Session[]; onEnd: (s: Session) => void }) {
  if (sessions.length === 0) return <p className="hint">Not signed in anywhere.</p>;
  return (
    <ul className="share-list">
      {sessions.map((s) => (
        <li key={s.id}>
          <span>
            <strong>{s.device ?? "Unknown device"}</strong>
            {s.current && <span className="status-badge status-done"> this one</span>}
            <span className="hint">
              {" "}
              · signed in {localDateTime(s.created_at)}
              {s.method ? ` with ${s.method.replace("_", " ")}` : ""}
              {s.last_seen ? ` · last used ${localDateTime(s.last_seen)}` : ""}
            </span>
          </span>
          {!s.current && (
            <button className="btn-sm" onClick={() => onEnd(s)}>
              Sign out
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The Account page's devices. */
export function MySessions() {
  const [rev, setRev] = useState(0);
  const sessions = useJson<Session[]>("/api/me/sessions", rev).data;
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      setRev((r) => r + 1);
    } catch (err) {
      setError(errorText(err));
    }
  };
  if (!sessions) return null;
  return (
    <>
      <h3>Signed-in devices</h3>
      <SessionList sessions={sessions} onEnd={(s) => run(() => apiJson(`/api/me/sessions/${s.id}`, "DELETE"))} />
      {sessions.some((s) => !s.current) && (
        <button className="btn-sm" onClick={() => run(() => apiJson("/api/me/sessions/sign-out-others", "POST"))}>
          Sign out everywhere else
        </button>
      )}
      {error && <p className="login-error">{error}</p>}
    </>
  );
}

/** A person's sessions, passkeys and API keys, for those who manage accounts. */
export function UserAccess({ userId, username, onClose }: { userId: string; username: string; onClose: () => void }) {
  const [rev, setRev] = useState(0);
  const data = useJson<Access>(`/api/users/${userId}/access`, rev);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      setRev((r) => r + 1);
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <div className="card user-access">
      <div className="role-card-head">
        <strong>{username}: devices and keys</strong>
        <span className="role-card-actions">
          <button className="btn-sm btn-ghost" onClick={onClose}>
            Close
          </button>
        </span>
      </div>
      {data.error && <p className="login-error">{data.error}</p>}
      {data.data && (
        <>
          <h4>Signed in</h4>
          <SessionList
            sessions={data.data.sessions}
            onEnd={(s) => run(() => apiJson(`/api/users/${userId}/sessions/${s.id}`, "DELETE"))}
          />
          {data.data.sessions.some((s) => !s.current) && (
            <button
              className="btn-sm btn-danger"
              onClick={() => {
                if (window.confirm(`Sign ${username} out everywhere?`))
                  run(() => apiJson(`/api/users/${userId}/sessions`, "DELETE"));
              }}
            >
              Sign out everywhere
            </button>
          )}
          <h4>Passkeys</h4>
          {data.data.passkeys.length === 0 ? (
            <p className="hint">None.</p>
          ) : (
            <ul className="share-list">
              {data.data.passkeys.map((k) => (
                <li key={k.id}>
                  <span>
                    <strong>{k.name}</strong>
                    <span className="hint">
                      {" "}
                      · added {localDateTime(k.created_at)}
                      {k.last_used ? ` · last used ${localDateTime(k.last_used)}` : ""}
                    </span>
                  </span>
                  <button
                    className="btn-sm btn-danger"
                    onClick={() => {
                      const last = data.data!.passkeys.length === 1;
                      const msg = last
                        ? `Remove ${username}'s only passkey? They can't sign in again until you give them a new invite link.`
                        : `Remove the passkey "${k.name}"? (A lost device, say.)`;
                      if (window.confirm(msg)) run(() => apiJson(`/api/users/${userId}/passkeys/${k.id}`, "DELETE"));
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h4>API keys</h4>
          {data.data.api_keys.length === 0 ? (
            <p className="hint">None.</p>
          ) : (
            <ul className="share-list">
              {data.data.api_keys.map((k) => (
                <li key={k.id}>
                  <span>
                    <strong>{k.name}</strong> <code>{k.prefix}…</code>
                    {k.integration && <span className="status-badge"> integration</span>}
                    <span className="hint">
                      {" "}
                      · made {localDateTime(k.created_at)}
                      {k.last_used ? ` · last used ${localDateTime(k.last_used)}` : " · never used"}
                    </span>
                  </span>
                  <button
                    className="btn-sm btn-danger"
                    onClick={() => {
                      if (window.confirm(`Revoke the API key "${k.name}"? Whatever uses it stops working.`))
                        run(() => apiJson(`/api/users/${userId}/api-keys/${k.id}`, "DELETE"));
                    }}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && <p className="login-error">{error}</p>}
    </div>
  );
}
