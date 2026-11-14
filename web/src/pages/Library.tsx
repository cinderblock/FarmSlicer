// /library: sliced jobs and projects as a file browser (src/folders.rs).
// Each library (yours: jobs and projects charged to no group; a group's:
// what's charged to it) has its own tree of folders. `?lib=me|<group>|all`
// and `?folder=<id>` keep the place in the URL. Drag a row onto a folder,
// or use its "Move to", to file it.
import { ShareButton } from "../components/Share";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { apiJson, useAuth } from "../auth";
import { errorText, formatDuration, formatSize, localDate, useJson } from "../api";
import { previewPath } from "../links";
import PageHeader, { EmptyState } from "../components/PageHeader";
import Icon from "../components/Icon";
import { ItemLabels, LabelFilter } from "../components/Labels";
import { useLabelFilter } from "../labels";
import { STATUS_LABELS, type Project } from "../projects";

interface SliceRecord {
  id: string;
  job_id: string;
  model_name: string;
  print_time_sec: number;
  filament_used_g: number;
  file_size: number;
  created_at: string;
  user_id: string | null;
  username: string | null;
  group_id: string | null;
  group_name: string | null;
  has_model: boolean;
}

interface Folder {
  id: string;
  parent_id: string | null;
  library_kind: "user" | "group";
  library_id: string;
  name: string;
  can_manage: boolean;
}

interface Library {
  kind: "user" | "group";
  id: string;
  name: string;
  can_manage: boolean;
}

interface FoldersData {
  folders: Folder[];
  libraries: Library[];
  items: { job?: Record<string, string>; project?: Record<string, string> };
}

type Dragged = { kind: "job" | "project"; id: string };

interface SharedWithMe {
  id: string;
  target_kind: "job" | "project" | "folder" | "library";
  target_id: string;
  name: string;
  level: "view" | "use" | "edit";
  by: string | null;
  expires_at: string | null;
  through_group: string | null;
}

/** What's been shared with this account, and from whom. */
function SharedList({ list }: { list: SharedWithMe[] | undefined }) {
  if (!list) return <p className="hint">Loading…</p>;
  if (list.length === 0) {
    return (
      <EmptyState icon="users" title="Nothing shared with you yet">
        When someone shares a job, project, folder or library with you, it shows up here.
      </EmptyState>
    );
  }
  const href = (s: SharedWithMe) =>
    s.target_kind === "job"
      ? `/jobs/${s.target_id}`
      : s.target_kind === "project"
        ? `/projects/${s.target_id}`
        : s.target_kind === "library"
          ? `/library?lib=all`
          : `/library?lib=all`;
  return (
    <table className="data-table cards">
      <thead>
        <tr>
          <th>What</th>
          <th>From</th>
          <th>May</th>
          <th>Until</th>
        </tr>
      </thead>
      <tbody>
        {list.map((s) => (
          <tr key={s.id}>
            <td className="cell-title">
              <Link to={href(s)}>{s.name}</Link> <span className="hint">{s.target_kind}</span>
            </td>
            <td data-label="From">
              {s.by ?? "—"}
              {s.through_group && <div className="hint">to {s.through_group}</div>}
            </td>
            <td data-label="May">{s.level}</td>
            <td data-label="Until">{s.expires_at ? localDate(s.expires_at) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function LibraryPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [rev, setRev] = useState(0);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [labelFilter, setLabelFilter] = useState<string[]>([]);
  const [dragged, setDragged] = useState<Dragged | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const folders = useJson<FoldersData>("/api/folders", rev).data;
  const slices = useJson<SliceRecord[]>("/api/slices", rev).data;
  const projects = useJson<Project[]>("/api/projects", rev).data;
  const labelledJobs = useLabelFilter("job", labelFilter);
  const labelledProjects = useLabelFilter("project", labelFilter);

  const libKey = params.get("lib") ?? "me";
  const folderId = params.get("folder");
  const sharedView = libKey === "shared";
  const flat = libKey === "all" || sharedView;
  const sharedWithMe = useJson<SharedWithMe[]>(sharedView ? "/api/shares/mine" : null, rev).data;
  const lib: Library | undefined = flat
    ? undefined
    : (folders?.libraries.find((l) => (libKey === "me" ? l.kind === "user" : l.kind === "group" && l.id === libKey)) ??
      folders?.libraries[0]);
  const inLib = (groupId: string | null, userId: string | null) =>
    !!lib && (lib.kind === "group" ? groupId === lib.id : groupId === null && userId === user?.id);

  const libFolders = useMemo(
    () => (folders?.folders ?? []).filter((f) => lib && f.library_kind === lib.kind && f.library_id === lib.id),
    [folders, lib],
  );
  const current = libFolders.find((f) => f.id === folderId) ?? null;
  const children = libFolders.filter((f) => f.parent_id === (current?.id ?? null));
  const trail: Folder[] = [];
  for (let f: Folder | null = current; f; f = libFolders.find((x) => x.id === f!.parent_id) ?? null) trail.unshift(f);
  // Every folder of this library, by path, for "Move to".
  const paths = useMemo(() => {
    const path = (f: Folder): string => {
      const parent = libFolders.find((x) => x.id === f.parent_id);
      return parent ? `${path(parent)} / ${f.name}` : f.name;
    };
    return libFolders.map((f) => ({ id: f.id, path: path(f) })).sort((a, b) => a.path.localeCompare(b.path));
  }, [libFolders]);

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  // Searching looks through the whole library, not just this folder.
  const here = (kind: "job" | "project", id: string) =>
    words.length > 0 || labelFilter.length > 0 ? true : (folders?.items[kind]?.[id] ?? null) === (current?.id ?? null);
  const shownSlices = (slices ?? []).filter(
    (s) =>
      (flat || (inLib(s.group_id, s.user_id) && here("job", s.job_id))) &&
      (!labelledJobs || labelledJobs.has(s.job_id)) &&
      matches(`${s.model_name} ${s.username ?? ""} ${s.group_name ?? ""}`),
  );
  const shownProjects = flat
    ? []
    : (projects ?? []).filter(
        (p) =>
          inLib(p.group_id, p.user_id) &&
          here("project", p.id) &&
          (!labelledProjects || labelledProjects.has(p.id)) &&
          matches(`${p.name} ${p.client_ref ?? ""}`),
      );

  const go = (lib: string, folder?: string | null) => {
    const next = new URLSearchParams();
    if (lib !== "me") next.set("lib", lib);
    if (folder) next.set("folder", folder);
    setParams(next);
  };
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      setRev((r) => r + 1);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const file = (item: Dragged, folder: string | null) =>
    act(() => apiJson("/api/folders/items", "PUT", { kind: item.kind, item_id: item.id, folder_id: folder }));
  const newFolder = () => {
    const name = window.prompt("Folder name");
    if (!name?.trim() || !lib) return;
    act(() =>
      apiJson("/api/folders", "POST", {
        name: name.trim(),
        parent_id: current?.id ?? null,
        library: lib.kind,
        group_id: lib.kind === "group" ? lib.id : undefined,
      }),
    );
  };
  const renameFolder = (f: Folder) => {
    const name = window.prompt("Rename folder", f.name);
    if (name?.trim() && name.trim() !== f.name) act(() => apiJson(`/api/folders/${f.id}`, "PUT", { name: name.trim() }));
  };
  const deleteFolder = (f: Folder) => {
    if (window.confirm(`Delete the folder "${f.name}"? What's in it moves up a level.`))
      act(() => apiJson(`/api/folders/${f.id}`, "DELETE"));
  };
  const dropProps = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragged) return;
      e.preventDefault();
      setDropOn(target ?? "top");
    },
    onDragLeave: () => setDropOn(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropOn(null);
      if (dragged) file(dragged, target);
      setDragged(null);
    },
  });
  const dragProps = (item: Dragged) => ({
    draggable: !flat,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      setDragged(item);
    },
    onDragEnd: () => setDragged(null),
  });
  const moveSelect = (item: Dragged) =>
    !flat &&
    paths.length > 0 && (
      <select
        className="select-sm"
        value={folders?.items[item.kind]?.[item.id] ?? ""}
        aria-label="Move to folder"
        onChange={(e) => file(item, e.target.value || null)}
      >
        <option value="">{lib?.name ?? "Top"} (top)</option>
        {paths.map((p) => (
          <option key={p.id} value={p.id}>
            {p.path}
          </option>
        ))}
      </select>
    );

  const loading = folders === undefined || slices === undefined || (!flat && projects === undefined);
  const empty = !loading && children.length === 0 && shownSlices.length === 0 && shownProjects.length === 0;

  return (
    <div className="page">
      <PageHeader
        title="Library"
        icon="library"
        actions={
          lib?.can_manage &&
          !flat && (
            <button className="btn-primary btn-inline" onClick={newFolder}>
              <Icon name="plus" /> New folder
            </button>
          )
        }
      >
        Your sliced jobs and projects, and your groups', in folders. Drag a row onto a folder (or use its Move to) to
        file it; folders belong to one library, so a group's work goes in the group's folders.
      </PageHeader>
      <div className="list-toolbar">
        <label>
          <select value={flat ? libKey : lib?.kind === "group" ? lib.id : "me"} onChange={(e) => go(e.target.value)} aria-label="Library">
            {folders?.libraries.map((l) => (
              <option key={`${l.kind}:${l.id}`} value={l.kind === "user" ? "me" : l.id}>
                {l.name}
              </option>
            ))}
            <option value="shared">Shared with me</option>
            <option value="all">Everything I can see</option>
          </select>
        </label>
        <label className="search-field">
          <Icon name="search" />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find in this library…" aria-label="Search the library" />
        </label>
        <LabelFilter value={labelFilter} onChange={setLabelFilter} />
        {lib?.kind === "group" && (
          <>
            <Link to={`/groups/${lib.id}`} className="hint">
              The group's library by season
            </Link>
            <ShareButton kind="library" id={lib.id} name={`${lib.name}'s library`} />
          </>
        )}
      </div>

      {!flat && lib && (
        <nav className="breadcrumb library-trail" aria-label="Folder">
          <button className={`link-button${dropOn === "top" ? " drop-target" : ""}`} onClick={() => go(libKey)} {...dropProps(null)}>
            {lib.name}
          </button>
          {trail.map((f) => (
            <span key={f.id}>
              {" / "}
              <button className={`link-button${dropOn === f.id ? " drop-target" : ""}`} onClick={() => go(libKey, f.id)} {...dropProps(f.id)}>
                {f.name}
              </button>
            </span>
          ))}
        </nav>
      )}
      {error && <p className="login-error">{error}</p>}

      {!flat && children.length > 0 && words.length === 0 && labelFilter.length === 0 && (
        <div className="folder-grid">
          {children.map((f) => (
            <div
              key={f.id}
              className={`folder-tile${dropOn === f.id ? " drop-target" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => go(libKey, f.id)}
              onKeyDown={(e) => e.key === "Enter" && go(libKey, f.id)}
              {...dropProps(f.id)}
            >
              <Icon name="projects" />
              <span className="folder-name">{f.name}</span>
              {f.can_manage && (
                <span className="folder-actions" onClick={(e) => e.stopPropagation()}>
                  <ShareButton kind="folder" id={f.id} name={f.name} />
                  <button className="btn-sm btn-ghost btn-icon" title="Rename" aria-label={`Rename ${f.name}`} onClick={() => renameFolder(f)}>
                    <Icon name="edit" size={14} />
                  </button>
                  <button className="btn-sm btn-ghost btn-icon btn-danger" title="Delete" aria-label={`Delete ${f.name}`} onClick={() => deleteFolder(f)}>
                    <Icon name="trash" size={14} />
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {sharedView ? (
        <SharedList list={sharedWithMe} />
      ) : loading ? (
        <p className="hint">Loading…</p>
      ) : empty ? (
        <EmptyState
          icon="library"
          title={current ? "This folder is empty" : "Nothing here yet"}
          action={
            !current && (
              <Link className="btn-primary btn-inline" to="/slice">
                <Icon name="slice" /> Slice a model
              </Link>
            )
          }
        >
          {current ? "Drag jobs or projects here, or use their Move to." : "Finished slices and projects land here, ready to print again."}
        </EmptyState>
      ) : (
        <>
          {shownProjects.length > 0 && (
            <table className="data-table cards">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Status</th>
                  <th>Created</th>
                  {paths.length > 0 && <th>Folder</th>}
                </tr>
              </thead>
              <tbody>
                {shownProjects.map((p) => (
                  <tr key={p.id} {...dragProps({ kind: "project", id: p.id })}>
                    <td className="cell-title">
                      <Icon name="projects" size={14} /> <Link to={`/projects/${p.id}`}>{p.name}</Link>
                      <ItemLabels kind="project" id={p.id} readOnly />
                    </td>
                    <td data-label="Status">{STATUS_LABELS[p.status]}</td>
                    <td data-label="Created">{localDate(p.created_at)}</td>
                    {paths.length > 0 && <td data-label="Folder">{moveSelect({ kind: "project", id: p.id })}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {shownSlices.length > 0 && (
            <table className="data-table cards">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>By</th>
                  {flat && <th>Group</th>}
                  <th>Date</th>
                  <th>Print time</th>
                  <th>Filament</th>
                  <th>Size</th>
                  {paths.length > 0 && <th>Folder</th>}
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {shownSlices.map((s) => (
                  <tr key={s.id} {...dragProps({ kind: "job", id: s.job_id })}>
                    <td className="cell-title">
                      <Link to={previewPath(s.job_id)} title="Preview">
                        {s.model_name}
                      </Link>
                      <ItemLabels kind="job" id={s.job_id} readOnly />
                    </td>
                    <td data-label="By">{s.username ?? "—"}</td>
                    {flat && (
                      <td data-label="Group">{s.group_id ? <Link to={`/groups/${s.group_id}`}>{s.group_name}</Link> : "Personal"}</td>
                    )}
                    <td data-label="Date">{localDate(s.created_at)}</td>
                    <td data-label="Print time">{formatDuration(s.print_time_sec)}</td>
                    <td data-label="Filament">{s.filament_used_g.toFixed(1)}g</td>
                    <td data-label="Size">{formatSize(s.file_size)}</td>
                    {paths.length > 0 && <td data-label="Folder">{moveSelect({ kind: "job", id: s.job_id })}</td>}
                    <td className="cell-actions">
                      <a className="btn-sm" href={`/api/slices/${s.id}/download`} download>
                        G-code
                      </a>
                      {s.has_model && (
                        <a className="btn-sm" href={`/api/jobs/${s.job_id}/model`} download>
                          Model
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
