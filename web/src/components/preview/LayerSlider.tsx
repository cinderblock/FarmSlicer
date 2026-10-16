// The preview's vertical layer range slider: a bottom and a top handle on
// one track (layer 1 at the bottom). Drag a handle, click the track to move
// the nearer one, or use the keyboard on a focused handle: arrows ±1,
// Page Up/Down ±10, Home/End.

import { useRef, type KeyboardEvent, type PointerEvent } from "react";

interface Props {
  /** Number of layers. */
  count: number;
  bottom: number;
  top: number;
  onChange: (bottom: number, top: number) => void;
  /** Label for a layer index (e.g. its Z). */
  label: (layer: number) => string;
}

export default function LayerSlider({ count, bottom, top, onChange, label }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<"bottom" | "top" | null>(null);
  const max = Math.max(0, count - 1);
  const pct = (layer: number) => (max > 0 ? (layer / max) * 100 : 0);

  const layerAt = (clientY: number) => {
    const r = track.current!.getBoundingClientRect();
    const f = 1 - (clientY - r.top) / r.height;
    return Math.round(Math.max(0, Math.min(1, f)) * max);
  };

  const set = (which: "bottom" | "top", layer: number) => {
    const v = Math.max(0, Math.min(max, layer));
    if (which === "top") onChange(Math.min(bottom, v), v);
    else onChange(v, Math.max(top, v));
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const layer = layerAt(e.clientY);
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-handle]")?.dataset.handle as
      | "bottom"
      | "top"
      | undefined;
    const which = target ?? (Math.abs(layer - top) <= Math.abs(layer - bottom) ? "top" : "bottom");
    dragging.current = which;
    e.currentTarget.setPointerCapture(e.pointerId);
    (e.currentTarget.querySelector(`[data-handle="${which}"]`) as HTMLElement | null)?.focus();
    if (!target) set(which, layer);
    e.preventDefault();
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) set(dragging.current, layerAt(e.clientY));
  };
  const up = () => {
    dragging.current = null;
  };

  const key = (which: "bottom" | "top") => (e: KeyboardEvent) => {
    const now = which === "top" ? top : bottom;
    const step: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 };
    let next: number | null = null;
    if (e.key in step) next = now + step[e.key];
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    set(which, next);
  };

  return (
    <div className="gp-layer-slider" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="gp-layer-track" ref={track}>
        <div className="gp-layer-fill" style={{ bottom: `${pct(bottom)}%`, height: `${pct(top) - pct(bottom)}%` }} />
        {(["bottom", "top"] as const).map((which) => {
          const layer = which === "top" ? top : bottom;
          return (
            <div
              key={which}
              data-handle={which}
              className={`gp-layer-handle gp-layer-${which}`}
              style={{ bottom: `${pct(layer)}%` }}
              role="slider"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label={which === "top" ? "Top layer" : "Bottom layer"}
              aria-valuemin={1}
              aria-valuemax={count}
              aria-valuenow={layer + 1}
              aria-valuetext={`Layer ${layer + 1}, ${label(layer)}`}
              onKeyDown={key(which)}
            >
              <span className="gp-layer-label">
                {layer + 1}
                <small>{label(layer)}</small>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
