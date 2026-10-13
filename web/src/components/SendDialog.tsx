import { useEffect, useMemo, useState } from "react";
import { apiJson, useAuth } from "../auth";
import { errorText } from "../api";
import GcodeCheckDetails from "./GcodeCheck";
import {
  describeState,
  formatCost,
  formatMinutes,
  loadedTrays,
  slotLabel,
  type GcodeCheck,
  type Plate,
  type PrintOptions,
  type PrintRecord,
  type Target,
} from "../printers";

interface Targets {
  plates: Plate[];
  targets: Target[];
  /** Why this plate needs approval for the caller (empty = it doesn't). */
  needs_approval: string[];
  /** G-code findings that stop the plate from being sent at all. */
  blocked: string[];
  /** G-code findings an admin must review (admins acknowledge them). */
  needs_review: string[];
  /** Set when the upload policy no longer lets this job be printed. */
  uploads_denied: string | null;
  gcode_check: GcodeCheck | null;
  estimated_cost: number;
  currency: string;
}

const OPTION_LABELS: [keyof PrintOptions, string, string][] = [
  ["bed_leveling", "Bed levelling", "Probe the bed before printing."],
  ["flow_calibration", "Flow calibration", "X1/H2: measure the extrusion flow before printing."],
  ["vibration_calibration", "Vibration calibration", "Tune the motion system before printing."],
  ["timelapse", "Timelapse", "Record a timelapse (needs storage on the printer)."],
];

/** Send a job with a printable package to a printer. */
export default function SendDialog({
  jobId,
  jobName,
  onClose,
  onSent,
}: {
  jobId: string;
  jobName: string;
  onClose: () => void;
  onSent: (print: PrintRecord) => void;
}) {
  const [plate, setPlate] = useState<number | null>(null);
  const [data, setData] = useState<Targets | null>(null);
  const [loadError, setLoadError] = useState("");
  const [printerId, setPrinterId] = useState("");
  // Per printer: the user's tray choice per filament (index = filament id - 1).
  const [mappings, setMappings] = useState<Record<string, number[]>>({});
  const [options, setOptions] = useState<PrintOptions>({
    bed_leveling: true,
    flow_calibration: true,
    vibration_calibration: true,
    timelapse: false,
    layer_inspect: false,
  });
  const [force, setForce] = useState(false);
  const { isAdmin } = useAuth();
  const [acknowledged, setAcknowledged] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`/api/jobs/${jobId}/targets${plate ? `?plate=${plate}` : ""}`, { cache: "no-store" })
        .then(async (r) => {
          const body = await r.json().catch(() => null);
          if (cancelled) return;
          if (!r.ok) setLoadError(body?.error ?? `HTTP ${r.status}`);
          else setData(body);
        })
        .catch((e) => !cancelled && setLoadError(String(e)));
    load();
    // Printers come and go; keep availability current while the dialog is open.
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [jobId, plate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const currentPlate = data?.plates.find((p) => p.index === plate) ?? data?.plates[0];
  const targets = useMemo(() => data?.targets ?? [], [data]);
  const review = data?.needs_review ?? [];
  const blocked = (data?.blocked.length ?? 0) > 0 || !!data?.uploads_denied;
  // Admins acknowledge a G-code review themselves; anyone else's request
  // waits for one.
  const adminReview = review.length > 0 && !isAdmin;
  // A request that needs approval can name a busy printer: it's sent when approved.
  const waits = (data?.needs_approval.length ?? 0) > 0 || adminReview;
  const usable = targets.filter((t) => !t.incompatible && (waits || !t.busy));
  // Default: the first free, fitting printer.
  const selected = targets.find((t) => t.printer_id === printerId) ?? usable[0];
  const mapping = selected ? (mappings[selected.printer_id] ?? selected.ams_mapping) : [];
  const trays = loadedTrays(selected?.status);
  // Bambu printers map the plate's filaments to AMS trays; elsewhere the
  // G-code names its tools and people load the spools.
  const mapsFilaments = selected?.capabilities?.filament_mapping ?? true;
  const optionLabels = OPTION_LABELS.filter(([key]) => selected?.capabilities?.print_options.includes(key) ?? true);

  // Cheap enough to recompute on every render.
  const problems = ((): string[] => {
    if (!selected || !currentPlate) return [];
    if (!mapsFilaments) return selected.problems;
    const out: string[] = [];
    for (const f of currentPlate.filaments) {
      const slot = mapping[f.id - 1] ?? -1;
      const tray = trays.find((t) => t.slot === slot);
      if (slot < 0 || !tray) out.push(`Filament ${f.id} (${f.material}) has no tray.`);
      else if ((tray.material ?? "").toUpperCase() !== f.material.toUpperCase())
        out.push(`Filament ${f.id} is ${f.material}, but ${slotLabel(tray)} holds ${tray.material}.`);
    }
    return out;
  })();

  const setSlot = (filamentId: number, slot: number) => {
    if (!selected) return;
    const next = [...mapping];
    while (next.length < filamentId) next.push(-1);
    next[filamentId - 1] = slot;
    setMappings((m) => ({ ...m, [selected.printer_id]: next }));
    setForce(false);
  };

  const send = async () => {
    if (!selected || !currentPlate) return;
    setSending(true);
    setError("");
    try {
      const print = await apiJson<PrintRecord>(`/api/jobs/${jobId}/print`, "POST", {
        printer_id: selected.printer_id,
        plate: currentPlate.index,
        ams_mapping: mapsFilaments ? mapping : undefined,
        options,
        ignore_mapping_problems: force,
        acknowledge_review: isAdmin && acknowledged,
      });
      onSent(print);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal send-dialog" role="dialog" aria-label={`Print ${jobName}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Print {jobName}</h3>
          <button className="btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {loadError && <p className="printer-error">{loadError}</p>}
        {!data && !loadError && <p className="hint">Loading printers…</p>}

        {data && currentPlate && (
          <>
            <div className="send-plate">
              {currentPlate.has_thumbnail && (
                <img
                  className="plate-thumb"
                  src={`/api/jobs/${jobId}/thumbnail?plate=${currentPlate.index}`}
                  alt={`Plate ${currentPlate.index}`}
                />
              )}
              <div>
                {data.plates.length > 1 && (
                  <label>
                    Plate{" "}
                    <select value={currentPlate.index} onChange={(e) => setPlate(Number(e.target.value))}>
                      {data.plates.map((p) => (
                        <option key={p.index} value={p.index}>
                          Plate {p.index}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <p className="hint">
                  {[
                    // What FarmSlicer goes by (the G-code's, when the file understates it).
                    (data.gcode_check?.time_sec ?? currentPlate.print_time_sec)
                      ? formatMinutes(Math.round((data.gcode_check?.time_sec ?? currentPlate.print_time_sec ?? 0) / 60))
                      : null,
                    (data.gcode_check?.grams ?? currentPlate.weight_g)
                      ? `${(data.gcode_check?.grams ?? currentPlate.weight_g ?? 0).toFixed(1)} g`
                      : null,
                    `about ${formatCost(data.estimated_cost, data.currency)} of filament`,
                    currentPlate.nozzle_diameters ? `${currentPlate.nozzle_diameters} mm nozzle` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {data.gcode_check && <GcodeCheckDetails check={data.gcode_check} />}
              </div>
            </div>

            <h4>Printer</h4>
            <div className="target-list">
              {targets.length === 0 && <p className="hint">No printers configured.</p>}
              {targets.map((t) => {
                const disabled = !!(t.incompatible || (t.busy && !waits));
                const { label, tone } = describeState(t.status ?? undefined);
                return (
                  <label key={t.printer_id} className={`target${disabled ? " target-disabled" : ""}`}>
                    <input
                      type="radio"
                      name="printer"
                      disabled={disabled}
                      checked={selected?.printer_id === t.printer_id}
                      onChange={() => setPrinterId(t.printer_id)}
                    />
                    <span className="target-main">
                      <strong>{t.name}</strong>
                      <span className="hint">
                        {t.machine_profile} · {t.nozzle_diameter} mm
                      </span>
                      {(t.incompatible || t.busy) && <span className="hint">{t.incompatible ?? t.busy}</span>}
                    </span>
                    <span className="printer-state">
                      {label}
                      <span className={`status-dot status-${tone}`} />
                    </span>
                  </label>
                );
              })}
            </div>

            {selected && !selected.incompatible && (waits || !selected.busy) && (
              <>
                <h4>Filaments</h4>
                {!mapsFilaments && (
                  <>
                    <ul className="filament-list">
                      {currentPlate.filaments.map((f) => (
                        <li key={f.id}>
                          <span className="tray-color" style={{ background: f.color || undefined }} />
                          {currentPlate.filaments.length > 1 && `Tool ${f.id - 1}: `}
                          {f.material || "Filament"}
                          <span className="hint"> · {f.used_g.toFixed(1)} g</span>
                        </li>
                      ))}
                    </ul>
                    {currentPlate.filaments.length === 0 && <p className="hint">The file doesn't say which filament.</p>}
                    <p className="hint">Make sure this is loaded on {selected.name}; it prints with whatever is.</p>
                  </>
                )}
                {mapsFilaments && (<>
                <table className="mapping-table">
                  <tbody>
                    {currentPlate.filaments.map((f) => {
                      const slot = mapping[f.id - 1] ?? -1;
                      return (
                        <tr key={f.id}>
                          <td>
                            <span className="tray-color" style={{ background: f.color }} />
                          </td>
                          <td>
                            {f.material}
                            <span className="hint"> · {f.used_g.toFixed(1)} g</span>
                          </td>
                          <td>→</td>
                          <td>
                            <select value={slot} onChange={(e) => setSlot(f.id, Number(e.target.value))}>
                              <option value={-1}>Choose a tray…</option>
                              {trays.map((t) => (
                                <option key={t.slot} value={t.slot}>
                                  {slotLabel(t)}: {t.name ?? t.material}
                                  {t.color ? ` (${t.color})` : ""}
                                  {t.material?.toUpperCase() !== f.material.toUpperCase() ? " ⚠ different material" : ""}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <span
                              className="tray-color"
                              style={{ background: trays.find((t) => t.slot === slot)?.color ?? undefined }}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {trays.length === 0 && (
                  <p className="hint">The printer reports no loaded filament yet.</p>
                )}
                </>)}

                {optionLabels.length > 0 && <h4>Options</h4>}
                <div className="send-options">
                  {optionLabels.map(([key, label, help]) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={options[key]}
                        onChange={(e) => setOptions((o) => ({ ...o, [key]: e.target.checked }))}
                      />{" "}
                      {label}
                      <span className="hint"> · {help}</span>
                    </label>
                  ))}
                </div>

                {problems.length > 0 && (
                  <div className="send-problems">
                    {problems.map((p) => (
                      <p key={p} className="printer-error">
                        {p}
                      </p>
                    ))}
                    <label>
                      <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Send
                      anyway (I've checked what's loaded)
                    </label>
                  </div>
                )}
              </>
            )}

            {data.uploads_denied && <div className="send-blocked">{data.uploads_denied}.</div>}
            {data.blocked.length > 0 && (
              <div className="send-blocked">
                <strong>This plate can't be sent:</strong> its G-code {data.blocked.join("; ")}. FarmSlicer can't
                tell what a printer would do with it. Re-slice it, or export it again from your slicer.
              </div>
            )}
            {review.length > 0 && data.blocked.length === 0 && (
              <div className="send-review">
                <strong>Its G-code does things Bambu's own G-code doesn't:</strong>
                <ul>
                  {review.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                {isAdmin ? (
                  <label>
                    <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />{" "}
                    I've reviewed these and want to print it anyway (recorded on the print)
                  </label>
                ) : (
                  <span>Sending asks an admin to review it; it prints once they approve.</span>
                )}
              </div>
            )}
            {data.needs_approval.length > 0 && (
              <div className="send-approval">
                <strong>Needs approval:</strong> {data.needs_approval.join("; ")}. Sending asks an admin or a
                manager of the job's group; it prints once they approve.
              </div>
            )}
            {error && <p className="printer-error">{error}</p>}
            <p className="hint">
              Is the plate clear? Handle build plates by their edges; if you touch the surface, clean it with
              isopropyl alcohol.
            </p>
            <div className="modal-actions">
              <button className="btn-sm" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary"
                style={{ width: "auto" }}
                disabled={
                  !selected ||
                  !!selected.incompatible ||
                  blocked ||
                  (review.length > 0 && isAdmin && !acknowledged) ||
                  (!!selected.busy && !waits) ||
                  sending ||
                  (problems.length > 0 && !force && !waits)
                }
                onClick={send}
              >
                {sending
                  ? "Sending…"
                  : waits
                    ? `Ask to print on ${selected?.name ?? "…"}`
                    : selected
                      ? `Print on ${selected.name}`
                      : "Print"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
