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

finish();
