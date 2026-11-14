// Labels on jobs, projects, printers and groups (src/labels.rs): the ones
// this account sees and what they're on, shared by every list through a
// tiny store so a change shows everywhere at once.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { apiJson } from "./auth";

export type LabelKind = "job" | "project" | "printer" | "group";
export type LabelScope = "site" | "group" | "user";

export interface Label {
  id: string;
  name: string;
  color: string;
  scope: LabelScope;
  owner_id: string;
  /** The group's path, for group labels. */
  owner_name: string | null;
  can_manage: boolean;
}

export interface LabelsData {
  labels: Label[];
  /** kind → item id → label ids */
  links: Partial<Record<LabelKind, Record<string, string[]>>>;
  colors: string[];
  can_make_site: boolean;
  /** Groups the caller may make labels in. */
  groups: { id: string; path: string }[];
}

let data: LabelsData | undefined;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Fetch (again) and tell every component. */
export async function reloadLabels(): Promise<void> {
  const res = await fetch("/api/labels");
  if (res.ok) {
    data = (await res.json()) as LabelsData;
    emit();
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The labels this account sees, loaded once and kept current. */
export function useLabels(): LabelsData | undefined {
  const snapshot = useSyncExternalStore(subscribe, () => data);
  useEffect(() => {
    if (!data && !loading) {
      loading = reloadLabels().finally(() => {
        loading = null;
      });
    }
  }, []);
  return snapshot;
}

/** The labels on one item, in name order. */
export function labelsOn(d: LabelsData | undefined, kind: LabelKind, id: string): Label[] {
  const ids = d?.links[kind]?.[id] ?? [];
  return (d?.labels ?? []).filter((l) => ids.includes(l.id));
}

/** Item ids of `kind` that carry every label in `filter` (empty = no filter: undefined). */
export function useLabelFilter(kind: LabelKind, filter: string[]): Set<string> | undefined {
  const d = useLabels();
  return useMemo(() => {
    if (filter.length === 0 || !d) return undefined;
    const out = new Set<string>();
    for (const [id, ids] of Object.entries(d.links[kind] ?? {})) {
      if (filter.every((f) => ids.includes(f))) out.add(id);
    }
    return out;
  }, [d, kind, filter]);
}

export async function setLabel(labelId: string, kind: LabelKind, targetId: string, on: boolean) {
  await apiJson(`/api/labels/${labelId}/items`, "PUT", { kind, target_id: targetId, on });
  await reloadLabels();
}

export async function createLabel(body: { name: string; color: string; scope: LabelScope; group_id?: string }) {
  const made = await apiJson<Label>("/api/labels", "POST", body);
  await reloadLabels();
  return made;
}

export async function updateLabel(id: string, body: { name: string; color: string }) {
  await apiJson(`/api/labels/${id}`, "PUT", body);
  await reloadLabels();
}

export async function deleteLabel(id: string) {
  await apiJson(`/api/labels/${id}`, "DELETE");
  await reloadLabels();
}

export function scopeText(l: Label): string {
  return l.scope === "site" ? "everyone" : l.scope === "group" ? (l.owner_name ?? "a group") : "only you";
}
