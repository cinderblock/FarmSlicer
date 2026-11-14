import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { printPath } from "../links";
import { apiJson } from "../auth";
import { errorText } from "../api";
import CameraView from "./CameraView";
import Icon from "./Icon";
import PrintControls from "./PrintControls";
import {
  describeState,
  formatMinutes,
  hmsCode,
  hmsHelpUrl,
  isBusy,
  printErrorCode,
  type Printer,
  type PrinterStatus,
  loadedTrays,
  plateLabel,
  PREHEAT_MATERIALS,
  type PrintRecord,
  slotLabel,
  type Tray,
  trayLeft,
} from "../printers";

function temp(t: { current: number; target: number }): string {
  const current = Math.round(t.current);
  return t.target > 0 ? `${current}/${Math.round(t.target)} °C` : `${current} °C`;
}

/** A temperature as a chip: warm while heating to a target. */
function TempChip({ label, icon, t }: { label: string; icon: "thermometer" | "bed" | "box"; t: { current: number; target: number } }) {
  const heating = t.target > 0;
  const reached = heating && Math.abs(t.current - t.target) <= 3;
  return (
    <span
      className={`temp-chip${heating ? " heating" : ""}${reached ? " reached" : ""}`}
      title={`${label}: ${temp(t)}${heating ? (reached ? " (at temperature)" : " (heating)") : ""}`}
    >
      <Icon name={icon} size={14} />
      <span className="temp-label">{label}</span>
      <span className="temp-value">{temp(t)}</span>
    </span>
  );
}

/** When a print with `minutes` left should end, as a local clock time. */
function finishAt(minutes: number): string {
  const end = new Date(Date.now() + minutes * 60_000);
  const sameDay = end.toDateString() === new Date().toDateString();
  const time = end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${end.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** A spool this low gets the warning colour. */
const LOW_PERCENT = 15;

function TraySwatch({ tray, active }: { tray: Tray; active: boolean }) {
  const label = tray.material ? `${tray.name ?? tray.material}, ${trayLeft(tray)}` : "Empty";
  const left = tray.remain_g != null ? `${tray.remain_g} g` : tray.remain != null ? `${tray.remain}%` : "?";
  const low = tray.remain != null && tray.remain <= LOW_PERCENT;
  return (
    <span
      className={`tray${active ? " tray-active" : ""}${tray.material ? "" : " tray-empty"}`}
      title={`${slotLabel(tray)}: ${label}${active ? " (feeding now)" : ""}`}
    >
      <span className="tray-color" style={tray.color ? { background: tray.color } : undefined} />
      <span className="tray-material">{tray.material ?? "—"}</span>
      {tray.material && (
        <span className={`tray-left${low ? " low" : ""}${tray.remain == null ? " unknown" : ""}`}>
          {left}
          {tray.remain != null && (
            <span className="tray-level" aria-hidden>
              <span style={{ width: `${tray.remain}%` }} />
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export default function PrinterCard({
  printer,
  status,
  print,
  managesPrinters,
  openReports,
  actions,
}: {
  printer: Printer;
  status: PrinterStatus | undefined;
  /** The FarmSlicer print using this printer, if any. */
  print?: PrintRecord;
  managesPrinters?: boolean;
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
  const job = status?.job_key ?? null;
  const caps = printer.capabilities;
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
        const body = slot.startsWith("material:") ? { material: slot.slice(9) } : { slot: Number(slot) };
        const r = await apiJson<{ nozzle: number; bed: number }>(`/api/printers/${printer.id}/preheat`, "POST", body);
        setNote(`Heating: nozzle ${r.nozzle} °C, bed ${r.bed} °C.`);
      }
    } catch (e) {
      setNote(errorText(e));
    }
    setHeatSlot("");
  };
  const configured = printer.configured;
  const busy = isBusy(status);

  return (
    <div className="card printer-card" data-tone={tone}>
      <div className="printer-header">
        <h3>
          {printer.name}
          {printer.dispatch?.send_mode === "yolo" && (
            <span className="send-mode-yolo" title={`Sends the next queued plate by itself, without asking (set by ${printer.dispatch.set_by ?? "?"})`}>
              YOLO
            </span>
          )}
          {printer.dispatch?.send_mode === "confirm" && (
            <span className="send-mode-confirm" title="Sends the next queued plate once someone says the bed is clear">
              auto
            </span>
          )}
        </h3>
        <span className={`printer-state tone-${tone}`}>
          <span className={`status-dot status-${tone}`} />
          {label}
        </span>
      </div>
      {printer.machine_profile && (
        <p className="hint printer-model">
          {printer.machine_profile}
          {printer.nozzle_diameter && ` · ${printer.nozzle_diameter} mm nozzle`}
          {printer.plate_type && ` · ${plateLabel(printer.plate_type)}`}
        </p>
      )}

      {!status && caps && (
        <p className="hint">
          {configured ? "Connecting…" : "Set the printer's address and credentials to connect."}
        </p>
      )}
      {!caps && <p className="hint">FarmSlicer can't talk to {printer.protocol || "these"} printers yet.</p>}
      {status && !status.online && status.connection_error && (
        <p className="printer-error">{status.connection_error}</p>
      )}

      {status?.online && (
        <>
          <div className="printer-temps">
            {status.nozzles.map((n, i) => (
              <TempChip key={i} icon="thermometer" label={status.nozzles.length > 1 ? (i === 0 ? "L" : "R") : "Nozzle"} t={n} />
            ))}
            {status.bed && <TempChip icon="bed" label="Bed" t={status.bed} />}
            {status.chamber != null && status.chamber > 0 && (
              <TempChip icon="box" label="Chamber" t={{ current: status.chamber, target: 0 }} />
            )}
          </div>
          {picture &&
            (print?.name ? (
              <Link to={printPath(print.id)} title="Watch it print, layer by layer">
                <img className="printer-picture" src={picture} alt="" onError={() => setMissingPicture(job)} />
              </Link>
            ) : (
              <img
                className="printer-picture"
                src={picture}
                alt=""
                title={status.job_name ?? undefined}
                onError={() => setMissingPicture(job)}
              />
            ))}
          {busy && (
            <div className="printer-job">
              <div className="printer-job-name" title={status.job_file ?? undefined}>
                {print?.name ? (
                  <Link to={printPath(print.id)} title="Watch it print, layer by layer">
                    {print.name}
                  </Link>
                ) : (
                  (status.job_name ?? "Untitled")
                )}
                {print?.username && <span className="hint"> · {print.username}</span>}
              </div>
              <div className="printer-progress">
                <span className="printer-percent">{status.percent != null ? `${status.percent}%` : "—"}</span>
                <span className="printer-progress-facts">
                  {status.remaining_minutes != null && (
                    <span title={`Should finish around ${finishAt(status.remaining_minutes)}`}>
                      <Icon name="clock" size={13} /> {formatMinutes(status.remaining_minutes)} left · {finishAt(status.remaining_minutes)}
                    </span>
                  )}
                  {status.total_layers && status.layer != null ? (
                    <span>
                      <Icon name="layers" size={13} /> Layer {status.layer} of {status.total_layers}
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="progress-bar progress-lg">
                <div className="progress-fill" style={{ width: `${status.percent ?? 0}%` }} />
              </div>
              {caps &&
                (print?.can_control ? (
                  <PrintControls print={print} capabilities={caps} status={status} />
                ) : (
                  managesPrinters && (
                    <PrintControls url={`/api/printers/${printer.id}/control`} capabilities={caps} status={status} />
                  )
                ))}
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

          {status.message && <p className="printer-error">{status.message}</p>}
          {status.print_error != null && (
            <p className="printer-error">
              {status.print_error_message ?? "Print error"}{" "}
              <span className="printer-error-code">{printErrorCode(status.print_error)}</span>
            </p>
          )}
          {status.hms.map((h) => (
            <p key={`${h.attr}-${h.code}`} className="printer-error">
              {h.message && <>{h.message} </>}
              <a
                className="printer-error-code"
                href={hmsHelpUrl(h)}
                target="_blank"
                rel="noreferrer"
                title="Bambu's help page for this code"
              >
                HMS {hmsCode(h)}
              </a>
            </p>
          ))}
        </>
      )}

      {status?.online &&
        caps?.heat &&
        !busy &&
        !print &&
        (loadedTrays(status).length > 0 ||
          !caps.filament_mapping ||
          status.nozzles.some((n) => n.target > 0) ||
          (status.bed?.target ?? 0) > 0) && (
        <label className="preheat">
          <Icon name="flame" size={15} />
          <select value={heatSlot} onChange={(e) => heat(e.target.value)} aria-label="Pre-heat">
            <option value="">Pre-heat for…</option>
            {loadedTrays(status).map((t) => (
                <option key={t.slot} value={t.slot}>
                  {t.name ?? t.material} ({t.slot >= 254 ? "external" : `slot ${t.slot + 1}`})
                  {t.remain_g != null || t.remain != null ? ` · ${trayLeft(t)}` : ""}
                </option>
              ))}
            {!caps.filament_mapping &&
              PREHEAT_MATERIALS.map((m) => (
                <option key={m} value={`material:${m}`}>
                  {m}
                </option>
              ))}
            {(status.nozzles.some((n) => n.target > 0) || (status.bed?.target ?? 0) > 0) && (
              <option value="off">Cool down</option>
            )}
          </select>
        </label>
      )}
      {note && <p className="hint">{note}</p>}
      {managesPrinters && !!openReports && (
        <p className="printer-error">
          <Icon name="alert" size={14} /> {openReports} open problem report{openReports === 1 ? "" : "s"}
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
        {caps?.camera && configured && (
          <button className="btn-sm" onClick={() => setCamera(true)}>
            <Icon name="camera" /> Camera
          </button>
        )}
        {!reporting && (
          <button className="btn-sm btn-ghost" onClick={() => setReporting(true)} title="Tell the admins something is wrong">
            <Icon name="alert" /> Report a problem
          </button>
        )}
        {actions && <span className="printer-admin-actions">{actions}</span>}
      </div>

      {camera && (
        <div className="modal-backdrop" onClick={() => setCamera(false)}>
          <div className="modal camera-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{printer.name}</h3>
              <button className="btn-sm btn-ghost btn-icon" onClick={() => setCamera(false)} aria-label="Close">
                <Icon name="x" />
              </button>
            </div>
            <CameraView printerId={printer.id} />
          </div>
        </div>
      )}
    </div>
  );
}
