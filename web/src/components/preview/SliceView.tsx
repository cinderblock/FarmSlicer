// A slice's view from the first frame to the finished G-code, without a
// jump: the live view while it slices (LiveSlicePreview), then the finished
// preview (`finished`, a GcodePreview), loaded underneath the live view and
// starting from its camera (handover.ts), takes over once it has drawn. Its
// layout matches the live view's, so nothing moves but the toolpaths.
//
// Kept at one place in the page's tree from slicing to done, or the live
// view would be made again (and reframe) as the page changes around it.

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { HandoverContext, type Handover } from "./handover";
import LiveSlicePreview, { type LiveSlicePreviewProps } from "./LiveSlicePreview";
import type { CameraPose } from "./types";

export default function SliceView({
  slicing,
  live,
  finished,
}: {
  /** Still slicing: only the live view. */
  slicing: boolean;
  /** The live view's props; null when there is none. */
  live: Omit<LiveSlicePreviewProps, "onCamera"> | null;
  /** The finished slice's view, shown once slicing is over. */
  finished: ReactNode;
}) {
  const camera = useRef<CameraPose | null>(null);
  // Only a view that was live hands over; one opened after the slice frames the print itself.
  const [wasLive] = useState(slicing);
  const [ready, setReady] = useState(false);
  const onCamera = useCallback((pose: CameraPose) => {
    camera.current = pose;
  }, []);
  const handover = useMemo<Handover>(() => ({ initialCamera: camera, onReady: () => setReady(true) }), []);
  const showLive = !!live && (slicing || (wasLive && !ready));

  return (
    <div className="slice-view">
      {!slicing && <HandoverContext.Provider value={wasLive ? handover : null}>{finished}</HandoverContext.Provider>}
      {showLive && (
        <div className={slicing ? "slice-view-live" : "slice-view-live slice-view-over"}>
          <LiveSlicePreview {...live} title={slicing ? live.title : "Sliced"} onCamera={onCamera} />
        </div>
      )}
    </div>
  );
}
