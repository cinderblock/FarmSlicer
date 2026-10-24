// Which changelog entries a browser hasn't seen (components/WhatsNewDialog.tsx).
// Remembered per browser: the newest entry id shown, in localStorage.

import type { ChangelogEntry } from "./changelog";

const SEEN_KEY = "farmslicer.whatsNewSeen";

/** The local calendar day (YYYY-MM-DD) of a SQLite UTC time, or null. */
export function localDay(sqlite: string | null | undefined): string | null {
  if (!sqlite) return null;
  const d = new Date(sqlite.replace(" ", "T") + (/[Zz]|[+-]\d\d:?\d\d$/.test(sqlite) ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The entries to show, newest first: those newer than `seen`, leaving out
 * releases from before the account existed (`accountDay`). A browser that
 * has seen nothing yet gets only the newest, not the whole history.
 */
export function unseenEntries(
  entries: ChangelogEntry[],
  seen: string | null,
  accountDay: string | null,
): ChangelogEntry[] {
  const fresh = entries.filter((e) => (seen === null || e.id > seen) && (accountDay === null || e.date >= accountDay));
  return seen === null ? fresh.slice(0, 1) : fresh;
}

export function seenId(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

/** Remember everything up to `id` as seen. */
export function markSeen(id: string) {
  try {
    if ((localStorage.getItem(SEEN_KEY) ?? "") < id) localStorage.setItem(SEEN_KEY, id);
  } catch {
    // Private mode without storage: it shows again next time, nothing worse.
  }
}
