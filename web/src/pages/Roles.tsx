// /roles: the built-in and custom roles, and the editor for custom ones
// (src/permissions.rs, src/roles_api.rs). Site roles are given on the Users
// page, group roles on a group's Members.
import { useState } from "react";
import { apiJson, useAuth } from "../auth";
import type { SiteCap } from "../auth";
import { errorText } from "../api";
import PageHeader from "../components/PageHeader";
import type { CapabilityInfo, Role } from "../roles";
import { useRoles } from "../roles";

interface Draft {
  id: string | null;
  scope: "site" | "group";
  name: string;
  description: string;
  caps: string[];
}

export default function RolesPage() {
  const { user: me, can } = useAuth();
  const [rev, setRev] = useState(0);
  const data = useRoles(rev).data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const editable = can("roles.manage");
  const owner = me?.role === "owner";
  const mine = new Set<string>(me?.caps ?? []);

  /** Capabilities this viewer may put in (or take out of) a role. */
  const grantable = (scope: "site" | "group", cap: string) =>
    owner || (scope === "site" ? mine.has(cap as SiteCap) : can("groups.manage_all"));
  const canEdit = (r: Role) => editable && !r.builtin && r.caps.every((c) => grantable(r.scope, c));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setError("");
    setBusy(true);
    try {
      const body = { name: draft.name, description: draft.description, caps: draft.caps, scope: draft.scope };
      if (draft.id) await apiJson(`/api/roles/${draft.id}`, "PUT", body);
      else await apiJson("/api/roles", "POST", body);
      setDraft(null);
      setRev((n) => n + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: Role) => {
    if (!window.confirm(`Delete the role "${r.name}"?`)) return;
    setError("");
    try {
      await apiJson(`/api/roles/${r.id}`, "DELETE");
      setRev((n) => n + 1);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const section = (scope: "site" | "group", title: string, intro: string) => {
    const roles = (data?.roles ?? []).filter((r) => r.scope === scope);
    const catalogue = data?.capabilities[scope] ?? [];
    return (
      <section className="roles-section">
        <div className="roles-section-head">
          <h3>{title}</h3>
          {editable && (scope === "site" || owner || can("groups.manage_all")) && (
            <button
              className="btn-sm btn-accent"
              onClick={() => setDraft({ id: null, scope, name: "", description: "", caps: [] })}
            >
              New {scope} role
            </button>
          )}
        </div>
        <p className="hint">{intro}</p>
        {draft?.scope === scope && draft.id === null && (
          <RoleEditor
            draft={draft}
            catalogue={catalogue}
            grantable={(c) => grantable(scope, c)}
            onChange={setDraft}
            onSubmit={save}
            onCancel={() => setDraft(null)}
            busy={busy}
          />
        )}
        <div className="roles-list">
          {roles.map((r) =>
            draft?.id === r.id ? (
              <RoleEditor
                key={r.id}
                draft={draft}
                catalogue={catalogue}
                grantable={(c) => grantable(scope, c)}
                onChange={setDraft}
                onSubmit={save}
                onCancel={() => setDraft(null)}
                busy={busy}
              />
            ) : (
              <div className="card role-card" key={r.id}>
                <div className="role-card-head">
                  <strong>{r.name}</strong>
                  {r.builtin ? (
                    <span className="status-badge">built in</span>
                  ) : (
                    <span className="hint">
                      {r.holders === 1 ? "1 holder" : `${r.holders ?? 0} holders`}
                    </span>
                  )}
                  {canEdit(r) && (
                    <span className="role-card-actions">
                      <button
                        className="btn-sm"
                        onClick={() =>
                          setDraft({ id: r.id, scope: r.scope, name: r.name, description: r.description, caps: r.caps })
                        }
                      >
                        Edit
                      </button>
                      <button className="btn-sm btn-danger" onClick={() => remove(r)} disabled={(r.holders ?? 0) > 0}>
                        Delete
                      </button>
                    </span>
                  )}
                </div>
                {r.description && <p className="hint">{r.description}</p>}
                <div className="cap-chips">
                  {r.caps.length === 0 ? (
                    <span className="hint">No extra permissions</span>
                  ) : r.caps.length === catalogue.length && r.builtin ? (
                    <span className="cap-chip">Everything</span>
                  ) : (
                    r.caps.map((c) => (
                      <span className="cap-chip" key={c} title={catalogue.find((x) => x.id === c)?.description}>
                        {catalogue.find((x) => x.id === c)?.label ?? c}
                      </span>
                    ))
                  )}
                </div>
              </div>
            ),
          )}
        </div>
      </section>
    );
  };

  return (
    <div className="page">
      <PageHeader title="Roles" icon="shield">
        A role is a set of permissions. Every account has one site role, given on the Users page, and a role in each
        group it belongs to, given on the group's page; a group role holds in that group and every group below it.
        Built-in roles can't change. Nobody can give a permission they don't hold, so a custom role can't be a way up.
      </PageHeader>
      {error && <p className="login-error">{error}</p>}
      {section(
        "site",
        "Site roles",
        "What an account may do across the whole farm. Users hold none of these; admins and the owner hold all of them.",
      )}
      {section(
        "group",
        "Group roles",
        "What a member may do in their group and its subgroups. Members slice and print for the group (and see its library when the group shares it); managers do everything.",
      )}
    </div>
  );
}

function RoleEditor({
  draft,
  catalogue,
  grantable,
  onChange,
  onSubmit,
  onCancel,
  busy,
}: {
  draft: Draft;
  catalogue: CapabilityInfo[];
  grantable: (cap: string) => boolean;
  onChange: (d: Draft) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const toggle = (cap: string, on: boolean) =>
    onChange({ ...draft, caps: on ? [...draft.caps, cap] : draft.caps.filter((c) => c !== cap) });
  return (
    <form className="card role-editor" onSubmit={onSubmit}>
      <label>
        Name
        <input
          type="text"
          value={draft.name}
          maxLength={40}
          required
          autoFocus
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </label>
      <label>
        Description
        <input
          type="text"
          value={draft.description}
          maxLength={300}
          placeholder="What it's for"
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
      </label>
      <fieldset className="cap-grid">
        <legend>Permissions</legend>
        {catalogue.map((c) => {
          const allowed = grantable(c.id);
          return (
            <label key={c.id} className={`checkbox-label cap-option${allowed ? "" : " is-disabled"}`}>
              <input
                type="checkbox"
                checked={draft.caps.includes(c.id)}
                disabled={!allowed}
                onChange={(e) => toggle(c.id, e.target.checked)}
              />
              <span>
                <strong>{c.label}</strong>
                <span className="hint">
                  {c.description}
                  {!allowed && " (you don't hold this)"}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <div className="role-editor-actions">
        <button className="btn-primary btn-inline" type="submit" disabled={busy}>
          {draft.id ? "Save role" : "Create role"}
        </button>
        <button className="btn-sm" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
