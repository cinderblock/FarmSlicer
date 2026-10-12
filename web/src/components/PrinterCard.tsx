import { useState, type ReactNode } from "react";
import { apiJson } from "../auth";
import { errorText } from "../api";
import CameraView from "./CameraView";
import PrintControls from "./PrintControls";
import {
  describeState,
  formatMinutes,
  hmsCode,
  printErrorCode,
  type Printer,
  type PrinterStatus,
  loadedTrays,
  type PrintRecord,
  type Tray,
} from "../printers";

function temp(t: { current: number; target: number }): string {
  const current = Math.round(t.current);
  return t.target > 0 ? `${current}/${Math.round(t.target)} °C` : `${current} °C`;
}

function TraySwatch({ tray, active }: { tray: Tray; active: boolean }) {
  const label = tray.material
    ? [tray.name ?? tray.material, tray.remain != null ? `${tray.remain}% left` : null]
        .filter(Boolean)
        .join(", ")
    : "Empty";
  return (
    <span
      className={`tray${active ? " tray-active" : ""}${tray.material ? "" : " tray-empty"}`}
      title={`Slot ${tray.slot}: ${label}${active ? " (feeding now)" : ""}`}
    >
      <span className="tray-color" style={tray.color ? { background: tray.color } : undefined} />
      <span className="tray-material">{tray.material ?? "—"}</span>
    </span>
  );
}

export default function PrinterCard({
  printer,
  status,
  print,
  isAdmin,
  openReports,
  actions,
}: {
  printer: Printer;
  status: PrinterStatus | undefined;
  /** The FarmSlicer print using this printer, if any. */
  print?: PrintRecord;
  isAdmin?: boolean;
  /** Open problem reports (admins). */
  openReports?: number;
  /** Admin buttons. */
  actions?: ReactNode;
}) {
  const { label, tone } = describeState(status);
  const [camera, setCamera] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [report, setReport] = useState("");
  const [note, setNote] = useState("");
  const [heatSlot, setHeatSlot] = useState("");
  // The current or last job's picture (hidden when there is none).
  const job = status?.subtask_name && status.subtask_name !== "project_file" ? status.subtask_name : null;
  const [missingPicture, setMissingPicture] = useState<string | null>(null);
  const picture =
    status?.online && job && job !== missingPicture && status.state !== "IDLE"
      ? `/api/printers/${printer.id}/thumbnail?job=${encodeURIComponent(job)}`
      : null;

  const sendReport = async () => {
    try {
      await apiJson(`/api/printers/${printer.id}/reports`, "POST", { description: report });
      setReporting(false);
      setReport("");
      setNote("Thanks, an admin will have a look.");
    } catch (e) {
      setNote(errorText(e));
    }
  };

  const heat = async (slot: string) => {
    setNote("");
    try {
      if (slot === "off") {
        await apiJson(`/api/printers/${printer.id}/cooldown`, "POST", {});
        setNote("Cooling down.");
      } else {
        const r = await apiJson<{ nozzle: number; bed: number }>(`/api/printers/${printer.id}/preheat`, "POST", {
          slot: Number(slot),
        });
        setNote(`Heating: nozzle ${r.nozzle} °C, bed ${r.bed} °C.`);
      }
    } catch (e) {
      setNote(errorText(e));
    }
    setHeatSlot("");
  };
  const configured = printer.protocol !== "bambu" || (printer.address && printer.access_code_set);
  const busy = status?.online && ["RUNNING", "PREPARE", "PAUSE"].includes(status.state ?? "");

  return (
    <div className="card printer-card">
      <div className="printer-header">
        <h3>{printer.name}</h3>
        <span className="printer-state">
          {label}
          <span className={`status-dot status-${tone}`} />
        </span>
      </div>
      {printer.machine_profile && (
        <p className="hint">
          {printer.machine_profile}
          {printer.nozzle_diameter && ` · ${printer.nozzle_diameter} mm nozzle`}
        </p>
      )}

      {!status && printer.protocol === "bambu" && (
        <p className="hint">
          {configured
            ? "Connecting…"
            : "Set the IP address, serial number and access code to connect."}
        </p>
      )}
      {status && !status.online && status.connection_error && (
        <p className="printer-error">{status.connection_error}</p>
      )}

      {status?.online && (
        <>
          {picture && (
            <img
              className="printer-picture"
              src={picture}
              alt=""
              title={status.job_name ?? undefined}
              onError={() => setMissingPicture(job)}
            />
          )}
          {busy && (
            <div className="printer-job">
              <div className="printer-job-name" title={status.gcode_file ?? undefined}>
                {print?.name ?? status.job_name ?? "Untitled"}
                {print?.username && <span className="hint"> · {print.username}</span>}
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${status.percent ?? 0}%` }} />
              </div>
              <div className="hint">
                {[
                  status.percent != null ? `${status.percent}%` : null,
                  status.total_layers ? `layer ${status.layer ?? 0}/${status.total_layers}` : null,
                  status.remaining_minutes != null
                    ? `${formatMinutes(status.remaining_minutes)} left`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {print?.can_control ? (
                <PrintControls print={print} state={status.state} speed={status.speed_level} />
              ) : (
                isAdmin && (
                  <PrintControls
                    url={`/api/printers/${printer.id}/control`}
                    state={status.state}
                    speed={status.speed_level}
                  />
                )
              )}
            </div>
          )}
          {print && ["uploading", "starting"].includes(print.status) && (
            <div className="printer-job">
              <div className="printer-job-name">
                {print.status === "uploading" ? "Uploading" : "Starting"} {print.name ?? "a print"}
                {print.username && <span className="hint"> · {print.username}</span>}
              </div>
              {print.status === "uploading" && (
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${print.progress}%` }} />
                </div>
              )}
            </div>
          )}
          {!busy && status.state === "FINISH" && status.job_name && (
            <p className="hint">Last print: {status.job_name}</p>
          )}

          <p className="hint printer-temps">
            {status.nozzles.map((n, i) => (
              <span key={i}>
                {status.nozzles.length > 1 ? `Nozzle ${i + 1}` : "Nozzle"} {temp(n)}
              </span>
            ))}
            {status.bed && <span>Bed {temp(status.bed)}</span>}
            {status.chamber != null && status.chamber > 0 && (
              <span>Chamber {Math.round(status.chamber)} °C</span>
            )}
          </p>

          {(status.ams.length > 0 || status.external.length > 0) && (
            <div className="printer-trays">
              {status.ams.map((unit) => (
                <div key={unit.id} className="ams-unit" title={unit.humidity != null ? `AMS ${unit.id + 1}, humidity level ${unit.humidity}` : `AMS ${unit.id + 1}`}>
                  {unit.trays.map((t) => (
                    <TraySwatch key={t.slot} tray={t} active={status.active_slot === t.slot} />
                  ))}
                </div>
              ))}
              {status.external.map((t) => (
                <div key={t.slot} className="ams-unit external" title="External spool">
                  <TraySwatch tray={t} active={status.active_slot === t.slot} />
                </div>
              ))}
            </div>
          )}

          {status.print_error != null && (
            <p className="printer-error">Print error {printErrorCode(status.print_error)}</p>
          )}
          {status.hms.map((h) => (
            <p key={`${h.attr}-${h.code}`} className="printer-error">
              <a
                href={`https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/${hmsCode(h)}`}
                target="_blank"
                rel="noreferrer"
              >
                HMS {hmsCode(h)}
              </a>
            </p>
          ))}
        </>
      )}

      {status?.online &&
        !busy &&
        !print &&
        (loadedTrays(status).length > 0 || status.nozzles.some((n) => n.target > 0) || (status.bed?.target ?? 0) > 0) && (
        <label className="preheat">
          <select value={heatSlot} onChange={(e) => heat(e.target.value)}>
            <option value="">Pre-heat for…</option>
            {loadedTrays(status).map((t) => (
                <option key={t.slot} value={t.slot}>
                  {t.name ?? t.material} ({t.slot >= 254 ? "external" : `slot ${t.slot + 1}`})
                </option>
              ))}
            {(status.nozzles.some((n) => n.target > 0) || (status.bed?.target ?? 0) > 0) && (
              <option value="off">Cool down</option>
            )}
          </select>
        </label>
      )}
      {note && <p className="hint">{note}</p>}
      {isAdmin && !!openReports && (
        <p className="printer-error">
          {openReports} open problem report{openReports === 1 ? "" : "s"}
        </p>
      )}
      {reporting && (
        <div className="report-form">
          <textarea
            value={report}
            onChange={(e) => setReport(e.target.value)}
            placeholder="What's wrong? (clogged nozzle, plate missing, odd noise…)"
            rows={3}
            maxLength={2000}
          />
          <span className="print-controls">
            <button className="btn-sm" disabled={!report.trim()} onClick={sendReport}>
              Send report
            </button>
            <button className="btn-sm" onClick={() => setReporting(false)}>
              Cancel
            </button>
          </span>
        </div>
      )}

      <div className="printer-actions">
        {printer.protocol === "bambu" && printer.address && printer.access_code_set && (
          <button className="btn-sm" onClick={() => setCamera(true)}>
            Camera
          </button>
        )}
        {!reporting && (
          <button className="btn-sm" onClick={() => setReporting(true)} title="Tell the admins something is wrong">
            Report a problem
          </button>
        )}
        {actions}
      </div>

      {camera && (
        <div className="modal-backdrop" onClick={() => setCamera(false)}>
          <div className="modal camera-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{printer.name}</h3>
              <button className="btn-sm" onClick={() => setCamera(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <CameraView printerId={printer.id} />
          </div>
        </div>
      )}
    </div>
  );
}
