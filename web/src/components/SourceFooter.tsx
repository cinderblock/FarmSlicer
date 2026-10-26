import { useAuth } from "../auth";
import { sourceUrl } from "../source";

/** Under the sign-in pages' card: FarmSlicer is open source, and where this build's source is. */
export default function SourceFooter() {
  const { status } = useAuth();
  return (
    <p className="source-footer hint">
      FarmSlicer is free software (AGPL).{" "}
      <a href={sourceUrl(status?.source_url)} target="_blank" rel="noopener noreferrer">
        Source code
      </a>
    </p>
  );
}
