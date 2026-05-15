import { StrictMode, useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router";
import Layout from "./components/Layout";
import SlicePage from "./pages/Slice";
import JobsPage from "./pages/Jobs";
import PrintersPage from "./pages/Printers";
import LibraryPage from "./pages/Library";
import ProfilesPage from "./pages/Profiles";
import LoginPage from "./pages/Login";
import "./index.css";

declare const __BUILD_VERSION__: string;

function useAutoRefresh(intervalMs = 30_000) {
  const currentVersion = useRef(__BUILD_VERSION__);
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const check = () => {
      fetch("/version.json", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.version && data.version !== currentVersion.current) {
            window.location.reload();
          }
        })
        .catch(() => {});
    };
    const id = setInterval(check, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

function App() {
  useAutoRefresh();

  const [authState, setAuthState] = useState<
    "loading" | "authenticated" | "login"
  >("loading");

  const checkAuth = () => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((data) => {
        if (!data.auth_required || data.authenticated) {
          setAuthState("authenticated");
        } else {
          setAuthState("login");
        }
      })
      .catch(() => {
        // If we can't reach the server, show the app anyway
        setAuthState("authenticated");
      });
  };

  useEffect(() => {
    checkAuth();
  }, []);

  if (authState === "loading") {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>FarmSlicer</h1>
          <p className="hint">Loading...</p>
        </div>
      </div>
    );
  }

  if (authState === "login") {
    return <LoginPage onLogin={() => setAuthState("authenticated")} />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<PrintersPage />} />
          <Route path="slice" element={<SlicePage />} />
          <Route path="jobs" element={<JobsPage />} />
          <Route path="printers" element={<PrintersPage />} />
          <Route path="profiles" element={<ProfilesPage />} />
          <Route path="library" element={<LibraryPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
