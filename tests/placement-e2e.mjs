#!/usr/bin/env node
// End-to-end test of part placement (src/placement.rs): the orientation and
// position the Slice page's viewer sends with a job are checked, stored on
// the job and handed to the browser engine. A server built with
// FARMSLICER_SKIP_CXX is enough (the stub slicer fails server slices; the
// placement is stored before slicing starts).
//
//   node tests/placement-e2e.mjs http://localhost:9337
//
// The server must list that origin in FARMSLICER_ORIGINS. Exit code 0 iff all
// checks pass. No dependencies beyond Node 22.
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";

console.log(`placement e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);
const same = (a, b) => JSON.stringify(a?.rotation) === JSON.stringify(b.rotation) && JSON.stringify(a?.offset) === JSON.stringify(b.offset);

const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));

// 90° about X (the part stood up on its side), moved 40 mm left, 12 mm back.
const placement = { rotation: [1, 0, 0, 0, 0, -1, 0, 1, 0], offset: [-40, 12] };

r = await owner.form("/api/jobs", { source: "browser", model_name: "bracket.stl", placement: JSON.stringify(placement) });
check(r.status === 201, "browser job with a placement", json(r));
check(
  same(r.json?.slice_options?.placement, placement),
  "the browser engine gets the placement",
  json(r),
);
check(JSON.parse(r.json?.placement_json ?? "null")?.offset?.[0] === -40, "the job records it", json(r));
const browserJob = r.json?.id;

r = await owner.form("/api/jobs", { source: "browser", model_name: "bracket.stl" });
check(r.status === 201 && r.json?.slice_options?.placement === null, "no placement: centred as loaded", json(r));
check(r.json?.placement_json === null, "and none recorded", json(r));

const stl = new Blob(["solid cube\nendsolid cube\n"], { type: "model/stl" });
r = await owner.form("/api/jobs", { model: [stl, "cube.stl"], placement: JSON.stringify(placement) });
check(r.status === 201, "server job with a placement", json(r));
const serverJob = r.json?.id;
r = await owner.get("/api/jobs");
const listed = r.json?.find((j) => j.id === serverJob);
check(JSON.parse(listed?.placement_json ?? "null")?.rotation?.[5] === -1, "server job keeps its placement", JSON.stringify(listed));
check(!!r.json?.find((j) => j.id === browserJob)?.placement_json, "listed jobs carry it");

for (const [label, bad] of [
  ["a scaled matrix", { rotation: [2, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0] }],
  ["a mirror", { rotation: [-1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0] }],
  ["a sheared matrix", { rotation: [1, 0.3, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0] }],
  ["too few numbers", { rotation: [1, 0, 0, 0, 1, 0], offset: [0, 0] }],
  ["an absurd offset", { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 1e9] }],
  ["unknown fields", { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0], scale: 2 }],
]) {
  r = await owner.form("/api/jobs", { source: "browser", model_name: "x.stl", placement: JSON.stringify(bad) });
  check(r.status === 400 && /placement/.test(r.json?.error ?? ""), `refuses ${label}`, json(r));
}
r = await owner.form("/api/jobs", { source: "browser", model_name: "x.stl", placement: "{nope" });
check(r.status === 400, "refuses malformed JSON", json(r));

const before = (await owner.get("/api/jobs")).json?.length;
r = await owner.form("/api/jobs", { model: [stl, "cube.stl"], placement: JSON.stringify({ rotation: [0], offset: [0, 0] }) });
check(r.status === 400, "a server job with a bad placement is refused", json(r));
check((await owner.get("/api/jobs")).json?.length === before, "and creates no job");

finish();
