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
import { createHash, generateKeyPairSync, sign as cryptoSign, randomBytes } from "node:crypto";

const BASE = (process.argv[2] ?? "http://localhost:9337").replace(/\/$/, "");
const ORIGIN = new URL(BASE).origin;
const RP_ID = new URL(BASE).hostname;

let failures = 0;
function check(cond, label, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

// ---- minimal CBOR encoder (enough for attestationObject + COSE keys) ----------
function cbor(value) {
  const parts = [];
  const head = (major, n) => {
    if (n < 24) parts.push(Buffer.from([(major << 5) | n]));
    else if (n < 0x100) parts.push(Buffer.from([(major << 5) | 24, n]));
    else if (n < 0x10000) parts.push(Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]));
    else parts.push(Buffer.from([(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]));
  };
  const enc = (v) => {
    if (typeof v === "number") {
      if (v >= 0) head(0, v);
      else head(1, -1 - v);
    } else if (typeof v === "string") {
      const b = Buffer.from(v, "utf8");
      head(3, b.length);
      parts.push(b);
    } else if (Buffer.isBuffer(v)) {
      head(2, v.length);
      parts.push(v);
    } else if (Array.isArray(v)) {
      head(4, v.length);
      v.forEach(enc);
    } else if (v instanceof Map) {
      head(5, v.size);
      for (const [k, val] of v) {
        enc(k);
        enc(val);
      }
    } else if (v && typeof v === "object") {
      const keys = Object.keys(v);
      head(5, keys.length);
      for (const k of keys) {
        enc(k);
        enc(v[k]);
      }
    } else throw new Error(`cbor: unsupported ${typeof v}`);
  };
  enc(value);
  return Buffer.concat(parts);
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (data) => createHash("sha256").update(data).digest();

// ---- software authenticator ------------------------------------------------------
class SoftAuthenticator {
  constructor() {
    this.creds = new Map(); // credId b64u → { key, userHandle, counter, rpId }
  }

  create(options) {
    const pk = options.publicKey;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    const credId = randomBytes(32);
    const cose = new Map([
      [1, 2], // kty EC2
      [3, -7], // alg ES256
      [-1, 1], // crv P-256
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ]);
    const flags = 0x01 | 0x04 | 0x40; // UP, UV, AT
    const counter = Buffer.alloc(4);
    const authData = Buffer.concat([
      sha256(pk.rp.id ?? RP_ID),
      Buffer.from([flags]),
      counter,
      Buffer.alloc(16), // aaguid
      Buffer.from([credId.length >> 8, credId.length & 0xff]),
      credId,
      cbor(cose),
    ]);
    const clientData = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge: pk.challenge, origin: ORIGIN, crossOrigin: false }),
    );
    const attestationObject = cbor({ fmt: "none", attStmt: {}, authData });
    const id = b64u(credId);
    this.creds.set(id, { privateKey, userHandle: pk.user.id, counter: 0, rpId: pk.rp.id ?? RP_ID });
    // Same shape @simplewebauthn/browser's startRegistration() returns.
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientData),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  get(options, pickId) {
    const pk = options.publicKey;
    const allowed = (pk.allowCredentials ?? []).map((c) => c.id);
    const id = pickId ?? allowed.find((a) => this.creds.has(a)) ?? [...this.creds.keys()].at(-1);
    const cred = this.creds.get(id);
    if (!cred) throw new Error("no matching credential");
    cred.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(cred.counter);
    const flags = 0x01 | 0x04; // UP, UV
    const authData = Buffer.concat([sha256(pk.rpId ?? cred.rpId), Buffer.from([flags]), counter]);
    const clientData = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: pk.challenge, origin: ORIGIN, crossOrigin: false }),
    );
    const signature = cryptoSign("sha256", Buffer.concat([authData, sha256(clientData)]), cred.privateKey);
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: cred.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}

// ---- tiny HTTP client with a cookie jar -------------------------------------------
class Client {
  constructor() {
    this.cookie = null;
    this.bearer = null;
  }
  async call(method, path, body) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookie) headers.cookie = this.cookie;
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const m = setCookie.match(/fs_session=([^;]*)/);
      if (m) this.cookie = m[1] ? `fs_session=${m[1]}` : null;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 120) };
    }
    return { status: res.status, json };
  }
  get(p) { return this.call("GET", p); }
  post(p, b) { return this.call("POST", p, b ?? {}); }
  put(p, b) { return this.call("PUT", p, b); }
  del(p) { return this.call("DELETE", p); }
}

async function register(client, authn, startPath, startBody, finishPath, keyName) {
  const start = await client.post(startPath, startBody);
  if (start.status !== 200) return start;
  const credential = authn.create(start.json.options);
  return client.post(finishPath, { flow_id: start.json.flow_id, credential, key_name: keyName });
}

async function login(client, authn, username, pickId) {
  const start = await client.post("/api/auth/login/start", username ? { username } : {});
  if (start.status !== 200) return start;
  const credential = authn.get(start.json.options, pickId);
  return client.post("/api/auth/login/finish", { flow_id: start.json.flow_id, credential });
}

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

console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
