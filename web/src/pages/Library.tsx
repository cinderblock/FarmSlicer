import { useState, useEffect, useCallback } from "react";

interface SliceRecord {
  id: string;
  model_name: string;
  print_time_sec: number;
  filament_used_g: number;
  file_size: number;
  created_at: string;
}

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function LibraryPage() {
  const [slices, setSlices] = useState<SliceRecord[]>([]);

  const fetchSlices = useCallback(async () => {
    const res = await fetch("/api/slices");
    setSlices(await res.json());
  }, []);

  useEffect(() => {
    fetchSlices();
  }, [fetchSlices]);

  return (
    <div className="page">
      <h2>Slice Library</h2>
      {slices.length === 0 ? (
        <p className="empty-state">
          No slices yet. Completed slice jobs will appear here.
        </p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Date</th>
              <th>Print Time</th>
              <th>Filament</th>
              <th>Size</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {slices.map((s) => (
              <tr key={s.id}>
                <td>{s.model_name}</td>
                <td>{new Date(s.created_at + "Z").toLocaleDateString()}</td>
                <td>{formatTime(s.print_time_sec)}</td>
                <td>{s.filament_used_g.toFixed(1)}g</td>
                <td>{formatSize(s.file_size)}</td>
                <td>
                  <a
                    className="btn-sm"
                    href={`/api/slices/${s.id}/download`}
                    download
                  >
                    Download
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
