// Models kept in this browser only ("keep on this device"): a job names
// them by SHA-256, and this IndexedDB store holds the files so the job can be
// sliced again from this browser. The server never sees them.

import { request } from "./idb";

interface StoredModel {
  sha256: string;
  name: string;
  data: Blob;
  savedAt: number;
}

/** A file's SHA-256, hex. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const digests = new WeakMap<Blob, Promise<string>>();

/** `sha256Hex`, worked out once per file object (the Slice page asks on every change). */
export function fileDigest(file: Blob): Promise<string> {
  let d = digests.get(file);
  if (!d) {
    d = sha256Hex(file);
    digests.set(file, d);
  }
  return d;
}

/** Keep a model in this browser; returns its digest. */
export async function saveLocalModel(file: File): Promise<string> {
  const sha256 = await sha256Hex(file);
  const entry: StoredModel = { sha256, name: file.name, data: file, savedAt: Date.now() };
  await request("models", (s) => s.put(entry), "readwrite");
  return sha256;
}

/** A model this browser kept, or null. */
export async function loadLocalModel(sha256: string): Promise<File | null> {
  try {
    const entry = await request<StoredModel | undefined>("models", (s) => s.get(sha256), "readonly");
    return entry ? new File([entry.data], entry.name) : null;
  } catch {
    return null;
  }
}

/** Is the model in this browser? */
export async function hasLocalModel(sha256: string): Promise<boolean> {
  try {
    return (await request<number>("models", (s) => s.count(sha256), "readonly")) > 0;
  } catch {
    return false;
  }
}

/** Forget a model (when its job is deleted). */
export async function deleteLocalModel(sha256: string): Promise<void> {
  await request("models", (s) => s.delete(sha256), "readwrite").catch(() => {});
}
