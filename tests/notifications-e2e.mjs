#!/usr/bin/env node
// e2e-env: FARMSLICER_PUSH_SERVICES=http://127.0.0.1:9451
// End-to-end test of notifications (src/notifications.rs): browsers'
// subscriptions are checked and kept per account, a push is encrypted for
// the browser (RFC 8291) and signed (VAPID, RFC 8292) so that an
// independent implementation (Node's crypto, here, as the browser) reads
// it, a failed print reaches whoever sent it and the printer's operators
// but not others, someone who stops a print isn't told it stopped, admins
// can ask for every print, approval requests reach only those who may
// approve, preferences are checked, and a subscription
// the push service says is gone is forgotten.
//
//   node tests/notifications-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup) started with
// FARMSLICER_PUSH_SERVICES=http://127.0.0.1:9451 (this test's fake push
// service). Exit code 0 iff all checks pass.
import { createServer } from "node:http";
import crypto from "node:crypto";
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";
import { startFakeMoonraker } from "./fake-moonraker/fake-moonraker.mjs";
import { addVoron, bracketsProject, printerFree, sleep, until } from "./farm-lib.mjs";

console.log(`notifications e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const unb64 = (s) => Buffer.from(s, "base64url");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

// ---- the fake push service: one endpoint per browser ----------------------------------------
const PUSH_PORT = 9451;
const browsers = new Map(); // endpoint name → { ecdh, auth, received: [] }
const gone = new Set(); // endpoint names that answer 410
function browser(name) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const b = { name, ecdh, auth: crypto.randomBytes(16), received: [], errors: [] };
  browsers.set(name, b);
  return b;
}
const subscription = (b) => ({
  endpoint: `http://127.0.0.1:${PUSH_PORT}/push/${b.name}`,
  keys: { p256dh: b64url(b.ecdh.getPublicKey()), auth: b64url(b.auth) },
});

/** RFC 8291 decryption, as a browser does it. */
function decrypt(b, body) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  if (rs < 18 || idlen !== 65 || sealed.length > rs) throw new Error(`bad header: rs ${rs}, idlen ${idlen}`);
  const uaPublic = b.ecdh.getPublicKey();
  const ecdhSecret = b.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hmac(hmac(b.auth, ecdhSecret), Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error("no last-record delimiter");
  return JSON.parse(padded.subarray(0, end).toString("utf8"));
}

/** RFC 8292: `vapid t=<ES256 JWT>, k=<public key>`; returns the claims and key. */
function verifyVapid(header) {
  const m = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!m) throw new Error(`not a vapid header: ${header}`);
  const [h, c, s] = m[1].split(".");
  const raw = unb64(m[2]);
  const key = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)) },
    format: "jwk",
  });
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, unb64(s));
  if (!ok) throw new Error("the VAPID signature doesn't verify");
  return { header: JSON.parse(unb64(h)), claims: JSON.parse(unb64(c)), key: m[2] };
}

const pushServer = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const name = req.url.replace(/^\/push\//, "");
    const b = browsers.get(name);
    if (!b) return res.writeHead(404).end();
    if (gone.has(name)) return res.writeHead(410).end();
    try {
      const vapid = verifyVapid(req.headers.authorization);
      const msg = decrypt(b, Buffer.concat(chunks));
      b.received.push({ msg, vapid, headers: req.headers });
      res.writeHead(201).end();
    } catch (e) {
      b.errors.push(String(e));
      res.writeHead(400).end(String(e));
    }
  });
});
await new Promise((resolve) => pushServer.listen(PUSH_PORT, "127.0.0.1", resolve));

async function received(b, n, ms = 8000) {
  for (let t = 0; t < ms && b.received.length < n; t += 100) await sleep(100);
  return b.received;
}

// ---- accounts ---------------------------------------------------------------------------------
const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));
async function enrol(username) {
  const made = await owner.post("/api/users", { username, role: "user" });
  const token = made.json.invite_url.split("/invite/")[1];
  const client = new Client({ "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0.0.0 Mobile Safari/537.36" });
  const done = await register(client, new SoftAuthenticator(), `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "k");
  check(done.status === 200, `${username} enrols`, json(done));
  return client;
}
const bob = await enrol("bob");
const opal = await enrol("opal");
const carl = await enrol("carl");
r = await owner.get("/api/users");
const opalId = r.json.find((u) => u.username === "opal")?.id;

// ---- settings ---------------------------------------------------------------------------------
r = await bob.get("/api/me/notifications");
check(r.status === 200 && unb64(r.json.key).length === 65 && unb64(r.json.key)[0] === 4, "the server's key: an uncompressed P-256 point", json(r));
const serverKey = r.json.key;
check(
  r.json.relations.map((x) => x.relation).join() === "mine" && !r.json.events.some((e) => e.event === "print.approval_requested"),
  "bob is offered his own prints, and no approval requests",
  json(r),
);
check(r.json.prefs["print.failed"].join() === "mine,operated" && r.json.prefs["print.finished"].length === 0, "defaults: failures of mine and of printers I operate", json(r));
check(r.json.subscriptions.length === 0, "no devices yet", json(r));
r = await owner.get("/api/me/notifications");
check(r.json.key === serverKey, "one key for everyone", json(r));
check(r.json.relations.some((x) => x.relation === "all") && r.json.events.some((e) => e.event === "print.approval_requested"), "admins: every print, approval requests", json(r));

r = await bob.put("/api/me/notifications", { prefs: { "print.exploded": ["mine"] } });
check(r.status === 400, "an unknown event is refused", json(r));
r = await bob.put("/api/me/notifications", { prefs: { "print.failed": ["friends"] } });
check(r.status === 400, "an unknown relation is refused", json(r));

// ---- subscribing ------------------------------------------------------------------------------
const bobPhone = browser("bob-phone");
const opalPhone = browser("opal-phone");
const carlPhone = browser("carl-phone");
const ownerLaptop = browser("owner-laptop");
r = await bob.post("/api/me/notifications/subscriptions", { ...subscription(bobPhone), endpoint: "https://evil.example.net/push/x" });
check(r.status === 400 && /push service/.test(r.json.error), "an endpoint that isn't a push service is refused", json(r));
r = await bob.post("/api/me/notifications/subscriptions", { ...subscription(bobPhone), keys: { p256dh: "AAAA", auth: b64url(bobPhone.auth) } });
check(r.status === 400, "a key that isn't a P-256 point is refused", json(r));
r = await bob.post("/api/me/notifications/subscriptions", subscription(bobPhone));
check(r.status === 201 && r.json.settings.subscriptions.length === 1, "bob's phone subscribes", json(r));
const bobDevice = r.json.id;
check(r.json.settings.subscriptions[0].label === "Chrome on Android", "named from its user agent", json(r));
r = await bob.post("/api/me/notifications/subscriptions", subscription(bobPhone));
check(r.status === 201 && r.json.id === bobDevice && r.json.settings.subscriptions.length === 1, "subscribing again keeps one device", json(r));
r = await opal.post("/api/me/notifications/subscriptions", subscription(opalPhone));
check(r.status === 201, "opal's phone subscribes", json(r));
r = await carl.post("/api/me/notifications/subscriptions", subscription(carlPhone));
check(r.status === 201, "carl's phone subscribes", json(r));
r = await owner.post("/api/me/notifications/subscriptions", { ...subscription(ownerLaptop), label: "Office laptop" });
check(r.status === 201 && r.json.settings.subscriptions[0].label === "Office laptop", "the owner's laptop subscribes, named", json(r));
r = await carl.del(`/api/me/notifications/subscriptions/${bobDevice}`);
check(r.status === 404, "carl can't remove bob's device", json(r));

// ---- a test push, as the browser reads it -------------------------------------------------------
r = await bob.post("/api/me/notifications/test");
check(r.status === 202 && r.json.devices === 1, "bob sends himself a test", json(r));
let got = await received(bobPhone, 1);
check(bobPhone.errors.length === 0, "the push decrypts and its signature verifies", bobPhone.errors.join("; "));
check(got[0]?.msg.title === "FarmSlicer" && got[0].msg.url === "/account", "the test notification", JSON.stringify(got[0]?.msg));
const vapid = got[0]?.vapid;
check(vapid?.key === serverKey && vapid.header.alg === "ES256", "signed with the server's key", JSON.stringify(vapid));
check(vapid?.claims.aud === `http://127.0.0.1:${PUSH_PORT}` && vapid.claims.exp > Date.now() / 1000 && /^https?:\/\//.test(vapid.claims.sub), "for the push service's origin, with a contact", JSON.stringify(vapid?.claims));
check(got[0]?.headers["content-encoding"] === "aes128gcm" && Number(got[0].headers.ttl) > 0, "aes128gcm, with a TTL", JSON.stringify(got[0]?.headers));
r = await bob.get("/api/me/notifications");
check(r.json.subscriptions[0].last_success_at, "the device's last delivery is recorded", json(r));

// ---- a print fails ------------------------------------------------------------------------------
const fakeA = await startFakeMoonraker({ printSeconds: 30 });
const fakeB = await startFakeMoonraker({ printSeconds: 30 });
const A = await addVoron(owner, fakeA, "Voron A");
const B = await addVoron(owner, fakeB, "Voron B");
r = await owner.post("/api/pools", { name: "Bay 1", printer_ids: [A], operator_ids: [opalId] });
check(r.status === 201, "opal operates Voron A", json(r));
r = await opal.get("/api/me/notifications");
check(r.json.relations.map((x) => x.relation).join() === "mine,operated", "now she's offered her printers", json(r));

r = await bob.form("/api/uploads", { file: [new Blob([bracketsProject()]), "Brackets.gcode.3mf"] });
check(r.status === 201, "bob uploads a project", json(r));
const job = r.json.id;
r = await bob.post(`/api/jobs/${job}/print`, { printer_id: A, plate: 1, acknowledge_review: true });
check(r.status === 201, "bob's plate goes to Voron A", json(r));
const failing = r.json.id;
await until(bob, `/api/prints/${failing}`, (p) => p?.status === "printing");
const before = { bob: bobPhone.received.length, opal: opalPhone.received.length, carl: carlPhone.received.length, owner: ownerLaptop.received.length };
await fetch(`http://${fakeA.address}/__fake/shutdown`);
await until(bob, `/api/prints/${failing}`, (p) => p?.status === "failed");
got = await received(bobPhone, before.bob + 1);
const bobMsg = got.at(-1)?.msg;
check(bobMsg?.title === "Print failed" && /on Voron A/.test(bobMsg.body) && bobMsg.tag === `print-${failing}` && bobMsg.url === "/prints", "bob hears his print failed", JSON.stringify(bobMsg));
check(got.at(-1)?.headers.urgency === "high", "urgently", JSON.stringify(got.at(-1)?.headers));
got = await received(opalPhone, before.opal + 1);
check(got.at(-1)?.msg.title === "Print failed", "opal hears it too: her printer", JSON.stringify(got.at(-1)?.msg));
await sleep(1000);
check(carlPhone.received.length === before.carl, "carl doesn't: not his print or printer", JSON.stringify(carlPhone.received.at(-1)?.msg));
check(ownerLaptop.received.length === before.owner, "nor the owner, who didn't ask for every print", JSON.stringify(ownerLaptop.received.at(-1)?.msg));

// ---- stopping a print yourself ---------------------------------------------------------------------
r = await owner.put("/api/me/notifications", { prefs: { "print.failed": ["all"] } });
check(r.status === 200 && r.json.prefs["print.failed"].join() === "all" && r.json.prefs["print.finished"].length === 0, "the owner asks for every print's failures", json(r));
r = await bob.post(`/api/jobs/${job}/print`, { printer_id: B, plate: 2, acknowledge_review: true });
check(r.status === 201, "and plate 2 to Voron B", json(r));
const stopping = r.json.id;
await until(bob, `/api/prints/${stopping}`, (p) => p?.status === "printing");
const before2 = { bob: bobPhone.received.length, opal: opalPhone.received.length, owner: ownerLaptop.received.length };
r = await bob.post(`/api/prints/${stopping}/control`, { action: "stop" });
check(r.status === 200, "bob stops his print on Voron B", json(r));
await until(bob, `/api/prints/${stopping}`, (p) => p?.status === "cancelled");
got = await received(ownerLaptop, before2.owner + 1);
check(got.at(-1)?.msg.title === "Print stopped" && /on Voron B/.test(got.at(-1).msg.body), "the owner hears it was stopped", JSON.stringify(got.at(-1)?.msg));
await sleep(1000);
check(bobPhone.received.length === before2.bob, "bob doesn't: he stopped it", JSON.stringify(bobPhone.received.at(-1)?.msg));
check(opalPhone.received.length === before2.opal, "opal doesn't: not her printer", JSON.stringify(opalPhone.received.at(-1)?.msg));

// ---- a print waits for approval ------------------------------------------------------------------------
await printerFree(owner, B);
r = await owner.call("PUT", "/api/settings", { print_rules: { materials: ["PETG"] } });
check(r.status === 200, "the site allows only PETG", json(r));
const before3 = { bob: bobPhone.received.length, opal: opalPhone.received.length, owner: ownerLaptop.received.length };
r = await bob.post(`/api/jobs/${job}/print`, { printer_id: B, plate: 1, acknowledge_review: true });
check(r.status === 202 && r.json.status === "pending_approval", "bob's PLA plate waits for approval", json(r));
const waiting = r.json.id;
got = await received(ownerLaptop, before3.owner + 1);
const ask = got.at(-1)?.msg;
check(ask?.title === "Print waiting for approval" && /^bob wants to print .* on Voron B\n/.test(ask.body) && ask.tag === `print-${waiting}`, "the owner, who may approve it, is asked", JSON.stringify(ask));
await sleep(1000);
check(opalPhone.received.length === before3.opal && bobPhone.received.length === before3.bob, "operators and the sender aren't: they can't approve", JSON.stringify([opalPhone.received.at(-1)?.msg, bobPhone.received.at(-1)?.msg]));
r = await owner.post(`/api/prints/${waiting}/reject`, { note: "PETG only" });
check(r.status === 200 && r.json.status === "rejected", "the owner rejects it", json(r));
r = await owner.call("PUT", "/api/settings", { print_rules: {} });

// ---- a subscription the push service says is gone ----------------------------------------------------
gone.add("carl-phone");
r = await carl.post("/api/me/notifications/test");
check(r.status === 202, "a test to carl's dead subscription", json(r));
const left = await until(carl, "/api/me/notifications", (s) => s?.subscriptions?.length === 0, 40);
check(left?.subscriptions?.length === 0, "a 410 forgets the device", JSON.stringify(left));
r = await carl.post("/api/me/notifications/test");
check(r.status === 409, "with no device, nothing to test", json(r));

// ---- removing a device ---------------------------------------------------------------------------------
r = await bob.del(`/api/me/notifications/subscriptions/${bobDevice}`);
check(r.status === 204, "bob removes his phone", json(r));
r = await bob.get("/api/me/notifications");
check(r.json.subscriptions.length === 0, "and it's gone", json(r));

await fakeA.close();
await fakeB.close();
pushServer.close();
finish();
