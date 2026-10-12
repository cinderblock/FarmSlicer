import { useState } from "react";
import { apiJson } from "../auth";
import { errorText, useJson } from "../api";
import { QuotaRulesEditor } from "../components/Quota";
import type { Rule } from "../groups";

interface SiteSettings {
  season_start: string;
  default_user_quotas: Rule[];
  default_guest_quotas: Rule[];
  guest_session_days: number;
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

        <button className="btn-primary" type="submit">
          Save
        </button>
        {saved && <p className="hint">Saved.</p>}
        {error && <p className="login-error">{error}</p>}
      </form>
    </div>
  );
}
