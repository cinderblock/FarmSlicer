// Where the live view's frames come from (LiveSlicePreview draws them): a
// browser slice's engine hands them to the page (useLocalLiveSlice), a
// server slice streams them from `GET /api/jobs/{id}/live`
// (useServerLiveSlice). Both give a `LiveSlice` that's replaced by a new
// one with every frame.

import { useCallback, useEffect, useState } from "react";
import { FrameReader, LiveSlice, decodeFrame, type LiveFrame } from "./liveSlice";

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
 * A server slice's frames while `active` (the job is queued or slicing).
 * Nothing to stream yet (still queued) asks again a little later.
 */
export function useServerLiveSlice(jobId: string, active: boolean): LiveSlice {
  const [state, setState] = useState(() => ({ jobId, live: LiveSlice.empty() }));
  if (state.jobId !== jobId) setState({ jobId, live: LiveSlice.empty() });

  useEffect(() => {
    if (!active) return;
    const ctrl = new AbortController();
    let retry: number | undefined;
    const add = (frames: LiveFrame[]) =>
      setState((s) => (s.jobId === jobId ? { jobId, live: frames.reduce((l, f) => l.add(f), s.live) } : s));
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
          const frames = split.push(value).map(decoded).filter((f): f is LiveFrame => f !== null);
          if (frames.length) add(frames);
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

  return state.jobId === jobId ? state.live : LiveSlice.empty();
}
