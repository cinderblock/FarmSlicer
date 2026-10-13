import { formatMinutes, type GcodeCheck, type GcodeFinding } from "../printers";

const VERDICTS: Record<string, [string, string]> = {
  ok: ["G-code checked", "gcode-ok"],
  info: ["G-code checked", "gcode-ok"],
  review: ["G-code needs review", "gcode-review"],
  block: ["G-code can't be sent", "gcode-block"],
  unchecked: ["G-code not checked yet", "gcode-unchecked"],
};

/** A chip for a job's or plate's check verdict. */
export function GcodeChip({ verdict, checked = true }: { verdict: GcodeCheck["verdict"]; checked?: boolean }) {
  const [label, cls] = VERDICTS[checked ? (verdict ?? "ok") : "unchecked"];
  return <span className={`gcode-chip ${cls}`}>{label}</span>;
}

const SEVERITY_LABELS: Record<GcodeFinding["severity"], string> = {
  block: "Can't be sent",
  review: "Needs review",
  info: "Note",
};

/**
 * What the check found and measured, tap to expand. `open` starts it
 * expanded (when there's something to act on).
 */
export default function GcodeCheckDetails({ check, open }: { check: GcodeCheck; open?: boolean }) {
  const s = check.stats;
  const facts = [
    `about ${formatMinutes(Math.round(s.time_sec / 60))} by its G-code`,
    s.max_nozzle_c ? `nozzle up to ${Math.round(s.max_nozzle_c)} °C` : null,
    s.max_bed_c ? `plate up to ${Math.round(s.max_bed_c)} °C` : null,
    s.max_chamber_c ? `chamber up to ${Math.round(s.max_chamber_c)} °C` : null,
    `${s.lines.toLocaleString()} lines`,
  ].filter(Boolean);
  return (
    <details className="gcode-check" open={open}>
      <summary>
        <GcodeChip verdict={check.verdict} />{" "}
        {check.findings.length === 0
          ? "nothing unusual"
          : `${check.findings.length} finding${check.findings.length === 1 ? "" : "s"}`}
      </summary>
      {check.findings.length > 0 && (
        <ul className="gcode-findings">
          {check.findings.map((f, i) => (
            <li key={i} className={`gcode-finding gcode-finding-${f.severity}`}>
              <strong>{SEVERITY_LABELS[f.severity]}:</strong> {f.message}
              {f.line ? <span className="hint"> (line {f.line.toLocaleString()}{f.count > 1 ? `, ${f.count} times` : ""})</span> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        Checked against what Bambu's own G-code does: {facts.join(" · ")}.
      </p>
    </details>
  );
}
