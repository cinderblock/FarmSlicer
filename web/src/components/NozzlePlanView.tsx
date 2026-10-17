import { nozzleSide, type NozzlePlan } from "../printers";

/** A filament profile's name without its printer suffix ("Bambu PLA Basic @BBL H2D" → "Bambu PLA Basic"). */
const shortName = (name: string) => name.replace(/\s*@.*$/, "");

/**
 * Which nozzle each filament prints from on a dual-nozzle printer, and why
 * (src/nozzles.rs): the Slice page before slicing, a job's page after.
 */
export default function NozzlePlanView({
  plan,
  filaments,
  title = "Nozzles",
}: {
  plan: NozzlePlan;
  /** The job's filament profile names, filament 1 first. */
  filaments: string[];
  title?: string;
}) {
  return (
    <div className="nozzle-plan">
      <div className="nozzle-plan-title">{title}</div>
      {plan.filaments.map((c, i) => (
        <div key={i} className="nozzle-plan-row">
          <span className={`nozzle-side nozzle-${c.nozzle === 1 ? "left" : "right"}`}>{nozzleSide(c.nozzle)}</span>
          <span>
            {shortName(filaments[i] ?? `Filament ${i + 1}`)}
            <span className="hint"> · {c.why}</span>
          </span>
        </div>
      ))}
      {plan.printers === 0 && (
        <span className="hint">No printer's AMS to go by (none online that says which nozzle it feeds).</span>
      )}
    </div>
  );
}
