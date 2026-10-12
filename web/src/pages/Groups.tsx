import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { apiJson, useAuth } from "../auth";
import { errorText, useJson } from "../api";
import type { GroupSummary } from "../groups";
import GroupTable from "../components/GroupTable";

/** /groups — the caller's groups (admins: every group), joining, creating top-level groups. */
export default function GroupsPage() {
  const { status, isAdmin, isGuest } = useAuth();
  const navigate = useNavigate();
  const [rev, setRev] = useState(0);
  const groups = useJson<GroupSummary[]>("/api/groups", rev);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");

  const all = groups.data ?? [];
  const mine = all.filter((g) => g.my_role);
  const others = all.filter((g) => !g.my_role);
  const joinable = (status?.join_groups ?? []).filter((j) => !mine.some((g) => g.id === j.id));

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const g = await apiJson<GroupSummary>("/api/groups", "POST", { name, description });
      setName("");
      setDescription("");
      setRev((r) => r + 1);
      navigate(`/groups/${g.id}`);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const openLink = (e: React.FormEvent) => {
    e.preventDefault();
    // Accept a whole URL or just the code.
    const code = link.trim().replace(/^.*\/join\//, "").replace(/[/?#].*$/, "");
    if (code) navigate(`/join/${encodeURIComponent(code)}`);
  };

  return (
    <div className="page">
      <h2>Groups</h2>
      <p className="hint">
        Jobs you slice for a group land in its library, where its members can see them. Groups can have
        subgroups; limits and settings carry down from parent groups.
      </p>

      <h3>Your groups</h3>
      {groups.data === undefined ? (
        <p className="hint">Loading…</p>
      ) : mine.length === 0 ? (
        <p className="hint">You aren't in any group yet.</p>
      ) : (
        <GroupTable groups={mine} />
      )}

      {others.length > 0 && (
        <>
          <h3>{isAdmin ? "All other groups" : "Groups you manage"}</h3>
          <GroupTable groups={others} />
        </>
      )}

      <h3>Join a group</h3>
      {joinable.length > 0 && (
        <ul className="join-list">
          {joinable.map((j) => (
            <li key={j.id}>
              <Link to={`/join/group/${j.id}`}>Join {j.name}</Link>
              {j.description && <span className="hint"> · {j.description}</span>}
            </li>
          ))}
        </ul>
      )}
      <form className="printer-form inline-form" onSubmit={openLink}>
        <label>
          Got a join link? Paste it here
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…/join/…" />
        </label>
        <button className="btn-primary" type="submit" disabled={!link.trim()}>
          Open
        </button>
      </form>

      {isAdmin && !isGuest && (
        <>
          <h3>New top-level group</h3>
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
          <p className="hint">Managers create subgroups from a group's Subgroups tab.</p>
        </>
      )}
      {error && <p className="login-error">{error}</p>}
    </div>
  );
}
