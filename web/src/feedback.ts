// Feedback reports as the API returns them (src/feedback_api.rs), and the
// words the UI uses for their kinds, statuses and sources.

export type Kind = "printer" | "slicer" | "app" | "bug" | "idea" | "other";
export type Status = "new" | "acknowledged" | "resolved" | "wont_fix";

/** In the order the Feedback dialog offers them. */
export const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: "bug", label: "Something's broken", hint: "An error, a crash, something that doesn't work" },
  { value: "slicer", label: "Slicing", hint: "Slicing results, settings, profiles" },
  { value: "printer", label: "A printer", hint: "A printer in the farm or how it's driven" },
  { value: "app", label: "Using the app", hint: "Confusing pages, missing information" },
  { value: "idea", label: "An idea", hint: "Something FarmSlicer could do" },
  { value: "other", label: "Something else", hint: "Anything at all" },
];

export const KIND_LABELS: Record<Kind, string> = {
  bug: "Bug",
  slicer: "Slicer",
  printer: "Printer",
  app: "App",
  idea: "Idea",
  other: "Other",
};

export const STATUSES: { value: Status; label: string }[] = [
  { value: "new", label: "New" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "resolved", label: "Resolved" },
  { value: "wont_fix", label: "Won't fix" },
];

export const STATUS_LABELS: Record<Status, string> = {
  new: "New",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
  wont_fix: "Won't fix",
};

/** Where an automatic report was caught. */
export const SOURCE_LABELS: Record<string, string> = {
  manual: "Report",
  window: "Uncaught error",
  promise: "Unhandled rejection",
  console: "Console error",
  react: "Page crash",
  api: "Failed request",
  resource: "Failed to load",
  server: "Server",
};

export interface Occurrence {
  user_id: string | null;
  username: string | null;
  version: string;
  count: number;
  first_seen: string;
  last_seen: string;
  page_url: string | null;
  user_agent: string | null;
  message: string | null;
}

export interface FeedbackItem {
  id: string;
  automatic: boolean;
  kind: Kind;
  source: string;
  message: string;
  /** Only in single-report responses. */
  stack: string | null;
  user_id: string | null;
  username: string | null;
  printer_id: string | null;
  printer_name: string | null;
  job_id: string | null;
  job_name: string | null;
  page_url: string | null;
  user_agent: string | null;
  version: string | null;
  /** Only in single-report responses. */
  context: unknown;
  count: number;
  /** Automatic: first seen. */
  created_at: string;
  last_seen: string;
  status: Status;
  admin_note: string;
  updated_at: string;
  affected_users: number;
  versions: string[];
  /** Automatic, single-report responses. */
  occurrences?: Occurrence[];
}

export type Counts = Record<"manual" | "automatic", Record<Status, number>>;

/** Window event after a report is sent, triaged or deleted: lists and the
 *  sidebar's count reload. */
export const FEEDBACK_CHANGED = "farmslicer:feedback-changed";

export function feedbackChanged() {
  window.dispatchEvent(new Event(FEEDBACK_CHANGED));
}

/** Reports per tab waiting for someone to look at them. */
export function newCount(counts: Counts | undefined): number {
  return counts ? counts.manual.new + counts.automatic.new : 0;
}

export interface FeedbackPrefill {
  kind?: Kind;
  printerId?: string;
  jobId?: string;
}

/** What the page the dialog opens on suggests: the job of a job page
 *  (`/jobs/:id` or `?job=`), a printer (`?printer=`), and a kind. */
export function prefillFor(pathname: string, search: string): FeedbackPrefill {
  const params = new URLSearchParams(search);
  const jobId = pathname.match(/^\/jobs\/([^/]+)/)?.[1] ?? params.get("job") ?? undefined;
  const printerId = params.get("printer") ?? undefined;
  const kind: Kind =
    pathname === "/" || pathname.startsWith("/printers") || printerId
      ? "printer"
      : pathname.startsWith("/slice") || pathname.startsWith("/jobs") || jobId
        ? "slicer"
        : "app";
  return { kind, printerId, jobId };
}
