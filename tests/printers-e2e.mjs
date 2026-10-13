#!/usr/bin/env node
// End-to-end test of the printers API: admin-only management, the access
// code never leaving the server, and live status for a printer that can't be
// reached (nothing listens on 127.0.0.1:8883 in CI).
//
//   node tests/printers-e2e.mjs http://localhost:9337
//
// Needs a fresh server (it performs first-run setup). Exit code 0 iff all
// checks pass. No dependencies beyond Node 22.
import { deflateSync } from "node:zlib";
import { BASE, check, Client, SoftAuthenticator, register, finish, zip } from "./lib.mjs";

console.log(`printers e2e against ${BASE}`);

const json = (r) => JSON.stringify(r.json);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const owner = new Client();
let r = await register(owner, new SoftAuthenticator(), "/api/auth/setup/start", { username: "owner" }, "/api/auth/setup/finish", "k");
check(r.status === 200, "owner set up", json(r));

r = await owner.post("/api/users", { username: "ursula", role: "user" });
check(r.status === 201, "admin creates a user", json(r));
const token = r.json.invite_url.split("/invite/")[1];
const user = new Client();
r = await register(user, new SoftAuthenticator(), `/api/auth/invite/${token}/start`, {}, `/api/auth/invite/${token}/finish`, "k");
check(r.status === 200, "user enrols", json(r));

// ---- management is admin-only ------------------------------------------------------
r = await user.post("/api/printers", { name: "nope" });
check(r.status === 403, "users can't add printers", json(r));

r = await owner.post("/api/printers", { name: "  " });
check(r.status === 400, "a printer needs a name", json(r));

r = await owner.post("/api/printers", {
  name: "Bench X1C",
  machine_profile: "Bambu Lab X1 Carbon",
  nozzle_diameter: "0.4",
  protocol: "bambu",
  address: " 127.0.0.1 ",
  serial_number: "00M00A000000000",
  access_code: "12345678",
});
check(r.status === 201, "admin adds a printer", json(r));
const id = r.json.id;
check(r.json.access_code === undefined && r.json.access_code_set === true, "the access code is write-only", json(r));
check(r.json.address === "127.0.0.1", "fields are trimmed", json(r));

r = await owner.get("/api/printers");
check(!JSON.stringify(r.json).includes("12345678"), "no listing carries the access code", json(r));
check(r.json[0]?.serial_number === "00M00A000000000", "admins see the serial number", json(r));

r = await user.get("/api/printers");
check(r.status === 200 && r.json.length === 1, "users see the printer", json(r));
check(r.json[0].serial_number === null && !JSON.stringify(r.json).includes("12345678"), "users see neither serial nor code", json(r));

r = await user.patch(`/api/printers/${id}`, { name: "mine" });
check(r.status === 403, "users can't edit printers", json(r));
r = await user.del(`/api/printers/${id}`);
check(r.status === 403, "users can't remove printers", json(r));

r = await owner.patch(`/api/printers/${id}`, { name: "Bench X1 Carbon" });
check(r.status === 200 && r.json.name === "Bench X1 Carbon" && r.json.access_code_set, "edit keeps unspecified fields", json(r));
r = await owner.patch(`/api/printers/nope`, { name: "x" });
check(r.status === 404, "editing an unknown printer is 404", json(r));

// ---- live status ---------------------------------------------------------------------
let status;
for (let i = 0; i < 20; i++) {
  r = await user.get("/api/printers/status");
  status = r.json?.find((s) => s.printer_id === id);
  if (status?.connection_error) break;
  await sleep(250);
}
check(status && status.online === false && /8883/.test(status.connection_error ?? ""), "an unreachable printer reports why", JSON.stringify(status));

r = await user.get(`/api/printers/${id}/report`);
check(r.status === 403, "raw reports are admin-only", json(r));

// The event stream starts with a snapshot of every connected printer.
const ctl = new AbortController();
const res = await fetch(`${BASE}/api/printers/events`, { headers: { cookie: user.cookie }, signal: ctl.signal });
check(res.headers.get("content-type")?.startsWith("text/event-stream"), "events are server-sent", res.headers.get("content-type"));
const reader = res.body.getReader();
let text = "";
while (!text.includes("\n\n")) {
  const { value, done } = await reader.read();
  if (done) break;
  text += new TextDecoder().decode(value);
}
ctl.abort();
check(text.startsWith("event: status") && text.includes(id), "the stream opens with each printer's status", text.slice(0, 200));

// ---- sliced projects and sending ------------------------------------------------------
const sliceInfo = `<?xml version="1.0" encoding="UTF-8"?>
<config><plate>
  <metadata key="index" value="1"/>
  <metadata key="printer_model_id" value="BL-P001"/>
  <metadata key="nozzle_diameters" value="0.4"/>
  <metadata key="prediction" value="3600"/>
  <metadata key="weight" value="12.5"/>
  <filament id="1" tray_info_idx="GFA00" type="PLA" color="#FF6A13" used_m="4.1" used_g="12.5"/>
</plate></config>`;
const pkg = zip({
  "Metadata/plate_1.gcode": "G28\n",
  "Metadata/slice_info.config": sliceInfo,
  "Metadata/plate_1.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
});
r = await user.form("/api/uploads", { file: [new Blob([pkg]), "Bracket v2.gcode.3mf"] });
check(r.status === 201 && r.json.source === "upload" && r.json.status === "done", "a sliced project uploads as a finished job", json(r));
const jobId = r.json.id;
const plates = JSON.parse(r.json.package_json ?? "null")?.plates;
check(plates?.[0]?.printer_model_id === "BL-P001" && plates[0].filaments[0].material === "PLA", "the job knows what the plate needs", r.json.package_json);
check(r.json.filament_used_g === 12.5 && r.json.print_time_sec === 3600, "time and weight come from the project", json(r));

r = await user.form("/api/uploads", { file: [new Blob([zip({ "3D/3dmodel.model": "<model/>" })]), "raw.3mf"] });
check(r.status === 400 && /no G-code/.test(r.json.error), "an unsliced project is refused with advice", json(r));

const thumb = await fetch(`${BASE}/api/jobs/${jobId}/thumbnail`, { headers: { cookie: user.cookie } });
check(thumb.status === 200 && thumb.headers.get("content-type") === "image/png", "the plate thumbnail is served", String(thumb.status));

r = await owner.post("/api/printers", { name: "Bench A1 mini", machine_profile: "Bambu Lab A1 mini", nozzle_diameter: "0.4", protocol: "bambu" });
const mini = r.json.id;
r = await user.get(`/api/jobs/${jobId}/targets`);
const byName = Object.fromEntries((r.json?.targets ?? []).map((t) => [t.name, t]));
check(/X1 Carbon/.test(byName["Bench A1 mini"]?.incompatible ?? ""), "a plate for an X1 Carbon doesn't fit an A1 mini", json(r));
check(byName["Bench X1 Carbon"]?.incompatible === null && /offline|connected/.test(byName["Bench X1 Carbon"]?.busy ?? ""), "the X1 Carbon fits but is unreachable", json(r));

r = await user.post(`/api/jobs/${jobId}/print`, { printer_id: mini });
check(r.status === 409 && /sliced for/.test(r.json.error), "sending to an incompatible printer is refused", json(r));
r = await user.post(`/api/jobs/${jobId}/print`, { printer_id: id });
check(r.status === 409 && /offline/.test(r.json.error), "sending to an offline printer is refused", json(r));
r = await user.get("/api/prints");
check(r.status === 200 && r.json.length === 0, "refused sends leave no prints", json(r));

r = await owner.post(`/api/printers/${id}/control`, { action: "pause" });
check(r.status === 409, "controlling an offline printer fails cleanly", json(r));
r = await user.post(`/api/printers/${id}/control`, { action: "pause" });
check(r.status === 403, "printer-level control is admin-only", json(r));

// A browser slice uploads its sliced project with the G-code.
r = await user.form("/api/jobs", { source: "browser", model_name: "bracket.stl" });
check(r.status === 201 && r.json.slice_options && r.json.slice_options.model_name === "bracket.stl", "browser jobs say what to produce", json(r));
const browserJob = r.json.id;
r = await user.form(`/api/jobs/${browserJob}/result`, {
  gcode: [new Blob(["G28\n"]), "out.gcode"],
  package: [new Blob([pkg]), "out.gcode.3mf"],
  print_time_sec: "3600",
  filament_used_g: "12.5",
});
check(r.status === 200 && r.json.status === "done", "the browser result is filed", json(r));
check(JSON.parse(r.json.package_json ?? "null")?.plates?.length === 1, "the uploaded package makes the job sendable", r.json.package_json);

// Plain G-code from any slicer: one plate, described by the slicer's comments.
const gcodeText = [
  "; HEADER_BLOCK_START",
  "; generated by OrcaSlicer 2.4.2",
  "; HEADER_BLOCK_END",
  "",
  "; thumbnail begin 4x4 8",
  `; ${Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]).toString("base64")}`,
  "; thumbnail end",
  "",
  "G28",
  "G1 X10 Y10 E1",
  "; filament used [mm] = 1000.00",
  "; filament used [g] = 3.00",
  "; total filament used [g] = 3.00",
  "; estimated printing time (normal mode) = 10m 0s",
  "; CONFIG_BLOCK_START",
  "; filament_type = PETG",
  "; filament_colour = #00AE42",
  "; nozzle_diameter = 0.4",
  "; printer_model = Voron 2.4 350",
  "; CONFIG_BLOCK_END",
  "",
].join("\n");
r = await user.form("/api/uploads", { file: [new Blob([gcodeText]), "Clip.gcode"] });
check(r.status === 201 && r.json.status === "done", "plain G-code uploads as a finished job", json(r));
const gcodeJob = r.json.id;
const gcodePkg = JSON.parse(r.json.package_json ?? "null");
check(
  gcodePkg?.format === "gcode" && gcodePkg.plates[0].printer_model === "Voron 2.4 350" && gcodePkg.plates[0].filaments[0].material === "PETG",
  "the job knows what the G-code needs",
  r.json.package_json,
);
check(r.json.print_time_sec === 600 && r.json.filament_used_g === 3, "time and weight come from the G-code's comments", json(r));
const gcodeThumb = await fetch(`${BASE}/api/jobs/${gcodeJob}/thumbnail`, { headers: { cookie: user.cookie } });
check(gcodeThumb.status === 200 && gcodeThumb.headers.get("content-type") === "image/png", "the G-code's thumbnail is served", String(gcodeThumb.status));
r = await user.get(`/api/jobs/${gcodeJob}/targets`);
check(
  r.json?.format === "gcode" && /takes a sliced Bambu project/.test(r.json?.targets?.find((t) => t.name === "Bench X1 Carbon")?.incompatible ?? ""),
  "Bambu printers don't take plain G-code",
  json(r),
);
r = await user.form("/api/uploads", { file: [new Blob(["solid cube\nfacet normal 0 0 0\n"]), "cube.stl"] });
check(r.status === 400 && /doesn't look like G-code/.test(r.json.error), "a file that isn't G-code is refused", json(r));

// ---- cost estimates -----------------------------------------------------------------
r = await user.get("/api/prices");
check(r.status === 200 && r.json.currency === "$" && r.json.per_kg.PLA === 19.99, "default filament prices", json(r));
r = await user.get("/api/jobs");
check(r.json.find((j) => j.id === jobId)?.estimated_cost === 0.25, "12.5 g of PLA costs about $0.25", json(r));
r = await owner.call("PUT", "/api/settings", { filament_prices: { currency: "€", per_kg: { PLA: 40 }, default_per_kg: 30 } });
check(r.status === 200 && r.json.filament_prices.currency === "€", "admins set prices", json(r));
r = await user.get(`/api/jobs/${jobId}/targets`);
check(r.json.estimated_cost === 0.5 && r.json.currency === "€", "the send dialog gets the estimate", json(r));
r = await owner.call("PUT", "/api/settings", { filament_prices: { currency: "$", per_kg: { PLA: -1 }, default_per_kg: 1 } });
check(r.status === 400, "negative prices are refused", json(r));
r = await user.call("PUT", "/api/settings", { filament_prices: { currency: "$", per_kg: {}, default_per_kg: 1 } });
check(r.status === 403, "only admins set prices", json(r));

// ---- guide ------------------------------------------------------------------------------
r = await owner.call("PUT", "/api/settings", { guide_notes: "  Open 9-5.\n\nAsk at the desk.  " });
check(r.status === 200 && r.json.guide_notes === "Open 9-5.\n\nAsk at the desk.", "admins write the guide notes", json(r));
r = await user.get("/api/guide");
check(r.status === 200 && r.json.notes.startsWith("Open 9-5.") && r.json.print_rules, "everyone reads the guide", json(r));

// ---- areas, equipment reports, pre-heating --------------------------------------------
r = await owner.patch(`/api/printers/${id}`, { plate_type: "Glass" });
check(r.status === 400, "unknown build plates are refused", json(r));
r = await owner.patch(`/api/printers/${id}`, { plate_type: "Textured PEI Plate" });
check(r.status === 200 && r.json.plate_type === "Textured PEI Plate", "printers record their build plate", json(r));
r = await owner.patch(`/api/printers/${id}`, { area: " Bay 1 " });
check(r.status === 200 && r.json.area === "Bay 1", "printers have an area", json(r));
r = await user.post(`/api/printers/${id}/reports`, { description: "  " });
check(r.status === 400, "a report needs a description", json(r));
r = await user.post(`/api/printers/${id}/reports`, { description: "Nozzle clogged" });
check(r.status === 201, "anyone reports a problem", json(r));
const reportId = r.json.id;
r = await user.get("/api/printer-reports");
check(r.json.length === 1 && r.json[0].username === "ursula", "users see their own reports", json(r));
r = await user.post(`/api/printer-reports/${reportId}/resolve`);
check(r.status === 403, "only admins resolve reports", json(r));
r = await owner.post(`/api/printer-reports/${reportId}/resolve`);
check(r.status === 204, "an admin resolves the report", String(r.status));
r = await owner.get("/api/printer-reports?open=1");
check(r.json.length === 0, "no open reports left", json(r));
r = await user.post(`/api/printers/${id}/preheat`, { slot: 0 });
check(r.status === 409, "pre-heating needs a connected, idle printer", json(r));
r = await user.post(`/api/printers/${id}/cooldown`);
check(r.status === 409, "so does cooling down", json(r));

// ---- print rules and approval ----------------------------------------------------------
r = await owner.call("PUT", "/api/settings", { print_rules: { max_minutes: 30, materials: ["PETG"] } });
check(r.status === 200 && r.json.print_rules?.max_minutes === 30, "site print rules", json(r));
r = await user.get(`/api/jobs/${jobId}/targets`);
check(r.json?.needs_approval?.length === 2, "the dialog learns the plate needs approval", json(r));
r = await owner.get(`/api/jobs/${jobId}/targets`);
check(r.json?.needs_approval?.length === 0, "admins aren't held to the rules", json(r));
r = await user.post(`/api/jobs/${jobId}/print`, { printer_id: id });
check(r.status === 202 && r.json.status === "pending_approval" && /takes 1 h; the limit is 30 min/.test(r.json.approval_reason), "a send that breaks the rules waits for approval", json(r));
const pending = r.json.id;
r = await user.get("/api/prints?pending=1");
check(r.json.length === 1 && r.json[0].can_approve === false, "the requester sees it, can't approve it", json(r));
r = await user.post(`/api/prints/${pending}/approve`);
check(r.status === 403, "users can't approve", json(r));
r = await owner.get("/api/prints?pending=1");
check(r.json[0]?.can_approve === true, "admins can approve", json(r));
r = await owner.post(`/api/prints/${pending}/approve`);
check(r.status === 409 && /offline/.test(r.json.error), "approval checks the printer is free", json(r));
r = await owner.post(`/api/prints/${pending}/reject`, { note: "too long for a weekday" });
check(r.status === 200 && r.json.status === "rejected" && r.json.error === "rejected by owner: too long for a weekday", "an admin rejects it with a note", json(r));
r = await owner.post(`/api/prints/${pending}/approve`);
check(r.status === 409, "a decided request stays decided", json(r));
r = await user.post(`/api/jobs/${jobId}/print`, { printer_id: id });
const second = r.json.id;
r = await user.post(`/api/prints/${second}/reject`);
check(r.status === 200 && r.json.error === "withdrawn by ursula", "the requester withdraws their own request", json(r));
r = await owner.call("PUT", "/api/settings", { print_rules: {} });
check(r.status === 200, "site rules cleared", json(r));

// A printer that jobs were tagged with can still be removed.
r = await user.form("/api/jobs", { source: "browser", model_name: "tagged.stl", printer_id: mini });
check(r.status === 201, "a job tagged with a printer", json(r));
r = await owner.del(`/api/printers/${mini}`);
check(r.status === 204, "removing a printer that jobs reference works", String(r.status));

// ---- thumbnail overlays ------------------------------------------------------------
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
r = await owner.post("/api/groups", { name: "Team 42", settings: { thumbnail_label: "#{group}" } });
check(r.status === 201, "a group with a thumbnail label", json(r));
const team = r.json.id;
r = await owner.get(`/api/groups/${team}/overlay`);
check(r.json?.label === "#Team 42" && r.json.logo_group === null, "the label template is filled in", json(r));
r = await owner.post("/api/groups", { name: "Too long", settings: { thumbnail_label: "x".repeat(65) } });
check(r.status === 400, "labels are limited", json(r));
const logoForm = (bytes) => {
  const f = new FormData();
  f.append("file", new Blob([bytes]), "logo.png");
  return f;
};
r = await user.call("PUT", `/api/groups/${team}/logo`, logoForm(png(600, 300)));
check(r.status === 403, "only managers set a group's logo", json(r));
r = await owner.call("PUT", `/api/groups/${team}/logo`, logoForm(Buffer.from("not an image")));
check(r.status === 400, "a non-image logo is refused", json(r));
r = await owner.call("PUT", `/api/groups/${team}/logo`, logoForm(png(600, 300)));
check(r.status === 200, "a manager sets the logo", json(r));
r = await owner.post("/api/groups", { name: "Sub", parent_id: team });
const sub = r.json.id;
r = await owner.get(`/api/groups/${sub}/overlay`);
check(r.json?.label === "#Sub" && r.json.logo_group === team, "subgroups inherit the label and the logo", json(r));
const logo = await fetch(`${BASE}/api/groups/${team}/logo`, { headers: { cookie: user.cookie } });
const logoBytes = Buffer.from(await logo.arrayBuffer());
check(logo.status === 200 && logoBytes.readUInt32BE(16) === 256 && logoBytes.readUInt32BE(20) === 128, "logos are stored shrunk to 256 px", `${logo.status} ${logoBytes.length}`);
r = await owner.del(`/api/groups/${team}/logo`);
check(r.status === 204, "a manager removes the logo", String(r.status));

// Clearing the access code disconnects the printer.
r = await owner.patch(`/api/printers/${id}`, { access_code: "" });
check(r.status === 200 && r.json.access_code_set === false, "admin clears the access code", json(r));
r = await user.get("/api/printers/status");
check(!r.json.some((s) => s.printer_id === id), "a printer without an access code isn't connected", json(r));

r = await owner.del(`/api/printers/${id}`);
check(r.status === 204, "admin removes the printer", String(r.status));

finish();
