#!/usr/bin/env node
// End-to-end test of what keeps unsafe G-code off printers: the overrides
// allowlist (src/config_policy.rs), package structure checks
// (src/bambu/zipcheck.rs), the G-code check on every package (src/gcode/,
// src/safety.rs) and how sending and approval follow it
// (src/prints_api.rs), the upload policy and the site's G-code limits.
//
//   node tests/gcode-safety-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup). Exit code 0 iff all
// checks pass. No dependencies beyond Node 22.
import { createHash } from "node:crypto";
import { BASE, check, Client, SoftAuthenticator, register, finish, zip } from "./lib.mjs";

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

// ---- packages ----------------------------------------------------------------------
const sliceInfo = (prediction = 3600, weight = 12.5) => `<?xml version="1.0" encoding="UTF-8"?>
<config><plate>
  <metadata key="index" value="1"/>
  <metadata key="printer_model_id" value="BL-P001"/>
  <metadata key="nozzle_diameters" value="0.4"/>
  <metadata key="prediction" value="${prediction}"/>
  <metadata key="weight" value="${weight}"/>
  <filament id="1" tray_info_idx="GFA00" type="PLA" color="#FF6A13" used_m="4.1" used_g="${weight}"/>
</plate></config>`;
const pkg = (gcode, extra = {}, info = sliceInfo()) =>
  zip({ "Metadata/plate_1.gcode": gcode, "Metadata/slice_info.config": info, ...extra });
const upload = (client, bytes, name = "part.gcode.3mf") => client.form("/api/uploads", { file: [new Blob([bytes]), name] });

const CLEAN = "M140 S55\nM104 S220\nG28\nG90\nM83\nG1 X10 Y10 Z0.2 F12000\nG1 X100 Y10 E5 F3000\nM104 S0\nM140 S0\n";
const HOT = "M104 S300\nG4 S36000\nM104 S0\n";
const UNREADABLE = "G1 X10 Y10\nG1 X(1)\n";

// Structure: refused at upload.
r = await upload(user, zip([["Metadata/plate_1.gcode", CLEAN], ["Metadata/slice_info.config", sliceInfo()], ["Metadata/plate_1.gcode", HOT]]));
check(r.status === 400 && /two entries/.test(r.json.error), "a package with two plate_1.gcode is refused", json(r));
r = await upload(user, pkg(HOT, { "Metadata/plate_1.gcode.md5": createHash("md5").update(CLEAN).digest("hex") }));
check(r.status === 400 && /changed after slicing/.test(r.json.error), "G-code that doesn't match its checksum is refused", json(r));

// A printer to send to (unreachable: nothing listens there).
r = await owner.post("/api/printers", {
  name: "Bench X1C", machine_profile: "Bambu Lab X1 Carbon", nozzle_diameter: "0.4", protocol: "bambu",
  address: "127.0.0.1", serial_number: "00M00A000000000", access_code: "12345678",
});
const printer = r.json.id;

r = await upload(user, pkg(CLEAN, { "Metadata/plate_1.gcode.md5": createHash("md5").update(CLEAN).digest("hex") }), "clean.gcode.3mf");
check(r.status === 201, "a clean package uploads", json(r));
const clean = r.json.id;
let plate = JSON.parse(r.json.package_json).plates[0];
check(plate.check && plate.check.verdict === null && plate.check.stats.max_nozzle_c === 220, "its G-code was checked on upload", JSON.stringify(plate.check));
r = await user.get(`/api/jobs/${clean}/targets`);
check(r.json.blocked.length === 0 && r.json.needs_review.length === 0 && r.json.gcode_check, "nothing holds a clean plate", json(r));

r = await upload(user, pkg(HOT), "hot.gcode.3mf");
const hot = r.json.id;
r = await user.get(`/api/jobs/${hot}/targets`);
check(r.json.needs_review.some((m) => /300 °C/.test(m)) && r.json.needs_review.some((m) => /waits 10 h/.test(m)), "an overheated, idling plate needs review", json(r));
r = await user.post(`/api/jobs/${hot}/print`, { printer_id: printer });
check(r.status === 202 && r.json.status === "pending_approval" && r.json.safety_review === true && /^G-code review: /.test(r.json.approval_reason),
  "a member's send waits for an admin", json(r));
const held = r.json.id;
r = await user.get("/api/prints?pending=1");
check(r.json[0]?.can_approve === false, "the member can't approve it", json(r));
r = await user.post(`/api/prints/${held}/approve`);
check(r.status === 403, "nor force it", json(r));
r = await owner.post(`/api/prints/${held}/approve`);
check(r.status === 409 && /offline|connected/.test(r.json.error), "an admin's approval gets as far as the printer", json(r));
r = await owner.post(`/api/prints/${held}/reject`, { note: "no" });
check(r.status === 200 && r.json.status === "rejected", "and the admin turns it down", json(r));
r = await owner.post(`/api/jobs/${hot}/print`, { printer_id: printer });
check(r.status === 409 && r.json.needs_review?.length > 0, "admins sending it themselves must acknowledge the review", json(r));
r = await owner.post(`/api/jobs/${hot}/print`, { printer_id: printer, acknowledge_review: true });
check(r.status === 409 && /offline|connected/.test(r.json.error), "acknowledged, it gets as far as the printer", json(r));

r = await upload(user, pkg(UNREADABLE), "odd.gcode.3mf");
const odd = r.json.id;
r = await user.get(`/api/jobs/${odd}/targets`);
check(r.json.blocked.length === 1 && /read differently/.test(r.json.blocked[0]), "an unreadable line blocks the plate", json(r));
r = await owner.post(`/api/jobs/${odd}/print`, { printer_id: printer, acknowledge_review: true });
check(r.status === 409 && /can't be sent/.test(r.json.error), "nobody can send it", json(r));

// The package says a minute; three 10-minute pauses say otherwise.
const LONG = "G4 S600\nG4 S600\nG4 S600\n";
r = await upload(user, pkg(LONG, {}, sliceInfo(60, 1)), "long.gcode.3mf");
check(r.json.print_time_sec >= 1800, "the job counts the time its G-code takes", json(r));
plate = JSON.parse(r.json.package_json).plates[0];
check(plate.check.findings.some((f) => f.code === "understated_time"), "and says the package understated it", JSON.stringify(plate.check));
const long = r.json.id;
r = await owner.call("PUT", "/api/settings", { print_rules: { max_minutes: 20 } });
r = await user.get(`/api/jobs/${long}/targets`);
check(r.json.needs_approval.some((m) => /takes 30 min/.test(m)), "print rules go by that time", json(r));
r = await owner.call("PUT", "/api/settings", { print_rules: {} });

// ---- browser results are checked like uploads ---------------------------------------
r = await user.form("/api/jobs", { source: "browser", model_name: "b.stl" });
const browser = r.json.id;
r = await user.form(`/api/jobs/${browser}/result`, {
  gcode: [new Blob([HOT]), "out.gcode"],
  package: [new Blob([pkg(HOT)]), "out.gcode.3mf"],
  print_time_sec: "60",
  filament_used_g: "1",
});
check(r.status === 200, "a browser result is filed", json(r));
r = await user.get(`/api/jobs/${browser}/targets`);
check(r.json.needs_review.length > 0, "and its G-code checked", json(r));

// Without a package, the job still counts what its G-code uses.
r = await user.form("/api/jobs", { source: "browser", model_name: "c.stl" });
const bare = r.json.id;
const EXTRUDES = "M83\n" + "G1 X10 E1000\n".repeat(10);
r = await user.form(`/api/jobs/${bare}/result`, { gcode: [new Blob([EXTRUDES]), "out.gcode"], print_time_sec: "1", filament_used_g: "0" });
check(r.json.filament_used_g > 25, "a client can't report zero grams", json(r));

// ---- upload policy -------------------------------------------------------------------
r = await user.call("PUT", "/api/settings", { uploads: "deny" });
check(r.status === 403, "only admins set the upload policy", json(r));
r = await owner.call("PUT", "/api/settings", { uploads: "sometimes" });
check(r.status === 400, "the policy is allow, review or deny", json(r));
r = await owner.call("PUT", "/api/settings", { uploads: "review" });
check(r.status === 200 && r.json.uploads === "review", "uploads need review", json(r));
r = await user.get(`/api/jobs/${clean}/targets`);
check(r.json.needs_approval.includes("uploaded files need approval here"), "so a clean upload waits for approval", json(r));
r = await owner.call("PUT", "/api/settings", { uploads: "deny" });
r = await upload(user, pkg(CLEAN));
check(r.status === 403 && /can't be uploaded/.test(r.json.error), "denied uploads are refused", json(r));
r = await user.post(`/api/jobs/${clean}/print`, { printer_id: printer });
check(r.status === 403, "and earlier ones can't be printed", json(r));
r = await upload(owner, pkg(CLEAN));
check(r.status === 201, "admins still upload", json(r));
r = await owner.call("PUT", "/api/settings", { uploads: "allow" });

// ---- limits --------------------------------------------------------------------------
r = await owner.call("PUT", "/api/settings", { gcode_limits: { max_dwell_sec: 0 } });
check(r.status === 400, "limits are range-checked", json(r));
r = await owner.call("PUT", "/api/settings", { gcode_limits: { max_dwell_sec: 300 } });
check(r.status === 200 && r.json.gcode_limits.max_dwell_sec === 300 && r.json.gcode_limits.max_heated_idle_sec === 2700, "admins set limits; the rest keep their defaults", json(r));
r = await user.get(`/api/jobs/${long}/targets`);
check(r.json.needs_review.some((m) => /waits 10 min/.test(m)), "plates are re-checked against new limits", json(r));

finish();
