#!/usr/bin/env node
// End-to-end test of the live view's stream (src/live.rs):
// `GET /api/jobs/{id}/live` is for whoever can see the job, and says 204
// when there is nothing to stream (no server slice under way). The frames
// themselves come from libslic3r, which the stub server this runs against
// doesn't have: wasm/test/smoke.mjs --live and the Rust unit tests cover
// them.
//
//   node tests/live-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup). Exit code 0 iff all
// checks pass. No dependencies beyond Node 22.
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";

console.log(`live view e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);

const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));

async function invite(username) {
  const res = await owner.post("/api/users", { username, role: "user" });
  const token = res.json.invite_url.split("/invite/")[1];
  const client = new Client();
  const done = await register(client, new SoftAuthenticator(), `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "k");
  check(done.status === 200, `${username} enrols`, json(done));
  return client;
}
const ursula = await invite("ursula");
const victor = await invite("victor");

// A job of ursula's: an uploaded G-code (never sliced here).
const gcode = ["; generated for the live e2e", "G90", "M83", ";LAYER_CHANGE", ";Z:0.2", "G1 Z0.2", "G1 X10 Y10 E1 F3000", ""].join("\n");
r = await ursula.form("/api/uploads", { file: [new Blob([gcode]), "part.gcode"] });
check(r.status === 201, "a G-code uploads", json(r));
const job = r.json?.id;

r = await ursula.get(`/api/jobs/${job}/live`);
check(r.status === 204, "nothing to stream for a job that isn't slicing: 204", String(r.status));
r = await owner.get(`/api/jobs/${job}/live`);
check(r.status === 204, "an admin sees it too: 204", String(r.status));
r = await victor.get(`/api/jobs/${job}/live`);
check(r.status === 404, "someone who can't see the job: 404", String(r.status));
r = await ursula.get(`/api/jobs/no-such-job/live`);
check(r.status === 404, "no such job: 404", String(r.status));
r = await new Client().get(`/api/jobs/${job}/live`);
check(r.status === 401, "signed out: 401", String(r.status));

finish();
