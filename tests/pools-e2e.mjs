#!/usr/bin/env node
// End-to-end test of printer pools and operators (src/pools.rs): admins
// make pools; an operator sees the queue for their printers in full, sends
// the next plate to them (not to other printers), controls the print and
// records its outcome; entries for a pool go only to its printers; others
// can do none of that; deleting a pool frees its entries.
//
//   node tests/pools-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup). Exit code 0 iff all
// checks pass.
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";
import { startFakeMoonraker } from "./fake-moonraker/fake-moonraker.mjs";
import { addVoron, bracketsProject, until } from "./farm-lib.mjs";

console.log(`pools e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);
const fakeA = await startFakeMoonraker({ printSeconds: 4 });
const fakeB = await startFakeMoonraker({ printSeconds: 4 });

const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));
async function enrol(username) {
  const made = await owner.post("/api/users", { username, role: "user" });
  const token = made.json.invite_url.split("/invite/")[1];
  const client = new Client();
  const done = await register(client, new SoftAuthenticator(), `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "k");
  check(done.status === 200, `${username} enrols`, json(done));
  return { client, id: made.json.id ?? made.json.user?.id };
}
const op = await enrol("opal");
const bob = await enrol("bob");
r = await owner.get("/api/users");
const opId = r.json.find((u) => u.username === "opal")?.id;

const A = await addVoron(owner, fakeA, "Voron A");
const B = await addVoron(owner, fakeB, "Voron B");

// ---- pools --------------------------------------------------------------------------------
r = await op.client.post("/api/pools", { name: "Bay 1", printer_ids: [A] });
check(r.status === 403, "only admins make pools", json(r));
r = await owner.post("/api/pools", { name: "Bay 1", printer_ids: [A], operator_ids: [opId], settings: { mixing: "sometimes" } });
check(r.status === 400 && /mixing/.test(r.json.error), "a pool's mixing rule is checked", json(r));
r = await owner.post("/api/pools", { name: "Bay 1", printer_ids: [A, "nope"], operator_ids: [opId] });
check(r.status === 400, "an unknown printer is refused", json(r));
r = await owner.post("/api/pools", { name: "Bay 1", printer_ids: [A], operator_ids: [opId], settings: { mixing: "any" } });
check(r.status === 201 && r.json.printer_ids.join() === A && r.json.operators[0].username === "opal", "Bay 1: Voron A, run by opal", json(r));
const bay1 = r.json.id;
r = await owner.post("/api/pools", { name: "bay 1", printer_ids: [B] });
check(r.status === 409, "pool names are unique", json(r));
r = await owner.post("/api/pools", { name: "Bay 2", printer_ids: [B] });
check(r.status === 201, "Bay 2: Voron B, no operator", json(r));
const bay2 = r.json.id;

r = await op.client.get("/api/pools");
check(r.json.pools.length === 1 && r.json.pools[0].id === bay1, "opal sees her pool", json(r));
r = await bob.client.get("/api/pools");
check(r.json.pools.length === 0, "bob sees none", json(r));
r = await owner.get("/api/pools");
check(r.json.pools.length === 2 && r.json.mixing === "group", "admins see every pool and the site's mixing rule", json(r));
r = await owner.put("/api/settings", { mixing: "sometimes" });
check(r.status === 400, "the site's mixing rule is checked", json(r));

// ---- the operator's queue ---------------------------------------------------------------------
r = await owner.form("/api/uploads", { file: [new Blob([bracketsProject()]), "Brackets.gcode.3mf"] });
const job = r.json.id;
r = await owner.post("/api/queue", { job_id: job, plate: 1, count: 2 });
check(r.status === 201, "the owner queues plate 1 twice", json(r));
const [first, second] = r.json.map((e) => e.id);
r = await owner.post("/api/queue", { job_id: job, plate: 2, pool_id: bay2 });
check(r.status === 201 && r.json[0].pool_id === bay2, "and plate 2 for Bay 2 only", json(r));
const forBay2 = r.json[0].id;
r = await owner.post("/api/queue", { job_id: job, plate: 2, pool_id: "nope" });
check(r.status === 400, "an unknown pool is refused", json(r));

r = await op.client.get("/api/queue");
const mine = r.json.entries.find((e) => e.id === first);
check(mine?.visible && mine.lines?.length === 2, "opal sees the entries her printer could take", json(r));
const notMine = r.json.entries.find((e) => e.id === forBay2);
check(notMine && notMine.visible === false, "but not Bay 2's", json(r));
check(r.json.printers.find((p) => p.printer_id === A).operates && !r.json.printers.find((p) => p.printer_id === B).operates, "she operates Voron A, not B", json(r));
r = await owner.get(`/api/queue?pool=${bay2}`);
check(r.json.printers.length === 1 && r.json.printers[0].printer_id === B && r.json.entries.some((e) => e.id === forBay2), "the queue for Bay 2: its printer and what fits it", json(r));
const bay2Entry = r.json.entries.find((e) => e.id === forBay2);
check(bay2Entry?.fits?.[0]?.refused === null, "Bay 2's entry fits Voron B", json(r));
r = await owner.get("/api/queue");
check(r.json.entries.find((e) => e.id === forBay2).fits.find((f) => f.printer_id === A).refused === "for another pool's printers", "and nothing else", json(r));

r = await bob.client.post(`/api/printers/${A}/send-next`);
check(r.status === 403, "bob can't send the queue to Voron A", json(r));
r = await op.client.post(`/api/printers/${B}/send-next`);
check(r.status === 403, "opal can't send it to Voron B", json(r));
r = await op.client.post(`/api/queue/${forBay2}/send`, { printer_id: A });
check(r.status === 403 || r.status === 404 || r.status === 409, "nor send Bay 2's plate to her printer", json(r));
r = await op.client.post(`/api/printers/${A}/send-next`);
check(r.status === 201 && r.json.entry.id === first && r.json.print.user_id === opId, "opal sends the next plate to Voron A; the print is hers", json(r));
const print = r.json.print.id;

// ---- operating the print --------------------------------------------------------------------------
await until(op.client, `/api/prints/${print}`, (p) => p?.status === "printing");
r = await bob.client.post(`/api/prints/${print}/control`, { action: "pause" });
check(r.status === 404, "bob can't touch it", json(r));
r = await op.client.post(`/api/printers/${A}/control`, { action: "pause" });
check(r.status === 200, "opal pauses her printer", json(r));
r = await op.client.post(`/api/printers/${B}/control`, { action: "pause" });
check(r.status === 403, "but not Voron B", json(r));
await until(op.client, `/api/prints/${print}`, (p) => p?.status === "paused");
r = await op.client.post(`/api/prints/${print}/control`, { action: "resume" });
check(r.status === 200, "and resumes the print", json(r));
let p = await until(op.client, `/api/prints/${print}`, (x) => x?.status === "finished");
check(p.can_record_outcome, "it finishes; opal may say how it came out", JSON.stringify(p));
r = await op.client.post(`/api/prints/${print}/outcome`, { all: "good" });
check(r.status === 200 && r.json.outcome_by === "opal", "she records it", json(r));
r = await bob.client.post(`/api/prints/${print}/outcome`, { all: "failed", reason: "other" });
check(r.status === 404, "bob can't", json(r));

// A print on her printer by someone else: she can operate it too.
r = await owner.post(`/api/queue/${second}/send`, { printer_id: A });
check(r.status === 201, "the owner sends the other plate to Voron A", json(r));
const owners = r.json.print.id;
r = await op.client.get(`/api/prints/${owners}`);
check(r.status === 200 && r.json.can_control, "opal sees and controls a print on her printer", json(r));
await until(op.client, `/api/prints/${owners}`, (x) => x?.status === "printing" && x.started_at);
r = await op.client.post(`/api/prints/${owners}/control`, { action: "stop" });
check(r.status === 200, "she stops it", json(r));
p = await until(op.client, `/api/prints/${owners}`, (x) => x?.status === "cancelled");
check(p.outcome === "failed", "the printer's record says failed", JSON.stringify(p));

// ---- changing and deleting pools ----------------------------------------------------------------
r = await owner.patch(`/api/pools/${bay1}`, { operator_ids: [] });
check(r.status === 200 && r.json.operators.length === 0 && r.json.printer_ids.join() === A, "opal stops operating Bay 1 (its printers stay)", json(r));
r = await op.client.post(`/api/printers/${A}/send-next`);
check(r.status === 403, "and can't send to Voron A any more", json(r));
r = await owner.del(`/api/pools/${bay2}`);
check(r.status === 204, "Bay 2 is deleted", json(r));
r = await owner.get("/api/queue");
const freed = r.json.entries.find((e) => e.id === forBay2);
check(freed.pool_id === null && freed.fits.every((f) => f.refused === null), "its entry may go to any printer now", json(r));

await fakeA.close();
await fakeB.close();
finish();
