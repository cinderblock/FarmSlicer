// Shared helpers for the end-to-end tests: a software WebAuthn
// authenticator (ES256, "none" attestation, minimal CBOR), a fetch client
// with a cookie jar, and check/summary bookkeeping. No dependencies beyond
// Node 22. The base URL is the first command-line argument.
import { createHash, generateKeyPairSync, sign as cryptoSign, randomBytes } from "node:crypto";

export const BASE = (process.argv[2] ?? "http://localhost:9337").replace(/\/$/, "");
export const ORIGIN = new URL(BASE).origin;
export const RP_ID = new URL(BASE).hostname;

let failures = 0;
export function check(cond, label, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

// ---- minimal CBOR encoder (enough for attestationObject + COSE keys) ----------
export function cbor(value) {
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
export class SoftAuthenticator {
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
export class Client {
  constructor() {
    this.cookie = null;
    this.bearer = null;
  }
  async call(method, path, body) {
    const headers = {};
    const form = body instanceof FormData;
    if (body !== undefined && !form) headers["content-type"] = "application/json";
    if (this.cookie) headers.cookie = this.cookie;
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    const payload = body === undefined ? undefined : form ? body : JSON.stringify(body);
    const res = await fetch(BASE + path, { method, headers, body: payload });
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
  /** POST multipart/form-data built from a plain object (Blobs stay files). */
  form(p, fields) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (Array.isArray(v)) fd.append(k, v[0], v[1]);
      else fd.append(k, v);
    }
    return this.call("POST", p, fd);
  }
}

export async function register(client, authn, startPath, startBody, finishPath, keyName) {
  const start = await client.post(startPath, startBody);
  if (start.status !== 200) return start;
  const credential = authn.create(start.json.options);
  return client.post(finishPath, { flow_id: start.json.flow_id, credential, key_name: keyName });
}

export async function login(client, authn, username, pickId) {
  const start = await client.post("/api/auth/login/start", username ? { username } : {});
  if (start.status !== 200) return start;
  const credential = authn.get(start.json.options, pickId);
  return client.post("/api/auth/login/finish", { flow_id: start.json.flow_id, credential });
}

/** Print the result line and exit 0 iff every check passed. */
export function finish() {
  console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
