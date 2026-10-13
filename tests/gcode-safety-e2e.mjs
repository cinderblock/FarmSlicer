#!/usr/bin/env node
// End-to-end test of what keeps unsafe G-code off printers: the overrides
// allowlist (src/config_policy.rs).
//
//   node tests/gcode-safety-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup). Exit code 0 iff all
// checks pass. No dependencies beyond Node 22.
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";

console.log(`gcode safety e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);

const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));

r = await owner.post("/api/users", { username: "ursula", role: "user" });
const token = r.json.invite_url.split("/invite/")[1];
const user = new Client();
r = await register(user, new SoftAuthenticator(), `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "k");
check(r.status === 200, "user enrols", json(r));

// ---- overrides ---------------------------------------------------------------------
const browserJob = (client, overrides) =>
  client.form("/api/jobs", { source: "browser", model_name: "part.stl", overrides: JSON.stringify(overrides) });

r = await browserJob(user, { layer_height: "0.2", sparse_infill_density: "20%" });
check(r.status === 201, "members change the settings the Slice page offers", json(r));
r = await browserJob(user, { machine_start_gcode: "M104 S300\nG4 S36000" });
check(r.status === 400 && /machine_start_gcode/.test(r.json.error), "members can't inject start G-code", json(r));
r = await browserJob(user, { filament_start_gcode: ["M140 S120"] });
check(r.status === 400 && /filament_start_gcode/.test(r.json.error), "nor filament G-code", json(r));
r = await browserJob(user, { layer_height: "3" });
check(r.status === 400 && /layer_height/.test(r.json.error), "values are range-checked", json(r));
r = await user.form("/api/jobs", { source: "browser", model_name: "part.stl", overrides: "{not json" });
check(r.status === 400 && /JSON/.test(r.json.error), "unreadable overrides are refused, not ignored", json(r));
r = await browserJob(owner, { machine_start_gcode: "G28" });
check(r.status === 201, "admins may change other settings", json(r));
r = await browserJob(owner, { post_process: "/bin/sh -c id" });
check(r.status === 400 && /post_process/.test(r.json.error), "nobody sets post-processing scripts", json(r));

// ---- custom profiles -----------------------------------------------------------------
const profile = (overrides) => ({ name: "Tuned", profile_type: "process", base_profile: "0.20mm Standard @BBL X1C", overrides: JSON.stringify(overrides) });
r = await user.post("/api/custom-profiles", profile({ wall_loops: "3" }));
check(r.status === 201, "members save custom profiles", json(r));
const pid = r.json.id;
r = await user.post("/api/custom-profiles", profile({ change_filament_gcode: "M500" }));
check(r.status === 400, "custom profiles follow the same rules", json(r));
r = await user.put(`/api/custom-profiles/${pid}`, { overrides: JSON.stringify({ layer_change_gcode: "G1 Z-5" }) });
check(r.status === 400, "including edits", json(r));
r = await user.put(`/api/custom-profiles/${pid}`, { overrides: JSON.stringify({ wall_loops: "4" }) });
check(r.status === 200, "allowed edits go through", json(r));

finish();
