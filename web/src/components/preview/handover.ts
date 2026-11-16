// The live view handing over to the finished G-code preview (SliceView.tsx
// provides it, GcodePreview reads it): where the live view's camera is, so
// the preview starts there instead of framing the print, and a call for
// when the preview has drawn, so the live view over it can go.

import { createContext, type RefObject } from "react";
import type { CameraPose } from "./types";

export interface Handover {
  /** The live view's camera (read when the preview frames its file). */
  initialCamera: RefObject<CameraPose | null>;
  /** The preview has drawn its first frame, or can't show its file. */
  onReady: () => void;
}

export const HandoverContext = createContext<Handover | null>(null);
