// The Slice page's work in progress, kept per browser tab so a reload (by
// hand, or for an update: appUpdate.ts) or leaving the page and coming back
// keeps the plate and settings. A tab's id lives in sessionStorage; its
// draft in IndexedDB (idb.ts `drafts`) as two records: `<id>:files` (the
// model files, written only when they change) and `<id>:state` (settings,
// plates, the last slice). Drafts of tabs not seen for DRAFT_TTL_MS go.

import type { PlateLayout } from "./engine/types";
import { request } from "./idb";

const TAB_KEY = "farmslicer.sliceDraft";
const DRAFT_TTL_MS = 3 * 24 * 3600_000;

/** The page's choices, as Slice.tsx keeps them (it owns the shape). */
export type DraftSettings = object;

export interface DraftState {
  /** The job this plate was opened from (`?from=`), if any. */
  from: string | null;
  settings: DraftSettings;
  /** The plates, indexing `files` in order. */
  plates: PlateLayout[];
}

interface StateRecord {
  key: string;
  savedAt: number;
  state: DraftState;
}

interface FilesRecord {
  key: string;
  savedAt: number;
  files: { name: string; type: string; lastModified: number; data: Blob }[];
}

/** This tab's draft id (sessionStorage survives reloads, not new tabs). */
export function tabDraftId(): string {
  let id = sessionStorage.getItem(TAB_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(TAB_KEY, id);
  }
  return id;
}

/** Identifies a set of model files without reading them. */
export function filesSignature(files: File[]): string {
  return JSON.stringify(files.map((f) => [f.name, f.size, f.lastModified]));
}

export async function loadDraft(id: string): Promise<{ state: DraftState; files: File[] } | null> {
  try {
    const state = await request<StateRecord | undefined>("drafts", (s) => s.get(`${id}:state`), "readonly");
    if (!state) return null;
    const stored = await request<FilesRecord | undefined>("drafts", (s) => s.get(`${id}:files`), "readonly");
    const files = (stored?.files ?? []).map(
      (f) => new File([f.data], f.name, { type: f.type, lastModified: f.lastModified }),
    );
    return { state: state.state, files };
  } catch {
    return null;
  }
}

export async function saveDraftState(id: string, state: DraftState): Promise<void> {
  const record: StateRecord = { key: `${id}:state`, savedAt: Date.now(), state };
  await request("drafts", (s) => s.put(record), "readwrite");
}

export async function saveDraftFiles(id: string, files: File[]): Promise<void> {
  const record: FilesRecord = {
    key: `${id}:files`,
    savedAt: Date.now(),
    files: files.map((f) => ({ name: f.name, type: f.type, lastModified: f.lastModified, data: f })),
  };
  await request("drafts", (s) => s.put(record), "readwrite");
}

/** Remove the drafts of tabs not saved for DRAFT_TTL_MS (other than `keep`). */
export async function pruneDrafts(keep: string): Promise<void> {
  try {
    const keys = (await request<IDBValidKey[]>("drafts", (s) => s.getAllKeys(), "readonly")).map(String);
    const ids = new Set(keys.map((k) => k.replace(/:(state|files)$/, "")));
    ids.delete(keep);
    for (const id of ids) {
      // A tab's state is saved most often; its files only when they change
      // (and may be saved just before its first state).
      const record =
        (await request<StateRecord | undefined>("drafts", (s) => s.get(`${id}:state`), "readonly")) ??
        (await request<FilesRecord | undefined>("drafts", (s) => s.get(`${id}:files`), "readonly"));
      if (record && Date.now() - record.savedAt < DRAFT_TTL_MS) continue;
      await request("drafts", (s) => s.delete(`${id}:state`), "readwrite");
      await request("drafts", (s) => s.delete(`${id}:files`), "readwrite");
    }
  } catch {
    // Nothing lost: they go next time.
  }
}
