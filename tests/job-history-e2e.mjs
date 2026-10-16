#!/usr/bin/env node
// End-to-end test of job history: every job keeps its source models (or
// names the ones that stayed in the browser), records what it was made from
// and its plate, serves its models back for re-slicing, and can be deleted
// (alone or in bulk) with its files, by whoever may.
//
//   node tests/job-history-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup); FARMSLICER_SKIP_CXX is
// enough. Exit code 0 iff all checks pass. No dependencies beyond Node 22.
import { createHash } from "node:crypto";
import { BASE, check, Client, SoftAuthenticator, register, finish, zip } from "./lib.mjs";

console.log(`job history e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);
const sha = (text) => createHash("sha256").update(text).digest("hex");

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

const CUBE = "solid cube\nendsolid cube\n";
const PEG = "solid peg\nfacet normal 0 0 1\nendfacet\nendsolid peg\n";
const ID = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** POST /api/jobs with repeatable fields: [name, value] or [name, Blob, filename]. */
function jobForm(client, fields) {
  const fd = new FormData();
  for (const [k, v, file] of fields) {
    if (file) fd.append(k, v, file);
    else fd.append(k, v);
  }
  return client.call("POST", "/api/jobs", fd);
}
const model = (text, name) => ["model", new Blob([text]), name];
const browserResult = (client, id) =>
  client.form(`/api/jobs/${id}/result`, {
    gcode: [new Blob(["; sliced\nG28\n"]), "x.gcode"],
    print_time_sec: "60",
    filament_used_g: "1.5",
    warnings: "[]",
  });

// ---- several models, a plate, inputs ----------------------------------------------
const plate = {
  objects: [
    { model: 0, placement: { rotation: ID, offset: [-30, 0] } },
    { model: 1, placement: { rotation: ID, offset: [30, 0] } },
  ],
};
// What the page proposed: a Cool Plate the job then didn't use, supports on.
const proposed = {
  nozzle: "0.4",
  bed_type: "Cool Plate",
  filaments: ["Bambu PLA Basic @BBL X1C"],
  supports: { enabled: true, materials: { mode: "same" } },
  overrides: {},
};
r = await jobForm(alice, [
  ["source", "browser"],
  model(CUBE, "cube.stl"),
  model(PEG, "peg.stl"),
  ["plate", JSON.stringify(plate)],
  ["proposed", JSON.stringify(proposed)],
  ["machine", "Bambu Lab X1 Carbon 0.4 nozzle"],
  ["process", "0.20mm Standard @BBL X1C"],
  ["bed_type", "Textured PEI Plate"],
]);
check(r.status === 201, "a plate of two models", json(r));
check(r.json?.model_count === 2 && r.json?.model_name === "cube.stl + 1 more", "the job has both models", json(r));
check(
  r.json?.slice_options?.plate?.objects?.length === 2 && r.json.slice_options.plate.objects[1].placement.offset[0] === 30,
  "the browser engine gets every part",
  json(r),
);
check(
  JSON.stringify(r.json?.slice_options?.models) === JSON.stringify([{ name: "cube.stl" }, { name: "peg.stl" }]),
  "and the models' names in plate order",
  json(r),
);
check(r.json?.slice_options?.placement === null, "no single placement for a plate of several parts", json(r));
const twoPart = r.json?.id;
r = await alice.get(`/api/jobs/${twoPart}/models/1`);
check(r.status === 200 && r.json?.raw?.startsWith("solid peg"), "the second model downloads", json(r));
// Copies: one model placed three times.
r = await jobForm(alice, [
  ["source", "browser"],
  model(CUBE, "cube.stl"),
  ["plate", JSON.stringify({ objects: [0, 1, 2].map((i) => ({ model: 0, placement: { rotation: ID, offset: [i * 25, 0] } })) })],
]);
check(r.status === 201 && r.json?.slice_options?.plate?.objects?.length === 3 && r.json?.model_count === 1, "copies of one model", json(r));

r = await jobForm(alice, [
  ["source", "browser"],
  model(CUBE, "cube.stl"),
  ["plate", JSON.stringify({ objects: [{ model: 0, placement: { rotation: ID, offset: [5, 5] } }] })],
  ["proposed", JSON.stringify(proposed)],
  // No filament: the profiles aren't resolved (the test server has no
  // vendor profiles), but the choices are still recorded.
  ["machine", "Bambu Lab X1 Carbon 0.4 nozzle"],
  ["process", "0.20mm Standard @BBL X1C"],
  ["bed_type", "Textured PEI Plate"],
  ["color", "#FF0000"],
  ["overrides", JSON.stringify({ enable_support: "1" })],
]);
check(r.status === 201, "a browser job uploads its model", json(r));
const job = r.json?.id;
check(r.json?.model_count === 1 && r.json?.local_models === 0, "the job counts its stored model", json(r));
check(r.json?.slice_options?.placement?.offset?.[0] === 5, "the browser engine gets the part's placement", json(r));
check(r.json?.keep_model === undefined, "no keep_model flag any more", json(r));

r = await alice.get(`/api/jobs/${job}`);
check(r.status === 200, "GET one job", json(r));
check(r.json?.models?.length === 1 && r.json.models[0].name === "cube.stl" && r.json.models[0].stored === true, "it lists its model", json(r));
check(r.json?.models?.[0]?.sha256 === sha(CUBE) && r.json.models[0].bytes === CUBE.length, "with size and digest", json(r));
check(r.json?.models?.[0]?.path === undefined, "but not its server path", json(r));
const inputs = r.json?.inputs;
check(
  inputs?.machine === "Bambu Lab X1 Carbon 0.4 nozzle" && inputs?.process === "0.20mm Standard @BBL X1C" &&
    Array.isArray(inputs?.filaments) && inputs?.bed_type === "Textured PEI Plate" &&
    inputs?.color === "#FF0000" && inputs?.source === "browser",
  "it records what it was made from",
  json(r),
);
check(r.json?.plate?.objects?.[0]?.placement?.offset?.[1] === 5, "and its plate", json(r));
check(JSON.parse(r.json?.proposed_json ?? "{}").filaments?.[0] === "Bambu PLA Basic @BBL X1C", "and what the page proposed", json(r));
check(JSON.parse(r.json?.overrides_json ?? "{}").enable_support === "1", "overrides as before", json(r));

r = await alice.get(`/api/jobs/${job}/models/0`);
check(r.status === 200 && r.json?.raw?.startsWith("solid cube"), "the model downloads by index", json(r));
r = await alice.get(`/api/jobs/${job}/model`);
check(r.status === 200 && r.json?.raw?.startsWith("solid cube"), "and through the old single-model URL", json(r));
r = await alice.get(`/api/jobs/${job}/models/7`);
check(r.status === 404, "no such model index", json(r));
r = await bob.get(`/api/jobs/${job}`);
check(r.status === 404, "another member can't see a personal job", json(r));
r = await bob.get(`/api/jobs/${job}/models/0`);
check(r.status === 404, "nor download its model", json(r));

r = await browserResult(alice, job);
check(r.status === 200 && r.json?.status === "done", "the browser slice finishes", json(r));
r = await alice.get("/api/slices");
check(r.json?.some((s) => s.job_id === job && s.has_model), "its slice says the model is kept", json(r));

// ---- which defaults people change -------------------------------------------------
r = await owner.get("/api/reports/defaults?days=0");
check(r.status === 200 && r.json?.jobs >= 1, "admins get the defaults-changed report", json(r));
const bed = r.json?.settings?.find((st) => st.key === "bed_type");
check(bed?.changed >= 1 && bed?.to?.[0]?.[0] === "Textured PEI Plate", "the plate type is compared", json(r));
const supportsStat = r.json?.settings?.find((st) => st.key === "enable_support");
check(supportsStat?.jobs >= 1 && supportsStat?.changed === 0, "supports left on count as kept", json(r));
const nozzle = r.json?.settings?.find((st) => st.key === "nozzle");
check(nozzle?.jobs >= 1 && nozzle?.changed === 0, "the nozzle in the machine's name is compared", json(r));
r = await alice.get("/api/reports/defaults");
check(r.status === 403, "members don't", json(r));

// ---- models kept on this device ---------------------------------------------------
r = await jobForm(alice, [
  ["source", "browser"],
  ["local_models", JSON.stringify([{ name: "secret.stl", bytes: 1234, sha256: sha("secret") }])],
]);
check(r.status === 201 && r.json?.local_models === 1 && r.json?.model_count === 1 && r.json?.stored_bytes === 0, "a local-only model is named, not stored", json(r));
const localJob = r.json?.id;
r = await alice.get(`/api/jobs/${localJob}`);
check(r.json?.models?.[0]?.stored === false && r.json.models[0].sha256 === sha("secret"), "the job knows its digest", json(r));
r = await alice.get(`/api/jobs/${localJob}/models/0`);
check(r.status === 404 && /browser/.test(r.json?.error ?? ""), "and says where it is", json(r));
r = await jobForm(alice, [["source", "browser"], ["model_name", "old-page.stl"]]);
check(r.status === 201 && r.json?.local_models === 1, "older pages' model_name still works", json(r));
r = await jobForm(alice, [["source", "browser"], model(CUBE, "cube.stl"), ["local_models", "[]"], ["model_name", "x.stl"]]);
check(r.status === 400, "uploaded and local models don't mix", json(r));

// ---- refusals leave nothing behind ------------------------------------------------
let before = (await alice.get("/api/jobs")).json.length;
for (const [label, fields] of [
  ["a plate naming a model that wasn't sent", [model(CUBE, "a.stl"), ["plate", JSON.stringify({ objects: [{ model: 1 }] })]]],
  ["two models without a plate", [model(CUBE, "a.stl"), model(PEG, "b.stl")]],
  ["a model left off the plate", [model(CUBE, "a.stl"), model(PEG, "b.stl"), ["plate", JSON.stringify({ objects: [{ model: 0, placement: { rotation: ID, offset: [0, 0] } }] })]]],
  ["a proposal that isn't an object", [model(CUBE, "a.stl"), ["proposed", "[1,2]"]]],
  ["an unknown build plate", [model(CUBE, "a.stl"), ["bed_type", "Lava Plate"]]],
  ["G-code in the overrides", [model(CUBE, "a.stl"), ["overrides", JSON.stringify({ machine_start_gcode: "G28" })]]],
]) {
  r = await jobForm(alice, fields);
  check(r.status === 400, `refuses ${label}`, json(r));
}
check((await alice.get("/api/jobs")).json.length === before, "and creates no job");

// ---- deleting ----------------------------------------------------------------------
r = await alice.call("DELETE", `/api/jobs/${localJob}`);
check(r.status === 409 && /cancel/.test(r.json?.error ?? ""), "a job still slicing can't be deleted", json(r));
r = await alice.post(`/api/jobs/${localJob}/cancel`);
r = await alice.call("DELETE", `/api/jobs/${localJob}`);
check(r.status === 204, "once cancelled it can", json(r));
r = await alice.get(`/api/jobs/${localJob}`);
check(r.status === 404, "and it's gone", json(r));

r = await bob.call("DELETE", `/api/jobs/${job}`);
check(r.status === 404, "others can't delete what they can't see", json(r));

// A job in a shared group: a member sees it but may not delete it.
r = await owner.post("/api/groups", { name: "Club", settings: { shared_library: true } });
const club = r.json?.id;
for (const name of ["alice", "bob"]) {
  r = await owner.post(`/api/groups/${club}/members`, { username: name, role: "member" });
  check(r.status === 200 || r.status === 201, `${name} joins the club`, json(r));
}
r = await jobForm(alice, [["source", "browser"], model(CUBE, "club.stl"), ["group_id", club]]);
const clubJob = r.json?.id;
await browserResult(alice, clubJob);
r = await bob.get(`/api/jobs/${clubJob}`);
check(r.status === 200, "a club member sees the club's job", json(r));
r = await bob.call("DELETE", `/api/jobs/${clubJob}`);
check(r.status === 403, "but can't delete someone else's", json(r));

// A print waiting for approval needs the package: no deleting under it.
const HOT = "M104 S300\nG4 S36000\nM104 S0\n";
const sliceInfo = `<?xml version="1.0" encoding="UTF-8"?>
<config><plate>
  <metadata key="index" value="1"/>
  <metadata key="printer_model_id" value="BL-P001"/>
  <metadata key="nozzle_diameters" value="0.4"/>
  <metadata key="prediction" value="60"/>
  <metadata key="weight" value="1"/>
  <filament id="1" tray_info_idx="GFA00" type="PLA" color="#FF6A13" used_m="0.3" used_g="1"/>
</plate></config>`;
r = await owner.post("/api/printers", {
  name: "Bench X1C", machine_profile: "Bambu Lab X1 Carbon", nozzle_diameter: "0.4", protocol: "bambu",
  address: "127.0.0.1", serial_number: "00M00A000000000", access_code: "12345678",
});
const printer = r.json?.id;
r = await alice.form("/api/uploads", { file: [new Blob([zip({ "Metadata/plate_1.gcode": HOT, "Metadata/slice_info.config": sliceInfo })]), "hot.gcode.3mf"] });
const held = r.json?.id;
r = await alice.post(`/api/jobs/${held}/print`, { printer_id: printer });
check(r.status === 202 && r.json?.status === "pending_approval", "a send waits for approval", json(r));
const heldPrint = r.json?.id;
r = await alice.call("DELETE", `/api/jobs/${held}`);
check(r.status === 409 && /print/.test(r.json?.error ?? ""), "its job can't be deleted meanwhile", json(r));
r = await owner.post(`/api/prints/${heldPrint}/reject`, { note: "no" });
check(r.status === 200, "the print is rejected", json(r));

// Bulk: what may go goes, the rest says why.
r = await alice.post("/api/jobs/delete", { ids: [job, held, clubJob, "no-such-job"] });
check(r.status === 200, "bulk delete answers", json(r));
check(
  r.json?.deleted?.length === 3 && r.json.deleted.includes(job) && r.json.deleted.includes(held) && r.json.deleted.includes(clubJob),
  "her own jobs go (the rejected print no longer holds its job)",
  json(r),
);
check(r.json?.refused?.length === 1 && r.json.refused[0].id === "no-such-job", "unknown ids are reported", json(r));
r = await alice.get(`/api/jobs/${job}/model`);
check(r.status === 404, "the model went with it", json(r));
r = await alice.get("/api/slices");
check(!r.json?.some((s) => s.job_id === job), "and its slice", json(r));
r = await owner.get(`/api/prints/${heldPrint}`);
check(r.status === 200 && r.json?.job_id === null, "the print's history stays, without its job", json(r));

// Admins delete anyone's.
r = await jobForm(bob, [["source", "browser"], model(CUBE, "bob.stl")]);
const bobJob = r.json?.id;
await browserResult(bob, bobJob);
r = await owner.call("DELETE", `/api/jobs/${bobJob}`);
check(r.status === 204, "an admin deletes another user's job", json(r));

finish();
