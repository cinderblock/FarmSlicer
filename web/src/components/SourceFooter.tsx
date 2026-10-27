import { useAuth } from "../auth";
import { sourceUrl } from "../source";

/** Under the sign-in pages' card: FarmSlicer is open source, where this build's source is, the licences and the trademark policy. */
export default function SourceFooter() {
  const { status } = useAuth();
  return (
    <p className="source-footer hint">
      FarmSlicer™ is free software (AGPL).{" "}
      <a href={sourceUrl(status?.source_url)} target="_blank" rel="noopener noreferrer">
        Source code
      </a>
      {" · "}
      <a href="/THIRD-PARTY-NOTICES.txt" target="_blank" rel="noopener noreferrer">
        Licences
      </a>
      {" · "}
      <a href="/TRADEMARKS.txt" target="_blank" rel="noopener noreferrer">
        Trademarks
      </a>
    </p>
  );
}
