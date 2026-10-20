import type { Progress } from "../projects";

/** Each kind's share of the bar in percent, in order, filling up to `wanted`. */
function barSegments(progress: Progress, wanted: number): [string, number, string][] {
  const total = Math.max(wanted, 1);
  const kinds: [string, number, string][] = [
    ["good", progress.good, `${progress.good} good`],
    ["unchecked", progress.unchecked, `${progress.unchecked} finished, unchecked`],
    ["printing", progress.printing, `${progress.printing} printing`],
    ["queued", progress.queued, `${progress.queued} queued`],
  ];
  return kinds.map(([kind, n, label], i) => {
    const before = kinds.slice(0, i).reduce((s, [, m]) => s + m, 0);
    const shown = Math.max(0, Math.min(n, wanted - before));
    return [kind, (shown / total) * 100, label];
  });
}

/** An item's (or project's) copies as one bar: good, unchecked, printing
 *  and queued, out of how many are wanted. Failed copies don't fill it. */
export default function ProgressBar({ progress, wanted }: { progress: Progress; wanted: number }) {
  const segments = barSegments(progress, wanted);
  return (
    <div
      className="project-bar"
      role="img"
      aria-label={segments
        .filter(([, w]) => w > 0)
        .map(([, , label]) => label)
        .concat(`${wanted} wanted`)
        .join(", ")}
    >
      {segments.map(([kind, width]) =>
        width > 0 ? <div key={kind} className={`project-bar-${kind}`} style={{ width: `${width}%` }} /> : null,
      )}
    </div>
  );
}
