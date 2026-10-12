import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import Layout from "./components/Layout";
import SlicePage from "./pages/Slice";
import JobsPage from "./pages/Jobs";
import PrintersPage from "./pages/Printers";
import LibraryPage from "./pages/Library";
import ProfilesPage from "./pages/Profiles";
import LoginPage from "./pages/Login";
import SetupPage from "./pages/Setup";
import UsersPage from "./pages/Users";
import AccountPage from "./pages/Account";
import { AuthProvider, useAuth } from "./auth";
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

function Splash({ text }: { text: string }) {
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>FarmSlicer</h1>
        <p className="hint">{text}</p>
      </div>
    </div>
  );
}

function App() {
  useAutoRefresh();
  const { status, offline, isAdmin } = useAuth();

  if (offline) return <Splash text="Cannot reach the server. Retrying…" />;
  if (!status) return <Splash text="Loading…" />;
  if (status.setup_required) return <SetupPage />;
  if (!status.authenticated) return <LoginPage />;

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
          <Route path="account" element={<AccountPage />} />
          <Route path="users" element={isAdmin ? <UsersPage /> : <Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
