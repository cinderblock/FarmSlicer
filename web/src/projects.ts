// Projects (src/projects.rs): what someone needs printed, item by item,
// and where each item's copies stand.

export interface Progress {
  good: number;
  failed: number;
  /** On finished prints nobody has checked. */
  unchecked: number;
  /** On prints still on a printer, or waiting for approval. */
  printing: number;
  /** On queued plates not sent yet. */
  queued: number;
}

export interface Item extends Progress {
  id: string;
  project_id: string;
  idx: number;
  name: string;
  quantity: number;
  /** The recipe: a job and one of its models. */
  job_id: string | null;
  model_idx: number | null;
  notes: string;
  created_at: string;
  /** Copies with no plate yet. */
  missing: number;
  done: boolean;
}

export interface Summary extends Progress {
  items: number;
  items_done: number;
  wanted: number;
  missing: number;
}

export type ProjectStatus = "open" | "printed" | "ready" | "shipped" | "on_hold" | "cancelled";

export interface Project {
  id: string;
  name: string;
  group_id: string | null;
  group_name: string | null;
  user_id: string | null;
  username: string | null;
  client_ref: string | null;
  external_ref: string | null;
  status: ProjectStatus;
  status_note: string | null;
  priority: number;
  due_at: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
  printed_at: string | null;
  shipped_at: string | null;
  summary: Summary;
  can_edit?: boolean;
}

export interface JobItem {
  job_id: string;
  plate: number;
  part: string;
  item_id: string;
  model_idx: number | null;
  name: string;
  copies: number;
}

export interface ProjectJob {
  job_id: string;
  name: string;
  status: string;
  sendable: boolean;
  visible: boolean;
  plates: number[];
  parts: JobItem[];
  prints: {
    id: string;
    plate: number;
    printer_name: string;
    status: string;
    outcome: "good" | "partial" | "failed" | null;
    created_at: string;
    finished_at: string | null;
  }[];
}

export interface ProjectDetail extends Project {
  items: Item[];
  can_edit: boolean;
  jobs: ProjectJob[];
}

/** A part of a job (GET /api/jobs/{id}/parts). */
export interface JobPart {
  key: string;
  model_idx: number | null;
  name: string;
  plates: [number, number][];
  copies: number;
  item: { id: string; name: string; project_id: string; project_name: string } | null;
}

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  open: "Open",
  printed: "Printed",
  ready: "Ready",
  shipped: "Shipped",
  on_hold: "On hold",
  cancelled: "Cancelled",
};

/** "3 of 8 good", with what's on its way. */
export function progressText(p: Progress & { quantity?: number; wanted?: number; missing: number }): string {
  const wanted = p.quantity ?? p.wanted ?? 0;
  const parts = [`${Math.min(p.good, wanted)} of ${wanted} good`];
  if (p.printing) parts.push(`${p.printing} printing`);
  if (p.unchecked) parts.push(`${p.unchecked} unchecked`);
  if (p.queued) parts.push(`${p.queued} queued`);
  if (p.missing) parts.push(`${p.missing} need plates`);
  if (p.failed) parts.push(`${p.failed} failed`);
  return parts.join(" · ");
}

/** Today's date as YYYY-MM-DD in local time, for due-date comparisons. */
export function overdue(due: string | null, status: ProjectStatus): boolean {
  if (!due || !["open", "printed", "on_hold"].includes(status)) return false;
  const d = new Date(due.length === 10 ? `${due}T23:59:59` : `${due.replace(" ", "T")}Z`);
  return d.getTime() < Date.now();
}
