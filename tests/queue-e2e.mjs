#!/usr/bin/env node
// End-to-end test of the print queue (src/queue.rs) on two fake Klipper
// printers: queueing plates, the queue's order (priority, to the top,
// projects' priority and holds), pins, a printer's "send next", entries
// following their prints (printed; failed; a send that never happened
// gives the entry back), a direct send taking a queued entry, the site
// putting failed plates back, reprints of a project's missing copies, and
// what people who can't see a job see.
//
//   node tests/queue-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup). Exit code 0 iff all
// checks pass.
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";
import { startFakeMoonraker } from "./fake-moonraker/fake-moonraker.mjs";
import { addVoron, bracketsProject, printerFree, until } from "./farm-lib.mjs";

console.log(`queue e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);
const fakeA = await startFakeMoonraker({ printSeconds: 4 });
const fakeB = await startFakeMoonraker({ printSeconds: 4 });

const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));
const made = await owner.post("/api/users", { username: "bob", role: "user" });
const token = made.json.invite_url.split("/invite/")[1];
const bob = new Client();
r = await register(bob, new SoftAuthenticator(), `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "k");
check(r.status === 200, "bob enrols", json(r));

const A = await addVoron(owner, fakeA, "Voron A");
const B = await addVoron(owner, fakeB, "Voron B");

r = await owner.form("/api/uploads", { file: [new Blob([bracketsProject()]), "Brackets.gcode.3mf"] });
check(r.status === 201, "a two-plate project", json(r));
const job = r.json.id;

// ---- queueing --------------------------------------------------------------------------------
r = await owner.post("/api/queue", { job_id: job, plate: 3 });
check(r.status === 400 && /plate 3/.test(r.json.error), "a plate the job doesn't have is refused", json(r));
r = await owner.post("/api/queue", { job_id: job, count: 500 });
check(r.status === 400, "too many at once is refused", json(r));
r = await owner.post("/api/queue", { job_id: job, count: 2 });
check(r.status === 201 && r.json.length === 4 && r.json.map((e) => e.plate).join() === "1,1,2,2", "every plate twice: four entries", json(r));
const [e1, e2, e3, e4] = r.json.map((e) => e.id);

r = await owner.get("/api/queue");
check(r.json.entries.map((e) => e.id).join() === [e1, e2, e3, e4].join(), "in the order they were queued", json(r));
const first = r.json.entries[0];
check(first.lines?.length === 2 && first.lines[0].planned === 3 && first.fits?.length === 2 && first.fits.every((f) => f.refused === null), "each entry says what it holds and fits both printers", JSON.stringify(first));
check(r.json.printers.every((p) => p.next === e1 && p.busy === null), "both printers would take the first entry", JSON.stringify(r.json.printers));

r = await owner.patch(`/api/queue/${e4}`, { position: "top" });
check(r.status === 200 && r.json.priority === 1, "to the top: its priority goes above the rest", json(r));
r = await owner.patch(`/api/queue/${e3}`, { printer_id: B });
check(r.status === 200 && r.json.printer_id === B, "pin an entry to Voron B", json(r));
r = await owner.get("/api/queue");
check(r.json.entries[0].id === e4, "the moved entry leads", json(r));
const pinned = r.json.entries.find((e) => e.id === e3);
check(pinned.fits.find((f) => f.printer_id === A).refused === "pinned to another printer", "the pinned entry doesn't fit Voron A", JSON.stringify(pinned.fits));

// ---- send next ---------------------------------------------------------------------------------
r = await owner.post(`/api/printers/${A}/send-next`);
check(r.status === 201 && r.json.entry.id === e4 && r.json.entry.status === "sent" && r.json.entry.print_id === r.json.print.id, "Voron A takes the first entry", json(r));
const p4 = r.json.print.id;
r = await owner.post(`/api/printers/${A}/send-next`);
check(r.status === 409, "a busy printer takes nothing more", json(r));
r = await owner.get("/api/queue");
check(!r.json.entries.some((e) => e.id === e4) && r.json.printers.find((p) => p.printer_id === A).busy, "the sent entry leaves the queue; Voron A is busy", json(r));
r = await owner.get("/api/queue?status=sent");
check(r.json.entries.length === 1 && r.json.entries[0].id === e4, "it shows as sent", json(r));

r = await owner.post(`/api/printers/${B}/send-next`);
check(r.status === 201 && r.json.entry.id === e1, "Voron B takes the next one", json(r));
const p1 = r.json.print.id;

// A stopped print's entry fails.
await until(owner, `/api/prints/${p1}`, (p) => p?.status === "printing" && p.started_at);
r = await owner.post(`/api/prints/${p1}/control`, { action: "stop" });
await until(owner, `/api/prints/${p1}`, (p) => p?.status === "cancelled");
r = await until(owner, "/api/queue?status=done", (x) => x?.entries?.some((e) => e.id === e1));
check(r.entries.find((e) => e.id === e1)?.status === "failed", "a stopped print's entry failed", JSON.stringify(r));
r = await owner.get("/api/queue");
check(!r.json.entries.some((e) => e.note?.includes("again")), "nothing queued again by default", json(r));

await until(owner, `/api/prints/${p4}`, (p) => p?.status === "finished");
r = await until(owner, "/api/queue?status=done", (x) => x?.entries?.some((e) => e.id === e4));
check(r.entries.find((e) => e.id === e4)?.status === "printed", "a finished print's entry is printed", JSON.stringify(r));

// ---- the site puts failed plates back ------------------------------------------------------------
r = await owner.put("/api/settings", { requeue_failed: true });
check(r.status === 200 && r.json.requeue_failed === true, "failed plates go back in the queue", json(r));
await printerFree(owner, A);
r = await owner.post(`/api/queue/${e2}/send`, { printer_id: A });
check(r.status === 201 && r.json.entry.status === "sent", "send one entry to a chosen printer", json(r));
const p2 = r.json.print.id;
await until(owner, `/api/prints/${p2}`, (p) => p?.status === "printing" && p.started_at);
await owner.post(`/api/prints/${p2}/control`, { action: "stop" });
r = await until(owner, "/api/queue", (x) => x?.entries?.some((e) => e.note?.includes("again")));
const again = r.entries.find((e) => e.note?.includes("again"));
check(again?.plate === 1 && again.job_id === job, "the failed plate is queued again", JSON.stringify(r));
await owner.put("/api/settings", { requeue_failed: false });

// ---- a direct send takes a queued entry ------------------------------------------------------------
await printerFree(owner, A);
r = await owner.post(`/api/jobs/${job}/print`, { printer_id: A, plate: 1 });
check(r.status === 201, "plate 1 sent directly", json(r));
const direct = r.json.id;
r = await owner.get("/api/queue?status=sent");
check(r.json.entries.some((e) => e.id === again.id && e.print_id === direct), "it took the plate's queued entry", json(r));
await until(owner, `/api/prints/${direct}`, (p) => p?.status === "finished");

// ---- a send that fails gives the entry back -------------------------------------------------------
await printerFree(owner, B);
await fakeB.close();
await until(owner, "/api/printers/status", (l) => l?.find((s) => s.printer_id === B)?.online === false);
r = await owner.post(`/api/queue/${e3}/send`, { printer_id: B });
check(r.status === 409 && /offline/.test(r.json.error), "an offline printer is refused", json(r));
r = await owner.get("/api/queue");
check(r.json.entries.some((e) => e.id === e3 && e.status === "queued"), "and the entry is still queued", json(r));
r = await owner.post(`/api/queue/${e3}/send`, { printer_id: A });
check(r.status === 409 && /pinned/.test(r.json.error), "a pinned entry goes nowhere else", json(r));
r = await owner.patch(`/api/queue/${e3}`, { printer_id: null });
check(r.status === 200 && r.json.printer_id === null, "unpin it", json(r));

// ---- projects: priority, holds, reprints -------------------------------------------------------------
r = await owner.form("/api/uploads", { file: [new Blob([bracketsProject()]), "Order brackets.gcode.3mf"] });
const orderJob = r.json.id;
r = await owner.post("/api/projects", {
  name: "Rush order",
  priority: 50,
  items: [{ job_id: orderJob, part: "Bracket", quantity: 6 }],
});
check(r.status === 201, "a rush project from another upload", json(r));
const rush = r.json.id;
const bracket = r.json.items[0].id;
r = await owner.post(`/api/projects/${rush}/items/${bracket}/reprint`);
check(r.status === 201 && r.json.length === 2 && r.json.every((e) => e.plate === 1), "6 brackets, 3 per plate: plate 1 twice", json(r));
r = await owner.get(`/api/projects/${rush}`);
check(r.json.items[0].queued === 6 && r.json.items[0].missing === 0, "the item counts them as queued", json(r));
r = await owner.get("/api/queue");
check(r.json.entries[0].job_id === orderJob && r.json.entries[0].projects?.[0]?.name === "Rush order", "the rush project's plates go first", json(r));
r = await owner.post(`/api/projects/${rush}/items/${bracket}/reprint`);
check(r.status === 409 && /missing/.test(r.json.error), "no more reprints while nothing is missing", json(r));

r = await owner.post(`/api/projects/${rush}/status`, { status: "on_hold" });
r = await owner.get("/api/queue");
const held = r.json.entries.filter((e) => e.job_id === orderJob);
check(held.length === 2 && held.every((e) => e.held) && r.json.entries[r.json.entries.length - 1].held, "a project on hold: its entries wait at the back", json(r));
check(r.json.printers.find((p) => p.printer_id === A).next !== held[0].id, "and no printer takes them", json(r));
await owner.post(`/api/projects/${rush}/status`, { status: "open" });

// ---- what others see -------------------------------------------------------------------------------
r = await bob.get("/api/queue");
check(r.status === 200 && r.json.entries.length > 0 && r.json.entries.every((e) => e.visible === false && e.job_name === null), "bob sees the queue's length, not what's in it", json(r));
r = await bob.post(`/api/printers/${A}/send-next`);
check(r.status === 403, "bob can't send the queue to a printer", json(r));
r = await bob.patch(`/api/queue/${e3}`, { priority: 5 });
check(r.status === 404, "nor change entries", json(r));
r = await bob.post("/api/queue", { job_id: job });
check(r.status === 404, "nor queue jobs he can't see", json(r));

// ---- removing ---------------------------------------------------------------------------------------
r = await owner.del(`/api/queue/${e3}`);
check(r.status === 204, "remove an entry", json(r));
r = await owner.get("/api/queue?status=done");
check(r.json.entries.find((e) => e.id === e3)?.status === "cancelled", "it ends cancelled", json(r));
r = await owner.del(`/api/queue/${e3}`);
check(r.status === 409, "only queued entries can be removed", json(r));

await fakeA.close();
finish();
