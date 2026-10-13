#!/usr/bin/env node
// A fake Elegoo Centauri Carbon speaking SDCP v3: the subset FarmSlicer's
// driver uses, with the shapes and codes of Elegoo's own clients
// (plans/printer-drivers/sdcp.md), and a print simulation fast enough for
// tests. There is no official emulator.
//
//   node tests/fake-sdcp/fake-sdcp.mjs [--ws 3030] [--http 80] [--video 3031] [--print-seconds N]
//
// or, from a test: `const fake = await startFakeSdcp({})` (random ports;
// `fake.address` is what to give FarmSlicer).
//
// Speaks: WebSocket /websocket (text `ping` → `pong`; envelopes with Cmd
// 0 status, 1 attributes, 128 start, 129 pause, 130 stop, 131 resume, 386
// camera, 403 speed/temperatures; answers on sdcp/response/<id>, status on
// sdcp/status/<id>), HTTP POST /uploadFile/upload (1 MiB multipart parts,
// whole-file MD5 checked after the last), GET /board-resource/history_image/
// <TaskId>.png (the file's last PNG thumbnail), and MJPEG on /video (one
// viewer). Kept from the real printer: status is pushed while printing but
// not while idle (some firmware stops), the file is "checked"
// (CurrentStatus 8) for a moment after an upload, PrintInfo.Status sticks
// after a job (9 complete, 8 stopped). And its fragility: an unknown
// command, or a start without Elegoo's exact payload, "crashes" the fake
// (every connection drops) and is recorded in `fake.crashes`.
// No dependencies beyond Node 22.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { parseMultipart, wsAccept } from "../fake-lib.mjs";

const KNOWN = new Set([0, 1, 128, 129, 130, 131, 386, 403]);
const START_KEYS = ["Calibration_switch", "Filename", "PrintPlatformType", "StartLayer", "Tlp_Switch"];

export async function startFakeSdcp({ printSeconds = 6, host = "127.0.0.1", wsPort = 0, httpPort = 0, videoPort = 0 } = {}) {
  const mainboard = "1c7319d30105041800009c0000000000";
  const files = new Map(); // "/local/<name>" → Buffer
  const uploads = new Map(); // Uuid → { chunks, got, total, md5, name }
  const history = new Map(); // TaskId → file path
  const crashes = [];
  const received = []; // every command, for tests
  const clients = new Set();
  const status = {
    CurrentStatus: [0],
    PreviousStatus: 0,
    TempOfHotbed: 25.0, TempTargetHotbed: 0,
    TempOfNozzle: 26.0, TempTargetNozzle: 0,
    TempOfBox: 24.0, TempTargetBox: 0,
    CurrentFanSpeed: { ModelFan: 0, AuxiliaryFan: 0, BoxFan: 0 },
    PrintInfo: { Status: 0, CurrentLayer: 0, TotalLayer: 0, CurrentTicks: 0, TotalTicks: 0, Filename: "", TaskId: "", PrintSpeedPct: 100, Progress: 0, ErrorNumber: 0 },
  };
  let job = null; // { elapsed }
  let checkingUntil = 0;

  const frame = (topic, body) => JSON.stringify({ ...body, MainboardID: mainboard, TimeStamp: Date.now(), Topic: `sdcp/${topic}/${mainboard}` });
  const pushStatus = () => {
    const msg = frame("status", { Status: structuredClone(status) });
    for (const c of clients) c.send(msg);
  };
  const crash = (why) => {
    crashes.push(why);
    for (const c of clients) c.close();
    clients.clear();
  };

  const timer = setInterval(() => {
    for (const [cur, tgt] of [["TempOfNozzle", "TempTargetNozzle"], ["TempOfHotbed", "TempTargetHotbed"]]) {
      const d = status[tgt] - status[cur];
      if (d) status[cur] = Math.round((status[cur] + Math.sign(d) * Math.min(Math.abs(d), 15)) * 10) / 10;
    }
    if (checkingUntil && Date.now() > checkingUntil) {
      checkingUntil = 0;
      status.CurrentStatus = [0];
    }
    const p = status.PrintInfo;
    if (job) {
      if (p.Status === 16 && (job.elapsed += 0.25) > 1) p.Status = 13; // preheating → printing
      else if (p.Status === 5) p.Status = 6; // pausing → paused
      else if (p.Status === 12) p.Status = 13; // resuming → printing
      else if (p.Status === 7) {
        p.Status = 8; // stopping → stopped
        status.CurrentStatus = [0];
        job = null;
      } else if (p.Status === 13) {
        job.elapsed += 0.25 * (p.PrintSpeedPct / 100);
        p.CurrentTicks = Math.min(p.TotalTicks, job.elapsed);
        p.Progress = Math.min(100, Math.round((job.elapsed / printSeconds) * 100));
        p.CurrentLayer = Math.min(p.TotalLayer, Math.ceil((p.Progress / 100) * p.TotalLayer));
        if (job.elapsed >= printSeconds) {
          p.Status = 9;
          status.CurrentStatus = [0];
          job = null;
        }
      }
    }
    // Pushes only while a task is on: idle pushes stop on some firmware.
    if (status.CurrentStatus.includes(1) || job) pushStatus();
  }, 250);

  const command = (cmd, data) => {
    received.push({ cmd, data });
    if (!KNOWN.has(cmd)) return crash(`unknown Cmd ${cmd}`);
    const p = status.PrintInfo;
    const busy = status.CurrentStatus.includes(1);
    switch (cmd) {
      case 0:
        setTimeout(pushStatus, 10);
        return { Ack: 0 };
      case 1:
        return { Ack: 0, Attributes: { Name: "Fake Carbon", MachineName: "Centauri Carbon", BrandName: "ELEGOO", ProtocolVersion: "V3.0.0", FirmwareVersion: "V1.1.46", MainboardID: mainboard, MaximumVideoStreamAllowed: 1, Capabilities: ["FILE_TRANSFER", "PRINT_CONTROL", "VIDEO_STREAM"] } };
      case 128: {
        const keys = Object.keys(data ?? {}).sort();
        if (JSON.stringify(keys) !== JSON.stringify(START_KEYS)) return crash(`start payload ${JSON.stringify(data)}`);
        if (busy || checkingUntil) return { Ack: 1 };
        const name = data.Filename.startsWith("/") ? data.Filename : `/local/${data.Filename}`;
        if (!files.has(name)) return { Ack: 2 };
        const task = randomUUID();
        history.set(task, name);
        job = { elapsed: 0 };
        status.CurrentStatus = [1];
        Object.assign(p, { Status: 16, Filename: name, TaskId: task, CurrentLayer: 0, TotalLayer: 20, CurrentTicks: 0, TotalTicks: printSeconds, Progress: 0, ErrorNumber: 0 });
        return { Ack: 0 };
      }
      case 129:
        if (busy && p.Status === 13) p.Status = 5;
        return { Ack: 0 };
      case 131:
        if (busy && p.Status === 6) p.Status = 12;
        return { Ack: 0 };
      case 130:
        if (busy) p.Status = 7;
        return { Ack: 0 };
      case 403:
        for (const k of Object.keys(data ?? {})) {
          if (!["PrintSpeedPct", "TempTargetNozzle", "TempTargetHotbed", "TempTargetBox", "TargetFanSpeed", "LightStatus"].includes(k)) {
            return crash(`403 key ${k}`);
          }
        }
        if (data.PrintSpeedPct !== undefined) p.PrintSpeedPct = data.PrintSpeedPct;
        if (data.TempTargetNozzle !== undefined) status.TempTargetNozzle = data.TempTargetNozzle;
        if (data.TempTargetHotbed !== undefined) status.TempTargetHotbed = data.TempTargetHotbed;
        return { Ack: 0 };
      case 386:
        return { Ack: 0, VideoUrl: `${host}:${video.address().port}/video` };
    }
  };

  // ---- WebSocket --------------------------------------------------------------------
  const ws = createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  ws.on("upgrade", (req, socket) => {
    if (new URL(req.url, "http://fake").pathname !== "/websocket") return socket.destroy();
    if (clients.size >= 5) {
      socket.end("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 17\r\n\r\ntoo many client\r\n");
      return;
    }
    const conn = wsAccept(req, socket);
    clients.add(conn);
    conn.onClose = () => clients.delete(conn);
    conn.onText = (text) => {
      if (text === "ping") return conn.send("pong");
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return crash(`not JSON: ${text.slice(0, 40)}`);
      }
      const d = msg?.Data ?? {};
      const result = command(d.Cmd, d.Data);
      if (!result) return;
      conn.send(frame("response", { Id: "", Data: { Cmd: d.Cmd, Data: result, RequestID: d.RequestID, MainboardID: mainboard, TimeStamp: Date.now() } }));
    };
  });

  // ---- HTTP: uploads, pictures ---------------------------------------------------------
  const thumbnail = (data) => {
    let last = null;
    for (const m of data.toString("utf8").matchAll(/; thumbnail begin \d+x\d+ \d+\n([\s\S]*?); thumbnail end/g)) {
      last = Buffer.from(m[1].replace(/^; ?/gm, "").replace(/\s/g, ""), "base64");
    }
    return last;
  };
  const http = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://fake");
      const reply = (body) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const failed = (field, message) => reply({ code: "111111", success: false, data: null, messages: [{ field, message }] });
      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<title>ELEGOO</title>");
      }
      if (url.pathname === "/uploadFile/upload" && req.method === "POST") {
        const f = parseMultipart(Buffer.concat(chunks), req.headers["content-type"]);
        if (!f.File?.filename) return failed("filename", "Cannot be empty");
        const total = Number(f.TotalSize);
        const up = uploads.get(f.Uuid) ?? { chunks: [], got: 0, total, md5: f["S-File-MD5"], name: f.File.filename };
        if (Number(f.Offset) !== up.got) return failed("common_field", -2);
        up.chunks.push(f.File.content);
        up.got += f.File.content.length;
        uploads.set(f.Uuid, up);
        if (up.got >= up.total) {
          uploads.delete(f.Uuid);
          const data = Buffer.concat(up.chunks);
          if (f.Check === "1" && createHash("md5").update(data).digest("hex") !== up.md5) return failed("common_field", -4);
          files.set(`/local/${up.name}`, data);
          // The printer checks the file for a moment.
          status.CurrentStatus = [8];
          checkingUntil = Date.now() + 1200;
        }
        return reply({ code: "000000", messages: null, data: {}, success: true });
      }
      const image = /^\/board-resource\/history_image\/(.+)\.png$/.exec(url.pathname);
      if (image) {
        const file = files.get(history.get(decodeURIComponent(image[1])));
        const png = file && thumbnail(file);
        if (!png) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(png);
      }
      res.writeHead(404);
      res.end();
    });
  });

  // ---- MJPEG camera (one viewer) -------------------------------------------------------
  const jpeg = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
  let viewers = 0;
  const video = createServer((req, res) => {
    if (new URL(req.url, "http://fake").pathname !== "/video") {
      res.writeHead(404);
      return res.end();
    }
    if (viewers >= 1) {
      res.writeHead(503);
      return res.end("too many viewers");
    }
    viewers += 1;
    res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=foo" });
    const t = setInterval(() => res.write(Buffer.concat([Buffer.from(`--foo\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), jpeg, Buffer.from("\r\n")])), 200);
    res.on("close", () => {
      clearInterval(t);
      viewers -= 1;
    });
  });

  const listen = (server, port) => new Promise((resolve) => server.listen(port, host, resolve));
  await Promise.all([listen(ws, wsPort), listen(http, httpPort), listen(video, videoPort)]);
  const ports = { ws: ws.address().port, http: http.address().port, video: video.address().port };
  return {
    ports,
    mainboard,
    address: `${host}:${ports.http}?ws=${ports.ws}&video=${ports.video}`,
    files,
    received,
    crashes,
    status,
    get viewers() {
      return viewers;
    },
    async close() {
      clearInterval(timer);
      for (const c of clients) c.close();
      await Promise.all([ws, http, video].map((s) => new Promise((resolve) => s.close(resolve))));
      for (const s of [ws, http, video]) s.closeAllConnections?.();
    },
  };
}

if (process.argv[1]?.endsWith("fake-sdcp.mjs")) {
  const args = process.argv.slice(2);
  const opt = (name, d) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : d;
  };
  const fake = await startFakeSdcp({
    host: opt("--host", "0.0.0.0"),
    wsPort: Number(opt("--ws", 3030)),
    httpPort: Number(opt("--http", 8080)),
    videoPort: Number(opt("--video", 3031)),
    printSeconds: Number(opt("--print-seconds", 30)),
  });
  console.log(`fake Centauri Carbon: ws ${fake.ports.ws}, http ${fake.ports.http}, video ${fake.ports.video}`);
}
