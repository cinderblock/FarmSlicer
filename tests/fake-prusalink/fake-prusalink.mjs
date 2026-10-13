#!/usr/bin/env node
// A fake Prusa printer's PrusaLink (Buddy firmware): the subset of its HTTP
// API FarmSlicer's driver uses, with the same shapes and rules
// (plans/printer-drivers/prusalink.md), and a print simulation fast enough
// for tests. There is no official emulator.
//
//   node tests/fake-prusalink/fake-prusalink.mjs [port] [--password PW] [--print-seconds N]
//
// or, from a test: `const fake = await startFakePrusaLink({ port, password })`.
//
// Speaks: GET /api/version, /api/v1/info, /api/v1/status (the job only
// while PRINTING / PAUSED / ATTENTION), /api/v1/job (204 without one),
// PUT /api/v1/files/usb/<path> (Content-Length required; Create-Folder;
// Overwrite; one transfer at a time; folders aren't made on upload),
// POST /api/v1/files/usb/<path> (start: 204 / 409), PUT /api/v1/job/<id>/
// pause|resume and DELETE /api/v1/job/<id> (404 for another id, 409 in the
// wrong state), GET /thumb/l/usb/<path> (the first PNG larger than 16x16
// in the first 2048 lines). Auth: X-Api-Key = the password, else 401 with
// a Digest challenge. Rules kept: job ids move on only when a print really
// starts; FINISHED / STOPPED stay until the screen is cleared or the next
// print starts. Test hooks: POST /__fake/attention (the next start waits
// for an answer on the screen), /__fake/answer, /__fake/clear (close the
// finish screen), /__fake/busy, /__fake/idle.
// No dependencies beyond Node 22.
import { createServer } from "node:http";

export async function startFakePrusaLink({ port = 0, password = "prusa-pw", printSeconds = 6, host = "127.0.0.1" } = {}) {
  const files = new Map(); // "usb/<path>" → Buffer; folders as null
  files.set("usb", null);
  let state = "IDLE";
  let jobId = 41;
  let job = null; // { id, path, elapsed }
  let attentionNext = false;
  let transfer = null;
  const printer = { temp_nozzle: 24, target_nozzle: 0, temp_bed: 23, target_bed: 0, speed: 100, flow: 100 };

  const TICK = 250;
  const timer = setInterval(() => {
    if (job && state === "PRINTING") {
      job.elapsed += TICK / 1000;
      if (job.elapsed >= printSeconds) {
        state = "FINISHED";
        job = null;
      }
    }
  }, TICK);

  const startPrint = (path) => {
    if (attentionNext) {
      // Held at the preview question: the old job id stays.
      attentionNext = false;
      state = "ATTENTION";
      job = { id: jobId, path, elapsed: 0, held: true };
      return;
    }
    jobId += 1;
    job = { id: jobId, path, elapsed: 0 };
    state = "PRINTING";
  };

  const json = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const empty = (res, code) => {
    res.writeHead(code);
    res.end();
  };
  const fail = (res, code, title, message) => json(res, code, { title, message });

  const thumbnail = (data) => {
    const lines = data.toString("utf8").split("\n").slice(0, 2048).join("\n");
    for (const m of lines.matchAll(/; thumbnail begin (\d+)x(\d+) \d+\n([\s\S]*?); thumbnail end/g)) {
      if (Number(m[1]) > 16 || Number(m[2]) > 16) return Buffer.from(m[3].replace(/^; ?/gm, "").replace(/\s/g, ""), "base64");
    }
    return null;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://fake");
    const path = decodeURIComponent(url.pathname);
    const hook = (name, f) => {
      if (path === `/__fake/${name}`) {
        f();
        json(res, 200, { ok: true, state });
        return true;
      }
      return false;
    };
    if (
      hook("attention", () => (attentionNext = true)) ||
      hook("answer", () => {
        if (state === "ATTENTION" && job) {
          jobId += 1;
          job = { id: jobId, path: job.path, elapsed: 0 };
          state = "PRINTING";
        }
      }) ||
      hook("clear", () => {
        if (state === "FINISHED" || state === "STOPPED") state = "IDLE";
      }) ||
      hook("busy", () => (state = "BUSY")) ||
      hook("idle", () => (state = "IDLE"))
    ) {
      return;
    }

    if (req.headers["x-api-key"] !== password) {
      res.writeHead(401, { "WWW-Authenticate": 'Digest realm="Printer API", nonce="0123456789abcdef", stale=false' });
      return res.end("Unauthorized");
    }

    // Uploads stream in; everything else is small.
    if (req.method === "PUT" && path.startsWith("/api/v1/files/usb/")) {
      const p = `usb/${path.slice("/api/v1/files/usb/".length)}`;
      const dir = p.slice(0, p.lastIndexOf("/"));
      if (req.headers["create-folder"] === "?1") {
        req.resume();
        if (files.has(p)) return fail(res, 409, "Conflict", "Already exists");
        files.set(p, null);
        return empty(res, 201);
      }
      if (req.headers["content-length"] === undefined) {
        req.resume();
        return fail(res, 411, "Length Required", "Content-Length required");
      }
      if (!/\.(gcode|gco|g|gc|bgcode|bgc)$/.test(p)) {
        req.resume();
        return fail(res, 415, "Unsupported Media Type", "Not a GCODE");
      }
      if (!files.has(dir)) {
        req.resume();
        return fail(res, 404, "Not Found", "Directory doesn't exist");
      }
      if (transfer) {
        req.resume();
        return fail(res, 409, "Conflict", "Another transfer in progress");
      }
      if (files.has(p) && req.headers.overwrite !== "?1") {
        req.resume();
        return fail(res, 409, "Conflict", "File already exists");
      }
      transfer = { size: Number(req.headers["content-length"]), got: 0 };
      const chunks = [];
      req.on("data", (c) => {
        chunks.push(c);
        transfer.got += c.length;
      });
      req.on("end", () => {
        transfer = null;
        files.set(p, Buffer.concat(chunks));
        const after = req.headers["print-after-upload"];
        if (after === "?1" || after === "1" || after === "true") {
          if (!["IDLE", "FINISHED", "STOPPED"].includes(state)) return fail(res, 409, "Conflict", "Can't print right now");
          startPrint(p);
        }
        empty(res, 201);
      });
      return;
    }

    req.resume();
    req.on("end", () => {
      if (path === "/api/version" && req.method === "GET") {
        return json(res, 200, { api: "2.0.0", server: "2.1.2", text: "PrusaLink", hostname: "prusa-mk4s", firmware: "6.10.1+0", printer: "1.4.1", capabilities: { "upload-by-put": true } });
      }
      if (path === "/api/v1/info") return json(res, 200, { nozzle_diameter: 0.4, mmu: false, serial: "FAKE0001", hostname: "prusa-mk4s", min_extrusion_temp: 170 });
      if (path === "/api/v1/status") {
        const body = { storage: { path: "/usb/", name: "usb", read_only: false }, printer: { state, ...printer } };
        if (job && ["PRINTING", "PAUSED", "ATTENTION"].includes(state)) {
          body.job = { id: job.id, progress: Math.min(100, (job.elapsed / printSeconds) * 100), time_remaining: Math.max(0, Math.round(printSeconds - job.elapsed)), time_printing: Math.round(job.elapsed) };
        }
        if (transfer) body.transfer = { id: 1, progress: (transfer.got / transfer.size) * 100, transferred: transfer.got };
        return json(res, 200, body);
      }
      if (path === "/api/v1/job" && req.method === "GET") {
        if (!job || !["PRINTING", "PAUSED", "ATTENTION"].includes(state)) return empty(res, 204);
        const display = job.path.split("/").pop();
        const sfn = display.slice(0, 6).toUpperCase() + "~1.GCO";
        return json(res, 200, {
          id: job.id,
          state: state === "ATTENTION" ? "PAUSED" : state,
          progress: Math.min(100, (job.elapsed / printSeconds) * 100),
          file: { name: sfn, display_name: display, path: "/usb/farmslicer", refs: { icon: `/thumb/s/${job.path}`, thumbnail: `/thumb/l/${job.path}`, download: `/${job.path}` } },
        });
      }
      const jobRoute = /^\/api\/v1\/job\/(\d+)(?:\/(pause|resume))?$/.exec(path);
      if (jobRoute) {
        if (!job || Number(jobRoute[1]) !== job.id) return fail(res, 404, "Not Found", "Job not found");
        const action = jobRoute[2];
        if (req.method === "PUT" && action === "pause") {
          if (state !== "PRINTING") return fail(res, 409, "Conflict", "Can't pause");
          state = "PAUSED";
          return empty(res, 204);
        }
        if (req.method === "PUT" && action === "resume") {
          if (state !== "PAUSED") return fail(res, 409, "Conflict", "Can't resume");
          state = "PRINTING";
          return empty(res, 204);
        }
        if (req.method === "DELETE" && !action) {
          if (!["PRINTING", "PAUSED", "ATTENTION"].includes(state)) return fail(res, 409, "Conflict", "Can't stop");
          state = "STOPPED";
          job = null;
          return empty(res, 204);
        }
        return fail(res, 400, "Bad Request", "Unknown action");
      }
      if (path.startsWith("/api/v1/files/usb/")) {
        const p = `usb/${path.slice("/api/v1/files/usb/".length)}`;
        if (!files.get(p)) return fail(res, 404, "Not Found", "File not found");
        if (req.method === "POST") {
          if (!["IDLE", "FINISHED", "STOPPED"].includes(state)) return fail(res, 409, "Conflict", "Can't print right now");
          startPrint(p);
          return empty(res, 204);
        }
        if (req.method === "GET" || req.method === "HEAD") return json(res, 200, { name: p.split("/").pop(), size: files.get(p).length });
      }
      if (path.startsWith("/thumb/l/")) {
        const data = files.get(path.slice("/thumb/l/".length));
        const png = data && thumbnail(data);
        if (!png) return fail(res, 404, "Not Found", "File doesn't contain preview");
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(png);
      }
      fail(res, 404, "Not Found", "Not found");
    });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    address: `${host}:${actualPort}`,
    password,
    files,
    get state() {
      return state;
    },
    /** Start a print as if from the printer's screen. */
    outsidePrint(path, data) {
      files.set(path, data);
      startPrint(path);
    },
    async close() {
      clearInterval(timer);
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
    },
  };
}

if (process.argv[1]?.endsWith("fake-prusalink.mjs")) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const fake = await startFakePrusaLink({
    port: Number(args.find((a) => /^\d+$/.test(a)) ?? 8080),
    host: opt("--host") ?? "0.0.0.0",
    password: opt("--password") ?? "prusa-pw",
    printSeconds: Number(opt("--print-seconds") ?? 30),
  });
  console.log(`fake PrusaLink on :${fake.port} (password ${fake.password})`);
}
