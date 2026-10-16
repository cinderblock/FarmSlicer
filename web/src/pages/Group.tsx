import { useState } from "react";
import PrintRulesEditor from "../components/PrintRulesEditor";
import { describeRules, UPLOAD_POLICIES, type UploadPolicy } from "../printers";
import { Link, useNavigate, useParams } from "react-router";
import { apiJson, useAuth } from "../auth";
import { errorText, localDate, useJson } from "../api";
import { QuotaRulesEditor, UsageLines } from "../components/Quota";
import GroupTable from "../components/GroupTable";
import SeasonLibrary from "../components/SeasonLibrary";
import type {
  GroupDetail,
  GroupLibrary,
  GroupQuotas,
  GroupSettings,
  GroupSummary,
  JoinLink,
  Member,
  QuotaLine,
  Rule,
  SubgroupPolicy,
} from "../groups";
import { ruleText, usageText } from "../groups";

type Tab = "library" | "members" | "subgroups" | "links" | "settings" | "quotas";

/** /groups/:id — one group: its library by season, members, subgroups, join links, settings, quotas. */
export default function GroupPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const [rev, setRev] = useState(0);
  const [tab, setTab] = useState<Tab>("library");
  const [error, setError] = useState("");
  const reload = () => setRev((r) => r + 1);
  const detail = useJson<GroupDetail>(`/api/groups/${id}`, rev);
  const g = detail.data;

  if (detail.status === 404) {
    return (
      <div className="page">
        <h2>Group not found</h2>
        <p className="hint">
          It doesn't exist, or you aren't in it. <Link to="/groups">Back to groups</Link>
        </p>
      </div>
    );
  }
  if (!g) return <div className="page"><p className="hint">Loading…</p></div>;

  const active = g.my_status === "active";
  const pending = g.my_status === "pending";
  const tabs: [Tab, string, boolean][] = [
    ["library", "Library", true],
    ["members", "Members", g.can_manage || active],
    ["subgroups", "Subgroups", g.can_manage],
    ["links", "Join links", g.can_manage],
    ["settings", "Settings", g.can_manage],
    ["quotas", "Quotas", true],
  ];

  const leave = async () => {
    if (!user || !window.confirm(`Leave ${g.name}? You'll lose access to its library.`)) return;
    try {
      await apiJson(`/api/groups/${g.id}/members/${user.id}`, "DELETE");
      await refresh();
      navigate("/groups");
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="page group-page">
      <p className="hint breadcrumb">
        <Link to="/groups">Groups</Link>
        {g.ancestors.map((a) => (
          <span key={a.id}>
            {" / "}
            <Link to={`/groups/${a.id}`}>{a.name}</Link>
          </span>
        ))}
      </p>
      <h2>
        {g.name}
        {g.my_role === "manager" && <span className="status-badge role-badge">manager</span>}
        {pending && <span className="status-badge status-queued">waiting for approval</span>}
      </h2>
      {g.description && <p className="group-description">{g.description}</p>}
      <p className="hint">
        {g.member_count} member{g.member_count === 1 ? "" : "s"}
        {g.my_role && (
          <>
            {" · "}
            <button className="link-button" onClick={leave}>
              Leave this group
            </button>
          </>
        )}
      </p>
      {error && <p className="login-error">{error}</p>}

      <div className="profile-tabs">
        {tabs
          .filter(([, , shown]) => shown)
          .map(([t, label]) => (
            <button key={t} className={`profile-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
      </div>

      {tab === "library" && <LibraryTab group={g} rev={rev} />}
      {tab === "members" && <MembersTab group={g} onChange={reload} />}
      {tab === "subgroups" && <SubgroupsTab group={g} onChange={reload} />}
      {tab === "links" && <LinksTab group={g} />}
      {tab === "settings" && <SettingsTab key={`${g.id}#${rev}`} group={g} onSaved={reload} />}
      {tab === "quotas" && <QuotasTab key={`${g.id}#${rev}`} group={g} onSaved={reload} />}
    </div>
  );
}

// ---- library -------------------------------------------------------------------------

function LibraryTab({ group, rev }: { group: GroupDetail; rev: number }) {
  const lib = useJson<GroupLibrary>(`/api/groups/${group.id}/library`, rev);
  if (lib.error) return <p className="login-error">{lib.error}</p>;
  if (!lib.data) return <p className="hint">Loading…</p>;
  return (
    <>
      {!group.effective.shared_library && !group.can_manage && (
        <p className="hint">This group's library isn't shared: you see only your own jobs here.</p>
      )}
      <SeasonLibrary library={lib.data} groupId={group.id} />
    </>
  );
}

// ---- members -------------------------------------------------------------------------

function MembersTab({ group, onChange }: { group: GroupDetail; onChange: () => void }) {
  const [rev, setRev] = useState(0);
  const members = useJson<Member[]>(`/api/groups/${group.id}/members`, rev);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"member" | "manager">("member");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Rule[]>([]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      setRev((r) => r + 1);
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    act(async () => {
      await apiJson(`/api/groups/${group.id}/members`, "POST", { username, role });
      setUsername("");
    });
  };

  const list = members.data ?? [];
  const pending = list.filter((m) => m.status === "pending");
  return (
    <>
      {members.error && <p className="login-error">{members.error}</p>}
      {group.can_manage && pending.length > 0 && (
        <p className="hint">
          {pending.length} waiting for approval (join policy: {group.effective.join_policy}).
        </p>
      )}
      <table className="data-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th>Status</th>
            <th>Joined</th>
            <th>Limits</th>
            {group.can_manage && <th></th>}
          </tr>
        </thead>
        <tbody>
          {list.map((m) => (
            <tr key={m.user_id}>
              <td>
                {m.username}
                {m.kind === "guest" && <span className="source-badge"> guest</span>}
              </td>
              <td>
                {group.can_manage ? (
                  <select
                    value={m.role}
                    onChange={(e) =>
                      act(() => apiJson(`/api/groups/${group.id}/members/${m.user_id}`, "PUT", { role: e.target.value }))
                    }
                  >
                    <option value="member">member</option>
                    <option value="manager">manager</option>
                  </select>
                ) : (
                  m.role
                )}
              </td>
              <td>
                {m.status === "pending" ? (
                  group.can_manage ? (
                    <button
                      className="btn-sm"
                      onClick={() =>
                        act(() => apiJson(`/api/groups/${group.id}/members/${m.user_id}`, "PUT", { status: "active" }))
                      }
                    >
                      Approve
                    </button>
                  ) : (
                    "pending"
                  )
                ) : (
                  "active"
                )}
              </td>
              <td>{localDate(m.joined_at)}</td>
              <td>
                {editing === m.user_id ? (
                  <div>
                    <QuotaRulesEditor rules={draft} onChange={setDraft} />
                    <button
                      className="btn-sm"
                      onClick={() =>
                        act(async () => {
                          await apiJson(`/api/groups/${group.id}/members/${m.user_id}`, "PUT", { quotas: draft });
                          setEditing(null);
                        })
                      }
                    >
                      Save
                    </button>
                    <button
                      className="btn-sm"
                      onClick={() =>
                        act(async () => {
                          await apiJson(`/api/groups/${group.id}/members/${m.user_id}`, "PUT", { quotas: null });
                          setEditing(null);
                        })
                      }
                    >
                      Use group default
                    </button>
                    <button className="btn-sm" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="hint">{m.quotas ? m.quotas.map(ruleText).join("; ") || "none" : "group default"}</span>
                    {group.can_govern && (
                      <>
                        {" "}
                        <button
                          className="btn-sm"
                          onClick={() => {
                            setDraft(m.quotas ?? (m.kind === "guest" && group.quotas.guest ? group.quotas.guest : group.quotas.member));
                            setEditing(m.user_id);
                          }}
                        >
                          Customize
                        </button>
                      </>
                    )}
                  </>
                )}
              </td>
              {group.can_manage && (
                <td>
                  <button
                    className="btn-sm btn-danger"
                    onClick={() => {
                      if (window.confirm(`Remove ${m.username} from ${group.name}?`))
                        act(() => apiJson(`/api/groups/${group.id}/members/${m.user_id}`, "DELETE"));
                    }}
                  >
                    Remove
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {group.can_manage && (
        <>
          <h3>Add a member</h3>
          <form className="printer-form inline-form" onSubmit={add}>
            <label>
              Username (an existing account)
              <input value={username} onChange={(e) => setUsername(e.target.value)} required />
            </label>
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value as "member" | "manager")}>
                <option value="member">member</option>
                <option value="manager">manager</option>
              </select>
            </label>
            <button className="btn-primary" type="submit">
              Add
            </button>
          </form>
          <p className="hint">
            People without an account join through a <strong>join link</strong> (Join links tab) when
            this group allows new accounts or guests.
          </p>
        </>
      )}
      {error && <p className="login-error">{error}</p>}
    </>
  );
}

// ---- subgroups -----------------------------------------------------------------------

function SubgroupsTab({ group, onChange }: { group: GroupDetail; onChange: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await apiJson("/api/groups", "POST", { name, description, parent_id: group.id });
      setName("");
      setDescription("");
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <>
      {group.children.length === 0 ? (
        <p className="hint">No subgroups.</p>
      ) : (
        <GroupTable groups={group.children} />
      )}
      <h3>New subgroup</h3>
      <form className="printer-form inline-form" onSubmit={create}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </label>
        <label>
          Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <button className="btn-primary" type="submit">
          Create
        </button>
      </form>
      {error && <p className="login-error">{error}</p>}
    </>
  );
}

// ---- join links ----------------------------------------------------------------------

function LinksTab({ group }: { group: GroupDetail }) {
  const [rev, setRev] = useState(0);
  const links = useJson<JoinLink[]>(`/api/groups/${group.id}/links`, rev);
  const [label, setLabel] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [code, setCode] = useState("");
  const [bypass, setBypass] = useState<"default" | "yes" | "no">("default");
  const [maxUses, setMaxUses] = useState("");
  const [expiresHours, setExpiresHours] = useState("");
  const [error, setError] = useState("");

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      setRev((r) => r + 1);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    act(async () => {
      await apiJson(`/api/groups/${group.id}/links`, "POST", {
        label,
        public: isPublic,
        code: isPublic ? code : undefined,
        bypass_approval: bypass === "default" ? undefined : bypass === "yes",
        max_uses: maxUses ? Number(maxUses) : undefined,
        expires_hours: expiresHours ? Number(expiresHours) : undefined,
      });
      setLabel("");
      setCode("");
      setMaxUses("");
      setExpiresHours("");
    });
  };

  const eff = group.effective;
  return (
    <>
      <p className="hint">
        Anyone with a link can join <strong>{group.name}</strong>
        {group.settings.subgroups && group.settings.subgroups.mode !== "none" ? " (and pick a subgroup)" : ""}. New
        accounts: {eff.allow_registration ? "allowed" : "not allowed"}; guests: {eff.allow_guests ? "allowed" : "not allowed"}
        ; joining needs approval: {eff.join_policy === "approval" ? "yes, unless the link skips it" : "no"}. Change
        these on the Settings tab.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Link</th>
            <th>Kind</th>
            <th>Approval</th>
            <th>Uses</th>
            <th>Expires</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(links.data ?? []).map((l) => (
            <tr key={l.id} className={l.disabled ? "row-disabled" : undefined}>
              <td>
                {l.label && <div>{l.label}</div>}
                <code className="link-url">{l.url}</code>{" "}
                <button className="btn-sm" onClick={() => navigator.clipboard?.writeText(l.url).catch(() => {})}>
                  Copy
                </button>
              </td>
              <td>{l.public ? "public" : "secret"}</td>
              <td>{l.bypass_approval ? "skips approval" : "follows join policy"}</td>
              <td>
                {l.uses}
                {l.max_uses != null ? ` / ${l.max_uses}` : ""}
              </td>
              <td>{l.expires_at ? localDate(l.expires_at) : "never"}</td>
              <td>
                <button
                  className="btn-sm"
                  onClick={() => act(() => apiJson(`/api/groups/${group.id}/links/${l.id}`, "PUT", { disabled: !l.disabled }))}
                >
                  {l.disabled ? "Enable" : "Disable"}
                </button>
                <button
                  className="btn-sm btn-danger"
                  onClick={() => {
                    if (window.confirm("Delete this link? It stops working at once."))
                      act(() => apiJson(`/api/groups/${group.id}/links/${l.id}`, "DELETE"));
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>New join link</h3>
      <form className="printer-form inline-form" onSubmit={create}>
        <label>
          Label (for you)
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. mentors, kickoff flyer" />
        </label>
        <label>
          Kind
          <select value={isPublic ? "public" : "secret"} onChange={(e) => setIsPublic(e.target.value === "public")}>
            <option value="secret">Secret (random code)</option>
            <option value="public">Public (a code you choose)</option>
          </select>
        </label>
        {isPublic && (
          <label>
            Code (a-z, 0-9, -)
            <input value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} required pattern="[a-z0-9-]{3,40}" />
          </label>
        )}
        <label>
          Approval
          <select value={bypass} onChange={(e) => setBypass(e.target.value as "default" | "yes" | "no")}>
            <option value="default">Default ({isPublic ? "follows the join policy" : "skips approval"})</option>
            <option value="yes">Skips approval</option>
            <option value="no">Follows the join policy</option>
          </select>
        </label>
        <label>
          Max uses
          <input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="unlimited" />
        </label>
        <label>
          Expires after (hours)
          <input type="number" min={1} value={expiresHours} onChange={(e) => setExpiresHours(e.target.value)} placeholder="never" />
        </label>
        <button className="btn-primary" type="submit">
          Create link
        </button>
      </form>
      {error && <p className="login-error">{error}</p>}
    </>
  );
}

// ---- settings ------------------------------------------------------------------------

type TriState = "inherit" | "on" | "off";
const toTri = (v: boolean | undefined): TriState => (v === undefined ? "inherit" : v ? "on" : "off");
const fromTri = (t: TriState): boolean | undefined => (t === "inherit" ? undefined : t === "on");

const BOOL_SETTINGS: { key: "shared_library" | "allow_registration" | "allow_guests"; label: string; help: string }[] = [
  { key: "shared_library", label: "Shared library", help: "Members see each other's jobs in this group." },
  { key: "allow_registration", label: "New accounts", help: "The join flow may create passkey accounts." },
  { key: "allow_guests", label: "Guest accounts", help: "The join flow may create guest accounts (no passkey; limited)." },
];

/** The group's thumbnail logo: upload, replace, remove (managers). */
function LogoSetting({ group }: { group: GroupDetail }) {
  const [rev, setRev] = useState(0);
  const [error, setError] = useState("");
  const overlay = useJson<{ label: string; logo_group: string | null }>(`/api/groups/${group.id}/overlay`, rev).data;
  const own = overlay?.logo_group === group.id;
  const from = overlay?.logo_group
    ? overlay.logo_group === group.id
      ? null
      : (group.ancestors.find((a) => a.id === overlay.logo_group)?.name ?? "a parent group")
    : null;

  const upload = async (file: File) => {
    setError("");
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/groups/${group.id}/logo`, { method: "PUT", body: form });
    if (!res.ok) setError((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
    setRev((r) => r + 1);
  };
  const remove = async () => {
    setError("");
    await fetch(`/api/groups/${group.id}/logo`, { method: "DELETE" });
    setRev((r) => r + 1);
  };

  return (
    <div className="logo-setting">
      <span>Thumbnail logo</span>
      <div className="logo-row">
        {overlay?.logo_group && (
          <img
            className="logo-preview"
            src={`/api/groups/${group.id}/overlay/logo?rev=${rev}`}
            alt="Logo drawn on thumbnails"
          />
        )}
        <div>
          <p className="hint">
            {own
              ? "Drawn in the corner of every thumbnail of jobs charged here and in subgroups without their own."
              : from
                ? `Inherited from ${from}. Upload one to use your own.`
                : "None. PNG or JPEG; it's shrunk to 256 px."}
            {overlay?.label && <> Label: <strong>{overlay.label}</strong>.</>}
          </p>
          {group.can_manage && (
            <span className="logo-actions">
              <label className="btn-sm file-button">
                {own ? "Replace…" : "Upload…"}
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  hidden
                  onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
                />
              </label>
              {own && (
                <button type="button" className="btn-sm btn-danger" onClick={remove}>
                  Remove
                </button>
              )}
            </span>
          )}
          {error && <p className="login-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function SettingsTab({ group, onSaved }: { group: GroupDetail; onSaved: () => void }) {
  const navigate = useNavigate();
  const [s, setS] = useState<GroupSettings>(group.settings);
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description);
  const [parent, setParent] = useState(group.parent_id ?? "");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const allGroups = useJson<GroupSummary[]>(group.is_admin ? "/api/groups" : null);

  const sourceName = (key: string) => {
    const src = group.effective.sources[key];
    if (src === undefined || src === null) return "site default";
    if (src === group.id) return "this group";
    return group.ancestors.find((a) => a.id === src)?.name ?? "a parent group";
  };
  // What clearing the value would give is only known when it's inherited now.
  const inheritLabel = (key: string, value: string) =>
    group.effective.sources[key] === group.id
      ? "Inherit from parent groups"
      : `Inherit: ${value} (from ${sourceName(key)})`;
  const sub: SubgroupPolicy = s.subgroups ?? {
    mode: "none",
    required: false,
    label: "",
    pattern: "",
    name_template: "",
    creator_becomes_manager: false,
  };
  const setSub = (patch: Partial<SubgroupPolicy>) => {
    const next = { ...sub, ...patch };
    setS({ ...s, subgroups: next.mode === "none" ? undefined : next });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaved(false);
    try {
      const body: Record<string, unknown> = { name, description, settings: s };
      if (group.is_admin && (parent || null) !== group.parent_id) body.parent_id = parent || null;
      await apiJson(`/api/groups/${group.id}`, "PUT", body);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${group.name}? Its jobs become their creators' personal jobs.`)) return;
    try {
      await apiJson(`/api/groups/${group.id}`, "DELETE");
      navigate("/groups");
    } catch (err) {
      setError(errorText(err));
    }
  };

  const eff = group.effective;
  return (
    <form className="printer-form settings-form" onSubmit={save}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
      </label>
      <label>
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {group.is_admin && (
        <label>
          Parent group
          <select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">(top level)</option>
            {(allGroups.data ?? [])
              .filter((o) => o.id !== group.id && !o.path.startsWith(`${group.path} / `))
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.path}
                </option>
              ))}
          </select>
        </label>
      )}

      <h3>Inherited by subgroups</h3>
      {BOOL_SETTINGS.map(({ key, label, help }) => (
        <label key={key}>
          {label}
          <select value={toTri(s[key])} onChange={(e) => setS({ ...s, [key]: fromTri(e.target.value as TriState) })}>
            <option value="inherit">{inheritLabel(key, eff[key] ? "on" : "off")}</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
          <span className="hint">{help}</span>
        </label>
      ))}
      <label>
        Joining
        <select
          value={s.join_policy ?? "inherit"}
          onChange={(e) =>
            setS({ ...s, join_policy: e.target.value === "inherit" ? undefined : (e.target.value as "open" | "approval") })
          }
        >
          <option value="inherit">{inheritLabel("join_policy", eff.join_policy)}</option>
          <option value="open">Open: joiners are members at once</option>
          <option value="approval">Approval: a manager approves each joiner</option>
        </select>
        <span className="hint">Secret links to this exact group skip approval unless set otherwise.</span>
      </label>
      <label>
        Uploaded sliced files
        <select
          value={s.uploads ?? "inherit"}
          onChange={(e) => setS({ ...s, uploads: e.target.value === "inherit" ? undefined : (e.target.value as UploadPolicy) })}
        >
          <option value="inherit">
            {inheritLabel("uploads", UPLOAD_POLICIES.find(([v]) => v === eff.uploads)?.[1] ?? eff.uploads)}
          </option>
          {UPLOAD_POLICIES.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <span className="hint">
          .gcode.3mf files from Bambu Studio and the like. Their G-code is checked either way; managers of
          this group and admins are exempt.
        </span>
      </label>
      <label>
        Season starts (MM-DD)
        <input
          value={s.season_start ?? ""}
          onChange={(e) => setS({ ...s, season_start: e.target.value.trim() || undefined })}
          placeholder={inheritLabel("season_start", eff.season_start)}
          pattern="[0-1][0-9]-[0-3][0-9]"
        />
        <span className="hint">The library shows this season first and earlier seasons separately.</span>
      </label>
      <label>
        Thumbnail label
        <input
          value={s.thumbnail_label ?? ""}
          disabled={s.thumbnail_label === ""}
          onChange={(e) => setS({ ...s, thumbnail_label: e.target.value || undefined })}
          placeholder={inheritLabel("thumbnail_label", eff.thumbnail_label || "none")}
          maxLength={64}
        />
        <span className="hint">
          Drawn on the plate thumbnail of every job charged here. <code>{"{key}"}</code> is the
          identifier the group was created under (e.g. a team number), <code>{"{group}"}</code> its name.
        </span>
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={s.thumbnail_label === ""}
          onChange={(e) => setS({ ...s, thumbnail_label: e.target.checked ? "" : undefined })}
        />
        No label here (don't inherit one)
      </label>

      <LogoSetting group={group} />

      <div className="rules-setting">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={s.print_rules !== undefined}
            onChange={(e) => setS({ ...s, print_rules: e.target.checked ? { ...eff.print_rules } : undefined })}
          />
          Set print rules here
          {s.print_rules === undefined && (
            <span className="hint">
              {" "}
              (inheriting from {sourceName("print_rules")}: {describeRules(eff.print_rules)})
            </span>
          )}
        </label>
        {s.print_rules !== undefined && (
          <PrintRulesEditor rules={s.print_rules} onChange={(r) => setS({ ...s, print_rules: r })} />
        )}
      </div>

      <h3>This group only</h3>
      {group.is_admin && (
        <label className="checkbox-label">
          <input type="checkbox" checked={!!s.listed} onChange={(e) => setS({ ...s, listed: e.target.checked || undefined })} />
          Offer “Join {name}” on the sign-in page
        </label>
      )}
      <label>
        Subgroups for joiners
        <select value={sub.mode} onChange={(e) => setSub({ mode: e.target.value as SubgroupPolicy["mode"] })}>
          <option value="none">None: join this group itself</option>
          <option value="choose">Choose one of the existing subgroups</option>
          <option value="self_service">Type an identifier; a new subgroup is created when needed</option>
        </select>
      </label>
      {sub.mode !== "none" && (
        <>
          <label className="checkbox-label">
            <input type="checkbox" checked={sub.required} onChange={(e) => setSub({ required: e.target.checked })} />
            Joiners must pick a subgroup (they don't join this group itself)
          </label>
          <label>
            What to call the choice
            <input value={sub.label} onChange={(e) => setSub({ label: e.target.value })} placeholder="e.g. Team number" />
          </label>
        </>
      )}
      {sub.mode === "self_service" && (
        <>
          <label>
            Allowed identifiers (regular expression, whole value)
            <input value={sub.pattern} onChange={(e) => setSub({ pattern: e.target.value })} placeholder="[0-9]{1,5}" required />
          </label>
          <label>
            New subgroup name ({"{value}"} = the identifier)
            <input
              value={sub.name_template}
              onChange={(e) => setSub({ name_template: e.target.value })}
              placeholder="Team {value}"
              required
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={sub.creator_becomes_manager}
              onChange={(e) => setSub({ creator_becomes_manager: e.target.checked })}
            />
            Whoever creates a subgroup becomes its manager
          </label>
        </>
      )}

      <button className="btn-primary" type="submit">
        Save settings
      </button>
      {saved && <p className="hint">Saved.</p>}
      {error && <p className="login-error">{error}</p>}
      {group.can_govern && group.children.length === 0 && (
        <p>
          <button type="button" className="btn-sm btn-danger" onClick={remove}>
            Delete this group
          </button>
        </p>
      )}
    </form>
  );
}

// ---- quotas --------------------------------------------------------------------------

function QuotasTab({ group, onSaved }: { group: GroupDetail; onSaved: () => void }) {
  const [q, setQ] = useState<GroupQuotas>({ pool: group.quotas.pool ?? [], member: group.quotas.member ?? [], guest: group.quotas.guest });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const usage = useJson<{ lines: QuotaLine[]; members: { user_id: string; username: string; lines: QuotaLine[] }[] }>(
    `/api/groups/${group.id}/usage`,
  );

  const save = async () => {
    setError("");
    setSaved(false);
    try {
      await apiJson(`/api/groups/${group.id}`, "PUT", { quotas: q });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <>
      <h3>Your usage here</h3>
      <p className="hint">
        Every limit that applies when you slice for this group: this group's and its parent groups'. Your own
        account limits are on the Account page.
      </p>
      {usage.data ? <UsageLines lines={usage.data.lines} /> : <p className="hint">Loading…</p>}

      {usage.data && usage.data.members.length > 0 && (
        <>
          <h3>Members' usage of the per-member limits</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Usage</th>
              </tr>
            </thead>
            <tbody>
              {usage.data.members.map((m) => (
                <tr key={m.user_id}>
                  <td>{m.username}</td>
                  <td>
                    {m.lines.length === 0
                      ? "no per-member limits"
                      : m.lines
                          .map((l) => `${l.group_name}: ${usageText(l)}`)
                          .join("; ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Limits</h3>
      {!group.can_govern && (
        <p className="hint">Set by admins or managers of a parent group.</p>
      )}
      <div className="quota-sections">
        <div>
          <h4>Shared pool</h4>
          <p className="hint">Everything charged to this group and its subgroups, together.</p>
          <QuotaRulesEditor rules={q.pool} onChange={(pool) => setQ({ ...q, pool })} disabled={!group.can_govern} />
        </div>
        <div>
          <h4>Per member</h4>
          <p className="hint">Each member's own jobs in this group and its subgroups. Members can have their own limits (Members tab).</p>
          <QuotaRulesEditor rules={q.member} onChange={(member) => setQ({ ...q, member })} disabled={!group.can_govern} />
        </div>
        <div>
          <h4>Per guest</h4>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={q.guest !== undefined}
              onChange={(e) => setQ({ ...q, guest: e.target.checked ? [...q.member] : undefined })}
              disabled={!group.can_govern}
            />
            Guests get different limits from other members
          </label>
          {q.guest !== undefined && (
            <QuotaRulesEditor rules={q.guest} onChange={(guest) => setQ({ ...q, guest })} disabled={!group.can_govern} />
          )}
        </div>
      </div>
      {group.can_govern && (
        <button className="btn-primary btn-inline" onClick={save}>
          Save limits
        </button>
      )}
      {saved && <p className="hint">Saved.</p>}
      {error && <p className="login-error">{error}</p>}
    </>
  );
}
