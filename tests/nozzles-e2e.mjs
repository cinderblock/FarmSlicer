#!/usr/bin/env node
// e2e-env: ORCA_RESOURCES_DIR={ROOT}/tests/fixtures
// End-to-end test of choosing nozzles on dual-nozzle printers: the
// printers' nozzle priority (only valid values), the Slice page's preview
// (`POST /api/nozzle-plan`), and the Manual filament map a job's config
// gets from it. Profiles come from tests/fixtures/profiles (an H2D and an
// X1C); no printer is online, so the priority alone decides (what's loaded
// on an AMS is covered by src/nozzles.rs's unit tests).
//
//   node tests/nozzles-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup) started with
// ORCA_RESOURCES_DIR=<repo>/tests/fixtures; FARMSLICER_SKIP_CXX is enough.
// Exit code 0 iff all checks pass. No dependencies beyond Node 22.
import { check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";

const json = (r) => JSON.stringify(r.json);
const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));

const H2D = "Bambu Lab H2D 0.4 nozzle";
const PROCESS = "0.20mm Standard @BBL H2D";
const PLA = "Bambu PLA Basic @BBL H2D";
const SUPPORT = "Bambu Support For PLA @BBL H2D";
const PETCF = "Bambu PET-CF @BBL H2D";
// The Supports section's overrides for an interface in filament 2.
const INTERFACE = { enable_support: "1", support_filament: "0", support_interface_filament: "2" };

r = await owner.get("/api/profiles/machine-models");
const models = Object.fromEntries((r.json ?? []).map((m) => [m.name, m.nozzles]));
check(models["Bambu Lab H2D"] === 2 && models["Bambu Lab X1 Carbon"] === 1, "machine models say how many nozzles", json(r));

// ---- the printer setting ------------------------------------------------------------
r = await owner.post("/api/printers", { name: "H2D one", machine_profile: "Bambu Lab H2D", nozzle_diameter: "0.4", protocol: "bambu" });
check(r.status === 201 && r.json.nozzle_priority === "", "a new printer has the default priority", json(r));
const h2d = r.json.id;
r = await owner.patch(`/api/printers/${h2d}`, { nozzle_priority: "sideways" });
check(r.status === 400 && /support-right/.test(r.json.error), "an unknown priority is refused", json(r));

// ---- the preview ----------------------------------------------------------------------
const plan = (body) => owner.post("/api/nozzle-plan", { machine: H2D, process: PROCESS, ...body });
r = await plan({ filaments: [PLA, SUPPORT], overrides: INTERFACE, printer_id: h2d });
check(r.status === 200 && r.json.plan, "the H2D gets a nozzle plan", json(r));
check(
  JSON.stringify(r.json.plan.filaments.map((c) => [c.nozzle, c.basis])) === JSON.stringify([[1, "priority"], [2, "priority"]]),
  "default priority: the part on the left, the support interface on the right",
  json(r),
);
check(r.json.plan.printers === 0 && r.json.plan.priority === "support-right", "no AMS to go by; the default priority", json(r));

r = await owner.patch(`/api/printers/${h2d}`, { nozzle_priority: "support-left" });
check(r.status === 200 && r.json.nozzle_priority === "support-left", "the priority can be changed", json(r));
r = await plan({ filaments: [PLA, SUPPORT], overrides: INTERFACE, printer_id: h2d });
check(JSON.stringify(r.json.plan?.filaments.map((c) => c.nozzle)) === "[2,1]", "supports-left puts them the other way round", json(r));
// No printer picked: every H2D of that nozzle size counts; they all say supports-left.
r = await plan({ filaments: [PLA, SUPPORT], overrides: INTERFACE });
check(JSON.stringify(r.json.plan?.filaments.map((c) => c.nozzle)) === "[2,1]", "any printer: the H2Ds' shared priority", json(r));

// The H2D prints PET-CF from its left nozzle only: the support keeps away
// from it, against the supports-left priority.
r = await plan({ filaments: [PETCF, SUPPORT], overrides: INTERFACE, printer_id: h2d });
check(
  JSON.stringify(r.json.plan?.filaments.map((c) => [c.nozzle, c.basis])) === JSON.stringify([[1, "printable"], [2, "priority"]]),
  "a left-only filament goes left and the support right",
  json(r),
);
r = await owner.patch(`/api/printers/${h2d}`, { nozzle_priority: "" });

r = await owner.post("/api/nozzle-plan", { machine: "Bambu Lab X1 Carbon 0.4 nozzle", process: "0.20mm Standard @BBL X1C", filaments: ["Bambu PLA Basic @BBL X1C"] });
check(r.status === 200 && r.json.plan === null, "single-nozzle printers get no plan", json(r));
r = await owner.patch(`/api/printers/${h2d}`, { nozzle_priority: "slicer" });
r = await plan({ filaments: [PLA, SUPPORT], overrides: INTERFACE, printer_id: h2d });
check(r.status === 200 && r.json.plan === null, "'let the slicer choose' gets no plan", json(r));
r = await owner.patch(`/api/printers/${h2d}`, { nozzle_priority: "support-right" });

// ---- a job --------------------------------------------------------------------------
function job(fields) {
  const fd = new FormData();
  fd.append("model", new Blob(["solid cube\nendsolid cube\n"]), "cube.stl");
  for (const [k, v] of fields) fd.append(k, v);
  return owner.call("POST", "/api/jobs", fd);
}
r = await job([
  ["source", "browser"],
  ["machine", H2D],
  ["process", PROCESS],
  ["filament", PLA],
  ["filament", SUPPORT],
  ["printer_id", h2d],
  ["overrides", JSON.stringify(INTERFACE)],
]);
check(r.status === 201, "an H2D job is created", json(r));
const config = JSON.parse(r.json.config_json ?? "{}");
check(config.filament_map_mode === "Manual", "its config takes the map as given", r.json.config_json);
check(JSON.stringify(config.filament_map) === JSON.stringify(["1", "2"]), "part left, support right in the config", r.json.config_json);
const id = r.json.id;
r = await owner.get(`/api/jobs/${id}`);
check(JSON.stringify(r.json.nozzle_plan?.filaments.map((c) => c.nozzle)) === "[1,2]", "the job records its plan and why", json(r));

// An explicit map in the overrides (admins) wins over the plan.
r = await job([
  ["source", "browser"],
  ["machine", H2D],
  ["process", PROCESS],
  ["filament", PLA],
  ["filament", SUPPORT],
  ["overrides", JSON.stringify({ ...INTERFACE, filament_map_mode: "Auto For Flush" })],
]);
const explicit = JSON.parse(r.json.config_json ?? "{}");
check(r.status === 201 && explicit.filament_map_mode === "Auto For Flush", "an explicit filament map mode is kept", json(r));
r = await owner.get(`/api/jobs/${r.json.id}`);
check(r.json.nozzle_plan === null, "and the job has no plan", json(r));

finish();
