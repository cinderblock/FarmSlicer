// Web Worker: stream a G-code file (a URL, or a Blob the page already
// holds) through the parser, report progress, and hand the typed arrays to
// the page without copying them. One file per worker; the page terminates
// it to cancel.

import { GcodeParser, transferables } from "./parser";
import type { ParseRequest, ParseResponse } from "./types";

function post(msg: ParseResponse, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

/** The response body and its uncompressed size, when the server says. */
async function open(req: ParseRequest): Promise<{ stream: ReadableStream<Uint8Array>; total: number | null }> {
  if (req.type === "blob") return { stream: req.blob.stream(), total: req.blob.size };
  const res = await fetch(req.url, { credentials: "same-origin" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  if (!res.body) throw new Error("the response has no body");
  // fetch() inflates gzip itself, so Content-Length (compressed) isn't the
  // size we read; the server sends the real one in X-Gcode-Bytes.
  const declared = Number(res.headers.get("x-gcode-bytes"));
  const length = res.headers.get("content-encoding") ? NaN : Number(res.headers.get("content-length"));
  const total = declared > 0 ? declared : length > 0 ? length : null;
  return { stream: res.body, total };
}

self.onmessage = async (ev: MessageEvent<ParseRequest>) => {
  const started = performance.now();
  try {
    const { stream, total } = await open(ev.data);
    const parser = new GcodeParser();
    const reader = stream.getReader();
    let reported = 0;
    post({ type: "progress", done: 0, total });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(value);
      const now = performance.now();
      if (now - reported > 100) {
        reported = now;
        post({ type: "progress", done: parser.consumed, total });
      }
    }
    const result = parser.done();
    post({ type: "done", result, ms: performance.now() - started }, transferables(result));
  } catch (err) {
    post({ type: "error", error: err instanceof Error ? err.message : String(err) });
  }
};
