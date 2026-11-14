#!/usr/bin/env node
// e2e-env: FARMSLICER_LAN_HEADER=X-FarmSlicer-LAN
// End-to-end test of sharing (src/shares.rs): jobs, projects, folders and
// group libraries shared with people and groups at view, use and edit,
// what each level allows, who may share, dropping a share, and public
// links (off by default, read only, reachable from the internet). Against
// a fresh server (first-run setup); a FARMSLICER_SKIP_CXX server is enough.
//
//   node tests/sharing-e2e.mjs http://localhost:9337
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";

console.log(`sharing e2e against ${BASE}`);
const json = (r) => JSON.stringify(r.json);
const LAN = { "X-FarmSlicer-LAN": "1" };

const owner = new Client(LAN);
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));
async function enrol(username) {
  const made = await owner.post("/api/users", { username, role: "user" });
  const token = made.json.invite_url.split("/invite/")[1];
  const client = new Client(LAN);
  const done = await register(client, new SoftAuthenticator(), `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "k");
  check(done.status === 200, `${username} enrols`, json(done));
  return { client, id: made.json.user.id };
}
const ann = await enrol("ann");
const bob = await enrol("bob");
const carl = await enrol("carl");
const dee = await enrol("dee");
const eve = await enrol("eve");

r = await owner.post("/api/groups", { name: "Club", settings: { shared_library: false } });
const club = r.json.id;
r = await owner.post("/api/groups", { name: "Team", settings: { shared_library: false } });
const team = r.json.id;
r = await owner.post("/api/groups", { name: "Juniors", parent_id: team });
const juniors = r.json.id;
await owner.post(`/api/groups/${club}/members`, { username: "bob", role: "member" });
await owner.post(`/api/groups/${team}/members`, { username: "dee", role: "member" });
await owner.post(`/api/groups/${juniors}/members`, { username: "eve", role: "member" });

const stl = new Blob(["solid cube\nendsolid cube\n"], { type: "model/stl" });
const job = async (who, name, group) => {
  const fields = { source: "browser", model: [stl, name] };
  if (group) fields.group_id = group;
  const res = await who.client.form("/api/jobs", fields);
  check(res.status === 201, `${name} made`, json(res));
  return res.json.id;
};
const j1 = await job(ann, "one.stl");
const j2 = await job(ann, "two.stl");
const clubJob = await job(bob, "club.stl", club);
r = await ann.client.post("/api/projects", { name: "Brackets" });
const project = r.json.id;

const share = (who, kind, id, withWho, level = "view", extra = {}) =>
  who.post("/api/shares", { kind, target_id: id, with: withWho, level, ...extra });

// ---- a job, shared with a person, level by level ---------------------------------------------
r = await carl.client.get(`/api/jobs/${j1}`);
check(r.status === 404, "carl can't see ann's job", json(r));
r = await bob.client.post("/api/shares", { kind: "job", target_id: j1, with: { kind: "user", id: "carl" } });
check(r.status === 404, "bob can't share what isn't his", json(r));
r = await share(ann.client, "job", j1, { kind: "user", id: "carl" }, "view", { expires_days: 30 });
check(r.status === 201 && r.json.who === "carl" && r.json.level === "view" && r.json.expires_at, "ann shares her job with carl to view, for 30 days", json(r));
const carlShare = r.json.id;
r = await carl.client.get(`/api/jobs/${j1}`);
check(r.status === 200, "carl sees it", json(r));
r = await carl.client.get("/api/jobs");
check(r.json.some((j) => j.id === j1) && !r.json.some((j) => j.id === j2), "it's in his job list, and only it", json(r));
r = await carl.client.get(`/api/jobs/${j1}/model`);
check(r.status === 403, "view: no model download", json(r));
r = await carl.client.post(`/api/jobs/${j1}/print`, { printer_id: "x", plate: 1 });
check(r.status === 403, "view: no printing", json(r));
r = await carl.client.post("/api/queue", { job_id: j1, plate: 1 });
check(r.status === 403, "view: no queueing", json(r));
r = await owner.post("/api/labels", { name: "Ready", scope: "site" });
const ready = r.json.id;
r = await carl.client.put(`/api/labels/${ready}/items`, { kind: "job", target_id: j1, on: true });
check(r.status === 403, "view: no labelling", json(r));

r = await share(ann.client, "job", j1, { kind: "user", id: carl.id }, "use");
check(r.status === 201 && r.json.id === carlShare && r.json.level === "use" && !r.json.expires_at, "sharing again changes the level (and the expiry)", json(r));
r = await carl.client.get(`/api/jobs/${j1}/model`);
check(r.status === 200, "use: he downloads the model", json(r));
r = await share(ann.client, "job", j1, { kind: "user", id: carl.id }, "edit");
r = await carl.client.put(`/api/labels/${ready}/items`, { kind: "job", target_id: j1, on: true });
check(r.status === 204, "edit: he labels it", json(r));
r = await carl.client.del(`/api/jobs/${j1}`);
check(r.status === 403, "edit: he still can't delete it", json(r));
r = await carl.client.put(`/api/jobs/${j1}`, { group_id: club });
check(r.status === 403, "nor move it to a group", json(r));
r = await carl.client.post("/api/shares", { kind: "job", target_id: j1, with: { kind: "user", id: "dee" } });
check(r.status === 403, "nor share it on", json(r));

r = await ann.client.get(`/api/shares?kind=job&id=${j1}`);
check(r.status === 200 && r.json.shares.length === 1 && r.json.public_links === false, "ann sees who has it", json(r));
r = await carl.client.get(`/api/shares?kind=job&id=${j1}`);
check(r.status === 403, "carl doesn't", json(r));
r = await carl.client.get("/api/shares/mine");
check(r.json.length === 1 && r.json[0].name === "one.stl" && r.json[0].by === "ann" && r.json[0].level === "edit", "carl's 'shared with me'", json(r));
r = await carl.client.del(`/api/shares/${carlShare}`);
check(r.status === 204, "carl drops it", String(r.status));
r = await carl.client.get(`/api/jobs/${j1}`);
check(r.status === 404, "and no longer sees it", json(r));

// ---- with a group (its subgroups' members too) ---------------------------------------------------
r = await share(ann.client, "job", j2, { kind: "group", id: team });
check(r.status === 201 && r.json.who === "members of Team", "ann shares her other job with Team", json(r));
r = await eve.client.get(`/api/jobs/${j2}`);
check(r.status === 200, "eve, in Team's subgroup, sees it", json(r));
r = await bob.client.get(`/api/jobs/${j2}`);
check(r.status === 404, "bob, outside Team, doesn't", json(r));

// ---- a folder: its contents and below ---------------------------------------------------------
r = await ann.client.post("/api/folders", { name: "Parts" });
const parts = r.json.id;
r = await ann.client.post("/api/folders", { name: "Plans", parent_id: parts });
const plans = r.json.id;
await ann.client.put("/api/folders/items", { kind: "job", item_id: j1, folder_id: parts });
await ann.client.put("/api/folders/items", { kind: "project", item_id: project, folder_id: plans });
r = await share(ann.client, "folder", parts, { kind: "user", id: "bob" });
check(r.status === 201, "ann shares a folder with bob", json(r));
r = await bob.client.get(`/api/jobs/${j1}`);
check(r.status === 200, "bob sees the job filed in it", json(r));
r = await bob.client.get(`/api/projects/${project}`);
check(r.status === 200, "and the project in its subfolder", json(r));
r = await bob.client.get(`/api/jobs/${j1}/model`);
check(r.status === 403, "at view level", json(r));
await ann.client.put("/api/folders/items", { kind: "job", item_id: j1, folder_id: null });
r = await bob.client.get(`/api/jobs/${j1}`);
check(r.status === 404, "taken out of the folder, it's no longer shared", json(r));

// ---- a whole group library -------------------------------------------------------------------
r = await bob.client.post("/api/shares", { kind: "library", target_id: club, with: { kind: "group", id: team } });
check(r.status === 403, "a member can't share the group's library", json(r));
r = await share(owner, "library", club, { kind: "group", id: team }, "use");
check(r.status === 201, "the owner shares Club's library with Team", json(r));
r = await dee.client.get("/api/jobs");
check(r.json.some((j) => j.id === clubJob), "dee sees Club's job in her list", json(r));
r = await dee.client.get(`/api/jobs/${clubJob}/model`);
check(r.status === 200, "and may use it", json(r));

// ---- public links ----------------------------------------------------------------------------
r = await share(ann.client, "job", j2, { kind: "link" });
check(r.status === 403, "public links are off by default", json(r));
r = await owner.put("/api/settings", { public_shares: true });
check(r.status === 200 && r.json.public_shares === true, "the owner turns them on", json(r));
r = await share(ann.client, "job", j2, { kind: "link" }, "use");
check(r.status === 400, "public links are view only", json(r));
r = await share(owner, "library", club, { kind: "link" });
check(r.status === 400, "and not for whole libraries", json(r));
r = await share(ann.client, "folder", parts, { kind: "link" });
check(r.status === 201 && r.json.url?.includes("/s/") && r.json.code, "ann makes a public link to her folder", json(r));
const code = r.json.code;
const link = r.json.id;
await ann.client.put("/api/folders/items", { kind: "job", item_id: j2, folder_id: parts });

const internet = new Client(); // no LAN header: from outside
r = await internet.get(`/api/public/shares/${code}`);
check(r.status === 200 && r.json.name === "Parts" && r.json.shared_by === "ann", "anyone on the internet opens it", json(r));
check(r.json.jobs.length === 1 && r.json.jobs[0].name === "two.stl" && r.json.projects.some((p) => p.name === "Brackets"), "showing what's filed in it and below", json(r));
check(!JSON.stringify(r.json).includes("model_path") && !JSON.stringify(r.json).includes("gcode"), "and no files", json(r));
r = await internet.get(`/api/public/shares/${code}/jobs/${clubJob}/thumbnail`);
check(r.status === 404, "nothing outside it", json(r));
r = await internet.get(`/api/jobs/${j2}`);
check(r.status === 401 || r.status === 403, "the rest of the API stays shut", json(r));
r = await internet.get("/api/public/shares/nonsense");
check(r.status === 404, "a wrong code finds nothing", json(r));
await owner.put("/api/settings", { public_shares: false });
r = await internet.get(`/api/public/shares/${code}`);
check(r.status === 404, "turning public links off stops every link", json(r));
await owner.put("/api/settings", { public_shares: true });
r = await ann.client.del(`/api/shares/${link}`);
check(r.status === 204, "ann removes the link", String(r.status));
r = await internet.get(`/api/public/shares/${code}`);
check(r.status === 404, "and it's dead", json(r));

// ---- cleanup and audit --------------------------------------------------------------------------
r = await ann.client.post(`/api/jobs/${j2}/cancel`);
r = await ann.client.del(`/api/jobs/${j2}`);
r = await eve.client.get("/api/shares/mine");
check(!r.json.some((s) => s.target_id === j2), "a deleted job's shares go with it", json(r));
r = await owner.get("/api/audit?action=share.");
const actions = r.json.entries.map((e) => `${e.actor_name}:${e.action}`);
check(actions.includes("ann:share.create") && actions.includes("carl:share.delete") && actions.includes("owner:share.create"), "shares are audited", actions.join(" | "));

finish();
