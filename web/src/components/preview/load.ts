// Main-thread side of the G-code parser: one worker per file, progress
// callbacks, cancellation by AbortSignal (the worker is terminated).
//
//   const { result } = await loadGcode({ url: `/api/jobs/${id}/gcode` }, { onProgress });
//   const { result } = await loadGcode({ data: gcodeBytes }); // a slice in memory

import type { ParseRequest, ParseResponse, ParsedGcode } from "./types";

/** Where the G-code comes from: the server, or bytes/text the page already holds. */
export type GcodeSource = { url: string } | { data: Blob | ArrayBuffer | ArrayBufferView | string };

export interface LoadProgress {
  /** Bytes parsed. */
  done: number;
  /** Bytes in the file, when known. */
  total: number | null;
}

export interface Loaded {
  result: ParsedGcode;
  /** Download and parse, ms. */
  ms: number;
}

function request(source: GcodeSource): ParseRequest {
  if ("url" in source) return { type: "url", url: new URL(source.url, location.href).href };
  const data = source.data;
  // A Blob crosses to the worker without copying the bytes, and streams there.
  if (data instanceof Blob) return { type: "blob", blob: data };
  if (typeof data === "string") return { type: "blob", blob: new Blob([data]) };
  if (data instanceof ArrayBuffer) return { type: "blob", blob: new Blob([data]) };
  const view = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  return { type: "blob", blob: new Blob([view]) };
}

export function loadGcode(
  source: GcodeSource,
  options: { onProgress?: (p: LoadProgress) => void; signal?: AbortSignal } = {},
): Promise<Loaded> {
  const { onProgress, signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("cancelled", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const stop = () => {
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      stop();
      reject(new DOMException("cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (ev: MessageEvent<ParseResponse>) => {
      const msg = ev.data;
      if (msg.type === "progress") onProgress?.({ done: msg.done, total: msg.total });
      else if (msg.type === "done") {
        stop();
        resolve({ result: msg.result, ms: msg.ms });
      } else {
        stop();
        reject(new Error(msg.error));
      }
    };
    worker.onerror = (ev) => {
      stop();
      reject(new Error(ev.message || "the G-code reader failed"));
    };
    worker.postMessage(request(source));
  });
}
