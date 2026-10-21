#!/usr/bin/env node
// End-to-end test of printers taking the queue by themselves
// (src/dispatch.rs) on a fake Klipper printer: `confirm` waits for someone
// to say the bed is clear before each plate; `yolo` (only when
// acknowledged) sends the next plate as soon as the last one finished,
// and stops after a failure until the bed is cleared; `manual` sends
// nothing; only admins and operators choose.
//
//   node tests/dispatch-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup). Exit code 0 iff all
// checks pass.
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";
import { startFakeMoonraker } from "./fake-moonraker/fake-moonraker.mjs";
import { addVoron, bracketsProject, sleep, until } from "./farm-lib.mjs";

console.log(`dispatch e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);
const fake = await startFakeMoonraker({ printSeconds: 4 });

const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));
const made = await owner.post("/api/users", { username: "bob", role: "user" });
const token = made.json.invite_url.split("/invite/")[1];
const bob = new Client();
await register(bob, new SoftAuthenticator(), `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "k");

const printer = await addVoron(owner, fake);
r = await owner.form("/api/uploads", { file: [new Blob([bracketsProject()]), "Brackets.gcode.3mf"] });
const job = r.json.id;
r = await owner.post("/api/queue", { job_id: job, plate: 2, count: 5 });
check(r.status === 201 && r.json.length === 5, "five plates queued", json(r));

const prints = async () => (await owner.get(`/api/prints?printer=${printer}`)).json;
const dispatchOf = async () => (await owner.get("/api/printers")).json.find((p) => p.id === printer).dispatch;
async function printsBecome(n, tries = 60) {
  let l;
  for (let i = 0; i < tries; i++) {
    l = await prints();
    if (l.length >= n) return l;
    await sleep(250);
  }
  return l;
}
async function lastEnds(status = "finished") {
  return until(owner, `/api/prints?printer=${printer}`, (l) => l?.[0]?.status === status, 120);
}

// ---- choosing ---------------------------------------------------------------------------
check((await dispatchOf()).send_mode === "manual", "printers start manual", "");
r = await bob.post(`/api/printers/${printer}/send-mode`, { mode: "confirm" });
check(r.status === 403, "bob can't choose", json(r));
r = await owner.post(`/api/printers/${printer}/send-mode`, { mode: "sometimes" });
check(r.status === 400, "unknown modes are refused", json(r));
r = await owner.post(`/api/printers/${printer}/send-mode`, { mode: "yolo" });
check(r.status === 400 && /acknowledge/.test(r.json.error), "YOLO must be acknowledged", json(r));

// ---- confirm -----------------------------------------------------------------------------
r = await owner.post(`/api/printers/${printer}/send-mode`, { mode: "confirm" });
check(r.status === 200 && r.json.send_mode === "confirm" && r.json.waiting_for === "bed" && r.json.set_by === "owner", "confirm: waiting for someone to clear the bed", json(r));
await sleep(2000);
check((await prints()).length === 0, "nothing goes out until then", "");
r = await bob.post(`/api/printers/${printer}/bed-clear`);
check(r.status === 403, "bob can't say the bed is clear", json(r));
r = await owner.post(`/api/printers/${printer}/bed-clear`);
check(r.status === 200 && r.json.waiting_for === null, "the owner says it's clear", json(r));
let l = await printsBecome(1);
check(l.length === 1 && l[0].user_id, "the next plate goes out by itself, as the owner", JSON.stringify(l));
await lastEnds();
await sleep(2500);
l = await prints();
check(l.length === 1 && (await dispatchOf()).waiting_for === "bed", "after it, the printer waits for the bed again", JSON.stringify(l));
r = await owner.post(`/api/prints/${l[0].id}/outcome`, { all: "good" });
await owner.post(`/api/printers/${printer}/bed-clear`);
l = await printsBecome(2);
check(l.length === 2, "cleared again: the next plate", JSON.stringify(l));
await lastEnds();

// ---- yolo --------------------------------------------------------------------------------
r = await owner.post(`/api/printers/${printer}/send-mode`, { mode: "yolo", acknowledge: true });
check(r.status === 200 && r.json.send_mode === "yolo" && r.json.waiting_for === null, "YOLO, acknowledged", json(r));
r = await owner.get("/api/queue");
check(r.json.printers[0].send_mode === "yolo", "the queue shows it", json(r));
l = await printsBecome(3);
check(l.length === 3, "the next plate goes out at once (the last one finished)", JSON.stringify(l));
// In YOLO the next print starts the moment one finishes: follow this one.
const third = l[0].id;
await until(owner, `/api/prints/${third}`, (x) => x?.status === "finished", 120);
l = await printsBecome(4);
check(l.length === 4, "and the next, with nobody asked", JSON.stringify(l));
const fourth = l[0].id;
let p = await until(owner, `/api/prints/${fourth}`, (x) => x?.status === "printing" && x.started_at);
r = await owner.post(`/api/prints/${fourth}/control`, { action: "stop" });
check(r.status === 200, "stop it while it prints", json(r));
p = await until(owner, `/api/prints/${fourth}`, (x) => x?.status === "cancelled");
check(p.status === "cancelled", "it ends cancelled", JSON.stringify(p));
await sleep(2500);
l = await prints();
const d = await dispatchOf();
check(l.length === 4 && d.waiting_for === "bed", "after a stopped print, YOLO waits for the bed", JSON.stringify({ n: l.length, d }));
await owner.post(`/api/printers/${printer}/bed-clear`);
l = await printsBecome(5);
check(l.length === 5, "cleared: it goes on", JSON.stringify(l));
await lastEnds();

// ---- the door says the bed was cleared -----------------------------------------------------
// A printer with a door switch: opening and closing the door after a print
// counts as clearing the bed; nobody presses anything.
const doorFake = await startFakeMoonraker({ printSeconds: 2, door: true });
const doored = await addVoron(owner, doorFake, "Voron Door");
r = await owner.post("/api/queue", { job_id: job, plate: 2, count: 2, printer_id: doored });
check(r.status === 201, "two plates for the door printer", json(r));
r = await owner.post(`/api/printers/${doored}/send-mode`, { mode: "confirm" });
check(r.status === 200 && r.json.clear_signal === "door" && r.json.waiting_for === "bed", "it reports its door, and waits for the bed", json(r));
const doorPrints = async () => (await owner.get(`/api/prints?printer=${doored}`)).json;
doorFake.setDoor(true);
await sleep(500);
doorFake.setDoor(false);
let dl = await until(owner, `/api/prints?printer=${doored}`, (x) => x?.length === 1);
check(dl.length === 1, "door opened and closed: the next plate starts by itself", JSON.stringify(dl));
await until(owner, `/api/prints/${dl[0].id}`, (x) => x?.status === "finished", 120);
await sleep(2500);
check((await doorPrints()).length === 1, "after it, nothing until the door moves again", "");
doorFake.setDoor(true);
await sleep(500);
doorFake.setDoor(false);
dl = await until(owner, `/api/prints?printer=${doored}`, (x) => x?.length === 2);
check(dl.length === 2, "another door cycle: the next plate", JSON.stringify(dl));
await until(owner, `/api/prints/${dl[0].id}`, (x) => x?.status === "finished", 120);
await owner.post(`/api/printers/${doored}/send-mode`, { mode: "manual" });
await doorFake.close();

// ---- manual ------------------------------------------------------------------------------
r = await owner.post(`/api/printers/${printer}/send-mode`, { mode: "manual" });
check(r.status === 200 && r.json.send_mode === "manual", "back to manual", json(r));
r = await owner.post("/api/queue", { job_id: job, plate: 2 });
await sleep(2500);
check((await prints()).length === 5, "a queued plate waits for someone again", "");

await fake.close();
finish();
