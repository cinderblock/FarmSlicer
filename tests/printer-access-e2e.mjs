#!/usr/bin/env node
// End-to-end test of printer access rules and certifications
// (src/access.rs): rules by printer, pool and model, first match wins,
// certified users, deny and approve, a rule's own approvers, holds lifted
// by approvers and senders who could approve, the queue's view of it, and
// who may change rules and give certifications. Against a fresh server
// (first-run setup) with two fake Klipper printers.
//
//   node tests/printer-access-e2e.mjs http://localhost:9337
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";
import { startFakeMoonraker } from "./fake-moonraker/fake-moonraker.mjs";
import { addVoron, bracketsProject, printerFree, until } from "./farm-lib.mjs";

console.log(`printer access e2e against ${BASE}`);
const json = (r) => JSON.stringify(r.json);
const fakeA = await startFakeMoonraker({ printSeconds: 2 });
const fakeB = await startFakeMoonraker({ printSeconds: 2 });

const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));

async function enrol(username, role = "user") {
  const made = await owner.post("/api/users", { username, role });
  const token = made.json.invite_url.split("/invite/")[1];
  const client = new Client();
  const done = await register(client, new SoftAuthenticator(), `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "k");
  check(done.status === 200, `${username} enrols`, json(done));
  return { client, id: made.json.user.id };
}

r = await owner.post("/api/roles", { name: "Trainer", scope: "site", caps: ["certifications.grant"] });
const trainerRole = r.json.id;
const ann = await enrol("ann");
const cy = await enrol("cy");
const appr = await enrol("appr");
const opal = await enrol("opal");
const tess = await enrol("tess", trainerRole);

const A = await addVoron(owner, fakeA, "Voron A");
const B = await addVoron(owner, fakeB, "Voron B");
const MODEL = "Voron 2.4 350";
r = await owner.post("/api/pools", { name: "Bay", printer_ids: [A], operator_ids: [opal.id] });
const bay = r.json.id;

/** A sendable job of `who`'s own (two plates of brackets). */
async function upload(who) {
  const res = await who.client.form("/api/uploads", { file: [new Blob([bracketsProject()]), "Brackets.gcode.3mf"] });
  check(res.status === 201, "upload", json(res));
  return res.json.id;
}
const annJob = await upload(ann);
const cyJob = await upload(cy);

// ---- no rules: open as before ------------------------------------------------------
r = await ann.client.get(`/api/jobs/${annJob}/targets?plate=1`);
check(r.json.targets?.every((t) => t.access?.effect === "allow"), "no rules: every printer is open", json(r));

// ---- who changes rules and certifications ---------------------------------------
r = await ann.client.post("/api/certifications", { name: "Voron trained" });
check(r.status === 403, "a user can't make certifications", json(r));
r = await owner.post("/api/certifications", { name: "Voron trained", description: "Knows the Vorons", valid_days: 365 });
check(r.status === 201 && r.json.valid_days === 365, "owner makes a certification", json(r));
const voron = r.json.id;
r = await owner.post("/api/certifications", { name: "voron TRAINED" });
check(r.status === 409, "certification names are unique", json(r));

r = await tess.client.post("/api/printer-access/rules", { target_kind: "site", who: { kind: "everyone" }, effect: "deny" });
check(r.status === 403, "a trainer can't make access rules", json(r));
r = await owner.post("/api/printer-access/rules", { target_kind: "printer", target_id: "nope", who: { kind: "everyone" }, effect: "deny" });
check(r.status === 400, "an unknown printer is refused", json(r));
r = await owner.post("/api/printer-access/rules", { target_kind: "model", target_id: MODEL, who: { kind: "certified", id: "nope" }, effect: "allow" });
check(r.status === 400, "an unknown certification is refused", json(r));
r = await owner.post("/api/printer-access/rules", { target_kind: "model", target_id: MODEL, who: { kind: "everyone" }, effect: "allow", approvers: [{ kind: "user", id: appr.id }] });
check(r.status === 400, "approvers only go with approve", json(r));

// The model: certified users print; everyone else asks appr.
r = await owner.post("/api/printer-access/rules", { target_kind: "model", target_id: MODEL, who: { kind: "certified", id: voron }, effect: "allow" });
check(r.status === 201 && r.json.who === "holders of Voron trained" && r.json.target_name === MODEL, "model rule: certified users allowed", json(r));
const certRule = r.json.id;
r = await owner.post("/api/printer-access/rules", {
  target_kind: "model",
  target_id: MODEL,
  who: { kind: "everyone" },
  effect: "approve",
  approvers: [{ kind: "user", id: appr.id }],
  note: "ask appr",
});
check(r.status === 201 && r.json.position === 1 && r.json.approver_names?.[0] === "appr", "model rule: everyone else needs appr's approval", json(r));
const everyoneRule = r.json.id;
// Voron B: not for ann.
r = await owner.post("/api/printer-access/rules", { target_kind: "printer", target_id: B, who: { kind: "user", id: ann.id }, effect: "deny", note: "ask about B" });
check(r.status === 201, "printer rule: ann can't use Voron B", json(r));

r = await ann.client.get("/api/printer-access/mine");
const mineA = r.json.printers?.find((p) => p.printer_id === A);
const mineB = r.json.printers?.find((p) => p.printer_id === B);
check(mineA?.effect === "approve" && /needs approval: ask appr/.test(mineA.why), "ann: Voron A needs approval", json(r));
check(mineB?.effect === "deny" && /isn't open to you: ask about B/.test(mineB.why), "ann: Voron B is closed", json(r));
r = await ann.client.get(`/api/jobs/${annJob}/targets?plate=1`);
check(r.json.targets.find((t) => t.printer_id === A).access.effect === "approve" && r.json.targets.find((t) => t.printer_id === B).access.effect === "deny", "the Send dialog's targets say so", json(r));
r = await appr.client.get(`/api/jobs/${annJob}/targets?plate=1`);
check(r.status === 404, "(appr can't see ann's job)", json(r));

// ---- deny and approve -----------------------------------------------------------
r = await ann.client.post(`/api/jobs/${annJob}/print`, { printer_id: B, plate: 1 });
check(r.status === 403 && /isn't open to you/.test(r.json.error), "ann can't send to Voron B", json(r));
r = await ann.client.post(`/api/jobs/${annJob}/print`, { printer_id: A, plate: 1, ignore_mapping_problems: true });
check(r.status === 202 && r.json.status === "pending_approval" && /needs approval/.test(r.json.approval_reason), "her send to Voron A waits for approval", json(r));
const held = r.json.id;
r = await ann.client.get(`/api/prints/${held}`);
check(r.json.can_approve === false, "she can't approve it herself", json(r));
r = await cy.client.post(`/api/prints/${held}/approve`);
check(r.status === 404, "nor can an unrelated user (who can't even see it)", json(r));
r = await appr.client.get("/api/prints?pending=1");
check(r.json.some?.((p) => p.id === held && p.can_approve), "the rule's approver sees it waiting, and may approve", json(r));
r = await appr.client.post(`/api/prints/${held}/approve`, { ignore_mapping_problems: true });
check(r.status === 200 && r.json.status !== "pending_approval", "appr approves; it goes to Voron A", json(r));
await until(owner, `/api/prints/${held}`, (p) => p?.status === "finished");
await printerFree(owner, A);

// ---- certification --------------------------------------------------------------
r = await ann.client.post(`/api/certifications/${voron}/holders`, { username: "cy" });
check(r.status === 403, "a user can't sign people off", json(r));
r = await tess.client.post(`/api/certifications/${voron}/holders`, { username: "cy", note: "did the course" });
check(r.status === 201 && r.json.valid && r.json.expires_at && r.json.granted_by === "tess", "the trainer signs cy off (expiring with the certification)", json(r));
r = await cy.client.get("/api/printer-access/mine");
check(r.json.printers.find((p) => p.printer_id === A).effect === "allow" && r.json.certifications?.[0]?.name === "Voron trained", "cy may use the Vorons and sees her certification", json(r));
r = await cy.client.post(`/api/jobs/${cyJob}/print`, { printer_id: A, plate: 1, ignore_mapping_problems: true });
check(r.status === 201, "cy sends straight to Voron A", json(r));
await until(owner, `/api/prints/${r.json.id}`, (p) => p?.status === "finished");
await printerFree(owner, A);

// The printer is more specific than the model.
r = await owner.post("/api/printer-access/rules", { target_kind: "printer", target_id: A, who: { kind: "user", id: cy.id }, effect: "deny" });
const cyOnA = r.json.id;
r = await cy.client.get("/api/printer-access/mine");
check(r.json.printers.find((p) => p.printer_id === A).effect === "deny" && r.json.printers.find((p) => p.printer_id === B).effect === "allow", "a printer rule beats the model's", json(r));
r = await owner.del(`/api/printer-access/rules/${cyOnA}`);
check(r.status === 204, "rule removed", String(r.status));

// Order matters: everyone first catches cy too.
r = await owner.put("/api/printer-access/order", { target_kind: "model", target_id: MODEL, ids: [everyoneRule] });
check(r.status === 400, "an order must list every rule of the target", json(r));
r = await owner.put("/api/printer-access/order", { target_kind: "model", target_id: MODEL, ids: [everyoneRule, certRule] });
check(r.status === 204, "rules reordered", json(r));
r = await cy.client.get("/api/printer-access/mine");
check(r.json.printers.find((p) => p.printer_id === A).effect === "approve", "first match wins: now cy asks too", json(r));
await owner.put("/api/printer-access/order", { target_kind: "model", target_id: MODEL, ids: [certRule, everyoneRule] });

// ---- the pool's operator, and the queue -------------------------------------------
r = await ann.client.post("/api/queue", { job_id: annJob, plate: 2 });
check(r.status === 201, "ann queues a plate", json(r));
const entry = r.json[0].id;
r = await owner.get("/api/queue");
const e = r.json.entries.find((x) => x.id === entry);
const fitA = e.fits.find((f) => f.printer_id === A);
const fitB = e.fits.find((f) => f.printer_id === B);
check(fitA.refused === null && /needs approval/.test(fitA.needs_approval ?? ""), "the queue: it may go to Voron A with approval", json(e));
check(/isn't open to you/.test(fitB.refused ?? ""), "and not to Voron B", json(e));
r = await opal.client.post(`/api/printers/${A}/send-next`, { ignore_mapping_problems: true });
check(r.status === 201 && r.json.print.status !== "pending_approval", "Voron A's operator sends it: her send is the approval", json(r));
await until(owner, `/api/prints/${r.json.print.id}`, (p) => p?.status === "finished");
await printerFree(owner, A);

// ---- a pool rule, and revoking --------------------------------------------------------
r = await owner.post("/api/printer-access/rules", { target_kind: "pool", target_id: bay, who: { kind: "everyone" }, effect: "deny" });
check(r.status === 201 && r.json.target_name === "pool Bay", "pool rule: Bay closed", json(r));
r = await cy.client.get("/api/printer-access/mine");
check(r.json.printers.find((p) => p.printer_id === A).effect === "deny", "a pool rule beats the model's", json(r));
r = await owner.get("/api/printer-access/mine");
check(r.json.printers.every((p) => p.effect === "allow"), "operating every printer is exempt", json(r));
r = await owner.del(`/api/pools/${bay}`);
check(r.status === 204, "pool deleted", String(r.status));
r = await owner.get("/api/printer-access");
check(!r.json.rules.some((x) => x.target_kind === "pool"), "its rules went with it", json(r));

r = await tess.client.del(`/api/certifications/${voron}/holders/${cy.id}`);
check(r.status === 204, "the trainer takes cy's sign-off back", String(r.status));
r = await cy.client.get("/api/printer-access/mine");
check(r.json.printers.find((p) => p.printer_id === A).effect === "approve", "cy asks again", json(r));
r = await owner.del(`/api/certifications/${voron}`);
check(r.status === 409, "a certification a rule names can't be deleted", json(r));

r = await tess.client.get("/api/printer-access");
check(r.status === 200 && r.json.certifications[0].holders.length === 0, "the trainer sees certifications and holders", json(r));

// ---- audit ---------------------------------------------------------------------------
r = await owner.get("/api/audit?limit=200");
const actions = r.json.entries.map((x) => `${x.actor_name}:${x.action}`);
for (const want of ["owner:access.rule.create", "owner:access.rule.delete", "owner:access.rule.order", "owner:certification.create", "tess:certification.grant", "tess:certification.revoke"]) {
  check(actions.includes(want), `audit: ${want}`, actions.join(" | "));
}

await fakeA.close?.();
await fakeB.close?.();
finish();
