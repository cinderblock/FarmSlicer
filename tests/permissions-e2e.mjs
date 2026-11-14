#!/usr/bin/env node
// End-to-end test of roles and capabilities (src/permissions.rs): custom
// site and group roles, what they open and what they don't, the rule that
// nobody hands out permissions they don't hold, suspended accounts, and
// the audit log. Against a fresh server (first-run setup); a server built
// with FARMSLICER_SKIP_CXX is enough.
//
//   node tests/permissions-e2e.mjs http://localhost:9337
import { BASE, check, Client, SoftAuthenticator, register, login, finish } from "./lib.mjs";

console.log(`permissions e2e against ${BASE}`);
const json = (r) => JSON.stringify(r.json);

const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));
r = await owner.get("/api/auth/status");
check(r.json.user?.caps?.includes("roles.manage") && r.json.user?.role_name === "Owner", "the owner holds every capability", json(r));

/** Make an account with `role` through `by`, enrol a passkey; the client is signed in. */
async function enrol(username, role = "user", by = owner) {
  const made = await by.post("/api/users", { username, role });
  if (made.status !== 201) return { made };
  const token = made.json.invite_url.split("/invite/")[1];
  const client = new Client();
  const authn = new SoftAuthenticator();
  const done = await register(client, authn, `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "k");
  check(done.status === 200, `${username} enrols`, json(done));
  return { made, client, authn, id: made.json.user.id };
}

// ---- the catalogue ----------------------------------------------------------------
r = await owner.get("/api/roles");
const builtins = r.json.roles?.filter((x) => x.builtin).map((x) => x.id).sort().join();
check(builtins === "admin,manager,member,owner,user", "built-in roles listed", json(r));
check(r.json.capabilities?.site?.some((c) => c.id === "printers.manage") && r.json.capabilities?.group?.some((c) => c.id === "prints.approve"), "capability lists offered");

// ---- custom site roles ------------------------------------------------------------
r = await owner.post("/api/roles", { name: "Printer admin", scope: "site", caps: ["printers.manage", "printers.operate"] });
check(r.status === 201 && r.json.id?.startsWith("r_") && r.json.holders === 0, "owner makes a site role", json(r));
const printerAdmin = r.json.id;
r = await owner.post("/api/roles", { name: "printer ADMIN", scope: "site", caps: [] });
check(r.status === 409, "role names are unique per scope (any case)", json(r));
r = await owner.post("/api/roles", { name: "Admin", scope: "site", caps: [] });
check(r.status === 400, "a built-in role's name is taken", json(r));
r = await owner.post("/api/roles", { name: "Nope", scope: "site", caps: ["no.such"] });
check(r.status === 400, "unknown capabilities are refused", json(r));
r = await owner.put("/api/roles/admin", { name: "Admin", caps: [] });
check(r.status === 400, "built-in roles can't be changed", json(r));
r = await owner.post("/api/roles", { name: "Account admin", scope: "site", caps: ["users.view", "users.manage", "roles.manage"] });
check(r.status === 201, "an account-admin role", json(r));
const accountAdmin = r.json.id;

const alice = await enrol("alice");
const carol = await enrol("carol", printerAdmin);
const dave = await enrol("dave", accountAdmin);
r = await carol.client.get("/api/auth/status");
check(r.json.user?.role === printerAdmin && r.json.user?.role_name === "Printer admin" && r.json.user?.caps?.join() === "printers.manage,printers.operate", "carol's session carries her role's capabilities", json(r));

// what a role opens, and what it doesn't
r = await carol.client.post("/api/pools", { name: "Bay", printer_ids: [] });
check(r.status === 201, "printer admin makes a pool", json(r));
r = await alice.client.post("/api/pools", { name: "Bay 2", printer_ids: [] });
check(r.status === 403 && r.json.missing_capability === "printers.manage", "a user can't, and is told which permission is missing", json(r));
r = await carol.client.get("/api/users");
check(r.status === 403, "printer admin can't see accounts", json(r));
r = await carol.client.get("/api/settings");
check(r.status === 403, "printer admin can't open site settings", json(r));
r = await dave.client.get("/api/users");
check(r.status === 200 && r.json.length === 4, "account admin sees accounts", json(r));
check(r.json.find((u) => u.username === "carol")?.manageable === false && r.json.find((u) => u.username === "alice")?.manageable === true, "…and which of them he may change");
r = await dave.client.get("/api/pools");
check(r.status === 200 && r.json.pools?.length === 0, "account admin doesn't see pools", json(r));

// nobody hands out what they don't hold
r = await dave.client.post("/api/users", { username: "eve", role: "admin" });
check(r.status === 403, "account admin can't make an admin", json(r));
r = await dave.client.post("/api/users", { username: "eve", role: printerAdmin });
check(r.status === 403, "…nor give a role with permissions he lacks", json(r));
r = await dave.client.post("/api/users", { username: "eve", role: "owner" });
check(r.status === 400, "nobody gives the owner role", json(r));
const eve = await enrol("eve", "user", dave.client);
check(eve.made.status === 201, "account admin makes a user", json(eve.made));
r = await dave.client.put(`/api/users/${carol.id}`, { remote_access: true });
check(r.status === 403, "account admin can't change a printer admin", json(r));
r = await dave.client.put(`/api/users/${alice.id}`, { role: accountAdmin });
check(r.status === 200 && r.json.role === accountAdmin && r.json.role_name === "Account admin", "…but can give his own role", json(r));
r = await dave.client.put(`/api/users/${alice.id}`, { role: "user" });
check(r.status === 200 && r.json.role === "user", "…and take it back", json(r));
r = await dave.client.post("/api/roles", { name: "Sneaky", scope: "site", caps: ["printers.manage"] });
check(r.status === 403, "a role can't be made with permissions you lack", json(r));
r = await dave.client.post("/api/roles", { name: "Viewer", scope: "site", caps: ["users.view"] });
check(r.status === 201, "…but can with ones you hold", json(r));
const viewerRole = r.json.id;
r = await dave.client.put(`/api/roles/${printerAdmin}`, { name: "Printer admin", caps: [] });
check(r.status === 403, "…and can't strip a role of permissions you lack", json(r));
r = await dave.client.put(`/api/users/${dave.id}`, { role: "admin" });
check(r.status === 403, "nobody raises their own role", json(r));
r = await dave.client.put(`/api/users/${(await owner.get("/api/auth/status")).json.user.id}`, { remote_access: true });
check(r.status === 403, "nobody but the owner changes the owner", json(r));

// roles in use stay
r = await owner.del(`/api/roles/${printerAdmin}`);
check(r.status === 409 && /1 account/.test(r.json.error), "a role someone holds can't be deleted", json(r));
r = await owner.del(`/api/roles/${viewerRole}`);
check(r.status === 204, "an unused role is deleted", String(r.status));
r = await owner.put(`/api/roles/${printerAdmin}`, { name: "Printer admin", caps: ["printers.manage"] });
check(r.status === 200, "owner changes a role", json(r));
r = await carol.client.get("/api/auth/status");
check(r.json.user?.caps?.join() === "printers.manage", "a role's change applies at once", json(r));

// ---- suspension ---------------------------------------------------------------------
r = await alice.client.post("/api/me/api-keys", { name: "script" });
const aliceKey = new Client();
aliceKey.bearer = r.json.key;
r = await aliceKey.get("/api/jobs");
check(r.status === 200, "alice's API key works", json(r));
r = await dave.client.put(`/api/users/${dave.id}`, { suspended: true });
check(r.status === 400, "nobody suspends themselves", json(r));
r = await dave.client.put(`/api/users/${alice.id}`, { suspended: true, suspend_reason: "left the club" });
check(r.status === 200 && r.json.suspended_at && r.json.suspended_by === "dave" && r.json.suspend_reason === "left the club", "account admin suspends alice", json(r));
r = await alice.client.get("/api/jobs");
check(r.status === 401, "her sessions end", json(r));
r = await aliceKey.get("/api/jobs");
check(r.status === 403 && r.json.suspended === true, "her API key is refused as suspended", json(r));
const again = new Client();
r = await login(again, alice.authn, "alice");
check(r.status === 403 && r.json.suspended === true, "she can't sign in", json(r));
r = await dave.client.put(`/api/users/${alice.id}`, { suspended: false });
check(r.status === 200 && !r.json.suspended_at, "reinstated", json(r));
r = await login(again, alice.authn, "alice");
check(r.status === 200, "she signs in again", json(r));
r = await aliceKey.get("/api/jobs");
check(r.status === 200, "her API key works again", json(r));
alice.client = again;

// ---- group roles --------------------------------------------------------------------
r = await dave.client.post("/api/roles", { name: "Approver", scope: "group", caps: ["prints.approve"] });
check(r.status === 403, "group roles need 'manage every group'", json(r));
r = await owner.post("/api/roles", { name: "Approver", scope: "group", caps: ["prints.approve", "library.view"] });
check(r.status === 201 && r.json.scope === "group", "owner makes a group role", json(r));
const approver = r.json.id;
r = await owner.post("/api/roles", { name: "Bouncer", scope: "group", caps: ["members"] });
const bouncer = r.json.id;

r = await owner.post("/api/groups", { name: "Club", settings: { shared_library: false } });
const club = r.json.id;
r = await owner.post("/api/groups", { name: "Juniors", parent_id: club });
const juniors = r.json.id;
r = await owner.post(`/api/groups/${club}/members`, { username: "alice", role: "member" });
check(r.status === 201, "alice joins the club", json(r));
r = await owner.post(`/api/groups/${club}/members`, { username: "eve", role: approver });
check(r.status === 201 && r.json.role === approver, "eve approves for the club", json(r));
r = await owner.post(`/api/groups/${club}/members`, { username: "dave", role: bouncer });
check(r.status === 201, "dave keeps the club's door", json(r));
r = await owner.post(`/api/groups/${club}/members`, { username: "carol", role: "nonsense" });
check(r.status === 403, "an unknown group role is refused", json(r));

r = await eve.client.get("/api/groups");
const eveClub = r.json.find((g) => g.id === club);
check(eveClub?.my_caps?.join() === "library.view,prints.approve" && eveClub?.can_manage === true, "eve's capabilities in the club", json(r));
check(r.json.find((g) => g.id === juniors)?.my_caps?.length === 2, "…hold in its subgroups too", json(r));

// a job in the club: the approver sees it without a shared library
const stl = new Blob(["solid cube\nendsolid cube\n"], { type: "model/stl" });
r = await alice.client.form("/api/jobs", { source: "browser", model: [stl, "cube.stl"], group_id: club });
check(r.status === 201, "alice slices for the club", json(r));
const job = r.json.id;
r = await eve.client.get(`/api/jobs/${job}`);
check(r.status === 200, "the approver sees the club's job", json(r));
r = await dave.client.get(`/api/jobs/${job}`);
check(r.status === 404, "the bouncer doesn't", json(r));
r = await eve.client.del(`/api/jobs/${job}`);
check(r.status === 403, "seeing isn't editing", json(r));

// the bouncer manages members, within his own role
r = await dave.client.post(`/api/groups/${club}/members`, { username: "carol", role: "member" });
check(r.status === 201, "the bouncer adds a member", json(r));
r = await dave.client.post(`/api/groups/${club}/members`, { username: "owner", role: approver });
check(r.status === 403, "…but can't give the approver role (he can't approve)", json(r));
r = await dave.client.put(`/api/groups/${club}/members/${eve.id}`, { role: "member" });
check(r.status === 403, "…nor demote the approver", json(r));
r = await dave.client.put(`/api/groups/${club}`, { name: "Dave's club" });
check(r.status === 403, "…nor rename the group", json(r));
r = await dave.client.post(`/api/groups/${club}/links`, { public: false });
check(r.status === 403, "…nor make join links", json(r));
r = await dave.client.del(`/api/groups/${club}/members/${carol.id}`);
check(r.status === 204, "…and removes a member", String(r.status));
r = await owner.del(`/api/roles/${approver}`);
check(r.status === 409, "a group role someone holds can't be deleted", json(r));

// ---- the audit log ------------------------------------------------------------------
r = await dave.client.get("/api/audit");
check(r.status === 403, "the audit log needs its permission", json(r));
r = await owner.get("/api/audit?limit=200");
const actions = (r.json.entries ?? []).map((e) => `${e.actor_name}:${e.action}:${e.target_name}`);
for (const want of [
  "owner:role.create:Printer admin",
  "dave:user.create:eve",
  "dave:user.role:alice",
  "dave:user.suspend:alice",
  "dave:user.reinstate:alice",
  "owner:role.update:Printer admin",
  "owner:role.delete:Viewer",
  "owner:group.create:Club",
  "dave:group.member.add:Club",
  "dave:group.member.remove:Club",
]) {
  check(actions.includes(want), `audit: ${want}`, actions.slice(0, 40).join(" | "));
}
const suspend = r.json.entries.find((e) => e.action === "user.suspend");
check(suspend?.detail?.reason === "left the club" && suspend.target_kind === "user" && suspend.target_id === alice.id, "an entry says what changed", json(r));
r = await owner.get(`/api/audit?action=group.&target=${club}`);
check(r.json.entries.length > 0 && r.json.entries.every((e) => e.action.startsWith("group.") && e.target_id === club), "filtered by action prefix and target", json(r));
r = await owner.get("/api/audit?limit=2");
check(r.json.entries.length === 2 && r.json.next_before === r.json.entries[1].id, "paged", json(r));
const cursor = r.json.next_before;
r = await owner.get(`/api/audit?limit=2&before=${cursor}`);
check(r.json.entries.length === 2 && r.json.entries.every((e) => e.id < cursor), "next page", json(r));

finish();
