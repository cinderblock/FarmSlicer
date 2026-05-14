import { useState, useEffect, useCallback } from "react";
import ProfileEditor from "../components/ProfileEditor";

interface CustomProfile {
  id: string;
  name: string;
  profile_type: string;
  base_profile: string;
  overrides: string;
  created_at: string;
  updated_at: string;
}

export default function ProfilesPage() {
  const [profiles, setProfiles] = useState<CustomProfile[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [profileType, setProfileType] = useState("process");
  const [baseProfile, setBaseProfile] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [bases, setBases] = useState<string[]>([]);
  const [error, setError] = useState("");

  const fetchProfiles = useCallback(async () => {
    const res = await fetch("/api/custom-profiles");
    setProfiles(await res.json());
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  useEffect(() => {
    if (!showForm) return;
    const endpoint =
      profileType === "process"
        ? "/api/profiles/processes"
        : "/api/profiles/filaments";
    fetch(endpoint)
      .then((r) => r.json())
      .then((data: { name: string }[]) => {
        setBases(data.map((d) => d.name));
        if (data.length > 0 && !data.some((d) => d.name === baseProfile)) {
          setBaseProfile(data[0].name);
        }
      })
      .catch(() => {});
  }, [showForm, profileType]);

  const resetForm = () => {
    setName("");
    setProfileType("process");
    setBaseProfile("");
    setOverrides({});
    setEditingId(null);
    setShowForm(false);
    setError("");
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    const overridesJson = JSON.stringify(overrides);

    if (editingId) {
      const res = await fetch(`/api/custom-profiles/${editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, overrides: overridesJson }),
      });
      if (!res.ok) {
        setError("Failed to update profile");
        return;
      }
    } else {
      const res = await fetch("/api/custom-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          profile_type: profileType,
          base_profile: baseProfile,
          overrides: overridesJson,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to create profile");
        return;
      }
    }

    resetForm();
    fetchProfiles();
  };

  const handleEdit = (p: CustomProfile) => {
    setName(p.name);
    setProfileType(p.profile_type);
    setBaseProfile(p.base_profile);
    try {
      setOverrides(JSON.parse(p.overrides));
    } catch {
      setOverrides({});
    }
    setEditingId(p.id);
    setShowForm(true);
    setError("");
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/custom-profiles/${id}`, { method: "DELETE" });
    fetchProfiles();
  };

  const overrideCount = (raw: string): number => {
    try {
      return Object.keys(JSON.parse(raw)).length;
    } catch {
      return 0;
    }
  };

  return (
    <div className="page">
      <h2>Custom Profiles</h2>
      <div className="page-actions">
        <button
          className="btn-primary"
          style={{ width: "auto" }}
          onClick={() => {
            if (showForm) resetForm();
            else setShowForm(true);
          }}
        >
          {showForm ? "Cancel" : "New Profile"}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: "1.5rem", maxWidth: 720 }}>
          <div className="printer-form">
            <label>
              Name
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Fast PLA"
              />
            </label>

            {!editingId && (
              <>
                <label>
                  Type
                  <select
                    value={profileType}
                    onChange={(e) => setProfileType(e.target.value)}
                  >
                    <option value="process">Process (print quality)</option>
                    <option value="filament">Filament</option>
                  </select>
                </label>
                <label>
                  Base Profile
                  <select
                    value={baseProfile}
                    onChange={(e) => setBaseProfile(e.target.value)}
                  >
                    {bases.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

            <ProfileEditor
              baseProfile={baseProfile}
              profileType={profileType}
              overrides={overrides}
              onChange={setOverrides}
            />

            {error && (
              <p style={{ color: "var(--error)", fontSize: "0.85rem" }}>
                {error}
              </p>
            )}

            <button
              className="btn-primary"
              onClick={handleSave}
              style={{ marginTop: "0.5rem" }}
            >
              {editingId ? "Update Profile" : "Create Profile"}
            </button>
          </div>
        </div>
      )}

      {profiles.length === 0 ? (
        <p className="empty-state">
          No custom profiles yet. Create one to save reusable setting overrides.
        </p>
      ) : (
        <div className="card-grid">
          {profiles.map((p) => (
            <div key={p.id} className="card profile-card">
              <div className="printer-header">
                <h3>{p.name}</h3>
                <span
                  className="profile-type-badge"
                  data-type={p.profile_type}
                >
                  {p.profile_type}
                </span>
              </div>
              <p className="hint">Based on: {p.base_profile}</p>
              <p className="hint">
                {overrideCount(p.overrides)} override
                {overrideCount(p.overrides) !== 1 ? "s" : ""}
              </p>
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  marginTop: "0.5rem",
                }}
              >
                <button className="btn-sm" onClick={() => handleEdit(p)}>
                  Edit
                </button>
                <button
                  className="btn-sm btn-danger"
                  onClick={() => handleDelete(p.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
