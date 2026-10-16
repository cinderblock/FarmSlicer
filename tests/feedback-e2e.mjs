#!/usr/bin/env node
// e2e-env: FARMSLICER_LAN_HEADER=X-FarmSlicer-LAN
// End-to-end test of feedback (src/feedback.rs, src/feedback_api.rs): manual
// reports, automatic error reports deduplicated by fingerprint, size caps
// and rate limits, who sees what, admin triage, slice failures reported by
// the server itself, and remote access. A server built with
// FARMSLICER_SKIP_CXX is enough (its stub slicer fails every server slice,
// which is one of the things reported).
//
//   FARMSLICER_LAN_HEADER=X-FarmSlicer-LAN farmslicer &
//   node tests/feedback-e2e.mjs http://localhost:9337
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";

console.log(`feedback e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);
const LAN = { "x-farmslicer-lan": "1" };
const lan = () => new Client({ ...LAN });
/** The same session from the other side of the proxy. */
const fromInternet = (client) => Object.assign(new Client(), { cookie: client.cookie });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- no anonymous endpoint ------------------------------------------------------------
let r = await lan().post("/api/feedback", { kind: "bug", message: "hello" });
check(r.status === 401, "manual reports need an account", `${r.status} ${json(r)}`);
r = await lan().post("/api/feedback/errors", { reports: [{ source: "window", message: "x" }] });
check(r.status === 401, "error reports need an account", `${r.status} ${json(r)}`);

// ---- accounts ----------------------------------------------------------------------------
const owner = lan();
r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));

async function member(username, extra = {}) {
  const made = await owner.post("/api/users", { username, ...extra });
  const token = made.json.invite_url.split("/invite/")[1];
  const client = lan();
  const enrolled = await register(client, new SoftAuthenticator(), `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "k");
  check(enrolled.status === 200, `${username} enrols`, json(enrolled));
  return client;
}
const mia = await member("mia");
const rob = await member("rob");
const ownerId = (await owner.get("/api/me")).json.id;
const miaId = (await mia.get("/api/me")).json.id;

// ---- manual reports ------------------------------------------------------------------------
r = await owner.post("/api/printers", {
  name: "Bench X1C", machine_profile: "Bambu Lab X1 Carbon", nozzle_diameter: "0.4", protocol: "bambu",
  address: "127.0.0.1", serial_number: "00M00A000000000", access_code: "12345678",
});
const printer = r.json?.id;
r = await mia.form("/api/jobs", { source: "browser", model_name: "bracket.stl" });
const miaJob = r.json?.id;
r = await owner.form("/api/jobs", { source: "browser", model_name: "secret.stl" });
const ownerJob = r.json?.id;
check(!!printer && !!miaJob && !!ownerJob, "a printer and two jobs to refer to");

const diagnostics = { console: [{ level: "error", text: "boom" }], viewport: "1280x800" };
r = await mia.post("/api/feedback", {
  kind: "printer",
  message: "  The X1C's plate came out warped  ",
  printer_id: printer,
  job_id: miaJob,
  page_url: "/printers",
  version: "abc123",
  context: diagnostics,
});
check(r.status === 201, "a member sends a manual report", json(r));
const miaReport = r.json;
check(
  miaReport?.kind === "printer" && miaReport?.status === "new" && miaReport?.automatic === false && miaReport?.source === "manual",
  "it's new, manual, of the chosen kind",
  json(r),
);
check(miaReport?.message === "The X1C's plate came out warped", "the message is trimmed", json(r));
check(miaReport?.user_id === miaId && miaReport?.username === "mia", "it's hers", json(r));
check(miaReport?.printer_name === "Bench X1C" && miaReport?.job_name === "bracket.stl", "printer and job are linked", json(r));
check(JSON.stringify(miaReport?.context) === JSON.stringify(diagnostics), "the diagnostics are kept", json(r));
check(typeof miaReport?.user_agent === "string" && miaReport.user_agent.length > 0, "the user agent comes from the request", json(r));

for (const [label, body, pattern] of [
  ["an unknown kind", { kind: "rant", message: "x" }, /kind/],
  ["an empty message", { kind: "bug", message: "   " }, /what happened/],
  ["a message over 5000 characters", { kind: "bug", message: "x".repeat(5001) }, /5000/],
  ["an unknown printer", { kind: "printer", message: "x", printer_id: "nope" }, /printer/],
  ["someone else's job", { kind: "slicer", message: "x", job_id: ownerJob }, /job/],
]) {
  r = await mia.post("/api/feedback", body);
  check(r.status === 400 && pattern.test(r.json?.error ?? ""), `refuses ${label}`, `${r.status} ${json(r)}`);
}
r = await mia.post("/api/feedback", { kind: "bug", message: "x".repeat(5000) });
check(r.status === 201, "5000 characters is fine", `${r.status}`);

r = await owner.post("/api/feedback", { kind: "idea", message: "admins have ideas too", job_id: ownerJob, context: { log: "x".repeat(40 * 1024) } });
check(r.status === 201, "the owner sends one with a 40 KiB context", json(r));
const ownerReport = r.json?.id;
r = await owner.get(`/api/feedback/${ownerReport}`);
check(/at most/.test(r.json?.context?.dropped ?? ""), "an oversized context is replaced by a note, the report kept", json(r));

// ---- automatic reports: dedup ------------------------------------------------------------
const error = (overrides = {}) => ({
  source: "window",
  message: "TypeError: can't read job 3f2c8a10-1b2c-4d5e-8f90-123456789abc",
  stack: "TypeError: can't read job\n    at renderPart (http://localhost:9337/assets/index-B1a2C3d4.js:12:3456)",
  url: "/slice",
  version: "v1",
  ...overrides,
});
r = await mia.post("/api/feedback/errors", { reports: [error()] });
check(r.status === 200 && r.json?.accepted === 1, "a batch with one error", json(r));
r = await mia.post("/api/feedback/errors", {
  reports: [
    error({
      message: "TypeError: can't read job 0a0a0a0a-1b2c-4d5e-8f90-000000000000",
      stack: "TypeError: can't read job\n    at renderPart (http://localhost:9337/assets/index-ZZZZZZZZ.js:99:1)",
    }),
  ],
});
check(r.status === 200 && r.json?.accepted === 1, "the same fault in another job and build", json(r));
r = await owner.get("/api/feedback?automatic=1");
let groups = r.json?.filter((f) => f.source === "window") ?? [];
check(groups.length === 1 && groups[0].count === 2, "is one report counted twice", json(r));
const shared = groups[0]?.id;
check(groups[0]?.kind === "app" && groups[0]?.automatic === true && groups[0]?.status === "new", "an automatic app report, new", json(r));

r = await owner.post("/api/feedback/errors", { reports: [error({ version: "v2", count: 5 })] });
check(r.json?.accepted === 1, "the owner hits it 5 times in another version", json(r));
r = await owner.get(`/api/feedback/${shared}`);
check(r.json?.count === 7 && r.json?.affected_users === 2, "7 occurrences, 2 accounts", json(r));
check(r.json?.versions?.length === 2 && r.json?.occurrences?.length === 2, "two versions, an occurrence row per account and version", json(r));
check(/renderPart/.test(r.json?.stack ?? ""), "the latest stack is kept", json(r));

r = await mia.post("/api/feedback/errors", {
  reports: [
    { source: "console", message: "console said so" },
    { source: "made-up", message: "unknown source" },
    { source: "window", message: "   " },
  ],
});
check(r.json?.accepted === 1 && r.json?.dropped === 2, "unknown sources and empty messages are dropped", json(r));

// ---- size caps --------------------------------------------------------------------------
r = await mia.post("/api/feedback/errors", {
  reports: [{ source: "promise", message: "M".repeat(5000), stack: "S".repeat(20000), version: "V".repeat(200), context: { big: "x".repeat(10000) } }],
});
check(r.json?.accepted === 1, "an oversized error is accepted", json(r));
r = await owner.get("/api/feedback?automatic=1");
const big = r.json?.find((f) => f.source === "promise");
r = await owner.get(`/api/feedback/${big?.id}`);
check([...(r.json?.message ?? "")].length <= 1000, "its message is cut to 1000 characters", String(r.json?.message?.length));
check([...(r.json?.stack ?? "")].length <= 8000, "its stack to 8000", String(r.json?.stack?.length));
check([...(r.json?.version ?? "")].length <= 64, "its version to 64", String(r.json?.version?.length));
check(typeof r.json?.context?.dropped === "string", "its 10 KiB context is dropped", json(r));
r = await mia.post("/api/feedback/errors", { reports: Array.from({ length: 21 }, () => error()) });
check(r.status === 400 && /20/.test(r.json?.error ?? ""), "more than 20 reports in a batch is refused", `${r.status} ${json(r)}`);
r = await mia.post("/api/feedback", { kind: "bug", message: "x", context: { blob: "x".repeat(300 * 1024) } });
check(r.status === 413, "a body over 256 KiB is refused", String(r.status));

// ---- who sees what ------------------------------------------------------------------------
r = await mia.get("/api/feedback");
const miaSees = r.json ?? [];
check(miaSees.some((f) => f.id === miaReport?.id), "mia sees her report", json(r));
check(!miaSees.some((f) => f.id === ownerReport), "but not the owner's", json(r));
const miaShared = miaSees.find((f) => f.id === shared);
check(!!miaShared, "and the error she hit", json(r));
check(miaShared?.count === 2 && miaShared?.affected_users === 1, "counted for her alone", JSON.stringify(miaShared));
check(miaShared?.username === "mia" && miaShared?.versions?.join() === "v1", "with her own details", JSON.stringify(miaShared));
r = await mia.get(`/api/feedback/${shared}`);
check(r.status === 200 && r.json?.occurrences?.length === 1 && r.json.occurrences[0].username === "mia", "her view lists only her occurrences", json(r));
check(r.json?.context === null && r.json?.fingerprint === null, "and none of the shared details", json(r));
r = await rob.get("/api/feedback");
check(r.status === 200 && r.json?.length === 0, "rob has nothing", json(r));
r = await rob.get(`/api/feedback/${shared}`);
check(r.status === 404, "an error rob didn't hit is not found for him", String(r.status));
r = await mia.get(`/api/feedback/${ownerReport}`);
check(r.status === 404, "someone else's report is not found", String(r.status));
r = await owner.get("/api/feedback?automatic=0");
check(r.json?.some((f) => f.id === miaReport?.id) && r.json?.some((f) => f.id === ownerReport), "admins see every report", json(r));
check(r.json?.every((f) => f.context === null && f.stack === null), "lists carry no context or stack", json(r));
r = await owner.get("/api/feedback?automatic=0&mine=1");
check(r.json?.length >= 1 && r.json.every((f) => f.user_id === ownerId), "?mine=1 narrows an admin to their own", json(r));
r = await owner.get("/api/feedback?automatic=0&kind=printer");
check(r.json?.length === 1 && r.json[0].id === miaReport?.id, "filter by kind", json(r));

// ---- triage -----------------------------------------------------------------------------
r = await mia.put(`/api/feedback/${miaReport?.id}`, { status: "resolved" });
check(r.status === 403, "members can't triage", String(r.status));
r = await mia.del(`/api/feedback/${miaReport?.id}`);
check(r.status === 403, "or delete", String(r.status));
r = await owner.put(`/api/feedback/${miaReport?.id}`, { status: "closed" });
check(r.status === 400, "an unknown status is refused", `${r.status} ${json(r)}`);
r = await owner.put(`/api/feedback/${miaReport?.id}`, { status: "acknowledged", admin_note: "Swapping the plate tomorrow." });
check(r.status === 200 && r.json?.status === "acknowledged" && r.json?.admin_note === "Swapping the plate tomorrow.", "an admin acknowledges with a note", json(r));
r = await mia.get(`/api/feedback/${miaReport?.id}`);
check(r.json?.status === "acknowledged" && r.json?.admin_note === "Swapping the plate tomorrow.", "mia sees the status and the note", json(r));
r = await owner.get("/api/feedback?automatic=0&status=open");
check(r.json?.some((f) => f.id === miaReport?.id), "acknowledged counts as open", json(r));
r = await owner.get("/api/feedback/counts");
check(r.json?.manual?.acknowledged === 1 && r.json?.automatic?.new >= 2, "counts per status", json(r));
r = await mia.get("/api/feedback/counts");
check(r.json?.manual?.acknowledged === 1 && r.json?.automatic?.new === 3, "a member's counts are their own", json(r));

r = await owner.put(`/api/feedback/${shared}`, { status: "resolved" });
check(r.json?.status === "resolved", "an admin resolves the shared error", json(r));
r = await mia.post("/api/feedback/errors", { reports: [error({ version: "v3" })] });
r = await owner.get(`/api/feedback/${shared}`);
check(r.json?.status === "new" && r.json?.count === 8, "it happens again: open again", json(r));

r = await owner.del(`/api/feedback/${ownerReport}`);
check(r.status === 204, "an admin deletes a report", String(r.status));
r = await owner.get(`/api/feedback/${ownerReport}`);
check(r.status === 404, "it's gone", String(r.status));

// ---- reported by the server ------------------------------------------------------------------
r = await mia.form("/api/jobs", { source: "browser", model_name: "tower.stl" });
const failing = r.json?.id;
r = await mia.post(`/api/jobs/${failing}/fail`, { error: "out of memory at 0x7f3a2b1c" });
check(r.status === 200, "a browser slice fails", String(r.status));
r = await owner.get("/api/feedback?automatic=1&kind=slicer");
const browserFailure = r.json?.find((f) => /browser slice failed/.test(f.message));
check(
  browserFailure?.source === "server" && browserFailure?.job_id === failing && browserFailure?.username === "mia",
  "the failure is reported as hers, linked to the job",
  json(r),
);
r = await mia.get("/api/feedback?automatic=1");
check(r.json?.some((f) => f.id === browserFailure?.id), "and she sees it", json(r));

const stl = new Blob(["solid cube\nendsolid cube\n"], { type: "model/stl" });
r = await rob.form("/api/jobs", { model: [stl, "cube.stl"] });
check(r.status === 201, "a server slice (the stub slicer fails it)", json(r));
let serverFailure;
for (let i = 0; i < 50 && !serverFailure; i++) {
  await sleep(100);
  r = await owner.get("/api/feedback?automatic=1&kind=slicer");
  serverFailure = r.json?.find((f) => /server slice failed/.test(f.message));
}
check(serverFailure?.username === "rob" && serverFailure?.version?.startsWith("server-"), "a failed server slice is reported", json(r));

// ---- rate limits ---------------------------------------------------------------------------
const flood = await member("flood");
const statuses = [];
for (let i = 0; i < 4; i++) {
  r = await flood.post("/api/feedback/errors", { reports: Array.from({ length: 20 }, (_, n) => error({ message: `loop ${i}-${n}` })) });
  statuses.push(`${r.status}:${r.json?.accepted ?? r.json?.error}`);
}
check(statuses.slice(0, 3).every((s) => s === "200:20"), "60 error reports go through", statuses.join(" "));
check(statuses[3].startsWith("429"), "then the account is rate-limited", statuses.join(" "));
check(r.json?.retry_after_secs > 0, "with a hint when to retry", json(r));
r = await mia.post("/api/feedback/errors", { reports: [error({ message: "someone else" })] });
check(r.status === 200, "other accounts aren't affected", String(r.status));

const chatty = await member("chatty");
const manual = [];
for (let i = 0; i < 11; i++) manual.push((await chatty.post("/api/feedback", { kind: "other", message: `note ${i}` })).status);
check(manual.slice(0, 10).every((s) => s === 201) && manual[10] === 429, "10 manual reports, then 429", manual.join(" "));

// ---- remote access ----------------------------------------------------------------------------
const remote = await member("remy", { remote_access: true });
const remy = fromInternet(remote);
r = await remy.post("/api/feedback", { kind: "app", message: "sent from home" });
check(r.status === 201, "an approved remote account sends feedback from the internet", `${r.status} ${json(r)}`);
r = await remy.post("/api/feedback/errors", { reports: [error({ message: "remote error" })] });
check(r.status === 200, "and error reports", `${r.status} ${json(r)}`);
r = await fromInternet(mia).post("/api/feedback", { kind: "app", message: "not approved" });
check(r.status === 403 && r.json?.remote_denied === true, "an unapproved account can't from the internet", `${r.status} ${json(r)}`);
r = await fromInternet(mia).post("/api/feedback/errors", { reports: [error()] });
check(r.status === 403, "not even error reports (they wait in the browser)", String(r.status));

finish();
