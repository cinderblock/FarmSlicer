#!/usr/bin/env node
// End-to-end test of FarmSlicer as a desktop slicer's OctoPrint print host
// (src/print_host.rs): the requests OrcaSlicer makes (extern/OrcaSlicer/
// src/slic3r/Utils/OctoPrint.cpp), with the key in X-Api-Key: the
// connection test, "Upload" (a job), "Upload and print" (a job plus its
// plate in the queue), plain-text errors, and integration keys.
//
//   node tests/print-host-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup). Exit code 0 iff all
// checks pass.
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";
import { bracketsProject } from "./farm-lib.mjs";

console.log(`print host e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);
const HOST = "/api/octoprint";

/** A request as OrcaSlicer sends it. */
async function slicer(key, method, path, form) {
  const headers = key ? { "X-Api-Key": key } : {};
  let body;
  if (form) {
    // Built in full first, like curl's form posts: a refusal answered
    // before the body is read then can't cut a streamed upload short.
    const built = new Response(form);
    headers["content-type"] = built.headers.get("content-type");
    body = Buffer.from(await built.arrayBuffer());
  }
  const res = await fetch(BASE + HOST + path, { method, headers, body });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: parsed };
}

function upload(key, file, name, fields = {}) {
  const fd = new FormData();
  fd.append("print", fields.print ?? "false");
  fd.append("path", fields.path ?? "");
  if (fields.plateindex) fd.append("plateindex", fields.plateindex);
  fd.append("file", new Blob([file]), name);
  return slicer(key, "POST", "/api/files/local", fd);
}

const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));
r = await owner.post("/api/me/api-keys", { name: "OrcaSlicer" });
check(r.status === 201 && r.json.key.startsWith("fsk_"), "a personal API key for the slicer", json(r));
const key = r.json.key;

// ---- connection test -------------------------------------------------------------------------
let s = await slicer(null, "GET", "/api/version");
check(s.status === 401, "no key, no answer", JSON.stringify(s));
s = await slicer("fsk_not-a-real-key", "GET", "/api/version");
check(s.status === 401, "a wrong key is refused", JSON.stringify(s));
s = await slicer(key, "GET", "/api/version");
check(s.status === 200 && s.body.api && /^OctoPrint /.test(s.body.text), "the slicer's connection test passes", JSON.stringify(s));

// ---- Upload ------------------------------------------------------------------------------------
s = await upload(key, bracketsProject(), "Brackets.gcode.3mf", { path: "" });
check(s.status === 201 && s.body.done === true && s.body.files.local.name === "Brackets.gcode.3mf", "Upload: OctoPrint's answer", JSON.stringify(s));
check(s.body.farmslicer.queued.length === 0 && s.body.effectivePrint === false, "nothing queued", JSON.stringify(s.body));
const job1 = s.body.farmslicer.job_id;
r = await owner.get(`/api/jobs/${job1}`);
check(r.status === 200 && r.json.status === "done" && r.json.source === "upload" && r.json.model_name === "Brackets.gcode.3mf", "it's an uploaded job", json(r));

s = await upload(key, bracketsProject(), "Brackets again.gcode.3mf", { path: "some/folder" });
check(s.status === 400 && /no group "some\/folder" you can charge/.test(s.body), "a folder that names no group is refused, readably", JSON.stringify(s));

// ---- Upload and print --------------------------------------------------------------------------
s = await upload(key, bracketsProject(), "Brackets.gcode.3mf", { print: "true", plateindex: "2" });
check(s.status === 201 && s.body.effectivePrint === true, "Upload and print", JSON.stringify(s));
check(s.body.farmslicer.queued.length === 1 && s.body.farmslicer.queued[0].plate === 2, "queues the plate OrcaSlicer names", JSON.stringify(s.body));
const job2 = s.body.farmslicer.job_id;
s = await upload(key, bracketsProject(), "Brackets.gcode.3mf", { print: "true" });
check(s.body.farmslicer.queued.map((e) => e.plate).join() === "1,2", "no plate named: every plate", JSON.stringify(s.body));
const job3 = s.body.farmslicer.job_id;
r = await owner.get("/api/queue");
const queued = r.json.entries.map((e) => `${e.job_id === job2 ? "a" : e.job_id === job3 ? "b" : "?"}${e.plate}`).sort().join();
check(queued === "a2,b1,b2", "the queue holds them", json(r));

// ---- errors ------------------------------------------------------------------------------------
s = await upload(key, "not a package", "junk.gcode.3mf");
check(s.status === 400 && s.type.startsWith("text/plain") && typeof s.body === "string" && s.body.length > 0, "errors are plain text the slicer can show", JSON.stringify(s));
s = await slicer(key, "POST", "/api/files/local", new FormData());
check(s.status === 400 && s.body === "no file", "no file", JSON.stringify(s));

// ---- integration keys --------------------------------------------------------------------------
r = await owner.post("/api/groups", { name: "Shop" });
const shop = r.json.id;

// ---- the dialog's folder picks the group --------------------------------------------------------
s = await upload(key, bracketsProject(), "Shop part.gcode.3mf", { path: "Shop" });
check(s.status === 400, "not a member: not a group the owner can charge", JSON.stringify(s));
r = await owner.post(`/api/groups/${shop}/members`, { username: "owner", role: "member" });
check(r.status < 300, "the owner joins the shop", json(r));
s = await upload(key, bracketsProject(), "Shop part.gcode.3mf", { path: "shop/" });
check(s.status === 201, "a group's name as the folder", JSON.stringify(s));
r = await owner.get(`/api/jobs/${s.body.farmslicer.job_id}`);
check(r.json.group_id === shop && r.json.model_name === "Shop part.gcode.3mf", "charges the job to that group", json(r));
s = await upload(key, bracketsProject(), "Mine.gcode.3mf", { path: "Nowhere" });
check(s.status === 400 && /one of: Shop/.test(s.body), "an unknown folder lists the groups there are", JSON.stringify(s));
r = await owner.post("/api/integrations/keys", { name: "Shop slicer", group_id: shop, permissions: ["projects:write"] });
check(r.status === 201, "an integration key for the shop", json(r));
const shopKey = r.json.key;
r = await owner.post("/api/integrations/keys", { name: "Read only", group_id: shop, permissions: ["projects:read"] });
const readKey = r.json.key;
s = await slicer(readKey, "GET", "/api/version");
check(s.status === 200, "any key passes the connection test", JSON.stringify(s));
s = await upload(readKey, bracketsProject(), "Brackets.gcode.3mf");
check(s.status === 403, "a read-only key can't upload", JSON.stringify(s));
s = await upload(shopKey, bracketsProject(), "Brackets.gcode.3mf", { print: "true" });
check(s.status === 403 && /Upload and print/.test(s.body), "an integration key can't queue", JSON.stringify(s));
s = await upload(shopKey, bracketsProject(), "Shop brackets.gcode.3mf", { path: "Elsewhere" });
check(s.status === 400, "an integration key's folder can only be its group", JSON.stringify(s));
s = await upload(shopKey, bracketsProject(), "Shop brackets.gcode.3mf", { path: "Shop" });
check(s.status === 201, "but it uploads", JSON.stringify(s));
r = await owner.get(`/api/jobs/${s.body.farmslicer.job_id}`);
check(r.json.group_id === shop, "into its group", json(r));

finish();
