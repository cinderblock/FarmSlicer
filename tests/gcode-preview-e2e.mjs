#!/usr/bin/env node
// End-to-end test of the G-code behind job previews (src/preview_api.rs):
// `GET /api/jobs/{id}/gcode?plate=N` for plain G-code and for plates of a
// `.gcode.3mf` (deflated and stored), with and without gzip, who may fetch
// it, and the 404s.
//
//   node tests/gcode-preview-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup). Exit code 0 iff all
// checks pass. No dependencies beyond Node 22.
import { request } from "node:http";
import { gunzipSync } from "node:zlib";
import { BASE, check, Client, SoftAuthenticator, register, finish, zip } from "./lib.mjs";

console.log(`gcode preview e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);

/** GET without fetch's transparent decoding: status, headers and the raw body. */
function raw(client, path, encoding) {
  return new Promise((resolve, reject) => {
    const headers = { "accept-encoding": encoding };
    if (client?.cookie) headers.cookie = client.cookie;
    const req = request(BASE + path, { headers }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** The G-code as text, whichever encoding the server chose. */
const text = (r) => (r.headers["content-encoding"] === "gzip" ? gunzipSync(r.body) : r.body).toString("utf8");

// ---- accounts --------------------------------------------------------------------
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

// ---- fixtures --------------------------------------------------------------------
/** Plain G-code with Klipper's dialect and enough moves to be worth compressing. */
function layers(count, tag) {
  const lines = [`; generated for ${tag}`, "G90", "M83", "G28"];
  for (let l = 1; l <= count; l++) {
    const z = (l * 0.2).toFixed(2);
    lines.push(";LAYER_CHANGE", `;Z:${z}`, ";HEIGHT:0.2", `G1 Z${z} F600`, ";TYPE:Outer wall", ";WIDTH:0.45");
    for (let i = 0; i < 40; i++) lines.push(`G1 X${100 + (i % 10) * 2} Y${100 + Math.floor(i / 10) * 2} E0.05 F3000`);
  }
  lines.push("; filament_type = PLA", "; nozzle_diameter = 0.4", "; printer_model = Voron 2.4 350", "");
  return lines.join("\n");
}
const PLAIN = layers(30, "plain");
const PLATE1 = layers(20, "plate 1");
const PLATE2 = layers(25, "plate 2");
const sliceInfo = `<?xml version="1.0" encoding="UTF-8"?>
<config>
<plate><metadata key="index" value="1"/><metadata key="printer_model_id" value="BL-P001"/><metadata key="nozzle_diameters" value="0.4"/>
<filament id="1" tray_info_idx="GFA00" type="PLA" color="#FF6A13" used_m="4.1" used_g="12.5"/></plate>
<plate><metadata key="index" value="2"/><metadata key="printer_model_id" value="BL-P001"/><metadata key="nozzle_diameters" value="0.4"/>
<filament id="1" tray_info_idx="GFA00" type="PLA" color="#FF6A13" used_m="4.1" used_g="12.5"/></plate>
</config>`;

const upload = async (client, bytes, name) => {
  const res = await client.form("/api/uploads", { file: [new Blob([bytes]), name] });
  check(res.status === 201, `${name} uploads`, json(res));
  return res.json?.id;
};
const plainJob = await upload(ursula, PLAIN, "part.gcode");
const deflated = await upload(
  ursula,
  zip({ "Metadata/plate_1.gcode": PLATE1, "Metadata/plate_2.gcode": PLATE2, "Metadata/slice_info.config": sliceInfo }, { deflate: true }),
  "two-plates.gcode.3mf",
);
const stored = await upload(ursula, zip({ "Metadata/plate_1.gcode": PLATE1, "Metadata/slice_info.config": sliceInfo }), "stored.gcode.3mf");

// ---- plain G-code ------------------------------------------------------------------
r = await raw(ursula, `/api/jobs/${plainJob}/gcode`, "gzip");
check(r.status === 200 && r.headers["content-encoding"] === "gzip", "plain G-code is gzipped for clients that take it", `${r.status} ${JSON.stringify(r.headers)}`);
check(text(r) === PLAIN, "and is the uploaded file");
check(r.body.length < PLAIN.length / 3, "and much smaller", `${r.body.length} of ${PLAIN.length}`);
check(r.headers["x-gcode-bytes"] === String(PLAIN.length), "X-Gcode-Bytes is the uncompressed size", r.headers["x-gcode-bytes"]);
check(/text\/plain/.test(r.headers["content-type"]) && /filename="part\.gcode"/.test(r.headers["content-disposition"]), "named after the job", JSON.stringify(r.headers));
check(/accept-encoding/i.test(r.headers.vary ?? ""), "varies by Accept-Encoding", r.headers.vary);

r = await raw(ursula, `/api/jobs/${plainJob}/gcode`, "identity");
check(r.status === 200 && !r.headers["content-encoding"] && r.body.toString() === PLAIN, "and sent as it is otherwise", `${r.status}`);
check(r.headers["content-length"] === String(PLAIN.length), "with its length", r.headers["content-length"]);

r = await raw(ursula, `/api/jobs/${plainJob}/gcode?plate=1`, "gzip");
check(r.status === 200 && text(r) === PLAIN, "plate 1 of plain G-code is the file");
r = await raw(ursula, `/api/jobs/${plainJob}/gcode?plate=2`, "gzip");
check(r.status === 404, "plain G-code has no plate 2", `${r.status}`);

// ---- packages ----------------------------------------------------------------------
r = await raw(ursula, `/api/jobs/${deflated}/gcode`, "gzip");
check(r.status === 200 && text(r) === PLATE1, "a package's first plate by default", `${r.status}`);
check(
  r.headers["content-encoding"] === "gzip" && r.headers["content-length"] === String(r.body.length),
  "a deflated plate goes out as gzip with a known length (the archive's own bytes)",
  JSON.stringify(r.headers),
);
check(r.headers["x-gcode-bytes"] === String(PLATE1.length), "X-Gcode-Bytes for a plate", r.headers["x-gcode-bytes"]);
check(/filename="two-plates-plate1\.gcode"/.test(r.headers["content-disposition"]), "named after the plate", r.headers["content-disposition"]);
r = await raw(ursula, `/api/jobs/${deflated}/gcode?plate=2`, "gzip");
check(r.status === 200 && text(r) === PLATE2, "plate 2 on request", `${r.status}`);
r = await raw(ursula, `/api/jobs/${deflated}/gcode?plate=2`, "identity");
check(r.status === 200 && !r.headers["content-encoding"] && r.body.toString() === PLATE2, "inflated for clients without gzip", `${r.status}`);
r = await raw(ursula, `/api/jobs/${deflated}/gcode?plate=3`, "gzip");
check(r.status === 404 && /plate 3/.test(r.body.toString()), "no plate 3", `${r.status} ${r.body}`);

r = await raw(ursula, `/api/jobs/${stored}/gcode`, "gzip");
check(r.status === 200 && r.headers["content-encoding"] === "gzip" && text(r) === PLATE1, "a stored plate is gzipped on the way", `${r.status}`);
r = await raw(ursula, `/api/jobs/${stored}/gcode`, "gzip;q=0, identity");
check(r.status === 200 && !r.headers["content-encoding"] && r.body.toString() === PLATE1, "gzip;q=0 is respected", `${r.status}`);

// fetch() (what the browser's worker uses) decodes it transparently.
const res = await fetch(`${BASE}/api/jobs/${deflated}/gcode?plate=2`, { headers: { cookie: ursula.cookie } });
check(res.ok && (await res.text()) === PLATE2, "fetch() reads it like any response");

// ---- who may see it ------------------------------------------------------------------
r = await raw(victor, `/api/jobs/${plainJob}/gcode`, "gzip");
check(r.status === 404, "another user can't fetch a personal job's G-code", `${r.status}`);
r = await raw(victor, `/api/jobs/${deflated}/gcode?plate=2`, "gzip");
check(r.status === 404, "nor a plate of it", `${r.status}`);
r = await raw(owner, `/api/jobs/${deflated}/gcode?plate=2`, "gzip");
check(r.status === 200 && text(r) === PLATE2, "admins can", `${r.status}`);
r = await raw(null, `/api/jobs/${plainJob}/gcode`, "gzip");
check(r.status === 401, "signed-out requests are refused", `${r.status}`);

// ---- 404s ------------------------------------------------------------------------
r = await raw(ursula, "/api/jobs/00000000-0000-0000-0000-000000000000/gcode", "gzip");
check(r.status === 404, "unknown job", `${r.status}`);
r = await ursula.form("/api/jobs", { source: "browser", model_name: "part.stl", overrides: "{}" });
check(r.status === 201, "a browser job is created", json(r));
r = await raw(ursula, `/api/jobs/${r.json.id}/gcode`, "gzip");
check(r.status === 404 && /no G-code/.test(r.body.toString()), "a job that hasn't been sliced has no G-code", `${r.status} ${r.body}`);

finish();
