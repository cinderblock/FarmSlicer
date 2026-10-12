#!/usr/bin/env node
// End-to-end test of the passkey account system against a running server,
// using a software authenticator (ES256, "none" attestation) so no human has
// to touch a security key. Exercises: first-run setup, login by username and
// discoverable login, invites, recovery codes, adding/removing passkeys,
// API keys, role rules.
//
//   node tests/passkey-e2e.mjs http://localhost:9337
//
// The server must list that origin in FARMSLICER_ORIGINS. Exit code 0 iff all
// checks pass. No dependencies beyond Node 22.
import { BASE, RP_ID, check, Client, SoftAuthenticator, register, login, finish } from "./lib.mjs";

// ---- the scenario ------------------------------------------------------------------
console.log(`passkey e2e against ${BASE} (rp id ${RP_ID})`);
const owner = new Client();
const ownerAuthn = new SoftAuthenticator();

let r = await owner.get("/api/auth/status");
check(r.json?.setup_required === true, "fresh server reports setup_required", JSON.stringify(r.json));
check(r.json?.rp_id === RP_ID, "rp_id matches the test origin", r.json?.rp_id);
r = await owner.get("/api/printers");
check(r.status === 401, "protected route is 401 before setup", String(r.status));

// first-run setup
r = await register(owner, ownerAuthn, "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "test key");
check(r.status === 200 && r.json?.user?.role === "owner", "setup creates the owner with a passkey", JSON.stringify(r.json));
const ownerRecovery = r.json?.recovery_code;
check(typeof ownerRecovery === "string" && ownerRecovery.length >= 20, "setup returns a recovery code");
r = await owner.post("/api/auth/setup/start", { username: "again" });
check(r.status === 409, "second setup is refused", String(r.status));
r = await owner.get("/api/me");
check(r.status === 200 && r.json?.username === "owner", "session cookie works");

// login: username flow and discoverable flow
const fresh = new Client();
r = await login(fresh, ownerAuthn, "owner");
check(r.status === 200 && r.json?.user?.username === "owner", "login with username + passkey", JSON.stringify(r.json));
const fresh2 = new Client();
r = await login(fresh2, ownerAuthn);
check(r.status === 200 && r.json?.user?.username === "owner", "discoverable login (no username)", JSON.stringify(r.json));
r = await login(new Client(), new SoftAuthenticator(), "owner").catch((e) => ({ status: -1, json: String(e) }));
check(r.status !== 200, "a foreign authenticator cannot sign in", JSON.stringify(r.json));
r = await fresh2.post("/api/auth/logout");
r = await fresh2.get("/api/me");
check(r.status === 401, "logout invalidates the session", String(r.status));

// replay protection: reusing a finished flow id
const start = await fresh.post("/api/auth/login/start", { username: "owner" });
const cred = ownerAuthn.get(start.json.options);
r = await fresh.post("/api/auth/login/finish", { flow_id: start.json.flow_id, credential: cred });
check(r.status === 200, "login flow works once");
r = await fresh.post("/api/auth/login/finish", { flow_id: start.json.flow_id, credential: cred });
check(r.status === 400, "a finished flow cannot be replayed", String(r.status));

// invite a user
r = await owner.post("/api/users", { username: "bob", role: "user" });
check(r.status === 201 && typeof r.json?.invite_url === "string", "admin creates a user + invite link", JSON.stringify(r.json));
const inviteToken = r.json.invite_url.split("/invite/")[1];
const bob = new Client();
const bobAuthn = new SoftAuthenticator();
r = await bob.get(`/api/auth/invite/${inviteToken}`);
check(r.status === 200 && r.json?.username === "bob", "invite info is public");
r = await register(bob, bobAuthn, `/api/auth/invite/${inviteToken}/start`, {}, `/api/auth/invite/${inviteToken}/finish`, "bob phone");
check(r.status === 200 && r.json?.user?.username === "bob", "invitee enrols a passkey and is signed in", JSON.stringify(r.json));
const bobRecovery = r.json?.recovery_code;
r = await bob.get(`/api/auth/invite/${inviteToken}`);
check(r.status === 404, "used invite is dead", String(r.status));
r = await bob.get("/api/users");
check(r.status === 403, "user role cannot list users", String(r.status));
r = await bob.post("/api/users", { username: "eve" });
check(r.status === 403, "user role cannot create users", String(r.status));

// bob adds a second passkey, removes the first, cannot remove the last
r = await register(bob, bobAuthn, "/api/me/passkeys/start", {}, "/api/me/passkeys/finish", "bob laptop");
check(r.status === 201, "add a second passkey", JSON.stringify(r.json));
r = await bob.get("/api/me/passkeys");
check(r.status === 200 && r.json.length === 2, "two passkeys listed");
const firstKeyId = r.json[0].id;
r = await bob.del(`/api/me/passkeys/${firstKeyId}`);
check(r.status === 204, "remove a passkey");
r = await bob.get("/api/me/passkeys");
r = await bob.del(`/api/me/passkeys/${r.json[0].id}`);
check(r.status === 400, "cannot remove the last passkey", String(r.status));
const bobKeys = [...bobAuthn.creds.keys()];
r = await login(new Client(), bobAuthn, "bob", bobKeys[1]);
check(r.status === 200, "login with the remaining passkey", JSON.stringify(r.json));
r = await login(new Client(), bobAuthn, "bob", bobKeys[0]).catch((e) => ({ status: -1, json: String(e) }));
check(r.status !== 200, "removed passkey no longer signs in", JSON.stringify(r.json));

// recovery code
const lostBob = new Client();
const newAuthn = new SoftAuthenticator();
r = await register(lostBob, newAuthn, "/api/auth/recover/start", { username: "bob", code: bobRecovery.toLowerCase() }, "/api/auth/recover/finish", "replacement");
check(r.status === 200 && r.json?.user?.username === "bob" && r.json?.recovery_code, "recovery code enrols a new passkey (case-insensitive)", JSON.stringify(r.json));
r = await lostBob.post("/api/auth/recover/start", { username: "bob", code: bobRecovery });
check(r.status === 401, "recovery code is single-use", String(r.status));
r = await owner.post("/api/me/recovery-code");
check(r.status === 200 && r.json?.recovery_code && r.json.recovery_code !== ownerRecovery, "regenerate recovery code");
r = await owner.post("/api/auth/recover/start", { username: "owner", code: ownerRecovery });
check(r.status === 401, "old recovery code is dead after regeneration", String(r.status));

// API keys
r = await bob.post("/api/me/api-keys", { name: "script" });
check(r.status === 201 && r.json?.key?.startsWith("fsk_"), "create API key");
const api = new Client();
api.bearer = r.json.key;
r = await api.get("/api/me");
check(r.status === 200 && r.json?.username === "bob", "bearer key authenticates");
api.bearer = "fsk_nope";
r = await api.get("/api/me");
check(r.status === 401, "bad bearer key is rejected");

// admin rules
r = await owner.get("/api/me");
const ownerId = r.json.id;
r = await owner.get("/api/users");
const bobId = r.json.find((u) => u.username === "bob").id;
check(r.json.find((u) => u.username === "bob").passkeys === 2, "admin list shows passkey counts", JSON.stringify(r.json));
r = await owner.del(`/api/users/${ownerId}`);
check(r.status === 403, "owner cannot be deleted");
r = await owner.put(`/api/users/${bobId}`, { role: "admin" });
check(r.status === 200 && r.json?.role === "admin", "promote to admin");
r = await bob.post(`/api/users/${ownerId}/invite`);
check(r.status === 403, "admin cannot re-enrol the owner");
r = await owner.post(`/api/users/${bobId}/invite`);
check(r.status === 200 && r.json?.invite_url, "owner re-issues an invite for a user");
r = await owner.del(`/api/users/${bobId}`);
check(r.status === 204, "delete a user");
api.bearer = undefined;
r = await login(new Client(), newAuthn, "bob").catch((e) => ({ status: -1 }));
check(r.status !== 200, "deleted user cannot sign in");

finish();
