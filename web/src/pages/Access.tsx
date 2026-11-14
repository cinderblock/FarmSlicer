// /access: who may print on which printer, and the certifications
// (training sign-offs) rules can ask for (src/access.rs, src/access_api.rs).
import { useState } from "react";
import { Link } from "react-router";
import { apiJson, useAuth } from "../auth";
import { errorText, localDate, useJson } from "../api";
import PageHeader, { EmptyState } from "../components/PageHeader";
import type { GroupSummary } from "../groups";
import type { AccessEffect } from "../printers";
import { useRoles } from "../roles";

interface Principal {
  kind: "everyone" | "user" | "group" | "role" | "certified";
  id: string;
}

interface Rule {
  id: string;
  target_kind: TargetKind;
  target_id: string;
  target_name: string | null;
  position: number;
  principal: Principal;
  who: string;
  effect: AccessEffect;
  approvers: Principal[];
  approver_names: string[];
  note: string;
}

interface Holder {
  user_id: string;
  username: string;
  granted_by: string | null;
  granted_at: string;
  expires_at: string | null;
  note: string;
  valid: boolean;
}

interface Certification {
  id: string;
  name: string;
  description: string;
  valid_days: number | null;
  holders: Holder[];
  rules: number;
}

interface Overview {
  rules: Rule[];
  certifications: Certification[];
  targets: {
    printers: { id: string; name: string; model: string }[];
    pools: { id: string; name: string }[];
    models: string[];
  };
}

type TargetKind = "printer" | "pool" | "model" | "site";

const KIND_ORDER: TargetKind[] = ["printer", "pool", "model", "site"];
const KIND_TITLE: Record<TargetKind, string> = {
  printer: "Printer",
  pool: "Pool",
  model: "Printer model",
  site: "Every printer",
};
const EFFECT_LABEL: Record<AccessEffect, string> = {
  allow: "may print",
  approve: "may ask for approval",
  deny: "may not print",
};
const EFFECT_TONE: Record<AccessEffect, string> = { allow: "status-done", approve: "status-queued", deny: "status-failed" };

export default function AccessPage() {
  const { can } = useAuth();
  const manages = can("printers.manage");
  const grants = can("certifications.grant");
  const [rev, setRev] = useState(0);
  const data = useJson<Overview>("/api/printer-access", rev);
  const [error, setError] = useState("");
  const reload = () => setRev((r) => r + 1);
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const ov = data.data;
  // Rules by target, most specific first, each target's in order.
  const groups = new Map<string, Rule[]>();
  for (const r of [...(ov?.rules ?? [])].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.target_kind) - KIND_ORDER.indexOf(b.target_kind) ||
      (a.target_name ?? "").localeCompare(b.target_name ?? "") ||
      a.position - b.position,
  )) {
    const key = `${r.target_kind}:${r.target_id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const move = (list: Rule[], i: number, by: number) => {
    const ids = list.map((r) => r.id);
    const [id] = ids.splice(i, 1);
    ids.splice(i + by, 0, id);
    act(() =>
      apiJson("/api/printer-access/order", "PUT", { target_kind: list[0].target_kind, target_id: list[0].target_id, ids }),
    );
  };

  return (
    <div className="page">
      <PageHeader title="Printer access" icon="key">
        Who may print on which printer. Rules are read from the most specific down: the printer, its pools, its model,
        then every printer; within each, top to bottom. The first rule that matches the person decides. With no
        matching rule, anyone may print. The person asking counts (for a queued plate, whoever queued it); those who
        operate every printer are exempt. A print that needs approval waits for anyone who approves prints, the
        printer's operators, or the rule's approvers; the queue's send modes never send it by themselves.
      </PageHeader>
      {error && <p className="login-error">{error}</p>}
      {data.error && <p className="login-error">{data.error}</p>}

      <h3>Rules</h3>
      {ov && groups.size === 0 && (
        <EmptyState icon="key" title="No rules: every printer is open to everyone">
          Add a rule to keep a printer, a pool or a model to some people, or to have prints there approved.
        </EmptyState>
      )}
      {[...groups.values()].map((list) => (
        <div className="card access-target" key={`${list[0].target_kind}:${list[0].target_id}`}>
          <div className="access-target-head">
            <span className="hint">{KIND_TITLE[list[0].target_kind]}</span>{" "}
            <strong>{list[0].target_kind === "site" ? "" : (list[0].target_name ?? list[0].target_id)}</strong>
          </div>
          <ol className="access-rules">
            {list.map((r, i) => (
              <li key={r.id}>
                <span>
                  <strong>{r.who}</strong>{" "}
                  <span className={`status-badge ${EFFECT_TONE[r.effect]}`}>{EFFECT_LABEL[r.effect]}</span>
                  {r.effect === "approve" && (
                    <span className="hint">
                      {" "}
                      approved by {r.approver_names.length ? `${r.approver_names.join(", ")}, ` : ""}the printer's operators
                      or anyone who approves prints
                    </span>
                  )}
                  {r.note && <span className="hint"> · {r.note}</span>}
                </span>
                {manages && (
                  <span className="access-rule-actions">
                    <button className="btn-sm btn-ghost" disabled={i === 0} onClick={() => move(list, i, -1)} title="Earlier">
                      ↑
                    </button>
                    <button
                      className="btn-sm btn-ghost"
                      disabled={i === list.length - 1}
                      onClick={() => move(list, i, 1)}
                      title="Later"
                    >
                      ↓
                    </button>
                    <button
                      className="btn-sm btn-danger"
                      onClick={() => act(() => apiJson(`/api/printer-access/rules/${r.id}`, "DELETE"))}
                    >
                      Remove
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      ))}
      {manages && ov && <RuleForm overview={ov} onSaved={reload} onError={setError} />}

      <h3>Certifications</h3>
      <p className="hint">
        Sign-offs people earn (training on a printer, say). A rule for "holders of" a certification applies only while
        theirs is valid. {grants ? "" : "Those who sign people off give them; "}
        {manages ? "" : "those who manage printers make them."}
      </p>
      {ov && ov.certifications.length === 0 && <p className="hint">None yet.</p>}
      {ov?.certifications.map((c) => (
        <CertCard key={c.id} cert={c} manages={manages} grants={grants} act={act} />
      ))}
      {manages && <CertForm onSaved={reload} onError={setError} />}
      <p className="hint">
        Everyone can see where they stand on their <Link to="/account">Account</Link> page.
      </p>
    </div>
  );
}

function RuleForm({ overview, onSaved, onError }: { overview: Overview; onSaved: () => void; onError: (e: string) => void }) {
  const roles = useRoles().data?.roles.filter((r) => r.scope === "site") ?? [];
  const groups = useJson<GroupSummary[]>("/api/groups").data ?? [];
  const [kind, setKind] = useState<TargetKind>("printer");
  const [target, setTarget] = useState("");
  const [whoKind, setWhoKind] = useState<Principal["kind"]>("everyone");
  const [whoId, setWhoId] = useState("");
  const [effect, setEffect] = useState<AccessEffect>("approve");
  const [approver, setApprover] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    onError("");
    try {
      await apiJson("/api/printer-access/rules", "POST", {
        target_kind: kind,
        target_id: kind === "site" ? "" : target,
        who: { kind: whoKind, id: whoKind === "everyone" ? "" : whoId },
        effect,
        approvers: effect === "approve" && approver.trim() ? [{ kind: "user", id: approver.trim() }] : [],
        note,
      });
      setWhoId("");
      setApprover("");
      setNote("");
      onSaved();
    } catch (err) {
      onError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const targetOptions: [string, string][] =
    kind === "printer"
      ? overview.targets.printers.map((p) => [p.id, p.name])
      : kind === "pool"
        ? overview.targets.pools.map((p) => [p.id, p.name])
        : kind === "model"
          ? overview.targets.models.map((m) => [m, m])
          : [];

  return (
    <form className="card access-form" onSubmit={save}>
      <h4>Add a rule</h4>
      <div className="access-form-row">
        <label>
          For
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as TargetKind);
              setTarget("");
            }}
          >
            {KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {KIND_TITLE[k]}
              </option>
            ))}
          </select>
        </label>
        {kind !== "site" && (
          <label>
            {KIND_TITLE[kind]}
            <select value={target} onChange={(e) => setTarget(e.target.value)} required>
              <option value="">Choose…</option>
              {targetOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="access-form-row">
        <label>
          Who
          <select
            value={whoKind}
            onChange={(e) => {
              setWhoKind(e.target.value as Principal["kind"]);
              setWhoId("");
            }}
          >
            <option value="everyone">Everyone</option>
            <option value="user">A person</option>
            <option value="group">Members of a group</option>
            <option value="role">Accounts with a role</option>
            <option value="certified">Holders of a certification</option>
          </select>
        </label>
        {whoKind === "user" && (
          <label>
            Username
            <input value={whoId} onChange={(e) => setWhoId(e.target.value)} required autoComplete="off" />
          </label>
        )}
        {whoKind === "group" && (
          <label>
            Group (with its subgroups)
            <select value={whoId} onChange={(e) => setWhoId(e.target.value)} required>
              <option value="">Choose…</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.path}
                </option>
              ))}
            </select>
          </label>
        )}
        {whoKind === "role" && (
          <label>
            Site role
            <select value={whoId} onChange={(e) => setWhoId(e.target.value)} required>
              <option value="">Choose…</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {whoKind === "certified" && (
          <label>
            Certification
            <select value={whoId} onChange={(e) => setWhoId(e.target.value)} required>
              <option value="">Choose…</option>
              {overview.certifications.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          May
          <select value={effect} onChange={(e) => setEffect(e.target.value as AccessEffect)}>
            <option value="allow">print</option>
            <option value="approve">ask for approval</option>
            <option value="deny">not print</option>
          </select>
        </label>
      </div>
      <div className="access-form-row">
        {effect === "approve" && (
          <label>
            Also approved by (username, optional)
            <input value={approver} onChange={(e) => setApprover(e.target.value)} autoComplete="off" />
          </label>
        )}
        <label>
          Note (shown to people it stops)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </label>
      </div>
      <button className="btn-primary btn-inline" type="submit" disabled={busy}>
        Add rule
      </button>
      <p className="hint">New rules go last for their printer, pool or model; move them up to come first.</p>
    </form>
  );
}

function CertCard({
  cert,
  manages,
  grants,
  act,
}: {
  cert: Certification;
  manages: boolean;
  grants: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [note, setNote] = useState("");
  return (
    <div className="card cert-card">
      <div className="role-card-head">
        <strong>{cert.name}</strong>
        <span className="hint">
          {cert.valid_days ? `valid ${cert.valid_days} days` : "doesn't expire"} · {cert.rules} rule
          {cert.rules === 1 ? "" : "s"}
        </span>
        {manages && cert.rules === 0 && (
          <span className="role-card-actions">
            <button
              className="btn-sm btn-danger"
              onClick={() => {
                if (window.confirm(`Delete the certification "${cert.name}"? Everyone holding it loses it.`))
                  act(() => apiJson(`/api/certifications/${cert.id}`, "DELETE"));
              }}
            >
              Delete
            </button>
          </span>
        )}
      </div>
      {cert.description && <p className="hint">{cert.description}</p>}
      {cert.holders.length === 0 ? (
        <p className="hint">Nobody holds it yet.</p>
      ) : (
        <ul className="cert-holders">
          {cert.holders.map((h) => (
            <li key={h.user_id}>
              <strong>{h.username}</strong>{" "}
              <span className="hint">
                {h.valid ? "" : "expired · "}
                since {localDate(h.granted_at)}
                {h.granted_by ? ` (${h.granted_by})` : ""}
                {h.expires_at ? ` · until ${localDate(h.expires_at)}` : ""}
                {h.note ? ` · ${h.note}` : ""}
              </span>
              {grants && (
                <button
                  className="btn-sm btn-ghost"
                  onClick={() => act(() => apiJson(`/api/certifications/${cert.id}/holders/${h.user_id}`, "DELETE"))}
                >
                  Take back
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {grants && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              await apiJson(`/api/certifications/${cert.id}/holders`, "POST", { username, note });
              setUsername("");
              setNote("");
            });
          }}
        >
          <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          <button className="btn-sm btn-accent" type="submit">
            Sign off
          </button>
        </form>
      )}
    </div>
  );
}

function CertForm({ onSaved, onError }: { onSaved: () => void; onError: (e: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [days, setDays] = useState("");
  return (
    <form
      className="card access-form"
      onSubmit={async (e) => {
        e.preventDefault();
        onError("");
        try {
          await apiJson("/api/certifications", "POST", {
            name,
            description,
            valid_days: days.trim() ? Number(days) : null,
          });
          setName("");
          setDescription("");
          setDays("");
          onSaved();
        } catch (err) {
          onError(errorText(err));
        }
      }}
    >
      <h4>New certification</h4>
      <div className="access-form-row">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="H2D trained" />
        </label>
        <label>
          Valid for (days, empty = until taken back)
          <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
      </div>
      <label>
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
      </label>
      <button className="btn-primary btn-inline" type="submit">
        Create certification
      </button>
    </form>
  );
}
