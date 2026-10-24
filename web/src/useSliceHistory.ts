// The Slice page's remembered slices (sliceCache.ts) as React state, and
// how a slice's time is shown.

import { useEffect, useState } from "react";
import { listSlices, onSlicesChanged } from "./sliceCache";
import type { SliceEntry } from "./sliceHistory";

/** The remembered slices, the newest first, kept current. */
export function useSliceHistory(): SliceEntry[] {
  const [entries, setEntries] = useState<SliceEntry[]>([]);
  useEffect(() => {
    let stale = false;
    const load = () =>
      listSlices().then((all) => {
        if (!stale) setEntries(all.sort((a, b) => b.createdAt - a.createdAt));
      });
    load();
    const off = onSlicesChanged(load);
    return () => {
      stale = true;
      off();
    };
  }, []);
  return entries;
}

/** "2:41 PM", or "Oct 23, 2:41 PM" before today. */
export function sliceTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
