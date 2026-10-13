import { useState } from "react";
import { apiJson } from "../auth";
import { errorText, useJson } from "../api";
import { QuotaRulesEditor } from "../components/Quota";
import type { Rule } from "../groups";
import PrintRulesEditor from "../components/PrintRulesEditor";
import { UPLOAD_POLICIES, type GcodeLimits, type Prices, type PrintRules, type UploadPolicy } from "../printers";

interface SiteSettings {
  season_start: string;
  default_user_quotas: Rule[];
  default_guest_quotas: Rule[];
  guest_session_days: number;
  print_rules: PrintRules;
  filament_prices: Prices;
  guide_notes: string;
  uploads: UploadPolicy;
  gcode_limits: GcodeLimits;
}

/** /settings (admins): site-wide defaults. Group-level settings live on each group's page. */
export default function SettingsPage() {
  const [rev, setRev] = useState(0);
  const settings = useJson<SiteSettings>("/api/settings", rev);
  if (settings.error) return <div className="page"><p className="login-error">{settings.error}</p></div>;
  if (!settings.data) return <div className="page"><p className="hint">Loading…</p></div>;
  return <SettingsForm key={rev} initial={settings.data} onSaved={() => setRev((r) => r + 1)} />;
}

function SettingsForm({ initial, onSaved }: { initial: SiteSettings; onSaved: () => void }) {
  const [s, setS] = useState(initial);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaved(false);
    try {
      await apiJson("/api/settings", "PUT", s);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="page">
      <h2>Settings</h2>
      <p className="hint">
        Site-wide defaults. Groups have their own settings and limits (Groups page); a user's own limits can be
        changed on the Users page.
      </p>
      <form className="printer-form settings-form" onSubmit={save}>
        <label>
          Season starts (MM-DD)
          <input
            value={s.season_start}
            onChange={(e) => setS({ ...s, season_start: e.target.value })}
            pattern="[0-1][0-9]-[0-3][0-9]"
            required
          />
          <span className="hint">For per-season limits and libraries, unless a group sets its own.</span>
        </label>

        <h3>Default limits for every account</h3>
        <p className="hint">Each account's own jobs, wherever they're charged. Empty = no limit.</p>
        <QuotaRulesEditor rules={s.default_user_quotas} onChange={(r) => setS({ ...s, default_user_quotas: r })} />

        <h3>Default limits for guest accounts</h3>
        <p className="hint">Replace the above for guests (accounts without a passkey).</p>
        <QuotaRulesEditor rules={s.default_guest_quotas} onChange={(r) => setS({ ...s, default_guest_quotas: r })} />

        <label>
          Guests stay signed in for (days)
          <input
            type="number"
            min={1}
            max={3650}
            value={s.guest_session_days}
            onChange={(e) => setS({ ...s, guest_session_days: Number(e.target.value) })}
          />
          <span className="hint">Applies to new guest sign-ins.</span>
        </label>

        <h3>Print rules</h3>
        <p className="hint">For personal jobs and for groups that set none.</p>
        <PrintRulesEditor rules={s.print_rules ?? {}} onChange={(r) => setS({ ...s, print_rules: r })} />

        <h3>Sliced files and G-code checks</h3>
        <p className="hint">
          Every plate's G-code is checked before it's sent: FarmSlicer runs it through a model of the printer
          and compares it with what Bambu's own G-code does. Plates it can't read safely are never sent; plates
          that do something unusual wait for an admin's approval.
        </p>
        <label>
          Uploaded sliced files (.gcode.3mf)
          <select value={s.uploads} onChange={(e) => setS({ ...s, uploads: e.target.value as UploadPolicy })}>
            {UPLOAD_POLICIES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <span className="hint">For personal jobs and groups that set none. Admins and group managers are exempt.</span>
        </label>
        <GcodeLimitsEditor limits={s.gcode_limits} onChange={(l) => setS({ ...s, gcode_limits: l })} />

        <h3>Guide</h3>
        <label>
          Notes for the Guide page
          <textarea
            rows={8}
            maxLength={20000}
            value={s.guide_notes ?? ""}
            onChange={(e) => setS({ ...s, guide_notes: e.target.value })}
            placeholder="Opening hours, who to ask, where the build plates live, which printers are for what…"
          />
          <span className="hint">Plain text; blank lines start paragraphs, links work.</span>
        </label>

        <h3>Filament prices</h3>
        <p className="hint">Per kilogram, for the cost estimates on jobs and prints.</p>
        <PricesEditor prices={s.filament_prices} onChange={(p) => setS({ ...s, filament_prices: p })} />

        <button className="btn-primary" type="submit">
          Save
        </button>
        {saved && <p className="hint">Saved.</p>}
        {error && <p className="login-error">{error}</p>}
      </form>
    </div>
  );
}

function GcodeLimitsEditor({ limits, onChange }: { limits: GcodeLimits; onChange: (l: GcodeLimits) => void }) {
  const field = (key: keyof GcodeLimits, label: string, hint: string, unit: string, scale: number, min: number, max: number) => (
    <label key={key}>
      {label} ({unit})
      <input
        type="number"
        min={min}
        max={max}
        step="any"
        value={Math.round((limits[key] / scale) * 100) / 100}
        onChange={(e) => onChange({ ...limits, [key]: Number(e.target.value) * scale })}
      />
      <span className="hint">{hint}</span>
    </label>
  );
  return (
    <>
      {field("max_dwell_sec", "Longest single pause", "A longer G4 or M400 wait needs review.", "minutes", 60, 1, 1440)}
      {field(
        "max_heated_idle_sec",
        "Longest a heater may stay on with nothing printed",
        "Longer needs review.",
        "minutes",
        60,
        1,
        1440,
      )}
      {field(
        "nozzle_margin_c",
        "Nozzle margin",
        "How far past the hottest vendor profile of a material the nozzle may go.",
        "°C",
        1,
        0,
        50,
      )}
      {field("bed_margin_c", "Plate margin", "The same for the plate.", "°C", 1, 0, 50)}
      {field(
        "reach_margin_mm",
        "Reach margin",
        "How far past the printer's own G-code moves (and its print area) the nozzle may go.",
        "mm",
        1,
        0,
        50,
      )}
    </>
  );
}

function PricesEditor({ prices, onChange }: { prices: Prices; onChange: (p: Prices) => void }) {
  const [newMaterial, setNewMaterial] = useState("");
  const rows = Object.entries(prices.per_kg);
  const setPrice = (material: string, value: number) =>
    onChange({ ...prices, per_kg: { ...prices.per_kg, [material]: value } });
  const remove = (material: string) => {
    const per_kg = { ...prices.per_kg };
    delete per_kg[material];
    onChange({ ...prices, per_kg });
  };
  return (
    <div className="prices-editor">
      <label>
        Currency symbol
        <input value={prices.currency} maxLength={8} onChange={(e) => onChange({ ...prices, currency: e.target.value })} />
      </label>
      <label>
        Any other material ({prices.currency}/kg)
        <input
          type="number"
          min={0}
          step={0.01}
          value={prices.default_per_kg}
          onChange={(e) => onChange({ ...prices, default_per_kg: Number(e.target.value) })}
        />
      </label>
      <table className="data-table">
        <thead>
          <tr>
            <th>Material</th>
            <th>{prices.currency}/kg</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([material, price]) => (
            <tr key={material}>
              <td>{material}</td>
              <td>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={price}
                  onChange={(e) => setPrice(material, Number(e.target.value))}
                />
              </td>
              <td>
                <button type="button" className="btn-sm" onClick={() => remove(material)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
          <tr>
            <td>
              <input value={newMaterial} placeholder="e.g. PETG-HF" onChange={(e) => setNewMaterial(e.target.value)} />
            </td>
            <td colSpan={2}>
              <button
                type="button"
                className="btn-sm"
                disabled={!newMaterial.trim() || newMaterial.trim() in prices.per_kg}
                onClick={() => {
                  setPrice(newMaterial.trim(), prices.default_per_kg);
                  setNewMaterial("");
                }}
              >
                Add material
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
