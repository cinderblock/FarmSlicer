// Where the live view's frames come from (LiveSlicePreview draws them): a
// browser slice's engine hands them to the page (useLocalLiveSlice), a
// server slice streams them from `GET /api/jobs/{id}/live`
// (useServerLiveSlice), with the slicer's progress as it comes (no waiting
// for the next poll of the job). Both give a `LiveSlice` that's replaced by
// a new one with every frame.

import { useCallback, useEffect, useState } from "react";
import { FrameReader, LiveSlice, decodeFrame, decodeProgress, type LiveFrame, type LiveProgress } from "./liveSlice";

/** A server slice still waiting for the slicer: ask again after (ms). */
const RETRY_MS = 1500;

function decoded(frame: ArrayBuffer | Uint8Array): LiveFrame | null {
  try {
    return decodeFrame(frame);
  } catch (e) {
    console.warn("[live] a frame of the live view didn't decode", e);
    return null;
  }
}

function progressOf(frame: Uint8Array): LiveProgress | null {
  try {
    return decodeProgress(frame);
  } catch (e) {
    console.warn("[live] a progress frame of the live view didn't decode", e);
    return null;
  }
}

/** Frames the page receives itself (a browser slice); `add` and `reset` are stable. */
export function useLocalLiveSlice(): { live: LiveSlice; add: (frame: ArrayBuffer | Uint8Array) => void; reset: () => void } {
  const [live, setLive] = useState(LiveSlice.empty);
  const add = useCallback((frame: ArrayBuffer | Uint8Array) => {
    const f = decoded(frame);
    if (f) setLive((l) => l.add(f));
  }, []);
  const reset = useCallback(() => setLive(LiveSlice.empty()), []);
  return { live, add, reset };
}

/**
 * A server slice's frames while `active` (the job is queued or slicing),
 * and its progress as the stream brings it (null before the first: use the
 * job's own, polled). Nothing to stream yet (still queued) asks again a
 * little later.
 */
export function useServerLiveSlice(jobId: string, active: boolean): { live: LiveSlice; progress: LiveProgress | null } {
  const [state, setState] = useState<{ jobId: string; live: LiveSlice; progress: LiveProgress | null }>(() => ({
    jobId,
    live: LiveSlice.empty(),
    progress: null,
  }));
  if (state.jobId !== jobId) setState({ jobId, live: LiveSlice.empty(), progress: null });

  useEffect(() => {
    if (!active) return;
    const ctrl = new AbortController();
    let retry: number | undefined;
    const add = (frames: LiveFrame[], progress: LiveProgress | null) =>
      setState((s) =>
        s.jobId === jobId ? { jobId, live: frames.reduce((l, f) => l.add(f), s.live), progress: progress ?? s.progress } : s,
      );
    const open = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/live`, { signal: ctrl.signal, cache: "no-store" });
        if (res.status === 204 || !res.ok || !res.body) {
          if (!ctrl.signal.aborted) retry = window.setTimeout(open, RETRY_MS);
          return;
        }
        const reader = res.body.getReader();
        const split = new FrameReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // Geometry frames, and the latest progress among the chunk's.
          const frames: LiveFrame[] = [];
          let progress: LiveProgress | null = null;
          for (const bytes of split.push(value)) {
            const p = progressOf(bytes);
            if (p) progress = p;
            else {
              const f = decoded(bytes);
              if (f) frames.push(f);
            }
          }
          if (frames.length || progress) add(frames, progress);
        }
      } catch (e) {
        if (!ctrl.signal.aborted) console.warn("[live] the live view's stream broke off", e);
      }
    };
    void open();
    return () => {
      ctrl.abort();
      clearTimeout(retry);
    };
  }, [jobId, active]);

  return state.jobId === jobId ? { live: state.live, progress: state.progress } : { live: LiveSlice.empty(), progress: null };
}
