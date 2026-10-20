#!/usr/bin/env node
// End-to-end test of the integration surface (src/integration.rs,
// src/webhooks.rs): an ordering tool's scoped key creates and follows its
// client's projects and nothing else; webhooks deliver signed events
// (ping, prints starting and finishing, outcomes, items and projects
// done, fulfillment) to a receiver this test runs; failures are retried
// and logged; the usage report adds up what was printed.
//
//   node tests/integration-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup). Exit code 0 iff all
// checks pass.
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";
import { startFakeMoonraker } from "./fake-moonraker/fake-moonraker.mjs";
import { addVoron, bracketsProject, until } from "./farm-lib.mjs";

console.log(`integration e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);
const fake = await startFakeMoonraker({ printSeconds: 1.5 });

// ---- a webhook receiver -----------------------------------------------------------------
const received = [];
let failing = false;
const receiver = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/broken" || failing) {
      res.writeHead(500).end("nope");
      return;
    }
    received.push({ headers: req.headers, body, json: JSON.parse(body) });
    res.writeHead(204).end();
  });
});
await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const hookUrl = `http://127.0.0.1:${receiver.address().port}`;
let secret = "";
const signed = (m) =>
  m.headers["x-farmslicer-signature"] ===
  `sha256=${createHmac("sha256", secret).update(`${m.headers["x-farmslicer-timestamp"]}.${m.body}`).digest("hex")}`;
async function event(name, extra = () => true, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const m = received.find((x) => x.json.event === name && extra(x.json));
    if (m) return m;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// ---- setup -------------------------------------------------------------------------------
const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));
r = await owner.post("/api/groups", { name: "Shop", description: "Paid work" });
check(r.status === 201, "a group for the shop's orders", json(r));
const shop = r.json.id;
const printer = await addVoron(owner, fake);

// ---- webhooks ----------------------------------------------------------------------------
r = await owner.post("/api/integrations/webhooks", { url: "ftp://x", events: ["*"] });
check(r.status === 400, "a webhook needs an http(s) URL", json(r));
r = await owner.post("/api/integrations/webhooks", { url: hookUrl, events: ["print.nothing"] });
check(r.status === 400, "unknown events are refused", json(r));
r = await owner.post("/api/integrations/webhooks", { url: hookUrl, events: ["*"], description: "order system" });
check(r.status === 201 && r.json.secret?.startsWith("whsec_") && r.json.events[0] === "*", "a webhook for every event; its secret shown once", json(r));
const hook = r.json.id;
secret = r.json.secret;
r = await owner.get("/api/integrations/webhooks");
check(r.json.webhooks.length === 1 && r.json.webhooks[0].secret === undefined && r.json.events.includes("print.outcome"), "listed without its secret", json(r));
r = await owner.post(`/api/integrations/webhooks/${hook}/test`);
check(r.status === 202, "send a test ping", json(r));
let m = await event("ping");
check(m && signed(m) && m.headers["x-farmslicer-event"] === "ping" && m.json.id === m.headers["x-farmslicer-delivery"], "the ping arrives, signed", JSON.stringify(m?.headers));
check(Math.abs(Number(m?.headers["x-farmslicer-timestamp"]) - Date.now() / 1000) < 60, "with a fresh timestamp", JSON.stringify(m?.headers));

r = await owner.post("/api/integrations/webhooks", { url: `${hookUrl}/broken`, events: ["ping"] });
const broken = r.json.id;
await owner.post(`/api/integrations/webhooks/${broken}/test`);
let d = await until(owner, `/api/integrations/webhooks/${broken}/deliveries`, (l) => l?.[0]?.attempts >= 1);
check(d[0].status === "pending" && d[0].response_status === 500 && /500/.test(d[0].last_error), "a failing endpoint: logged, to be retried", JSON.stringify(d));
r = await owner.post(`/api/integrations/deliveries/${d[0].id}/retry`);
check(r.status === 200 && r.json.status === "pending", "a delivery can be retried by hand", json(r));
d = await until(owner, `/api/integrations/webhooks/${broken}/deliveries`, (l) => l?.[0]?.attempts >= 2);
check(d[0].attempts >= 2, "and is tried again", JSON.stringify(d));
r = await owner.del(`/api/integrations/webhooks/${broken}`);
check(r.status === 204, "remove the broken webhook", json(r));

// ---- integration keys --------------------------------------------------------------------
r = await owner.post("/api/integrations/keys", { name: "Shop orders", group_id: shop, client_ref: "acme", permissions: ["projects:write", "usage:read", "printers:control"] });
check(r.status === 400, "unknown permissions are refused", json(r));
r = await owner.post("/api/integrations/keys", { name: "Shop orders", group_id: shop, client_ref: "acme", permissions: ["projects:write", "usage:read"] });
check(r.status === 201 && r.json.key.startsWith("fsk_") && r.json.api_key.client_ref === "acme", "a key for acme's orders in the shop", json(r));
const shopKey = new Client();
shopKey.bearer = r.json.key;
const keyId = r.json.api_key.id;
r = await owner.post("/api/integrations/keys", { name: "Read only", group_id: shop, permissions: ["projects:read"] });
const readKey = new Client();
readKey.bearer = r.json.key;
r = await owner.get("/api/integrations/keys");
check(r.json.length === 2 && r.json.every((k) => k.group_name === "Shop"), "admins list the keys", json(r));
r = await owner.get("/api/me/api-keys");
check(Array.isArray(r.json) && r.json.length === 0, "integration keys aren't personal keys", json(r));

r = await shopKey.get("/api/me");
check(r.status === 200, "the key works", json(r));
r = await shopKey.get("/api/printers");
check(r.status === 403 && /doesn't reach/.test(r.json.error), "but not for printers", json(r));
r = await shopKey.post("/api/integrations/keys", { name: "more", group_id: shop, permissions: ["projects:read"] });
check(r.status === 403, "nor for making keys", json(r));
r = await readKey.post("/api/projects", { name: "x" });
check(r.status === 403 && /projects:write/.test(r.json.error), "a read-only key can't create", json(r));

r = await shopKey.form("/api/uploads", { file: [new Blob([bracketsProject()]), "Acme brackets.gcode.3mf"] });
check(r.status === 201 && r.json.group_id === shop, "the key uploads a sliced project; it lands in the shop", json(r));
const job = r.json.id;
r = await shopKey.post("/api/projects", { name: "Acme order 77", external_ref: "A-77", client_ref: "other", items: [{ job_id: job, part: "Bracket", quantity: 3 }] });
check(r.status === 403, "it can't make projects for another client", json(r));
r = await shopKey.post("/api/projects", { name: "Acme order 77", external_ref: "A-77", items: [{ job_id: job, part: "Bracket", quantity: 3 }] });
check(r.status === 201 && r.json.group_id === shop && r.json.client_ref === "acme", "it makes acme's project", json(r));
const project = r.json.id;
r = await shopKey.post("/api/projects", { name: "Acme order 77 (again)", external_ref: "A-77" });
check(r.status === 200 && r.json.id === project, "a retried order returns the same project", json(r));

r = await owner.post("/api/projects", { name: "Other client", group_id: shop, client_ref: "other" });
const other = r.json.id;
r = await owner.post("/api/projects", { name: "Personal" });
r = await shopKey.get("/api/projects");
check(r.json.length === 1 && r.json[0].id === project, "the key sees only acme's projects", json(r));
r = await shopKey.get(`/api/projects/${other}`);
check(r.status === 404, "another client's project isn't there for it", json(r));
r = await readKey.get("/api/projects");
check(r.json.length === 2, "a key for the whole shop sees both of its clients", json(r));
r = await shopKey.patch(`/api/projects/${project}`, { client_ref: "other" });
check(r.status === 403, "nor can it move its project to another client", json(r));
r = await shopKey.get(`/api/jobs/${job}/parts`);
check(r.status === 200 && r.json[0].item?.project_id === project, "it reads its job's parts", json(r));
r = await owner.form("/api/uploads", { file: [new Blob([bracketsProject()]), "Not the shop's.gcode.3mf"] });
r = await shopKey.get(`/api/jobs/${r.json.id}`);
check(r.status === 404, "but not a job outside its group", json(r));
r = await shopKey.post("/api/queue", { job_id: job });
check(r.status === 403, "the farm queues plates, not the ordering tool", json(r));

// ---- printing: events --------------------------------------------------------------------
r = await owner.post(`/api/projects/${project}/items/${(await owner.get(`/api/projects/${project}`)).json.items[0].id}/reprint`);
check(r.status === 201, "the farm queues acme's plate", json(r));
r = await owner.post(`/api/printers/${printer}/send-next`);
check(r.status === 201, "and sends it", json(r));
const print = r.json.print.id;
m = await event("print.started", (e) => e.data.print.id === print);
check(m && signed(m) && m.json.data.projects.includes(project), "print.started, naming the project", JSON.stringify(m?.json));
m = await event("print.finished", (e) => e.data.print.id === print);
check(m && m.json.data.print.status === "finished", "print.finished", JSON.stringify(m?.json));
r = await owner.post(`/api/prints/${print}/outcome`, { all: "good" });
check(r.status === 200, "all good", json(r));
m = await event("print.outcome", (e) => e.data.print.id === print);
check(m && m.json.data.lines[0].good === 3 && m.json.data.lines[0].item_id, "print.outcome with the counts", JSON.stringify(m?.json));
m = await event("item.completed", (e) => e.data.item.project_id === project);
check(m && m.json.data.item.good === 3 && m.json.data.item.done, "item.completed", JSON.stringify(m?.json));
m = await event("project.printed", (e) => e.data.project.id === project);
check(m && m.json.data.project.summary.items_done === 1, "project.printed", JSON.stringify(m?.json));

// ---- fulfillment through the key ------------------------------------------------------------
r = await shopKey.post(`/api/projects/${project}/status`, { status: "shipped", note: "UPS 1Z" });
check(r.status === 200 && r.json.status === "shipped", "the fulfillment tool marks it shipped", json(r));
m = await event("project.status", (e) => e.data.project.id === project && e.data.project.status === "shipped");
check(m && m.json.data.project.status_note === "UPS 1Z", "project.status says so", JSON.stringify(m?.json));

// ---- usage -------------------------------------------------------------------------------
r = await shopKey.get("/api/usage/prints");
// The plate held 3 brackets for the order and a clip for no one: the
// order's share of the print is 3/4.
check(r.status === 200 && r.json.total.prints === 0.75 && r.json.total.good === 3 && r.json.total.grams.PLA === 9.4, "usage: 3/4 of a print (its share of the plate), 3 good copies, 9.4 g of PLA", json(r));
check(r.json.projects.length === 1 && r.json.projects[0].external_ref === "A-77" && r.json.projects[0].usage.estimated_cost > 0, "per project, with a cost estimate", json(r));
r = await shopKey.get(`/api/usage/prints?client_ref=other`);
check(r.status === 403, "not another client's usage", json(r));
r = await shopKey.get("/api/usage/prints?from=2000-01-01&to=2000-01-02");
check(r.json.total.prints === 0, "a period with nothing in it", json(r));
r = await readKey.get("/api/usage/prints");
check(r.status === 403, "a key without usage:read can't", json(r));
r = await owner.get("/api/usage/prints");
check(r.json.total.prints === 1 && r.json.total.grams.PLA === 12.5 && r.json.unassigned.prints === 0.25, "admins see the farm's usage, the clip's share unassigned", json(r));

// ---- revoking --------------------------------------------------------------------------------
r = await owner.del(`/api/integrations/keys/${keyId}`);
check(r.status === 204, "the key is revoked", json(r));
r = await shopKey.get("/api/projects");
check(r.status === 401, "and stops working", json(r));
r = await owner.patch(`/api/integrations/webhooks/${hook}`, { enabled: false });
check(r.status === 200 && r.json.enabled === false, "a webhook can be paused", json(r));

await fake.close();
receiver.close();
finish();
