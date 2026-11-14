#!/usr/bin/env node
// End-to-end test of 3MF models (src/model_check.rs): settings a 3MF carries
// per object and per part get the overrides' policy, a damaged package is
// refused, and a painted, multi-part 3MF the web app wrote is accepted with
// copies scaled and mirrored (src/placement.rs). The fixtures come from
// tests/fixtures/models/make.ts. The stub slicer is enough: the checks run
// when the job is made.
//
//   node tests/model-3mf-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup). Exit code 0 iff all
// checks pass. No dependencies beyond Node 22.
import { readFileSync } from "node:fs";
import { BASE, check, Client, SoftAuthenticator, register, finish } from "./lib.mjs";

console.log(`3MF model e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);
const fixture = (name) => new Blob([readFileSync(new URL(`./fixtures/models/${name}`, import.meta.url))]);

const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));
r = await owner.post("/api/users", { username: "mia", role: "user" });
const token = r.json.invite_url.split("/invite/")[1];
const member = new Client();
r = await register(member, new SoftAuthenticator(), `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "k");
check(r.status === 200, "member enrols", json(r));

// A painted cube, a knob on another filament and an infill modifier.
r = await member.form("/api/jobs", { model: [fixture("painted.3mf"), "painted.3mf"] });
check(r.status === 201, "members slice painted multi-part 3MFs", json(r));

// Its object sets wall_loops (anyone may), its modifier start G-code.
r = await member.form("/api/jobs", { model: [fixture("member-settings.3mf"), "settings.3mf"] });
check(r.status === 400 && /settings\.3mf: machine_start_gcode/.test(r.json?.error ?? ""), "a member's 3MF can't set start G-code", json(r));
r = await owner.form("/api/jobs", { model: [fixture("member-settings.3mf"), "settings.3mf"] });
check(r.status === 201, "an admin's may", json(r));

r = await member.form("/api/jobs", { model: [new Blob(["PK\u0003\u0004 not really a zip"]), "broken.3mf"] });
check(r.status === 400 && /broken\.3mf/.test(r.json?.error ?? ""), "a damaged 3MF is refused by name", json(r));

// Two copies: one twice as tall, one mirrored.
const plates = {
  plates: [
    {
      objects: [
        { model: 0, placement: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 2], offset: [-40, 0] } },
        { model: 0, placement: { rotation: [-1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [40, 0] } },
      ],
    },
  ],
};
r = await member.form("/api/jobs", { model: [fixture("painted.3mf"), "painted.3mf"], plates: JSON.stringify(plates) });
check(r.status === 201, "copies may be scaled and mirrored", json(r));
const stored = JSON.parse(r.json?.plate_json ?? "{}");
check(stored.plates?.[0]?.objects?.[0]?.placement?.rotation?.[8] === 2, "the scale is kept", r.json?.plate_json);

// Changes by height: kept with the job's inputs, handed to the browser engine.
/** A browser job of two filaments (`form` can't repeat a field). */
const twoFilamentJob = (changes) => {
  const fd = new FormData();
  fd.append("source", "browser");
  fd.append("model_name", "tower.stl");
  fd.append("filament", "Bambu PLA Basic @BBL X1C");
  fd.append("filament", "Bambu PLA Basic @BBL X1C");
  fd.append("height_changes", JSON.stringify(changes));
  return member.call("POST", "/api/jobs", fd);
};
r = await twoFilamentJob([
  { z: 10.2, kind: "filament", filament: 2 },
  { z: 20, kind: "pause" },
  { z: 30, kind: "swap" },
]);
check(r.status === 201, "a job with changes by height", json(r));
check(JSON.parse(r.json?.inputs_json ?? "{}").height_changes?.length === 3, "kept with its inputs", r.json?.inputs_json);
check(r.json?.slice_options?.height_changes?.[0]?.filament === 2, "the browser engine gets them", json(r));
r = await twoFilamentJob([{ z: 4, kind: "pause", plate: 1 }]);
check(r.status === 201 && r.json?.slice_options?.height_changes?.[0]?.plate === 1, "a change on one plate", json(r));
for (const [label, bad] of [
  ["a filament the job hasn't", [{ z: 5, kind: "filament", filament: 3 }]],
  ["no height", [{ z: 0, kind: "pause" }]],
  ["an unknown kind", [{ z: 5, kind: "gcode", filament: 1 }]],
  ["free-form G-code", [{ z: 5, kind: "pause", gcode: "M104 S300" }]],
  ["plate 0", [{ z: 5, kind: "pause", plate: 0 }]],
  ["a plate the job hasn't", [{ z: 5, kind: "pause", plate: 2 }]],
]) {
  r = await twoFilamentJob(bad);
  check(r.status === 400 && /height_changes/.test(r.json?.error ?? ""), `refuses ${label}`, json(r));
}

finish();
