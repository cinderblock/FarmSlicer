import { useState, useEffect, useCallback, useMemo } from "react";
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

interface MachineModel {
  name: string;
  vendor: string;
  vendor_display: string;
  nozzle_diameters: string[];
}

interface ProfileEntry {
  name: string;
  vendor: string;
}

type ViewMode = "browse" | "custom";

export default function ProfilesPage() {
  const [viewMode, setViewMode] = useState<ViewMode>("browse");

  // -- Browse state --
  const [models, setModels] = useState<MachineModel[]>([]);
  const [selectedVendor, setSelectedVendor] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedNozzle, setSelectedNozzle] = useState("");
  const [browseType, setBrowseType] = useState<"process" | "filament">(
    "process",
  );
  const [browseProfiles, setBrowseProfiles] = useState<ProfileEntry[]>([]);
  const [viewingProfile, setViewingProfile] = useState<string | null>(null);

  // -- Custom profiles state --
  const [profiles, setProfiles] = useState<CustomProfile[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [profileType, setProfileType] = useState("process");
  const [baseProfile, setBaseProfile] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  // -- Load machine models + custom profiles --
  const fetchProfiles = useCallback(async () => {
    const res = await fetch("/api/custom-profiles");
    setProfiles(await res.json());
  }, []);

  useEffect(() => {
    fetchProfiles();
    fetch("/api/profiles/machine-models")
      .then((r) => r.json())
      .then(setModels)
      .catch(() => {});
  }, [fetchProfiles]);

  // -- Manufacturer / model / nozzle cascade --
  const vendors = useMemo(() => {
    const v = [...new Set(models.map((m) => m.vendor_display))];
    v.sort();
    return v;
  }, [models]);

  const vendorModels = useMemo(
    () => models.filter((m) => m.vendor_display === selectedVendor),
    [models, selectedVendor],
  );

  const currentModel = models.find((m) => m.name === selectedModel);
  const nozzleOptions = currentModel?.nozzle_diameters ?? [];

  const resolvedMachine = useMemo(() => {
    if (!selectedModel) return "";
    return selectedNozzle
      ? `${selectedModel} ${selectedNozzle} nozzle`
      : selectedModel;
  }, [selectedModel, selectedNozzle]);

  const handleVendorChange = (vendor: string) => {
    setSelectedVendor(vendor);
    setSelectedModel("");
    setSelectedNozzle("");
  };

  const handleModelChange = (modelName: string) => {
    setSelectedModel(modelName);
    const m = models.find((x) => x.name === modelName);
    if (m && m.nozzle_diameters.length > 0) {
      setSelectedNozzle(
        m.nozzle_diameters.find((n) => n === "0.4") ?? m.nozzle_diameters[0],
      );
    } else {
      setSelectedNozzle("");
    }
  };

  // -- Fetch profiles for selected machine --
  useEffect(() => {
    if (!resolvedMachine) {
      setBrowseProfiles([]);
      return;
    }
    const endpoint =
      browseType === "process"
        ? `/api/profiles/processes?machine=${encodeURIComponent(resolvedMachine)}`
        : `/api/profiles/filaments?machine=${encodeURIComponent(resolvedMachine)}`;
    fetch(endpoint)
      .then((r) => r.json())
      .then((data: ProfileEntry[]) => setBrowseProfiles(data))
      .catch(() => setBrowseProfiles([]));
  }, [resolvedMachine, browseType]);

  // -- Custom profile CRUD --
  const resetForm = () => {
    setName("");
    setProfileType("process");
    setBaseProfile("");
    setOverrides({});
    setEditingId(null);
    setShowForm(false);
    setError("");
  };

  const startCustomize = (profileName: string, type: "process" | "filament") => {
    setViewMode("custom");
    setName("");
    setProfileType(type);
    setBaseProfile(profileName);
    setOverrides({});
    setEditingId(null);
    setShowForm(true);
    setError("");
    setViewingProfile(null);
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
    setViewMode("custom");
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
      <h2>Profiles</h2>

      <div className="profile-tabs">
        <button
          className={`profile-tab ${viewMode === "browse" ? "active" : ""}`}
          onClick={() => {
            setViewMode("browse");
            resetForm();
          }}
        >
          Browse Profiles
        </button>
        <button
          className={`profile-tab ${viewMode === "custom" ? "active" : ""}`}
          onClick={() => setViewMode("custom")}
        >
          Custom Profiles
          {profiles.length > 0 && (
            <span className="override-badge">{profiles.length}</span>
          )}
        </button>
      </div>

      {/* ── Browse OrcaSlicer Profiles ── */}
      {viewMode === "browse" && (
        <div className="browse-section">
          <div className="browse-filters">
            <label>
              Manufacturer
              <input
                type="text"
                list="profile-vendor-list"
                value={selectedVendor}
                onChange={(e) => handleVendorChange(e.target.value)}
                placeholder="Type to search..."
              />
              <datalist id="profile-vendor-list">
                {vendors.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </label>

            {vendorModels.length > 0 && (
              <label>
                Printer Model
                <select
                  value={selectedModel}
                  onChange={(e) => handleModelChange(e.target.value)}
                >
                  <option value="">Select model...</option>
                  {vendorModels.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {nozzleOptions.length > 0 && (
              <label>
                Nozzle Size
                <select
                  value={selectedNozzle}
                  onChange={(e) => setSelectedNozzle(e.target.value)}
                >
                  {nozzleOptions.map((n) => (
                    <option key={n} value={n}>
                      {n}mm
                    </option>
                  ))}
                </select>
              </label>
            )}

            {resolvedMachine && (
              <label>
                Profile Type
                <select
                  value={browseType}
                  onChange={(e) =>
                    setBrowseType(e.target.value as "process" | "filament")
                  }
                >
                  <option value="process">Process (print quality)</option>
                  <option value="filament">Filament</option>
                </select>
              </label>
            )}
          </div>

          {!resolvedMachine ? (
            <p className="empty-state">
              Select a manufacturer and model to browse available profiles.
            </p>
          ) : browseProfiles.length === 0 ? (
            <p className="empty-state">Loading profiles...</p>
          ) : (
            <>
              <p className="hint" style={{ marginBottom: "0.75rem" }}>
                {browseProfiles.length}{" "}
                {browseType === "process" ? "process" : "filament"} profile
                {browseProfiles.length !== 1 ? "s" : ""} for{" "}
                {resolvedMachine}
              </p>

              {viewingProfile && (
                <div
                  className="card"
                  style={{ marginBottom: "1rem", maxWidth: 720 }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "0.5rem",
                    }}
                  >
                    <h3 style={{ fontSize: "1rem" }}>{viewingProfile}</h3>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        className="btn-sm"
                        onClick={() =>
                          startCustomize(viewingProfile, browseType)
                        }
                      >
                        Customize
                      </button>
                      <button
                        className="btn-sm"
                        onClick={() => setViewingProfile(null)}
                      >
                        Close
                      </button>
                    </div>
                  </div>
                  <ProfileEditor
                    baseProfile={viewingProfile}
                    profileType={browseType}
                    overrides={{}}
                    onChange={() => {}}
                    readOnly
                  />
                </div>
              )}

              <div className="profile-list">
                {browseProfiles.map((p) => (
                  <div
                    key={p.name}
                    className={`profile-list-item ${viewingProfile === p.name ? "active" : ""}`}
                  >
                    <span className="profile-list-name">{p.name}</span>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        className="btn-sm"
                        onClick={() =>
                          setViewingProfile(
                            viewingProfile === p.name ? null : p.name,
                          )
                        }
                      >
                        {viewingProfile === p.name ? "Hide" : "View"}
                      </button>
                      <button
                        className="btn-sm"
                        onClick={() => startCustomize(p.name, browseType)}
                      >
                        Customize
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Custom Profiles ── */}
      {viewMode === "custom" && (
        <>
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
            <div
              className="card"
              style={{ marginBottom: "1.5rem", maxWidth: 720 }}
            >
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
                )}

                <label>
                  Base Profile
                  <input
                    type="text"
                    value={baseProfile}
                    readOnly={!!editingId}
                    onChange={(e) => setBaseProfile(e.target.value)}
                    placeholder="e.g. 0.20mm Standard @BBL X1C"
                  />
                  {editingId && (
                    <span className="hint" style={{ fontSize: "0.75rem" }}>
                      Base profile cannot be changed after creation
                    </span>
                  )}
                </label>

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

          {profiles.length === 0 && !showForm ? (
            <p className="empty-state">
              No custom profiles yet. Browse OrcaSlicer profiles and click
              "Customize" to create one, or use "New Profile" above.
            </p>
          ) : (
            !showForm && (
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
                      <button
                        className="btn-sm"
                        onClick={() => handleEdit(p)}
                      >
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
            )
          )}
        </>
      )}
    </div>
  );
}
