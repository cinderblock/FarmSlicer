// /s/:code: what a public share link shows to anyone, signed in or not
// (src/shares.rs): names, facts and plate pictures, no files.
import { useParams } from "react-router";
import { formatDuration, localDate, useJson } from "../api";
import { BrandMark } from "../components/Icon";
import SourceFooter from "../components/SourceFooter";

interface PublicJob {
  id: string;
  name: string;
  created_at: string;
  print_time_sec: number | null;
  filament_used_g: number | null;
  plates: { index: number; thumbnail: string }[];
}

interface PublicShare {
  kind: "job" | "project" | "folder";
  name: string;
  shared_by: string | null;
  expires_at: string | null;
  jobs: PublicJob[];
  projects: { name?: string; items?: { name: string; quantity: number }[] }[];
}

export default function SharedLinkPage() {
  const { code = "" } = useParams();
  const data = useJson<PublicShare>(`/api/public/shares/${encodeURIComponent(code)}`);
  return (
    <div className="shared-page">
      <header className="shared-head">
        <BrandMark size={28} />
        <span>FarmSlicer</span>
      </header>
      <main className="page">
        {data.error ? (
          <>
            <h2>This link doesn't work</h2>
            <p className="hint">It may have been stopped, or it expired. Ask whoever sent it for a new one.</p>
          </>
        ) : !data.data ? (
          <p className="hint">Loading…</p>
        ) : (
          <>
            <h2>{data.data.name}</h2>
            <p className="hint">
              Shared{data.data.shared_by ? ` by ${data.data.shared_by}` : ""}
              {data.data.expires_at ? `, until ${localDate(data.data.expires_at)}` : ""}.
            </p>
            {data.data.projects.flatMap((p) => p.items ?? []).length > 0 && (
              <>
                <h3>Parts</h3>
                <ul>
                  {data.data.projects
                    .flatMap((p) => p.items ?? [])
                    .map((i, n) => (
                      <li key={n}>
                        {i.name} × {i.quantity}
                      </li>
                    ))}
                </ul>
              </>
            )}
            {data.data.projects.some((p) => p.name) && (
              <>
                <h3>Projects</h3>
                <ul>
                  {data.data.projects
                    .filter((p) => p.name)
                    .map((p, n) => (
                      <li key={n}>{p.name}</li>
                    ))}
                </ul>
              </>
            )}
            {data.data.jobs.length > 0 && <h3>{data.data.kind === "job" ? "Plates" : "Sliced models"}</h3>}
            <div className="shared-jobs">
              {data.data.jobs.map((j) => (
                <section key={j.id} className="card">
                  {data.data!.kind !== "job" && <h4>{j.name}</h4>}
                  <p className="hint">
                    {localDate(j.created_at)}
                    {j.print_time_sec ? ` · ${formatDuration(j.print_time_sec)}` : ""}
                    {j.filament_used_g ? ` · ${j.filament_used_g.toFixed(1)} g` : ""}
                  </p>
                  <div className="shared-plates">
                    {j.plates.map((p) => (
                      <figure key={p.index}>
                        <img src={p.thumbnail} alt={`Plate ${p.index}`} loading="lazy" />
                        {j.plates.length > 1 && <figcaption>Plate {p.index}</figcaption>}
                      </figure>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </main>
      <SourceFooter />
    </div>
  );
}
