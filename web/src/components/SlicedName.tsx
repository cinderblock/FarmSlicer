// A model's name where it's listed: sliced, it opens the plate's G-code
// preview; not sliced, it says so and offers to slice it (the Slice page
// with the job's models and settings, `?from=`).

import type { ReactNode } from "react";
import { Link } from "react-router";
import Icon from "./Icon";
import { previewPath } from "../links";

export default function SlicedName({
  jobId,
  sliced,
  plate,
  canSlice,
  children,
}: {
  jobId: string;
  /** The job has G-code to show. */
  sliced: boolean;
  /** The plate to open at. */
  plate?: number | null;
  /** Its models are on the server, so it can be sliced from here. */
  canSlice: boolean;
  children: ReactNode;
}) {
  if (sliced) {
    return (
      <Link to={previewPath(jobId, plate)} title="Preview the sliced plate">
        {children}
      </Link>
    );
  }
  return (
    <span className="unsliced">
      <span>{children}</span>
      <span className="unsliced-chip" title="There's no G-code for this model yet: nothing to preview or print">
        Not sliced
      </span>
      {canSlice && (
        <Link className="btn-sm btn-accent" to={`/slice?from=${encodeURIComponent(jobId)}`} title="Open it on the Slice page with its settings, ready to slice">
          <Icon name="slice" /> Slice
        </Link>
      )}
    </span>
  );
}
