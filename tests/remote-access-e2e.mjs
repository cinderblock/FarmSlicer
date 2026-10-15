#!/usr/bin/env node
// e2e-env: FARMSLICER_LAN_HEADER=X-FarmSlicer-LAN
// End-to-end test of remote access: the server is told which header the
// reverse proxy sets on local-network requests, and everything without it
// counts as from the internet. Exercises: what the internet can reach,
// per-account approval, invite links from the internet, passkey-only
// sessions (recovery, API keys refused), revocation, and that only an exact
// `1` makes a request local.
//
//   FARMSLICER_LAN_HEADER=X-FarmSlicer-LAN farmslicer &
//   node tests/remote-access-e2e.mjs http://localhost:9337
import { BASE, check, Client, SoftAuthenticator, register, login, finish } from "./lib.mjs";

const LAN = { "x-farmslicer-lan": "1" };
const lan = () => new Client({ ...LAN });
const wan = (headers = {}) => new Client(headers);
/** The same cookie from the other side of the proxy (a laptop going home). */
const fromInternet = (client) => Object.assign(wan(), { cookie: client.cookie });

console.log(`remote access e2e against ${BASE}`);

// ---- before setup: the internet can't set the server up -------------------------------
let r = await wan().get("/api/auth/status");
check(r.json?.remote === true, "a request without the header is remote", JSON.stringify(r.json));
r = await lan().get("/api/auth/status");
check(r.json?.remote === false, "a request with the header is local", JSON.stringify(r.json));
r = await wan().post("/api/auth/setup/start", { username: "owner" });
check(r.status === 403 && r.json?.remote_denied === true, "setup is refused from the internet", `${r.status} ${JSON.stringify(r.json)}`);
r = await wan().get("/api/health");
check(r.status === 200, "health answers the internet", String(r.status));

// ---- the owner sets up on the LAN ------------------------------------------------------
const owner = lan();
const ownerAuthn = new SoftAuthenticator();
r = await register(owner, ownerAuthn, "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "owner key");
check(r.status === 200 && r.json?.user?.remote_access === false, "owner created, not approved for remote", JSON.stringify(r.json));
r = await owner.get("/api/me");
check(r.status === 200, "owner's session works on the LAN", String(r.status));

// The owner's LAN session, carried outside: refused until approved.
r = await fromInternet(owner).get("/api/me");
check(r.status === 403 && r.json?.remote_denied === true, "an unapproved account's session is refused from the internet", `${r.status} ${JSON.stringify(r.json)}`);
r = await fromInternet(owner).get("/api/auth/status");
check(
  r.json?.authenticated === false && typeof r.json?.remote_refused === "string",
  "status explains the refusal",
  JSON.stringify(r.json),
);
r = await login(wan(), ownerAuthn, "owner");
check(r.status === 403, "an unapproved account can't sign in from the internet", `${r.status} ${JSON.stringify(r.json)}`);

// ---- accounts: one approved, one not ----------------------------------------------------
r = await owner.post("/api/users", { username: "alice", remote_access: true });
check(r.status === 201 && r.json?.user?.remote_access === true, "admin creates an approved account", JSON.stringify(r.json));
const aliceToken = r.json.invite_url.split("/invite/")[1];
r = await owner.post("/api/users", { username: "bob" });
check(r.status === 201 && r.json?.user?.remote_access === false, "admin creates a local-only account", JSON.stringify(r.json));
const bobToken = r.json.invite_url.split("/invite/")[1];

// bob's invite: local only.
r = await wan().get(`/api/auth/invite/${bobToken}`);
check(r.status === 404, "a local-only account's invite reads as invalid from the internet", String(r.status));
r = await wan().post(`/api/auth/invite/${bobToken}/start`);
check(r.status === 404, "…and can't be started from the internet", String(r.status));
for (const value of ["0", "true", "11", "yes"]) {
  r = await wan({ "x-farmslicer-lan": value }).get(`/api/auth/invite/${bobToken}`);
  check(r.status === 404, `header value ${JSON.stringify(value)} doesn't make a request local`, String(r.status));
}
r = await lan().get(`/api/auth/invite/${bobToken}`);
check(r.status === 200, "…but works on the LAN", String(r.status));

// alice's invite: from the internet.
const alice = wan();
const aliceAuthn = new SoftAuthenticator();
r = await alice.get(`/api/auth/invite/${aliceToken}`);
check(r.status === 200 && r.json?.username === "alice", "an approved account's invite works from the internet", JSON.stringify(r.json));
r = await register(alice, aliceAuthn, `/api/auth/invite/${aliceToken}/start`, {}, `/api/auth/invite/${aliceToken}/finish`, "alice key");
check(r.status === 200 && typeof r.json?.recovery_code === "string", "alice enrols a passkey from the internet", JSON.stringify(r.json));
const aliceRecovery = r.json?.recovery_code;
r = await alice.get("/api/me");
check(r.status === 200 && r.json?.remote_access === true, "the enrolment session works from the internet", `${r.status} ${JSON.stringify(r.json)}`);
r = await alice.get("/api/printers");
check(r.status === 200, "alice uses the API from the internet", String(r.status));
r = await alice.get("/api/auth/status");
check(r.json?.authenticated === true && r.json?.remote === true && r.json?.join_groups?.length === 0, "status: signed in, remote, no join groups", JSON.stringify(r.json));

// Passkey sign-in from the internet, both ways.
r = await login(wan(), aliceAuthn, "alice");
check(r.status === 200, "alice signs in from the internet by username", `${r.status} ${JSON.stringify(r.json)}`);
r = await login(wan(), aliceAuthn);
check(r.status === 200, "alice signs in from the internet with a discoverable passkey", `${r.status} ${JSON.stringify(r.json)}`);

// ---- only passkeys from the internet -----------------------------------------------------
r = await wan().post("/api/auth/recover/start", { username: "alice", code: aliceRecovery });
check(r.status === 403 && r.json?.remote_denied === true, "recovery codes are refused from the internet", `${r.status} ${JSON.stringify(r.json)}`);
r = await wan().post("/api/join/resolve", {});
check(r.status === 403, "the join flow is refused from the internet", String(r.status));
r = await wan().post("/api/auth/guest/signin", { username: "x", code: "y" });
check(r.status === 403, "guest sign-in codes are refused from the internet", String(r.status));

// API keys: made on the LAN, useless outside.
const aliceLan = lan();
r = await login(aliceLan, aliceAuthn, "alice");
r = await aliceLan.post("/api/me/api-keys", { name: "script" });
check(r.status === 201, "alice makes an API key on the LAN", String(r.status));
const key = r.json?.key;
const keyLan = lan();
keyLan.bearer = key;
r = await keyLan.get("/api/me");
check(r.status === 200, "the API key works on the LAN", String(r.status));
const keyWan = wan();
keyWan.bearer = key;
r = await keyWan.get("/api/me");
check(r.status === 403 && r.json?.remote_denied === true, "the API key is refused from the internet", `${r.status} ${JSON.stringify(r.json)}`);

// A session made with a recovery code (on the LAN) doesn't count outside.
const recovered = lan();
r = await register(
  recovered,
  new SoftAuthenticator(),
  "/api/auth/recover/start",
  { username: "alice", code: aliceRecovery },
  "/api/auth/recover/finish",
  "recovered key",
);
check(r.status === 200, "alice recovers on the LAN", `${r.status} ${JSON.stringify(r.json)}`);
r = await fromInternet(recovered).get("/api/me");
check(r.status === 403, "a recovery-code session is refused from the internet", `${r.status} ${JSON.stringify(r.json)}`);

// ---- approval is checked on every request -------------------------------------------------
const aliceId = (await owner.get("/api/users")).json.find((u) => u.username === "alice").id;
r = await owner.put(`/api/users/${aliceId}`, { remote_access: false });
check(r.status === 200 && r.json?.remote_access === false, "admin revokes alice's remote access", JSON.stringify(r.json));
r = await alice.get("/api/me");
check(r.status === 403, "revocation takes effect on the next request", String(r.status));
r = await owner.put(`/api/users/${aliceId}`, { remote_access: true });
r = await alice.get("/api/me");
check(r.status === 200, "re-approval restores the session", String(r.status));

// The owner approves themselves, then signs in from outside.
const ownerId = (await owner.get("/api/me")).json.id;
r = await owner.put(`/api/users/${ownerId}`, { remote_access: true });
check(r.status === 200 && r.json?.remote_access === true, "the owner approves their own account", JSON.stringify(r.json));
r = await fromInternet(owner).get("/api/me");
check(r.status === 200, "the owner's passkey session now works from the internet", String(r.status));
r = await login(wan(), ownerAuthn, "owner");
check(r.status === 200, "the owner signs in from the internet", `${r.status} ${JSON.stringify(r.json)}`);

// An approved admin can't change the owner's approval.
r = await owner.put(`/api/users/${aliceId}`, { role: "admin" });
r = await aliceLan.put(`/api/users/${ownerId}`, { remote_access: false });
check(r.status === 403, "an admin can't change the owner's remote access", `${r.status} ${JSON.stringify(r.json)}`);

finish();
