import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { apiJson, useAuth } from "../auth";
import { errorText } from "../api";
import RecoveryCode from "../components/RecoveryCode";
import { browserSupportsWebAuthn, defaultKeyName, registerPasskey, signInWithPasskey } from "../passkeys";
import SourceFooter from "../components/SourceFooter";

interface Step {
  group?: string;
  key?: string;
}

interface Resolved {
  entry: { id: string; name: string; description: string; link_label: string | null };
  walked: { id: string; name: string }[];
  target: {
    exists: boolean;
    id?: string;
    name: string;
    path: string;
    description?: string;
    membership?: { role: string; status: string } | null;
  };
  next: {
    mode: "choose" | "self_service";
    required: boolean;
    label: string;
    pattern: string;
    options: { id: string; name: string; description: string }[];
  } | null;
  can_finish: boolean;
  outcome: { status: "active" | "pending"; role: "member" | "manager" };
  allow_registration: boolean;
  allow_guests: boolean;
  signed_in: { username: string; kind: string } | null;
}

interface Joined {
  group_id: string;
  group_name: string;
  created: boolean;
  status: "active" | "pending";
  role: string;
}

/**
 * /join/:code (a join link) and /join/group/:id (a group offered on the
 * sign-in page): walk down into subgroups if the group asks for it, then join
 * as yourself, a new passkey account, or a guest.
 */
export default function JoinPage() {
  const { code, id } = useParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const entry = useMemo(() => (code ? { code } : { group: id }), [code, id]);
  const [selection, setSelection] = useState<Step[]>([]);
  const [rev, setRev] = useState(0);
  const [resolved, setResolved] = useState<{ data?: Resolved; error?: string; for: string }>({ for: "" });
  const [keyInput, setKeyInput] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [goDeeper, setGoDeeper] = useState(false);
  const [done, setDone] = useState<{ joined: Joined; code?: string; codeKind?: "recovery" | "signin" } | null>(null);

  const requestKey = JSON.stringify({ entry, selection, rev });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/join/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry, selection }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (cancelled) return;
        if (r.ok) setResolved({ data: body as Resolved, for: requestKey });
        else setResolved({ error: body?.error ?? `HTTP ${r.status}`, for: requestKey });
      })
      .catch((err) => !cancelled && setResolved({ error: String(err), for: requestKey }));
    return () => {
      cancelled = true;
    };
  }, [entry, selection, rev, requestKey]);

  const r = resolved.data;
  const request = { entry, selection };

  const pushStep = async (step: Step) => {
    setError("");
    const candidate = [...selection, step];
    try {
      // Check before moving on so a bad identifier shows its error here.
      await apiJson("/api/join/resolve", "POST", { entry, selection: candidate });
      setSelection(candidate);
      setKeyInput("");
      setGoDeeper(false);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const run = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const joinSignedIn = () =>
    run(async () => {
      const joined = await apiJson<Joined>("/api/join/finish", "POST", request);
      await refresh();
      setDone({ joined });
    });

  const signIn = () =>
    run(async () => {
      await signInWithPasskey();
      await refresh();
      setRev((n) => n + 1);
    });

  const register = () =>
    run(async () => {
      const res = await registerPasskey<{ recovery_code: string; joined: Joined }>(
        "/api/join/register/start",
        { request, username },
        "/api/join/register/finish",
        defaultKeyName(),
      );
      setDone({ joined: res.joined, code: res.recovery_code, codeKind: "recovery" });
    });

  const guest = () =>
    run(async () => {
      const res = await apiJson<{ signin_code: string; joined: Joined }>("/api/join/guest", "POST", {
        request,
        username,
      });
      setDone({ joined: res.joined, code: res.signin_code, codeKind: "signin" });
    });

  const goToGroup = async () => {
    await refresh();
    navigate(done ? `/groups/${done.joined.group_id}` : "/", { replace: true });
  };

  // ---- rendering ----

  if (done) {
    const { joined } = done;
    return (
      <JoinCard>
        <p>
          {joined.created ? "Created and joined " : "Joined "}
          <strong>{joined.group_name}</strong>
          {joined.role === "manager" ? " as its manager" : ""}.
        </p>
        {joined.status === "pending" && (
          <p className="hint">A manager of the group has to approve you before you can see its library.</p>
        )}
        {done.code && done.codeKind === "signin" && (
          <RecoveryCode
            code={done.code}
            onDone={goToGroup}
            title="Save your sign-in code."
            intro="Guest accounts have no passkey. This browser stays signed in; to sign in anywhere else, use your username and this code (each code works once, and you get a new one each time). You can add a passkey later on your Account page."
          />
        )}
        {done.code && done.codeKind === "recovery" && <RecoveryCode code={done.code} onDone={goToGroup} />}
        {!done.code && (
          <button className="btn-primary" onClick={goToGroup}>
            Go to {joined.group_name}
          </button>
        )}
      </JoinCard>
    );
  }

  if (resolved.error && !r) {
    return (
      <JoinCard>
        <p className="login-error">{resolved.error}</p>
        <p className="hint">
          <Link to="/">Back to FarmSlicer</Link>
        </p>
      </JoinCard>
    );
  }
  if (!r) return <JoinCard><p className="hint">Loading…</p></JoinCard>;

  const steps = r.walked.slice(1);
  const askNext = r.next && (r.next.required || goDeeper);
  const already = r.target.membership;

  return (
    <JoinCard>
      <h2 className="join-title">Join {r.entry.name}</h2>
      {r.entry.description && <p className="hint">{r.entry.description}</p>}

      {(steps.length > 0 || !r.target.exists) && (
        <p className="join-path">
          {[r.entry.name, ...steps.map((s) => s.name), ...(r.target.exists ? [] : [r.target.name])].join(" › ")}{" "}
          <button className="link-button" onClick={() => setSelection(selection.slice(0, -1))}>
            back
          </button>
        </p>
      )}

      {askNext && r.next?.mode === "choose" && (
        <div className="join-step">
          <p>{r.next.label ? `Choose your ${r.next.label.toLowerCase()}:` : "Choose one:"}</p>
          <div className="join-options">
            {r.next.options.map((o) => (
              <button key={o.id} className="btn-sm join-option" onClick={() => pushStep({ group: o.id })}>
                <strong>{o.name}</strong>
                {o.description && <span className="hint"> {o.description}</span>}
              </button>
            ))}
            {r.next.options.length === 0 && <p className="hint">Nothing to choose from yet.</p>}
          </div>
        </div>
      )}
      {askNext && r.next?.mode === "self_service" && (
        <form
          className="join-step"
          onSubmit={(e) => {
            e.preventDefault();
            pushStep({ key: keyInput });
          }}
        >
          <label>
            {r.next.label || "Identifier"}
            <input value={keyInput} onChange={(e) => setKeyInput(e.target.value)} autoFocus required />
          </label>
          <button className="btn-primary" type="submit">
            Continue
          </button>
        </form>
      )}
      {r.next && !r.next.required && !goDeeper && (
        <p className="hint">
          <button className="link-button" onClick={() => setGoDeeper(true)}>
            Join a {r.next.label ? r.next.label.toLowerCase() : "subgroup"} of {r.target.name} instead
          </button>
        </p>
      )}

      {r.can_finish && !askNext && (
        <div className="join-finish">
          <p>
            {r.target.exists ? (
              <>
                You're joining <strong>{r.target.name}</strong>
              </>
            ) : (
              <>
                <strong>{r.target.name}</strong> doesn't exist yet; it will be created
                {r.outcome.role === "manager" ? " with you as its manager" : ""}
              </>
            )}
            .
          </p>
          {r.target.description && <p className="hint">{r.target.description}</p>}
          {already ? (
            <p className="hint">
              You're already {already.status === "pending" ? "waiting for approval in" : `a ${already.role} of`} this group.{" "}
              <Link to={`/groups/${r.target.id}`}>Open it</Link>
            </p>
          ) : (
            r.outcome.status === "pending" && (
              <p className="hint">A manager of the group approves new members before they can see its library.</p>
            )
          )}

          {r.signed_in && !already && (
            <button className="btn-primary" onClick={joinSignedIn} disabled={busy}>
              Join as {r.signed_in.username}
            </button>
          )}

          {!r.signed_in && (
            <>
              {(r.allow_registration || r.allow_guests) && (
                <label>
                  Pick a username
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    placeholder="2-32 letters, digits, . _ -"
                  />
                </label>
              )}
              {r.allow_registration && (
                <button
                  className="btn-primary"
                  onClick={register}
                  disabled={busy || !username.trim() || !browserSupportsWebAuthn()}
                >
                  {busy ? "Working…" : "Create an account with a passkey"}
                </button>
              )}
              {r.allow_guests && (
                <>
                  <button className="btn-sm join-guest" onClick={guest} disabled={busy || !username.trim()}>
                    Continue as a guest (no passkey)
                  </button>
                  <p className="hint">
                    Guests can slice and see their groups' libraries, but can't create API keys or change printers and
                    profiles.
                  </p>
                </>
              )}
              <p className="hint">
                Already have an account?{" "}
                <button className="link-button" onClick={signIn} disabled={busy}>
                  Sign in with your passkey
                </button>{" "}
                (guests: <Link to="/">sign in with your code</Link>, then open this link again).
              </p>
              {!r.allow_registration && !r.allow_guests && (
                <p className="hint">This group doesn't take new accounts; sign in first.</p>
              )}
            </>
          )}
        </div>
      )}
      {error && <p className="login-error">{error}</p>}
    </JoinCard>
  );
}

function JoinCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="login-page">
      <div className="login-card join-card">
        <h1>FarmSlicer</h1>
        {children}
      </div>
      <SourceFooter />
    </div>
  );
}
