#!/usr/bin/env node
// End-to-end test of library folders (src/folders.rs): personal and group
// libraries, who sees and makes folders, filing items only in their own
// library, moving and deleting folders, and items leaving a folder when
// they move to another group. Against a fresh server (first-run setup); a
// FARMSLICER_SKIP_CXX server is enough.
//
//   node tests/folders-e2e.mjs http://localhost:9337
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";

console.log(`folders e2e against ${BASE}`);
const json = (r) => JSON.stringify(r.json);

const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));
async function enrol(username) {
  const made = await owner.post("/api/users", { username, role: "user" });
  const token = made.json.invite_url.split("/invite/")[1];
  const client = new Client();
  const done = await register(client, new SoftAuthenticator(), `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "k");
  check(done.status === 200, `${username} enrols`, json(done));
  return { client, id: made.json.user.id };
}
const ann = await enrol("ann");
const bob = await enrol("bob");
const mia = await enrol("mia");
const carl = await enrol("carl");

r = await owner.post("/api/groups", { name: "Club", settings: { shared_library: false } });
const club = r.json.id;
await owner.post(`/api/groups/${club}/members`, { username: "ann", role: "member" });
await owner.post(`/api/groups/${club}/members`, { username: "mia", role: "member" });
await owner.post(`/api/groups/${club}/members`, { username: "bob", role: "manager" });

const stl = new Blob(["solid cube\nendsolid cube\n"], { type: "model/stl" });
r = await ann.client.form("/api/jobs", { source: "browser", model: [stl, "mine.stl"] });
const personalJob = r.json.id;
r = await ann.client.form("/api/jobs", { source: "browser", model: [stl, "club.stl"], group_id: club });
const clubJob = r.json.id;
r = await ann.client.post("/api/projects", { name: "Brackets" });
const project = r.json.id;

r = await ann.client.get("/api/folders");
check(r.json.libraries.map((l) => l.name).join() === "My library,Club" && r.json.libraries[1].can_manage === false, "ann's libraries: hers, and Club's (not hers to arrange)", json(r));

// ---- personal folders ---------------------------------------------------------------
r = await ann.client.post("/api/folders", { name: "Brackets" });
check(r.status === 201 && r.json.library_kind === "user" && r.json.library_id === ann.id, "ann makes a folder in her library", json(r));
const brackets = r.json.id;
r = await ann.client.post("/api/folders", { name: "brackets" });
check(r.status === 409, "names are unique in a folder", json(r));
r = await ann.client.post("/api/folders", { name: "a/b" });
check(r.status === 400, "no slashes", json(r));
r = await ann.client.post("/api/folders", { name: "v2", parent_id: brackets });
check(r.status === 201 && r.json.parent_id === brackets, "and a subfolder", json(r));
const v2 = r.json.id;
r = await ann.client.post("/api/folders", { name: "Brackets", parent_id: brackets });
check(r.status === 201, "the same name is fine one level down", json(r));
const inner = r.json.id;

const fileIt = (c, kind, id, folder) => c.put("/api/folders/items", { kind, item_id: id, folder_id: folder });
r = await fileIt(ann.client, "job", personalJob, v2);
check(r.status === 204, "she files her job in v2", json(r));
r = await fileIt(ann.client, "project", project, brackets);
check(r.status === 204, "and her project in Brackets", json(r));
r = await fileIt(ann.client, "job", clubJob, brackets);
check(r.status === 400 && /another library/.test(r.json.error), "a Club job doesn't go in her own folder", json(r));
r = await fileIt(bob.client, "job", personalJob, null);
check(r.status === 404, "bob can't touch her personal job", json(r));
r = await ann.client.get("/api/folders");
check(r.json.items.job?.[personalJob] === v2 && r.json.items.project?.[project] === brackets, "she sees where they're filed", json(r));
r = await bob.client.get("/api/folders");
check(!r.json.folders.some((f) => f.library_kind === "user" && f.library_id === ann.id), "nobody else sees her folders", json(r));

// ---- group folders ------------------------------------------------------------------
r = await ann.client.post("/api/folders", { name: "Season 1", library: "group", group_id: club });
check(r.status === 403, "a member can't make the group's folders", json(r));
r = await bob.client.post("/api/folders", { name: "Season 1", library: "group", group_id: club });
check(r.status === 201 && r.json.library_kind === "group" && r.json.can_manage, "its manager can", json(r));
const season = r.json.id;
r = await fileIt(ann.client, "job", clubJob, season);
check(r.status === 204, "ann files her Club job there (she can change the job)", json(r));
r = await fileIt(mia.client, "job", clubJob, null);
check(r.status === 404, "mia can't (the library isn't shared: she can't see it)", json(r));
r = await mia.client.get("/api/folders");
check(r.json.folders.some((f) => f.id === season) && !r.json.items.job?.[clubJob], "mia sees the folder, not what she can't see in it", json(r));
r = await bob.client.get("/api/folders");
check(r.json.items.job?.[clubJob] === season, "bob sees the job filed", json(r));
r = await carl.client.get("/api/folders");
check(!r.json.folders.some((f) => f.id === season) && r.json.libraries.length === 1, "carl, outside Club, sees nothing of it", json(r));
r = await carl.client.put(`/api/folders/${season}`, { name: "carl's" });
check(r.status === 404, "nor changes it", json(r));
r = await mia.client.del(`/api/folders/${season}`);
check(r.status === 403, "a member can't delete it", json(r));

// ---- moving and deleting folders --------------------------------------------------------
r = await ann.client.put(`/api/folders/${brackets}`, { parent_id: v2 });
check(r.status === 400 && /inside itself/.test(r.json.error), "a folder can't move inside itself", json(r));
r = await ann.client.put(`/api/folders/${v2}`, { parent_id: season });
check(r.status === 400, "nor to another library", json(r));
r = await ann.client.put(`/api/folders/${inner}`, { parent_id: null });
check(r.status === 409, "nor where its name is taken", json(r));
r = await ann.client.put(`/api/folders/${v2}`, { name: "Version 2" });
check(r.status === 200 && r.json.name === "Version 2" && r.json.parent_id === brackets, "renamed in place", json(r));
r = await ann.client.del(`/api/folders/${v2}`);
check(r.status === 204, "v2 deleted", String(r.status));
r = await ann.client.get("/api/folders");
check(r.json.items.job?.[personalJob] === brackets, "its job moved up into Brackets", json(r));
r = await ann.client.del(`/api/folders/${brackets}`);
r = await ann.client.get("/api/folders");
const innerNow = r.json.folders.find((f) => f.id === inner);
check(!r.json.items.job?.[personalJob] && !r.json.items.project?.[project], "deleting Brackets moves its items to the top", json(r));
check(innerNow?.parent_id === null && innerNow.name === "Brackets (moved)", "and its subfolder up, renamed where the name was taken", json(r));

// ---- items that change library leave their folder ----------------------------------------------
r = await ann.client.put(`/api/jobs/${clubJob}`, { group_id: null });
check(r.status === 200, "ann takes her Club job back to herself", json(r));
r = await bob.client.get("/api/folders");
check(!r.json.items.job?.[clubJob], "it left Club's folder", json(r));
r = await owner.del(`/api/groups/${club}`);
r = await owner.get("/api/folders");
check(!r.json.folders.some((f) => f.id === season), "a deleted group's folders go with it", json(r));

r = await owner.get("/api/audit?action=folder.");
const actions = r.json.entries.map((e) => `${e.actor_name}:${e.action}`);
check(actions.includes("bob:folder.create") && !actions.some((a) => a.startsWith("ann:")), "group folders are audited, personal ones aren't", actions.join(" | "));

finish();
