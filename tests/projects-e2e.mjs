#!/usr/bin/env node
// End-to-end test of projects (src/projects.rs): creating one from ordering
// software (idempotent by external_ref), items made from a job's parts,
// progress counted from prints and their outcomes (printing, unchecked,
// good, failed, missing), a job reused by a second project counting only
// once, open → printed by itself (and back when a record is corrected),
// fulfillment statuses, a job made for a project from POST /api/jobs, and
// who may see and change what.
//
//   node tests/projects-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup). Exit code 0 iff all
// checks pass.
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";
import { startFakeMoonraker } from "./fake-moonraker/fake-moonraker.mjs";
import { addVoron, bracketsProject, printerFree, until } from "./farm-lib.mjs";

console.log(`projects e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);
const fake = await startFakeMoonraker({ printSeconds: 1.5 });

const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));

async function enrol(username) {
  const made = await owner.post("/api/users", { username, role: "user" });
  const token = made.json.invite_url.split("/invite/")[1];
  const client = new Client();
  const done = await register(client, new SoftAuthenticator(), `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "k");
  check(done.status === 200, `${username} enrols`, json(done));
  return client;
}
const alice = await enrol("alice");
const bob = await enrol("bob");

const printer = await addVoron(owner, fake);

r = await alice.form("/api/uploads", { file: [new Blob([bracketsProject()]), "Brackets.gcode.3mf"] });
check(r.status === 201, "alice uploads a two-plate project", json(r));
const job = r.json.id;

r = await alice.get(`/api/jobs/${job}/parts`);
check(
  r.status === 200 && r.json.length === 2 && r.json[0].name === "Bracket" && r.json[0].copies === 3 && r.json[1].copies === 2 && r.json[1].item === null,
  "the job's parts: 3 brackets on plate 1, a clip on each plate",
  json(r),
);

// ---- ordering software creates a project ---------------------------------------------------
const order = {
  name: "Order 1001",
  client_ref: "acme",
  external_ref: "ORD-1001",
  due_at: "2026-11-01",
  priority: 5,
  items: [
    { job_id: job, part: "Bracket", quantity: 5 },
    { job_id: job, part: "Clip", quantity: 2 },
    { name: "Hand-finished sign", quantity: 1 },
  ],
};
r = await alice.post("/api/projects", { ...order, items: [{ job_id: job, part: "Bolt", quantity: 1 }] });
check(r.status === 400 && /no such part/.test(r.json.error), "an item from a part the job doesn't have is refused", json(r));
r = await alice.get("/api/projects?external_ref=ORD-1001");
check(r.json.length === 0, "and nothing was left behind", json(r));
r = await alice.post("/api/projects", { ...order, due_at: "soon" });
check(r.status === 400 && /due_at/.test(r.json.error), "a due date must be a date", json(r));

r = await alice.post("/api/projects", order);
check(r.status === 201 && r.json.status === "open" && r.json.items.length === 3, "the project is made with three items", json(r));
const project = r.json.id;
const [bracket, clip, sign] = r.json.items;
check(bracket.linked === undefined && bracket.missing === 5 && clip.missing === 2 && sign.missing === 1, "nothing printed yet: every copy missing", json(r));
check(r.json.summary.wanted === 8 && r.json.summary.items === 3 && r.json.due_at === "2026-11-01" && r.json.priority === 5, "its totals and due date", json(r));

r = await alice.post("/api/projects", order);
check(r.status === 200 && r.json.id === project, "retrying with the same external_ref returns the same project", json(r));

r = await alice.get(`/api/projects/${project}`);
const plates = r.json.jobs?.[0];
check(r.status === 200 && r.json.jobs.length === 1 && plates.parts.length === 3 && plates.sendable, "the job's plates carry the bracket (plate 1) and the clip (both plates)", json(r));

r = await alice.get(`/api/jobs/${job}/parts`);
check(r.json[0].item?.project_id === project && r.json[0].item.name === "Bracket", "the job says which item each part counts for", json(r));

// ---- printing and outcomes move it along ----------------------------------------------------
async function itemsOf(client = alice) {
  const p = (await client.get(`/api/projects/${project}`)).json;
  return { p, bracket: p.items[0], clip: p.items[1] };
}
async function printPlate(plate) {
  await printerFree(owner, printer);
  const sent = await alice.post(`/api/jobs/${job}/print`, { printer_id: printer, plate });
  check(sent.status === 201 || sent.status === 202, `plate ${plate} goes to the printer`, JSON.stringify(sent.json));
  return sent.json.id;
}

let print = await printPlate(1);
await until(alice, `/api/prints/${print}`, (x) => x?.status === "printing");
let s = await itemsOf();
check(s.bracket.printing === 3 && s.clip.printing === 1 && s.bracket.missing === 2, "while it prints: 3 brackets and a clip on their way, 2 brackets missing", JSON.stringify(s.p.items));
await until(alice, `/api/prints/${print}`, (x) => x?.status === "finished");
s = await itemsOf();
check(s.bracket.unchecked === 3 && s.bracket.printing === 0 && s.bracket.good === 0, "finished: unchecked until someone looks", JSON.stringify(s.bracket));

r = await alice.post(`/api/prints/${print}/outcome`, { all: "good", lines: [{ line: 0, good: 2, failed: 1, reason: "warping" }] });
check(r.status === 200 && r.json.lines[0].item_id === bracket.id && r.json.lines[1].item_id === clip.id, "the record's lines say which items they are for", json(r));
s = await itemsOf();
check(s.bracket.good === 2 && s.bracket.failed === 1 && s.bracket.missing === 3 && s.clip.good === 1 && s.clip.missing === 1, "2 good brackets and a failed one: 3 missing; 1 of 2 clips", JSON.stringify(s.p.items));

// ---- a second project reusing the job counts nothing twice ----------------------------------
r = await alice.post("/api/projects", { name: "Order 1002", items: [{ job_id: job, part: "Bracket", quantity: 3 }] });
check(r.status === 201 && r.json.items[0].missing === 3, "a second project's item from the same job", json(r));
const second = r.json.id;
r = await alice.get(`/api/projects/${second}`);
check(r.json.jobs.length === 0 && r.json.items[0].good === 0, "is a recipe only: the job's plates still count for the first project", json(r));
r = await alice.post(`/api/projects/${second}/jobs`, { job_id: job, items: [{ part: "Bracket" }] });
check(r.status === 409 && /another item/.test(r.json.error), "linking the job to it again is refused", json(r));

// ---- every item done: printed by itself ------------------------------------------------------
for (const plate of [1, 2]) {
  print = await printPlate(plate);
  await until(alice, `/api/prints/${print}`, (x) => x?.status === "finished");
  r = await alice.post(`/api/prints/${print}/outcome`, { all: "good" });
  check(r.status === 200, `plate ${plate}: all good`, json(r));
}
s = await itemsOf();
check(s.bracket.good === 5 && s.bracket.done && s.clip.good === 3 && s.clip.done, "5 brackets, 3 clips: both done", JSON.stringify(s.p.items));
check(s.p.status === "open" && s.p.summary.items_done === 2, "the hand-finished sign keeps it open", JSON.stringify(s.p));
r = await alice.del(`/api/projects/${project}/items/${sign.id}`);
check(r.status === 204, "drop the sign", json(r));
s = await itemsOf();
check(s.p.status === "printed" && s.p.printed_at, "every item done: printed", JSON.stringify(s.p));

// A corrected record reopens it.
r = await alice.post(`/api/prints/${print}/outcome`, { all: "failed", reason: "surface" });
s = await itemsOf();
check(s.p.status === "printed" && s.clip.good === 2 && s.clip.done, "the last clip failing still leaves 2 of 2", JSON.stringify(s.p.items));
r = await alice.patch(`/api/projects/${project}/items/${clip.id}`, { quantity: 4 });
check(r.status === 200 && r.json.quantity === 4, "the order grows to 4 clips", json(r));
s = await itemsOf();
check(s.p.status === "open" && s.clip.missing === 2, "and the project is open again, 2 clips missing", JSON.stringify(s.p));
r = await alice.patch(`/api/projects/${project}/items/${clip.id}`, { quantity: 2 });
s = await itemsOf();
check(s.p.status === "printed", "back to 2: printed", JSON.stringify(s.p));

// ---- fulfillment -----------------------------------------------------------------------------
r = await alice.post(`/api/projects/${project}/status`, { status: "printed" });
check(r.status === 400, "printed is never set by hand", json(r));
r = await alice.post(`/api/projects/${project}/status`, { status: "ready", note: "box 4" });
check(r.status === 200 && r.json.status === "ready" && r.json.status_note === "box 4", "packed: ready", json(r));
r = await alice.post(`/api/projects/${project}/status`, { status: "shipped", note: "1Z999" });
check(r.status === 200 && r.json.status === "shipped" && r.json.shipped_at, "shipped", json(r));
r = await alice.get("/api/projects?status=active");
check(!r.json.some((p) => p.id === project) && r.json.some((p) => p.id === second), "shipped projects leave the active list", json(r));
r = await alice.get("/api/projects?client_ref=acme");
check(r.json.length === 1 && r.json[0].summary.good === 7, "projects by client_ref, with totals", json(r));

// ---- who sees what ---------------------------------------------------------------------------
r = await bob.get(`/api/projects/${project}`);
check(r.status === 404, "bob doesn't see alice's project", json(r));
r = await bob.get("/api/projects");
check(r.status === 200 && r.json.length === 0, "nor in the list", json(r));
r = await bob.post("/api/projects", { name: "Bob's", items: [{ job_id: job, part: "Clip" }] });
check(r.status === 404, "nor use her job as a recipe", json(r));
r = await owner.get(`/api/projects/${project}`);
check(r.status === 200 && r.json.can_edit, "admins see and change every project", json(r));
r = await bob.patch(`/api/projects/${project}`, { name: "Mine now" });
check(r.status === 404, "bob can't change it", json(r));
r = await alice.patch(`/api/projects/${project}`, { name: "Order 1001 (acme)", due_at: null, priority: 200 });
check(r.status === 400 && /priority/.test(r.json.error), "priority is bounded", json(r));
r = await alice.patch(`/api/projects/${project}`, { name: "Order 1001 (acme)", due_at: null });
check(r.status === 200 && r.json.name === "Order 1001 (acme)" && r.json.due_at === null, "alice renames it and clears the due date", json(r));

// ---- a job made for a project ----------------------------------------------------------------
const ID = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const at = (model, x) => ({ model, placement: { rotation: ID, offset: [x, 0] } });
const fd = new FormData();
fd.append("source", "browser");
fd.append("local_models", JSON.stringify([{ name: "Knob.stl", bytes: 10 }, { name: "Dial.stl", bytes: 10 }]));
fd.append("plates", JSON.stringify({ plates: [{ objects: [at(0, -40), at(0, 0), at(1, 40)] }, { objects: [at(0, 0)] }] }));
fd.append("project", JSON.stringify({ new: { name: "Panel kit", client_ref: "acme" }, items: [{ model: 0, quantity: 6 }, { model: 1, name: "Dial (blue)" }] }));
r = await alice.call("POST", "/api/jobs", fd);
check(r.status === 201, "a job made for a new project", json(r));
const kitJob = r.json.id;
r = await alice.get("/api/projects?q=Panel");
const kit = r.json[0];
check(kit?.summary.items === 2 && kit.summary.wanted === 7 && kit.client_ref === "acme", "the project exists with its two items", json(r));
r = await alice.get(`/api/projects/${kit.id}`);
const [knob, dial] = r.json.items;
check(knob.name === "Knob" && knob.quantity === 6 && knob.job_id === kitJob && dial.name === "Dial (blue)" && dial.quantity === 1, "items named after their models, quantities as asked", json(r));
check(r.json.jobs[0].parts.filter((p) => p.item_id === knob.id).map((p) => p.copies).join() === "2,1", "the knob's copies on each plate", json(r));

const fd2 = new FormData();
fd2.append("source", "browser");
fd2.append("model_name", "Knob.stl");
fd2.append("project", JSON.stringify({ project_id: kit.id, items: [{ item_id: knob.id }] }));
r = await alice.call("POST", "/api/jobs", fd2);
check(r.status === 201, "another plate of knobs for the same item", json(r));
r = await alice.get(`/api/projects/${kit.id}`);
check(r.json.jobs.length === 2 && r.json.items.length === 2, "counts for the existing item", json(r));

const fd3 = new FormData();
fd3.append("source", "browser");
fd3.append("model_name", "Knob.stl");
fd3.append("project", JSON.stringify({ project_id: kit.id }));
r = await bob.call("POST", "/api/jobs", fd3);
check(r.status === 404, "bob can't add jobs to alice's project", json(r));
const fd4 = new FormData();
fd4.append("source", "browser");
fd4.append("model_name", "Knob.stl");
fd4.append("project", JSON.stringify({ new: { name: "x", external_ref: "ORD-1001" } }));
r = await alice.call("POST", "/api/jobs", fd4);
check(r.status === 409, "a new project can't take an external_ref in use", json(r));

r = await alice.del(`/api/projects/${second}`);
check(r.status === 204, "a project can be deleted", json(r));
r = await alice.get(`/api/jobs/${job}`);
check(r.status === 200, "its recipe job stays", json(r));

await fake.close();
finish();
