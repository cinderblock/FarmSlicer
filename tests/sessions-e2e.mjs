#!/usr/bin/env node
// End-to-end test of signed-in devices (src/sessions_api.rs): your own
// sessions, signing one or all others out, and account managers seeing
// and revoking a person's sessions, passkeys and API keys within the rank
// rule. Against a fresh server (first-run setup); a FARMSLICER_SKIP_CXX
// server is enough.
//
//   node tests/sessions-e2e.mjs http://localhost:9337
import { BASE, check, Client, SoftAuthenticator, register, login, finish } from "./lib.mjs";

console.log(`sessions e2e against ${BASE}`);
const json = (r) => JSON.stringify(r.json);

const owner = new Client();
const ownerAuthn = new SoftAuthenticator();
let r = await register(owner, ownerAuthn, "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));
const ownerId = (await owner.get("/api/auth/status")).json.user.id;

async function enrol(username, role = "user") {
  const made = await owner.post("/api/users", { username, role });
  const token = made.json.invite_url.split("/invite/")[1];
  const client = new Client();
  const authn = new SoftAuthenticator();
  const done = await register(client, authn, `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "laptop");
  check(done.status === 200, `${username} enrols`, json(done));
  return { client, authn, id: made.json.user.id };
}
r = await owner.post("/api/roles", { name: "Account admin", scope: "site", caps: ["users.view", "users.manage"] });
const ann = await enrol("ann");
const dave = await enrol("dave", r.json.id);

// ---- your own devices -------------------------------------------------------------------
const phone = new Client();
r = await login(phone, ann.authn, "ann");
check(r.status === 200, "ann signs in on a second device", json(r));
await phone.get("/api/auth/status"); // as the web app does right after signing in
r = await ann.client.get("/api/me/sessions");
check(r.json.length === 2 && r.json.filter((s) => s.current).length === 1, "she sees two sessions, one of them this one", json(r));
check(r.json.every((s) => s.id.length === 16 && s.method === "passkey" && s.device), "each with an id, how it signed in and a device", json(r));
check(!JSON.stringify(r.json).includes("token"), "and nothing that signs in", json(r));
const other = r.json.find((s) => !s.current);
r = await ann.client.del(`/api/me/sessions/${other.id}`);
check(r.status === 204, "she signs the other device out", String(r.status));
r = await phone.get("/api/jobs");
check(r.status === 401, "it's signed out", json(r));
r = await ann.client.del("/api/me/sessions/zzzz");
check(r.status === 404, "a made-up id finds nothing", json(r));
await login(phone, ann.authn, "ann");
const tablet = new Client();
await login(tablet, ann.authn, "ann");
r = await ann.client.post("/api/me/sessions/sign-out-others");
check(r.status === 200 && r.json.ended === 2, "'everywhere else' signs both out", json(r));
r = await ann.client.get("/api/me/sessions");
check(r.json.length === 1 && r.json[0].current, "only this one left", json(r));

// ---- an account manager -------------------------------------------------------------------
r = await ann.client.post("/api/me/api-keys", { name: "printer script" });
const key = new Client();
key.bearer = r.json.key;
r = await ann.client.get(`/api/users/${ann.id}/access`);
check(r.status === 403, "a user can't open the access panel", json(r));
r = await dave.client.get(`/api/users/${ownerId}/access`);
check(r.status === 403, "dave can't look at the owner's", json(r));
r = await dave.client.get(`/api/users/${ann.id}/access`);
check(r.status === 200 && r.json.sessions.length === 1 && r.json.passkeys[0].name === "laptop" && r.json.api_keys[0].name === "printer script", "dave sees ann's sessions, passkey and key", json(r));
const keyId = r.json.api_keys[0].id;
const passkeyId = r.json.passkeys[0].id;
r = await dave.client.del(`/api/users/${ann.id}/api-keys/${keyId}`);
check(r.status === 204, "dave revokes her API key", String(r.status));
r = await key.get("/api/jobs");
check(r.status === 401, "it stops working", json(r));
r = await dave.client.del(`/api/users/${ann.id}/sessions`);
check(r.status === 200 && r.json.ended === 1, "dave signs her out everywhere", json(r));
r = await ann.client.get("/api/jobs");
check(r.status === 401, "she's signed out", json(r));
r = await dave.client.del(`/api/users/${ann.id}/passkeys/${passkeyId}`);
check(r.status === 204, "dave removes her lost passkey", String(r.status));
r = await login(new Client(), ann.authn, "ann");
check(r.status !== 200, "it no longer signs in", json(r));
r = await owner.get(`/api/users/${ownerId}/access`);
const ownerPasskey = r.json.passkeys[0].id;
r = await owner.del(`/api/users/${ownerId}/passkeys/${ownerPasskey}`);
check(r.status === 400, "nobody removes their own only passkey here", json(r));
r = await owner.del(`/api/users/${ownerId}/sessions`);
check(r.status === 200 && r.json.ended === 0, "signing yourself out everywhere keeps this session", json(r));
r = await owner.get("/api/jobs");
check(r.status === 200, "(still signed in)", json(r));

r = await owner.get("/api/audit?action=user.");
const actions = r.json.entries.map((e) => `${e.actor_name}:${e.action}`);
for (const want of ["dave:user.api_key.delete", "dave:user.sessions.end", "dave:user.passkey.delete"]) {
  check(actions.includes(want), `audit: ${want}`, actions.join(" | "));
}

finish();
