#!/usr/bin/env node
// End-to-end test of the MCP endpoint for agents (src/mcp.rs): Streamable
// HTTP JSON-RPC at /api/mcp with an API key, the handshake, tools that
// forward to the REST API with the caller's permissions, and integration
// keys seeing only the tools their routes allow.
//
//   node tests/mcp-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup). Exit code 0 iff all
// checks pass.
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";
import { bracketsProject } from "./farm-lib.mjs";

console.log(`mcp e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);
let nextId = 1;

/** One JSON-RPC message (or a batch) to /api/mcp, as an MCP client sends it. */
async function mcp(key, message, extraHeaders = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...extraHeaders };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${BASE}/api/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const request = (key, method, params) => mcp(key, { jsonrpc: "2.0", id: nextId++, method, params });

/** tools/call: the tool's result, its JSON parsed from the text content. */
async function call(key, name, args = {}) {
  const r = await request(key, "tools/call", { name, arguments: args });
  const result = r.body?.result;
  let data;
  try {
    data = JSON.parse(result?.content?.[0]?.text ?? "null");
  } catch {
    data = result?.content?.[0]?.text;
  }
  return { status: r.status, error: r.body?.error, isError: result?.isError, data, raw: r.body };
}

const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));
r = await owner.post("/api/me/api-keys", { name: "Agent" });
check(r.status === 201, "an API key for the agent", json(r));
const key = r.json.key;

// ---- transport ---------------------------------------------------------------------------------
let m = await mcp(null, { jsonrpc: "2.0", id: 1, method: "ping" });
check(m.status === 401, "no key, no answer", JSON.stringify(m));
const cookieRes = await owner.post("/api/mcp", { jsonrpc: "2.0", id: 1, method: "ping" });
check(cookieRes.status === 401, "a browser session isn't enough", String(cookieRes.status));
let g = await fetch(`${BASE}/api/mcp`, { headers: { authorization: `Bearer ${key}` } });
check(g.status === 405, "GET: no server stream", String(g.status));
g = await fetch(`${BASE}/api/mcp`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "text/plain" }, body: "{}" });
check(g.status === 415, "JSON only", String(g.status));

m = await request(key, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "e2e", version: "1" },
});
check(m.status === 200 && m.body.result.protocolVersion === "2025-06-18", "initialize: the client's version", JSON.stringify(m));
check(m.body.result.capabilities.tools && m.body.result.serverInfo.name === "farmslicer" && m.body.result.instructions.length > 0, "server info and instructions", JSON.stringify(m.body));
m = await mcp(key, { jsonrpc: "2.0", method: "notifications/initialized" });
check(m.status === 202 && m.body === null, "a notification gets 202", JSON.stringify(m));
m = await request(key, "initialize", { protocolVersion: "1999-01-01" });
check(m.body.result.protocolVersion === "2025-11-25", "an unknown version: our newest", JSON.stringify(m.body));
m = await mcp(key, [
  { jsonrpc: "2.0", id: 91, method: "ping" },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 92, method: "nope" },
]);
check(Array.isArray(m.body) && m.body.length === 2 && m.body[1].error.code === -32601, "a batch: answers for requests only", JSON.stringify(m));
m = await mcp(key, "not json-rpc");
check(m.body.error?.code === -32600, "junk is an invalid request", JSON.stringify(m));

// ---- tools -------------------------------------------------------------------------------------
m = await request(key, "tools/list", {});
const tools = m.body.result.tools;
const names = tools.map((t) => t.name);
check(names.includes("list_jobs") && names.includes("queue_plates") && names.includes("control_print"), "tools/list", names.join());
check(tools.every((t) => t.inputSchema.type === "object" && t.description && t.annotations), "every tool has a schema and annotations", JSON.stringify(tools[0]));
check(tools.find((t) => t.name === "control_print").annotations.destructiveHint === true, "stopping a print is marked destructive", "");

let t = await call(key, "whoami");
check(!t.isError && t.data.username === "owner", "whoami", JSON.stringify(t.raw));
t = await call(key, "list_printers");
check(!t.isError && Array.isArray(t.data) && t.data.length === 0, "list_printers (none yet)", JSON.stringify(t.raw));

const fd = new FormData();
fd.append("file", new Blob([bracketsProject()]), "Brackets.gcode.3mf");
const up = await fetch(`${BASE}/api/uploads`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: fd });
const job = await up.json();
check(up.status === 201, "an upload with the same key (as the instructions say)", JSON.stringify(job));

t = await call(key, "list_jobs", { search: "brackets" });
check(t.data.length === 1 && t.data[0].id === job.id && t.data[0].plates.join() === "1,2", "list_jobs: the job and its plates", JSON.stringify(t.data));
check(t.data[0].config_json === undefined && t.raw.result.structuredContent.items.length === 1, "trimmed, with structured content", JSON.stringify(t.raw.result));
t = await call(key, "list_jobs", { search: "nothing like it" });
check(t.data.length === 0, "list_jobs: search", JSON.stringify(t.data));
t = await call(key, "get_job", { job_id: job.id });
check(!t.isError && t.data.plates.length === 2 && t.data.plates[0].filaments.length > 0 && !("config_json" in t.data), "get_job: plates with filaments, no config", JSON.stringify(t.data));
check(t.data.parts.length > 0 && t.data.parts.every((p) => p.key && p.copies > 0), "and its parts", JSON.stringify(t.data.parts));
const part = t.data.parts[0];
t = await call(key, "get_job", { job_id: "no-such-job" });
check(t.isError && /not found/.test(t.data) && /404/.test(t.data), "a REST error is a tool error", JSON.stringify(t.raw));
t = await call(key, "get_job", { job_id: "../me" });
check(t.isError, "ids stay ids", JSON.stringify(t.raw));

t = await call(key, "queue_plates", { job_id: job.id, plates: [2], note: "from an agent" });
check(!t.isError && t.data.length === 1 && t.data[0].plate === 2, "queue_plates", JSON.stringify(t.raw));
const entry = t.data[0].id;
t = await call(key, "list_queue");
check(t.data.entries.some((e) => e.id === entry), "list_queue shows it", JSON.stringify(t.data));
t = await call(key, "cancel_queue_entry", { entry_id: entry });
check(!t.isError, "cancel_queue_entry", JSON.stringify(t.raw));
t = await call(key, "list_queue");
check(!t.data.entries.some((e) => e.id === entry), "gone from the queue", JSON.stringify(t.data));
t = await call(key, "queue_plates", { job_id: job.id, plates: [7] });
check(t.isError && /plate 7/.test(t.data), "the API's checks apply", JSON.stringify(t.raw));

t = await call(key, "create_project", { name: "Brackets for the shop" });
check(!t.isError && t.data.id, "create_project", JSON.stringify(t.raw));
const project = t.data.id;
t = await call(key, "add_project_item", { project_id: project, name: "Bracket", quantity: 4, job_id: job.id, part: part.key });
check(!t.isError, "add_project_item", JSON.stringify(t.raw));
t = await call(key, "get_project", { project_id: project });
check(t.data.items.length === 1 && t.data.items[0].quantity === 4, "get_project", JSON.stringify(t.data));
t = await call(key, "list_projects");
check(t.data.some((p) => p.id === project), "list_projects", JSON.stringify(t.data));
t = await call(key, "list_prints", { active: true });
check(!t.isError && Array.isArray(t.data), "list_prints", JSON.stringify(t.raw));
t = await call(key, "control_print", { print_id: "no-such-print", action: "pause" });
check(t.isError, "control_print on nothing", JSON.stringify(t.raw));

t = await call(key, "no_such_tool");
check(t.error?.code === -32602, "an unknown tool is a protocol error", JSON.stringify(t.raw));
t = await call(key, "get_job", {});
check(t.isError && /job_id is required/.test(t.data), "a missing argument", JSON.stringify(t.raw));

// ---- the web app's tools (WebMCP, web/src/webmcp.ts) ---------------------------------------------
r = await owner.get("/api/mcp/tools");
check(r.status === 200 && r.json.tools.some((t) => t.name === "queue_plates"), "the signed-in page lists the tools", json(r));
r = await owner.post("/api/mcp/call", { name: "get_job", arguments: { job_id: job.id } });
check(r.status === 200 && !r.json.isError && r.json.structuredContent.id === job.id, "and runs them with its session", json(r));
r = await owner.post("/api/mcp/call", { name: "no_such_tool", arguments: {} });
check(r.status === 400 && /unknown tool/.test(r.json.error), "an unknown tool", json(r));
const pageCall = (headers) =>
  fetch(`${BASE}/api/mcp/call`, {
    method: "POST",
    headers: { cookie: owner.cookie, ...headers },
    body: JSON.stringify({ name: "whoami", arguments: {} }),
  });
let pr = await pageCall({ "content-type": "application/json", "sec-fetch-site": "cross-site" });
check(pr.status === 403, "not from another site's page", String(pr.status));
pr = await pageCall({ "content-type": "text/plain" });
check(pr.status === 415, "nor as a form post", String(pr.status));
pr = await fetch(`${BASE}/api/mcp/tools`);
check(pr.status === 401, "signed out: no tools", String(pr.status));

// ---- integration keys --------------------------------------------------------------------------
r = await owner.post("/api/groups", { name: "Shop" });
const shop = r.json.id;
r = await owner.post("/api/integrations/keys", { name: "Shop agent", group_id: shop, permissions: ["projects:read"] });
check(r.status === 201, "a read-only integration key", json(r));
const readKey = r.json.key;
m = await request(readKey, "tools/list", {});
const scoped = m.body.result.tools.map((t) => t.name).sort().join();
check(scoped === "get_job,get_project,list_projects,whoami", "it sees only the tools its routes allow", scoped);
t = await call(readKey, "queue_plates", { job_id: job.id });
check(t.isError && /can't use that tool/.test(t.data), "and can't call the others", JSON.stringify(t.raw));
t = await call(readKey, "get_job", { job_id: job.id });
check(t.isError && /not found/.test(t.data), "nor see a job outside its group", JSON.stringify(t.raw));
t = await call(readKey, "list_projects");
check(!t.isError && !t.data.some((p) => p.id === project), "its projects are its group's", JSON.stringify(t.data));

finish();
