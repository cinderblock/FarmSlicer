import { useEffect, useState } from "react";
import { apiJson } from "../auth";
import { errorText, localDateTime, useJson } from "../api";
import {
  currentSubscription,
  permission,
  support,
  turnOff,
  turnOn,
  type Device,
  type NotificationSettings as Settings,
} from "../notifications";

/** The Account page's Notifications: this device on or off, what to be told about, the devices. */
export default function NotificationSettings() {
  const [rev, setRev] = useState(0);
  const loaded = useJson<Settings>("/api/me/notifications", rev);
  const [saved, setSaved] = useState<Settings | null>(null);
  const settings = saved ?? loaded.data;
  // This device's endpoint, once known ("" = not subscribed).
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const can = support();

  useEffect(() => {
    let cancelled = false;
    currentSubscription()
      .then((s) => !cancelled && setEndpoint(s?.endpoint ?? ""))
      .catch(() => !cancelled && setEndpoint(""));
    return () => {
      cancelled = true;
    };
  }, [rev]);

  const reload = () => {
    setSaved(null);
    setRev((r) => r + 1);
  };

  const devices = settings?.subscriptions ?? [];
  const here = endpoint ? devices.find((d) => d.endpoint === endpoint) : undefined;

  const act = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await what();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      reload();
    }
  };

  const toggle = async (event: string, relation: string, on: boolean) => {
    if (!settings) return;
    const current = settings.prefs[event] ?? [];
    const prefs = { ...settings.prefs, [event]: on ? [...current, relation] : current.filter((r) => r !== relation) };
    setSaved({ ...settings, prefs });
    setError("");
    try {
      setSaved(await apiJson<Settings>("/api/me/notifications", "PUT", { prefs }));
    } catch (err) {
      setError(errorText(err));
      reload();
    }
  };

  const remove = (d: Device) =>
    act(async () => {
      if (d === here) await turnOff();
      else await apiJson(`/api/me/notifications/subscriptions/${d.id}`, "DELETE");
    });

  const test = () =>
    act(async () => {
      const res = await apiJson<{ devices: number }>("/api/me/notifications/test", "POST");
      setNote(`Sent to ${res.devices === 1 ? "your device" : `your ${res.devices} devices`}.`);
    });

  return (
    <>
      <h3>Notifications</h3>
      <p className="hint">
        FarmSlicer can tell you on your phone or computer, even when it isn't open, when a print fails or needs
        you. Turn it on for each device you want them on.
      </p>

      {can === "install" && (
        <p className="hint warn">
          On iPhone and iPad, notifications only reach FarmSlicer on the Home Screen: tap Share, then Add to Home
          Screen, and open it from there.
        </p>
      )}
      {can === "insecure" && <p className="hint warn">Notifications need FarmSlicer's https address.</p>}
      {can === "unsupported" && <p className="hint warn">This browser can't receive notifications.</p>}
      {can === "ok" && settings && endpoint !== null && (
        <div className="notify-device">
          {here ? (
            <>
              <span>
                <strong>On</strong> for this device ({here.label}).
              </span>
              <button className="btn-sm" disabled={busy} onClick={test}>
                Send a test
              </button>
              <button className="btn-sm" disabled={busy} onClick={() => act(turnOff)}>
                Turn off here
              </button>
            </>
          ) : permission() === "denied" ? (
            <span className="hint warn">
              Notifications are blocked for this site. Allow them in the browser's site settings, then reload.
            </span>
          ) : (
            <button className="btn-primary" disabled={busy} onClick={() => act(() => turnOn(settings.key))}>
              {busy ? "Turning on…" : "Turn on notifications on this device"}
            </button>
          )}
        </div>
      )}
      {note && <p className="hint">{note}</p>}
      {error && <p className="login-error">{error}</p>}
      {loaded.error && !settings && <p className="login-error">{loaded.error}</p>}

      {settings && (
        <div className="printer-form notify-prefs">
          {settings.events.map((e) => (
            <fieldset key={e.event}>
              <legend>{e.label}</legend>
              {settings.relations
                // Approval requests come only for groups one manages (or every print, for admins).
                .filter((r) => e.event !== "print.approval_requested" || r.relation === "managed" || r.relation === "all")
                .map((r) => (
                  <label key={r.relation} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={(settings.prefs[e.event] ?? []).includes(r.relation)}
                      onChange={(ev) => toggle(e.event, r.relation, ev.target.checked)}
                    />
                    {r.label}
                  </label>
                ))}
            </fieldset>
          ))}
        </div>
      )}

      {devices.length > 0 && (
        <table className="data-table cards">
          <thead>
            <tr>
              <th>Device</th>
              <th>Turned on</th>
              <th>Last delivered</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td className="cell-title">
                  {d.label}
                  {d === here && <span className="hint"> (this device)</span>}
                  {d.last_error && <div className="hint warn">Last push failed: {d.last_error}</div>}
                </td>
                <td data-label="Turned on">{localDateTime(d.created_at)}</td>
                <td data-label="Last delivered">{d.last_success_at ? localDateTime(d.last_success_at) : "not yet"}</td>
                <td className="cell-actions">
                  <button className="btn-sm btn-danger" disabled={busy} onClick={() => remove(d)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
