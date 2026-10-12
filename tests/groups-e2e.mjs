#!/usr/bin/env node
// End-to-end test of groups, join links, self-service subgroups, guest
// accounts, job visibility, model keeping, seasons and quotas, against a
// fresh server (it performs first-run setup). Browser-sourced jobs stand in
// for slicing, so a server built with FARMSLICER_SKIP_CXX is enough.
//
//   node tests/groups-e2e.mjs http://localhost:9337
//
// The server must list that origin in FARMSLICER_ORIGINS. Exit code 0 iff all
// checks pass. No dependencies beyond Node 22.
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";

console.log(`groups e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);

// ---- setup: owner, a league with programs, a self-service team level -------------
const owner = new Client();
const ownerAuthn = new SoftAuthenticator();
let r = await register(owner, ownerAuthn, "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));

r = await owner.post("/api/groups", {
  name: "League",
  description: "Everyone in the league",
  settings: {
    listed: true,
    allow_registration: true,
    allow_guests: true,
    join_policy: "approval",
    subgroups: { mode: "choose", required: true, label: "Program" },
  },
});
check(r.status === 201, "admin creates a top-level group", json(r));
const league = r.json.id;

r = await owner.post("/api/groups", {
  name: "Program A",
  parent_id: league,
  settings: {
    season_start: "09-01",
    keep_models: true,
    subgroups: {
      mode: "self_service",
      required: true,
      label: "Team number",
      pattern: "[0-9]{1,5}",
      name_template: "A {value}",
      creator_becomes_manager: true,
    },
  },
});
check(r.status === 201, "subgroup with self-service teams", json(r));
const programA = r.json.id;

r = await owner.post("/api/groups", {
  name: "Bad",
  parent_id: league,
  settings: { subgroups: { mode: "self_service", pattern: "(", name_template: "x {value}" } },
});
check(r.status === 400, "an invalid pattern is refused", json(r));

r = await new Client().get("/api/auth/status");
check(r.json?.join_groups?.some((g) => g.id === league), "listed group appears on the sign-in page", json(r));

// ---- join flow: resolve step by step ------------------------------------------------
const anon = new Client();
const entry = { group: league };
r = await anon.post("/api/join/resolve", { entry, selection: [] });
check(r.status === 200 && r.json.next?.mode === "choose" && r.json.can_finish === false, "entry asks for a program", json(r));
check(r.json.next?.options?.some((o) => o.id === programA), "program offered as an option");
check(r.json.allow_guests === true && r.json.allow_registration === true, "guests and registration inherited");
r = await anon.post("/api/join/resolve", { entry, selection: [{ group: programA }] });
check(r.json.next?.mode === "self_service" && r.json.next?.label === "Team number", "program asks for a team number", json(r));
r = await anon.post("/api/join/resolve", { entry, selection: [{ group: programA }, { key: "12a" }] });
check(r.status === 400, "an identifier failing the pattern is refused", json(r));
const team254 = [{ group: programA }, { key: "254" }];
r = await anon.post("/api/join/resolve", { entry, selection: team254 });
check(
  r.json.target?.exists === false && r.json.target?.name === "A 254" && r.json.outcome?.role === "manager",
  "new team previewed; creator would manage it",
  json(r),
);
r = await anon.post("/api/join/resolve", { entry: { group: programA }, selection: [] });
check(r.status === 404, "unlisted groups can't be entered by id", json(r));

// ---- guests ---------------------------------------------------------------------------
const kid1 = new Client();
r = await kid1.post("/api/join/guest", { request: { entry, selection: team254 }, username: "kid1" });
check(r.status === 200 && r.json.joined?.created === true && r.json.joined?.role === "manager", "guest creates the team and manages it", json(r));
const kid1Code = r.json.signin_code;
const team = r.json.joined?.group_id;
check(typeof kid1Code === "string" && kid1Code.length > 20, "guest gets a sign-in code");
r = await kid1.get("/api/me");
check(r.json?.kind === "guest" && r.json?.groups?.[0]?.path === "League / Program A / A 254", "guest is signed in, member of the team", json(r));

const kid2 = new Client();
r = await kid2.post("/api/join/guest", { request: { entry, selection: team254 }, username: "kid2" });
check(r.status === 200 && r.json.joined?.status === "pending", "second joiner waits for approval (inherited join_policy)", json(r));
const kid2Id = (await kid2.get("/api/me")).json.id;

r = await kid1.post("/api/me/api-keys", { name: "x" });
check(r.status === 403, "guests can't create API keys", json(r));
r = await kid1.post("/api/printers", { name: "p" });
check(r.status === 403, "guests can't add printers", json(r));
r = await kid1.post("/api/groups", { name: "g", parent_id: team });
check(r.status === 403, "guests can't create groups", json(r));

// sign in on another device with the one-time code
const kid1b = new Client();
r = await kid1b.post("/api/auth/guest/signin", { username: "kid1", code: kid1Code });
check(r.status === 200 && r.json.signin_code && r.json.signin_code !== kid1Code, "guest signs in with the code and gets a new one", json(r));
r = await new Client().post("/api/auth/guest/signin", { username: "kid1", code: kid1Code });
check(r.status === 401, "a sign-in code works once", json(r));
r = await kid1b.get("/api/me");
check(r.json?.username === "kid1", "the second device is signed in", json(r));

// ---- managing members ---------------------------------------------------------------
r = await kid2.get(`/api/groups/${team}/members`);
check(r.status === 403, "pending members can't list members", json(r));
r = await kid1.get(`/api/groups/${team}/members`);
check(r.status === 200 && r.json.some((m) => m.username === "kid2" && m.status === "pending"), "manager sees the pending member", json(r));
r = await kid1.put(`/api/groups/${team}/members/${kid2Id}`, { status: "active" });
check(r.status === 200 && r.json.status === "active", "manager approves", json(r));
r = await kid1.put(`/api/groups/${team}`, { quotas: { pool: [{ metric: "slices", period: "day", limit: 999 }] } });
check(r.status === 403, "a team's own manager can't set its quotas", json(r));
r = await kid1.put(`/api/groups/${team}`, { description: "Robots!" });
check(r.status === 200 && r.json.description === "Robots!", "manager edits the description", json(r));
r = await kid1.put(`/api/groups/${team}`, { settings: { listed: true } });
check(r.status === 403, "only admins list groups", json(r));

// a team invite link skips approval; a passkey account registers through it
r = await kid1.post(`/api/groups/${team}/links`, { label: "mentors" });
check(r.status === 201 && r.json.bypass_approval === true && r.json.public === false, "manager creates a secret link", json(r));
const teamLink = r.json;
const mentor = new Client();
const mentorAuthn = new SoftAuthenticator();
r = await mentor.post("/api/join/resolve", { entry: { code: teamLink.code }, selection: [] });
check(r.json.target?.name === "A 254" && r.json.outcome?.status === "active", "link resolves straight to the team", json(r));
r = await register(
  mentor,
  mentorAuthn,
  "/api/join/register/start",
  { request: { entry: { code: teamLink.code }, selection: [] }, username: "mentor" },
  "/api/join/register/finish",
  "mentor key",
);
check(r.status === 200 && r.json.user?.kind === "full" && r.json.joined?.status === "active", "new passkey account joins via the link", json(r));
r = await kid1.get(`/api/groups/${team}/links`);
check(r.json?.[0]?.uses === 1, "link use counted", json(r));
r = await kid1.put(`/api/groups/${team}/links/${teamLink.id}`, { disabled: true });
r = await anon.post("/api/join/resolve", { entry: { code: teamLink.code }, selection: [] });
check(r.status === 404, "a disabled link is dead", json(r));

// public link to the league
r = await owner.post(`/api/groups/${league}/links`, { public: true, code: "Bad Code" });
check(r.status === 400, "public codes must be slugs", json(r));
r = await owner.post(`/api/groups/${league}/links`, { public: true, code: "group" });
check(r.status === 400, "the code 'group' is reserved for the UI's routes", json(r));
r = await owner.post(`/api/groups/${league}/links`, { public: true, code: "league-join" });
check(r.status === 201 && r.json.bypass_approval === false, "public link created", json(r));
r = await anon.post("/api/join/resolve", { entry: { code: "LEAGUE-JOIN" }, selection: [] });
check(r.status === 200 && r.json.entry?.id === league, "public link resolves (case-insensitive)", json(r));

// an outsider on another team
const outsider = new Client();
r = await outsider.post("/api/join/guest", {
  request: { entry: { code: "league-join" }, selection: [{ group: programA }, { key: "1678" }] },
  username: "outsider",
});
check(r.status === 200 && r.json.joined?.group_name === "A 1678", "another team is created through the public link", json(r));

// ---- jobs, visibility, kept models ------------------------------------------------------
const gcode = new Blob(["; test gcode\nG28\n"], { type: "text/plain" });
const stl = new Blob(["solid cube\nendsolid cube\n"], { type: "model/stl" });

async function browserJob(client, groupId, grams = 5) {
  const fields = { source: "browser", model_name: "cube.stl" };
  if (groupId) fields.group_id = groupId;
  const created = await client.form("/api/jobs", fields);
  if (created.status !== 201) return created;
  const done = await client.form(`/api/jobs/${created.json.id}/result`, {
    gcode: [gcode, "x.gcode"],
    model: [stl, "cube.stl"],
    print_time_sec: "600",
    filament_used_g: String(grams),
    warnings: "[]",
  });
  return { status: done.status, json: { ...done.json, keep_model: created.json.keep_model } };
}

r = await kid2.form("/api/jobs", { source: "browser", model_name: "x.stl", group_id: programA });
check(r.status === 403, "can't charge a group you're not in", json(r));

r = await browserJob(kid1, team);
check(r.status === 200 && r.json.status === "done" && r.json.keep_model === true, "team job sliced in the browser, model kept", json(r));
const teamJob = r.json.id;
r = await browserJob(kid1, null);
check(r.status === 200, "personal job", json(r));
const personalJob = r.json.id;

r = await kid2.get("/api/jobs");
check(r.json.some((j) => j.id === teamJob) && !r.json.some((j) => j.id === personalJob), "teammate sees team jobs, not personal ones", json(r));
r = await outsider.get("/api/jobs");
check(!r.json.some((j) => j.id === teamJob), "other teams don't see it");
r = await owner.get("/api/jobs");
check(r.json.some((j) => j.id === teamJob) && r.json.some((j) => j.id === personalJob), "admins see everything");
r = await kid2.get(`/api/jobs/${teamJob}/model`);
check(r.status === 200, "teammate downloads the model", json(r));
r = await outsider.get(`/api/jobs/${teamJob}/model`);
check(r.status === 404, "outsider can't", json(r));
const slices = (await kid1.get("/api/slices")).json;
const teamSlice = slices.find((s) => s.job_id === teamJob);
check(teamSlice?.group_name === "A 254" && teamSlice?.has_model === true, "slice carries group and model flag", JSON.stringify(slices));
r = await outsider.get(`/api/slices/${teamSlice?.id}/download`);
check(r.status === 404, "outsider can't download the G-code");
r = await kid2.get(`/api/slices/${teamSlice?.id}/download`);
check(r.status === 200, "teammate downloads the G-code");
r = await outsider.post(`/api/jobs/${teamJob}/cancel`);
check(r.status === 404, "outsider can't touch the job");

r = await kid1.put(`/api/jobs/${personalJob}`, { group_id: team });
check(r.status === 200 && r.json.group_id === team, "creator moves a personal job into the team", json(r));
r = await kid2.put(`/api/jobs/${personalJob}`, { group_id: null });
check(r.status === 403, "a teammate can't move someone else's job", json(r));

// library with seasons (Program A's season starts 09-01)
r = await kid2.get(`/api/groups/${team}/library`);
const lib = r.json;
check(r.status === 200 && lib.season_start === "09-01" && lib.jobs.length === 2, "team library lists the team's jobs", json(r));
check(lib.seasons.find((s) => s.current)?.label?.includes("–"), "season labels span two years for a fall start", JSON.stringify(lib.seasons));
check(lib.jobs.every((j) => j.season === lib.current_season && j.slice_id), "jobs carry season and slice", JSON.stringify(lib.jobs));
check(
  lib.jobs.find((j) => j.id === teamJob)?.has_model === true && lib.jobs.find((j) => j.id === personalJob)?.has_model === false,
  "only the job sliced for the team kept its model (personal jobs keep theirs local)",
);

// ---- quotas ---------------------------------------------------------------------------
r = await owner.put(`/api/groups/${team}`, { quotas: { pool: [{ metric: "slices", period: "season", limit: 3 }] } });
check(r.status === 200, "admin sets the team's pool", json(r));
r = await browserJob(kid2, team);
check(r.status === 200, "third team job fits the pool", json(r));
r = await browserJob(kid2, team);
check(r.status === 429 && /A 254's shared slice quota for this season/.test(r.json?.error), "the pool is enforced", json(r));
r = await browserJob(kid2, null);
check(r.status === 200, "personal jobs aren't charged to the team", json(r));
r = await kid1.get(`/api/groups/${team}/usage`);
const pool = r.json?.lines?.find((l) => l.scope === "pool" && l.group_id === team);
check(pool?.used === 3 && pool?.limit === 3, "usage shows the pool", json(r));

r = await owner.put(`/api/groups/${team}`, { quotas: {} });
r = await owner.put(`/api/groups/${league}`, { quotas: { member: [{ metric: "filament_g", period: "month", limit: 12 }] } });
check(r.status === 200, "league-wide per-member limit", json(r));
r = await browserJob(kid1, team);
check(r.status === 200, "kid1 still has filament left (10 g used)", json(r));
r = await browserJob(kid1, team);
check(r.status === 429 && /League's per-member filament/.test(r.json?.error), "inherited per-member limit is enforced", json(r));
r = await owner.put(`/api/groups/${league}/members/${kid2Id}`, { quotas: [] });
check(r.status === 404, "member overrides need a membership in that group", json(r));
const kid1Id = (await kid1.get("/api/me")).json.id;
r = await owner.put(`/api/groups/${team}/members/${kid1Id}`, { quotas: [{ metric: "filament_g", period: "month", limit: 1000 }] });
check(r.status === 200, "admin overrides kid1's per-member rules in the team", json(r));
r = await browserJob(kid1, team);
check(r.status === 429, "the league's own per-member rule still applies above the team", json(r));
r = await owner.put(`/api/groups/${league}`, { quotas: {} });

r = await owner.put("/api/settings", { default_guest_quotas: [{ metric: "slices", period: "day", limit: 1 }] });
check(r.status === 200, "admin sets a guest default", json(r));
r = await browserJob(kid1, team);
check(r.status === 429 && /your personal slice quota for today/.test(r.json?.error), "guest default applies", json(r));
r = await owner.put("/api/settings", { default_guest_quotas: [] });
r = await owner.put("/api/settings", { season_start: "13-01" });
check(r.status === 400, "bad season start refused", json(r));
r = await kid1.get("/api/settings");
check(r.status === 403, "settings are admin-only", json(r));
r = await kid1.get("/api/me/usage");
check(r.status === 200 && r.json.groups?.some((g) => g.group_id === team), "me/usage lists groups", json(r));

// ---- leaving, upgrading, deleting ---------------------------------------------------------
r = await register(kid2, new SoftAuthenticator(), "/api/me/passkeys/start", {}, "/api/me/passkeys/finish", "kid2 key");
check(r.status === 201, "a guest adds a passkey", json(r));
r = await kid2.get("/api/me");
check(r.json?.kind === "full", "and becomes a full account", json(r));
r = await kid2.del(`/api/groups/${team}/members/${kid2Id}`);
check(r.status === 204, "members can leave", json(r));
r = await kid2.get("/api/jobs");
check(!r.json.some((j) => j.id === teamJob), "after leaving, team jobs are hidden");

r = await owner.get("/api/users");
check(r.json.find((u) => u.username === "kid1")?.groups?.[0]?.role === "manager", "admin user list shows groups", json(r));
const outsiderId = r.json.find((u) => u.username === "outsider").id;
r = await owner.post(`/api/users/${outsiderId}/invite`);
const outsiderInvite = r.json.invite_url.split("/invite/")[1];
r = await register(new Client(), new SoftAuthenticator(), `/api/auth/invite/${outsiderInvite}/start`, {}, `/api/auth/invite/${outsiderInvite}/finish`, "k");
check(r.status === 200 && r.json.user?.kind === "full", "a guest who enrols through an admin's invite becomes full", json(r));
r = await owner.del(`/api/groups/${programA}`);
check(r.status === 409, "groups with subgroups can't be deleted", json(r));
r = await kid1.del(`/api/groups/${team}`);
check(r.status === 403, "a team's manager can't delete their own team", json(r));
r = await owner.put(`/api/groups/${league}`, { parent_id: team });
check(r.status === 400, "a group can't move below itself", json(r));

finish();
