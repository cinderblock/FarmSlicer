#!/usr/bin/env node
// End-to-end test of labels (src/labels.rs): personal, group and site
// labels, who sees them and what they're on, who may make them and put
// them on jobs, projects, printers and groups, and cleanup. Against a
// fresh server (first-run setup); a FARMSLICER_SKIP_CXX server is enough.
//
//   node tests/labels-e2e.mjs http://localhost:9337
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";

console.log(`labels e2e against ${BASE}`);
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
const carl = await enrol("carl");

r = await owner.post("/api/groups", { name: "Club", settings: { shared_library: false } });
const club = r.json.id;
await owner.post(`/api/groups/${club}/members`, { username: "ann", role: "member" });
await owner.post(`/api/groups/${club}/members`, { username: "bob", role: "manager" });

const stl = new Blob(["solid cube\nendsolid cube\n"], { type: "model/stl" });
r = await ann.client.form("/api/jobs", { source: "browser", model: [stl, "cube.stl"], group_id: club });
const annJob = r.json.id;
r = await ann.client.post("/api/projects", { name: "Brackets" });
check(r.status === 201, "ann makes a project", json(r));
const annProject = r.json.id;
r = await owner.post("/api/printers", { name: "Voron", machine_profile: "Voron 2.4 350", nozzle_diameter: "0.4", protocol: "moonraker", address: "127.0.0.1:9" });
check(r.status === 201, "a printer", json(r));
const printer = r.json.id;

// ---- making labels ----------------------------------------------------------------
r = await ann.client.post("/api/labels", { name: "mine", color: "teal" });
check(r.status === 201 && r.json.scope === "user" && r.json.can_manage, "ann makes a personal label", json(r));
const annLabel = r.json.id;
r = await ann.client.post("/api/labels", { name: "MINE", color: "red" });
check(r.status === 409, "names are unique per owner", json(r));
r = await bob.client.post("/api/labels", { name: "mine" });
check(r.status === 201, "…not across owners", json(r));
r = await ann.client.post("/api/labels", { name: "x", color: "chartreuse" });
check(r.status === 400, "colours come from the list", json(r));
r = await ann.client.post("/api/labels", { name: "Urgent", scope: "site" });
check(r.status === 403 && r.json.missing_capability === "labels.manage", "users don't make site labels", json(r));
r = await owner.post("/api/labels", { name: "Urgent", scope: "site", color: "red" });
check(r.status === 201, "the owner makes a site label", json(r));
const urgent = r.json.id;
r = await ann.client.post("/api/labels", { name: "Season 1", scope: "group", group_id: club });
check(r.status === 403, "members don't make group labels", json(r));
r = await bob.client.post("/api/labels", { name: "Season 1", scope: "group", group_id: club, color: "blue" });
check(r.status === 201 && r.json.owner_name === "Club", "the group's manager does", json(r));
const season = r.json.id;

r = await ann.client.get("/api/labels");
let names = r.json.labels.map((l) => l.name).sort().join();
check(names === "Season 1,Urgent,mine", "ann sees hers, her group's and the site's", json(r));
check(r.json.groups.length === 0 && r.json.can_make_site === false, "…and may make only personal ones", json(r));
r = await carl.client.get("/api/labels");
names = r.json.labels.map((l) => l.name).sort().join();
check(names === "Urgent", "carl sees only the site's", json(r));
r = await bob.client.get("/api/labels");
check(r.json.groups.some((g) => g.id === club), "bob may make Club's labels", json(r));

// ---- putting labels on things ---------------------------------------------------------
const put = (c, label, kind, id, on = true) => c.put(`/api/labels/${label}/items`, { kind, target_id: id, on });
r = await put(ann.client, annLabel, "job", annJob);
check(r.status === 204, "ann labels her job", json(r));
r = await put(ann.client, urgent, "job", annJob);
check(r.status === 204, "…with a site label too (she can change the job)", json(r));
r = await put(ann.client, season, "project", annProject);
check(r.status === 204, "…and her project with the group's label", json(r));
r = await put(ann.client, urgent, "printer", printer);
check(r.status === 403, "she can't put a shared label on a printer", json(r));
r = await put(ann.client, annLabel, "printer", printer);
check(r.status === 204, "…but her own label, yes", json(r));
r = await put(ann.client, season, "group", club);
check(r.status === 403, "she can't label the group", json(r));
r = await put(bob.client, season, "group", club);
check(r.status === 204, "its manager can", json(r));
r = await put(carl.client, urgent, "job", annJob);
check(r.status === 404, "carl can't label a job he can't see", json(r));
r = await put(carl.client, annLabel, "printer", printer);
check(r.status === 404, "nor use ann's label", json(r));
r = await put(ann.client, annLabel, "spaceship", printer);
check(r.status === 400, "unknown kinds are refused", json(r));

r = await ann.client.get("/api/labels");
check(r.json.links.job?.[annJob]?.sort().join() === [annLabel, urgent].sort().join(), "ann's job carries both", json(r));
check(r.json.links.printer?.[printer]?.join() === annLabel && r.json.links.group?.[club]?.join() === season, "her printer label and the group's", json(r));
r = await carl.client.get("/api/labels");
check(!r.json.links.job && !r.json.links.printer, "carl sees none of it (not her label, not her job)", json(r));
r = await bob.client.get("/api/labels");
check(r.json.links.job?.[annJob]?.join() === urgent && !r.json.links.printer, "bob, who manages Club, sees the job's site label, not her personal ones", json(r));

r = await put(ann.client, annLabel, "job", annJob, false);
check(r.status === 204, "ann takes her label off", json(r));

// ---- changing and deleting ---------------------------------------------------------------
r = await ann.client.put(`/api/labels/${urgent}`, { name: "Not urgent", color: "red" });
check(r.status === 403, "ann can't rename the site's label", json(r));
r = await carl.client.put(`/api/labels/${annLabel}`, { name: "carl's", color: "red" });
check(r.status === 404, "carl can't even find ann's", json(r));
r = await ann.client.put(`/api/labels/${annLabel}`, { name: "mine!", color: "pink" });
check(r.status === 200 && r.json.name === "mine!" && r.json.color === "pink", "ann renames hers", json(r));
r = await owner.del(`/api/labels/${urgent}`);
check(r.status === 204, "the owner deletes the site label", String(r.status));
r = await ann.client.get("/api/labels");
check(!r.json.links.job?.[annJob], "it came off the job", json(r));
r = await ann.client.del(`/api/jobs/${annJob}`);
r = await ann.client.post(`/api/jobs/${annJob}/cancel`);
r = await ann.client.del(`/api/projects/${annProject}`);
r = await ann.client.get("/api/labels");
check(!r.json.links.project?.[annProject], "a deleted project's labels go with it", json(r));
r = await owner.del(`/api/groups/${club}`);
check(r.status === 204, "Club deleted", json(r));
r = await bob.client.get("/api/labels");
check(!r.json.labels.some((l) => l.id === season), "its labels went with it", json(r));

r = await owner.get("/api/audit?action=label.");
const actions = r.json.entries.map((e) => `${e.actor_name}:${e.action}:${e.target_name}`);
check(actions.includes("owner:label.create:Urgent") && actions.includes("bob:label.create:Season 1") && actions.includes("owner:label.delete:Urgent"), "shared labels are audited", actions.join(" | "));
check(!actions.some((a) => a.includes(":mine")), "personal ones aren't", actions.join(" | "));

finish();
