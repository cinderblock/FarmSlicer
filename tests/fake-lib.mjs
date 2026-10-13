// Helpers for the fake printers (tests/fake-*/): a minimal WebSocket server
// (handshake, text frames, ping/pong; enough for one JSON message per frame)
// and a multipart/form-data parser. No dependencies beyond Node 22.
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ---- minimal WebSocket server framing --------------------------------------------
export function wsAccept(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buf = Buffer.alloc(0);
  const conn = {
    onText: () => {},
    onClose: () => {},
    send(text) {
      const payload = Buffer.from(text, "utf8");
      let head;
      if (payload.length < 126) head = Buffer.from([0x81, payload.length]);
      else if (payload.length < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x81;
        head[1] = 126;
        head.writeUInt16BE(payload.length, 2);
      } else {
        head = Buffer.alloc(10);
        head[0] = 0x81;
        head[1] = 127;
        head.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
    },
    close() {
      if (!socket.destroyed) socket.end(Buffer.from([0x88, 0]));
    },
  };
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = buf[1] & 0x80;
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const data = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < data.length; i++) data[i] ^= buf[maskOff + (i % 4)];
      buf = buf.subarray(off + len);
      if (op === 0x1) conn.onText(data.toString("utf8"));
      else if (op === 0x8) {
        conn.close();
        conn.onClose();
      } else if (op === 0x9) {
        // ping → pong
        const head = Buffer.from([0x8a, data.length]);
        if (!socket.destroyed) socket.write(Buffer.concat([head, data]));
      }
    }
  });
  socket.on("close", () => conn.onClose());
  socket.on("error", () => {});
  return conn;
}

// ---- multipart (just enough for Moonraker's upload form) ----------------------------
export function parseMultipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? "");
  if (!boundary) return {};
  const sep = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const fields = {};
  let pos = body.indexOf(sep);
  while (pos !== -1) {
    const start = pos + sep.length + 2;
    const next = body.indexOf(sep, start);
    if (next === -1) break;
    const part = body.subarray(start, next - 2);
    const headerEnd = part.indexOf("\r\n\r\n");
    const headers = part.subarray(0, headerEnd).toString();
    const content = part.subarray(headerEnd + 4);
    const name = /name="([^"]*)"/.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/.exec(headers)?.[1];
    if (name) fields[name] = filename !== undefined ? { filename, content } : content.toString();
    pos = next;
  }
  return fields;
}
