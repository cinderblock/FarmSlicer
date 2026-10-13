#!/usr/bin/env node
// A fake OctoPrint: the subset of its API FarmSlicer's driver uses, with the
// same shapes (plans/printer-drivers/octoprint.md), and a print simulation
// fast enough for tests. For conformance against the real thing, see the
// Dockerfile here (OctoPrint + its Virtual Printer).
//
//   node tests/fake-octoprint/fake-octoprint.mjs [port] [--api-key KEY] [--print-seconds N]
//
// or, from a test: `const fake = await startFakeOctoPrint({ port, apiKey })`.
//
// Speaks: POST /api/login (passive), GET /api/printer (409 while the serial
// link is down), GET /api/job, POST /api/job (pause/resume/cancel),
// POST /api/files/local (multipart upload into a folder),
// GET|POST /api/files/local/<path> (info with the Slicer Thumbnails
// plugin's `thumbnail`; select + print), POST /api/printer/printhead
// (feedrate), /api/printer/tool and /bed (targets), GET /api/settings
// (webcam), and the push socket /sockjs/websocket (subscribe, auth,
// `current` + `event` messages). Quirks kept: the file stays selected after
// a print; a cancel sends PrintCancelled and then PrintFailed{reason:
// "cancelled"}; select+print answers 409 while busy. Test hooks:
// POST /__fake/disconnect (the printer's serial link drops),
// /__fake/reconnect, /__fake/outside-print, /__fake/fail.
// No dependencies beyond Node 22.
import { createServer } from "node:http";
import { parseMultipart, wsAccept } from "../fake-lib.mjs";

export async function startFakeOctoPrint({ port = 0, apiKey = "FARMSLICERTESTKEY", printSeconds = 6, host = "127.0.0.1" } = {}) {
  const files = new Map(); // path → { data, userdata, thumbnail }
  const feedrates = []; // feedrate factors received, as sent (to catch floats)
  const clients = new Set();
  const flags = () => ({
    operational: serial,
    printing: job?.state === "printing",
    pausing: false,
    paused: job?.state === "paused",
    cancelling: false,
    finishing: false,
    resuming: false,
    error: error !== "",
    closedOrError: !serial || error !== "",
    ready: serial && !job && error === "",
    sdReady: true,
  });
  let serial = true;
  let error = "";
  let selected = null; // path
  let job = null; // { path, state, elapsed }
  let completion = null;
  const temps = { tool0: { actual: 21.3, target: 0 }, bed: { actual: 21.3, target: 0 } };

  const stateText = () =>
    !serial ? "Offline" : error ? "Error" : job?.state === "paused" ? "Paused" : job ? "Printing" : "Operational";
  const jobBody = () => ({
    job: {
      file: selected
        ? { name: selected.split("/").pop(), display: selected.split("/").pop(), path: selected, origin: "local", size: files.get(selected)?.data.length ?? 0 }
        : { name: null, path: null, origin: null, size: null },
      estimatedPrintTime: null,
      filament: null,
      user: "admin",
    },
    progress: {
      completion,
      printTime: job ? Math.round(job.elapsed) : null,
      printTimeLeft: job ? Math.max(0, Math.round(printSeconds - job.elapsed)) : null,
      printTimeLeftOrigin: "linear",
    },
    state: stateText(),
  });
  const current = () => ({
    current: {
      // After the job body: its `state` is a string; here it's the object.
      ...jobBody(),
      state: { text: stateText(), flags: flags(), error },
      temps: [{ time: Date.now() / 1000, ...structuredClone(temps) }],
      logs: [],
      messages: [],
    },
  });
  const send = (msg) => {
    for (const c of clients) if (c.authed) c.send(JSON.stringify(msg));
  };
  const event = (type, payload = {}) => send({ event: { type, payload } });
  const fileEvent = (path) => ({ name: path.split("/").pop(), path, origin: "local" });

  const startPrint = (path) => {
    selected = path;
    job = { path, state: "printing", elapsed: 0 };
    completion = 0;
    event("PrintStarted", fileEvent(path));
  };
  const finish = (type, extra = {}) => {
    const path = job.path;
    job = null;
    if (type === "PrintDone") {
      completion = 100;
      event("PrintDone", { ...fileEvent(path), time: printSeconds });
    } else if (type === "cancel") {
      completion = null;
      event("PrintCancelled", fileEvent(path));
      event("PrintFailed", { ...fileEvent(path), reason: "cancelled" });
    } else {
      completion = null;
      event("PrintFailed", { ...fileEvent(path), reason: "error", ...extra });
    }
  };

  const TICK = 250;
  const timer = setInterval(() => {
    for (const t of Object.values(temps)) {
      const d = t.target - t.actual;
      if (d !== 0) t.actual = Math.round((t.actual + Math.sign(d) * Math.min(Math.abs(d), 10)) * 10) / 10;
    }
    if (job?.state === "printing") {
      job.elapsed += TICK / 1000;
      completion = Math.min(100, (job.elapsed / printSeconds) * 100);
      if (completion >= 100) finish("PrintDone");
    }
    send(current());
  }, TICK);

  const json = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const noContent = (res) => {
    res.writeHead(204);
    res.end();
  };
  const conflict = (res, msg) => json(res, 409, { error: msg });

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://fake");
      const path = decodeURIComponent(url.pathname);
      const raw = Buffer.concat(chunks);
      let body = {};
      if ((req.headers["content-type"] ?? "").startsWith("application/json")) {
        try {
          body = JSON.parse(raw.toString() || "{}");
        } catch {
          return json(res, 400, { error: "bad JSON" });
        }
      }
      // Test hooks.
      if (path === "/__fake/disconnect") {
        serial = false;
        if (job) finish("error", { error: "Connection lost" });
        event("Disconnected", {});
        return json(res, 200, { ok: true });
      }
      if (path === "/__fake/reconnect") {
        serial = true;
        error = "";
        return json(res, 200, { ok: true });
      }
      if (path === "/__fake/fail") {
        error = "Heater failure";
        if (job) finish("error", { error: "Heater failure" });
        return json(res, 200, { ok: true });
      }
      if (path === "/__fake/outside-print") {
        const p = "Outside_Print.gcode";
        files.set(p, { data: Buffer.from("G28\n"), thumbnail: Buffer.from("89504e470d0a1a0a6f63746f2d6f757473696465", "hex") });
        if (job) finish("cancel");
        startPrint(p);
        return json(res, 200, { ok: true });
      }
      if (path.startsWith("/plugin/prusaslicerthumbnails/thumbnail/")) {
        const f = files.get(path.slice("/plugin/prusaslicerthumbnails/thumbnail/".length).replace(/\.png$/, ".gcode"));
        if (!f?.thumbnail) return json(res, 404, { error: "Not found" });
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(f.thumbnail);
      }

      if (req.headers["x-api-key"] !== apiKey) return json(res, 403, { error: "You don't have the permission to access the requested resource." });

      if (path === "/api/login" && req.method === "POST") {
        if (!body.passive) return json(res, 400, { error: "not passive" });
        return json(res, 200, { name: "admin", session: "fakesession", active: true, admin: true });
      }
      if (path === "/api/printer" && req.method === "GET") {
        if (!serial) return conflict(res, "Printer is not operational");
        return json(res, 200, { state: { text: stateText(), flags: flags(), error }, temperature: temps, sd: { ready: true } });
      }
      if (path === "/api/job" && req.method === "GET") return json(res, 200, jobBody());
      if (path === "/api/job" && req.method === "POST") {
        if (body.command === "pause") {
          if (!job) return conflict(res, "Printer is neither printing nor paused, 'pause' command cannot be performed");
          const action = body.action ?? "toggle";
          if (action === "pause" || (action === "toggle" && job.state === "printing")) {
            if (job.state === "printing") {
              job.state = "paused";
              event("PrintPaused", fileEvent(job.path));
            }
          } else if (job.state === "paused") {
            job.state = "printing";
            event("PrintResumed", fileEvent(job.path));
          }
          return noContent(res);
        }
        if (body.command === "cancel") {
          if (!job) return conflict(res, "Printer is neither printing nor paused, 'cancel' command cannot be performed");
          finish("cancel");
          return noContent(res);
        }
        if (body.command === "start") {
          // The selected-file trap: starts whatever is still selected.
          if (job) return conflict(res, "Printer is already printing, did you mean 'restart'?");
          if (!selected) return conflict(res, "No file selected");
          startPrint(selected);
          return noContent(res);
        }
        return json(res, 400, { error: "unknown command" });
      }
      if (path === "/api/files/local" && req.method === "POST") {
        const form = parseMultipart(raw, req.headers["content-type"]);
        if (!form.file?.filename) return json(res, 400, { error: "No file to upload" });
        const dir = typeof form.path === "string" && form.path ? `${form.path.replace(/\/$/, "")}/` : "";
        const p = dir + form.file.filename;
        if (job?.path === p) return conflict(res, "Trying to overwrite file that is currently being printed");
        const text = form.file.content.toString("utf8");
        const thumb = /; thumbnail begin \d+x\d+ \d+\n([\s\S]*?); thumbnail end/.exec(text);
        files.set(p, {
          data: form.file.content,
          userdata: form.userdata ? JSON.parse(form.userdata) : undefined,
          thumbnail: thumb ? Buffer.from(thumb[1].replace(/^; ?/gm, "").replace(/\s/g, ""), "base64") : undefined,
        });
        event("FileAdded", { storage: "local", path: p, name: form.file.filename, type: ["machinecode", "gcode"] });
        return json(res, 201, { done: true, effectivePrint: false, effectiveSelect: false, files: { local: { name: form.file.filename, origin: "local", path: p } } });
      }
      if (path.startsWith("/api/files/local/")) {
        const p = path.slice("/api/files/local/".length);
        const f = files.get(p);
        if (!f) return json(res, 404, { error: "File not found" });
        if (req.method === "GET") {
          return json(res, 200, {
            name: p.split("/").pop(),
            path: p,
            origin: "local",
            size: f.data.length,
            userdata: f.userdata,
            ...(f.thumbnail ? { thumbnail: `plugin/prusaslicerthumbnails/thumbnail/${p.replace(/\.gcode$/, ".png")}?20261013` } : {}),
            refs: { resource: `/api/files/local/${p}` },
          });
        }
        if (req.method === "POST" && body.command === "select") {
          if (!serial) return conflict(res, "Printer is not operational");
          if (job) return conflict(res, "Printer is already printing or paused");
          selected = p;
          if (body.print) startPrint(p);
          return noContent(res);
        }
      }
      if (path === "/api/printer/printhead" && req.method === "POST") {
        if (!serial) return conflict(res, "Printer is not operational");
        feedrates.push(body.factor);
        return noContent(res);
      }
      if ((path === "/api/printer/tool" || path === "/api/printer/bed") && req.method === "POST") {
        if (!serial) return conflict(res, "Printer is not operational");
        if (path.endsWith("tool")) for (const [k, v] of Object.entries(body.targets ?? {})) if (temps[k]) temps[k].target = v;
        if (path.endsWith("bed")) temps.bed.target = body.target;
        return noContent(res);
      }
      if (path === "/api/settings") {
        return json(res, 200, { webcam: { webcamEnabled: true, streamUrl: "/webcam/?action=stream", snapshotUrl: "http://127.0.0.1:8080/?action=snapshot", webcams: [] } });
      }
      json(res, 404, { error: "Not found" });
    });
  });

  server.on("upgrade", (req, socket) => {
    if (new URL(req.url, "http://fake").pathname !== "/sockjs/websocket") return socket.destroy();
    if (req.headers.origin) {
      // OctoPrint checks Origin against the host when it's sent.
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const conn = wsAccept(req, socket);
    clients.add(conn);
    conn.onClose = () => clients.delete(conn);
    conn.onText = (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.auth) {
        if (msg.auth !== "admin:fakesession") return conn.send(JSON.stringify({ reauthRequired: { reason: "stale" } }));
        conn.authed = true;
        conn.send(JSON.stringify({ connected: { version: "1.11.8-fake" } }));
        conn.send(JSON.stringify({ history: current().current }));
      }
    };
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    address: `${host}:${actualPort}`,
    apiKey,
    files,
    feedrates,
    temps,
    async close() {
      clearInterval(timer);
      for (const c of clients) c.close();
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
    },
  };
}

if (process.argv[1]?.endsWith("fake-octoprint.mjs")) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const fake = await startFakeOctoPrint({
    port: Number(args.find((a) => /^\d+$/.test(a)) ?? 5000),
    host: opt("--host") ?? "0.0.0.0",
    apiKey: opt("--api-key") ?? "FARMSLICERTESTKEY",
    printSeconds: Number(opt("--print-seconds") ?? 30),
  });
  console.log(`fake OctoPrint on :${fake.port} (API key ${fake.apiKey})`);
}
