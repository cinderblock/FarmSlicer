import { useState } from "react";

interface LoginPageProps {
  onLogin: () => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      const data = await res.json();
      if (data.ok) {
        onLogin();
      } else {
        setError(data.error || "Login failed");
      }
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>FarmSlicer</h1>
        <form onSubmit={handleSubmit}>
          <label>
            Passphrase
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Enter passphrase"
              autoFocus
            />
          </label>
          <button className="btn-primary" type="submit" disabled={loading}>
            {loading ? "Logging in..." : "Log In"}
          </button>
          {error && <p className="login-error">{error}</p>}
        </form>
      </div>
    </div>
  );
}
