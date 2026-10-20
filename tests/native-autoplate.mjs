#!/usr/bin/env node
// Auto-plating against a server with libslic3r (src/autoplate.rs, slice_core
// arrange_models): a native image run with FARMSLICER_NO_AUTH=1 and the
// stock profiles. The e2e runner (a stub build) can't arrange; run this by
// hand after changing either:
//
//   docker run -d -p 127.0.0.1:9343:9337 -e FARMSLICER_NO_AUTH=1 farmslicer
//   node tests/native-autoplate.mjs http://127.0.0.1:9343
//
// Exit code 0 iff all checks pass.
const BASE = process.argv[2] ?? "http://127.0.0.1:9343";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cubeStl(size) {
  const v = [[0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0], [0, 0, size], [size, 0, size], [size, size, size], [0, size, size]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  let s = "solid cube\n";
  for (const [a, b, c] of faces) {
    s += "facet normal 0 0 0\n outer loop\n";
    for (const i of [a, b, c]) s += `  vertex ${v[i].join(" ")}\n`;
    s += " endloop\nendfacet\n";
  }
  return s + "endsolid cube\n";
}

const call = async (method, path, body) => {
  const form = body instanceof FormData;
  const r = await fetch(BASE + path, { method, headers: form || !body ? {} : { "content-type": "application/json" }, body: form ? body : body && JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function waitJob(id) {
  for (let i = 0; i < 600; i++) {
    const j = (await call("GET", `/api/jobs/${id}`)).json;
    if (!["queued", "slicing"].includes(j.status)) return j;
    await sleep(1000);
  }
}
let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures++;
};

async function run(label, machine, process, filament, size, wanted, half) {
  console.log(`== ${label}: ${wanted} × ${size} mm cube`);
  const fd = new FormData();
  fd.append("source", "server");
  fd.append("model", new Blob([cubeStl(size)]), "cube.stl");
  fd.append("machine", machine);
  fd.append("process", process);
  fd.append("filament", filament);
  let r = await call("POST", "/api/jobs", fd);
  check(r.status === 201, "recipe job created", JSON.stringify(r.json));
  const recipe = await waitJob(r.json.id);
  check(recipe.status === "done", "recipe sliced", recipe.error);
  r = await call("POST", "/api/projects", { name: `${label} order`, items: [{ job_id: recipe.id, model: 0, quantity: wanted }] });
  check(r.status === 201 && r.json.items[0].missing === wanted, `the project misses ${wanted}`, JSON.stringify(r.json?.items));
  const project = r.json.id;
  const t0 = Date.now();
  r = await call("POST", `/api/projects/${project}/autoplate`, { spacing: 4 });
  check(r.status === 200 && r.json.jobs.length === 1, `auto-plated in ${Date.now() - t0} ms`, JSON.stringify(r.json));
  const plated = r.json.jobs?.[0];
  console.log(`   -> ${plated?.plates} plate(s), ${plated?.copies} copies`);
  r = await call("GET", `/api/projects/${project}`);
  check(r.json.items[0].queued === wanted && r.json.items[0].missing === 0, "every missing copy is queued", JSON.stringify(r.json.items[0]));
  const job = await waitJob(plated.job_id);
  check(job.status === "done", "the auto-plated job slices", job.error);
  const pkg = JSON.parse(job.package_json ?? "null");
  check(pkg?.plates?.length === plated.plates, `the package has ${plated.plates} plates`, job.package_json?.slice(0, 200));
  const plates = job.plates ?? JSON.parse(job.plate_json).plates;
  let total = 0;
  plates.forEach((p, n) => {
    total += p.objects.length;
    const offs = p.objects.map((o) => o.placement.offset);
    const inside = offs.every(([x, y]) => Math.abs(x) + size / 2 <= half + 0.01 && Math.abs(y) + size / 2 <= half + 0.01);
    let overlap = false;
    for (let i = 0; i < offs.length; i++)
      for (let k = i + 1; k < offs.length; k++)
        if (Math.abs(offs[i][0] - offs[k][0]) < size + 3.9 && Math.abs(offs[i][1] - offs[k][1]) < size + 3.9) overlap = true;
    check(inside && !overlap, `plate ${n + 1}: ${offs.length} copies on the bed, ≥4 mm apart`, JSON.stringify(offs));
  });
  check(total === wanted, `${total} copies in all`);
  r = await call("GET", "/api/queue");
  check(r.json.entries.filter((e) => e.job_id === plated.job_id).length === plated.plates, "each plate queued once", "");
}

async function mixing() {
  console.log("== farm-wide plating and the mixing rule");
  const fd = new FormData();
  fd.append("source", "server");
  fd.append("model", new Blob([cubeStl(25)]), "small.stl");
  fd.append("machine", "Voron 2.4 350 0.4 nozzle");
  fd.append("process", "0.20mm Standard @Voron");
  fd.append("filament", "Generic PLA @System");
  let r = await call("POST", "/api/jobs", fd);
  const recipe = await waitJob(r.json.id);
  const order = async (name, client) =>
    (await call("POST", "/api/projects", { name, client_ref: client, items: [{ job_id: recipe.id, model: 0, quantity: 6 }] })).json.id;
  await call("PUT", "/api/settings", { mixing: "group" });
  await order("Mix A", "x");
  await order("Mix B", "y");
  r = await call("POST", "/api/queue/autoplate", {});
  check(r.status === 200 && r.json.jobs.length === 2 && r.json.jobs.every((j) => j.copies === 6), "different clients, mixing=group: a job each", JSON.stringify(r.json));
  await call("PUT", "/api/settings", { mixing: "any" });
  await order("Mix C", "x");
  await order("Mix D", "y");
  r = await call("POST", "/api/queue/autoplate", {});
  check(r.status === 200 && r.json.jobs.length === 1 && r.json.jobs[0].copies === 12 && r.json.jobs[0].projects.length === 2, "mixing=any: one job for both", JSON.stringify(r.json));
  const job = await waitJob(r.json.jobs[0].job_id);
  check(job.status === "done" && JSON.parse(job.package_json).plates.length === 1, "12 small parts of two projects on one plate, sliced", job.error);
  r = await call("POST", "/api/queue/autoplate", {});
  check(r.status === 409, "nothing left to plate", JSON.stringify(r.json));
}

await run("Voron", "Voron 2.4 350 0.4 nozzle", "0.20mm Standard @Voron", "Generic PLA @System", 60, 40, 175);
await mixing();
await run("X1C", "Bambu Lab X1 Carbon 0.4 nozzle", "0.20mm Standard @BBL X1C", "Bambu PLA Basic @BBL X1C", 30, 70, 128);
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
