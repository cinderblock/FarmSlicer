import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import Layout from "./components/Layout";
import SlicePage from "./pages/Slice";
import JobsPage from "./pages/Jobs";
import JobPage from "./pages/Job";
import PrintsPage from "./pages/Prints";
import ProjectsPage from "./pages/Projects";
import QueuePage from "./pages/Queue";
import IntegrationsPage from "./pages/Integrations";
import ProjectPage from "./pages/Project";
import GuidePage from "./pages/Guide";
import PrintersPage from "./pages/Printers";
import LibraryPage from "./pages/Library";
import ProfilesPage from "./pages/Profiles";
import LoginPage from "./pages/Login";
import SetupPage from "./pages/Setup";
import InvitePage from "./pages/Invite";
import RecoverPage from "./pages/Recover";
import UsersPage from "./pages/Users";
import AccountPage from "./pages/Account";
import GroupsPage from "./pages/Groups";
import GroupPage from "./pages/Group";
import JoinPage from "./pages/Join";
import SettingsPage from "./pages/Settings";
import FeedbackPage from "./pages/Feedback";
import ReportsPage from "./pages/Reports";
import ErrorBoundary from "./components/ErrorBoundary";
import { AuthProvider, useAuth } from "./auth";
import { installErrorReporting, setSignedIn } from "./errorReporting";
import { installUpdateWatch } from "./appUpdate";
import "./index.css";

// First, so errors while the app starts are caught too.
installErrorReporting();
installUpdateWatch();

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

/** Everything except the invite, recovery and join pages: setup → login → the app. */
function Gate() {
  const { status, offline, isAdmin } = useAuth();

  if (offline) return <Splash text="Cannot reach the server. Retrying…" />;
  if (!status) return <Splash text="Loading…" />;
  if (status.setup_required)
    return status.remote ? <Splash text="FarmSlicer isn't set up yet. Set it up from the local network." /> : <SetupPage />;
  if (!status.authenticated) return <LoginPage />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<PrintersPage />} />
        <Route path="slice" element={<SlicePage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="jobs/:id" element={<JobPage />} />
        <Route path="prints" element={<PrintsPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="queue" element={<QueuePage />} />
        <Route path="projects/:id" element={<ProjectPage />} />
        <Route path="guide" element={<GuidePage />} />
        <Route path="printers" element={<PrintersPage />} />
        <Route path="profiles" element={<ProfilesPage />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="groups" element={<GroupsPage />} />
        <Route path="groups/:id" element={<GroupPage />} />
        <Route path="users" element={isAdmin ? <UsersPage /> : <Navigate to="/" replace />} />
        <Route path="settings" element={isAdmin ? <SettingsPage /> : <Navigate to="/" replace />} />
        <Route path="feedback" element={<FeedbackPage />} />
        <Route path="reports" element={isAdmin ? <ReportsPage /> : <Navigate to="/" replace />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

/** Error reports wait in the browser until someone is signed in. */
function useReportingAuth() {
  const { status } = useAuth();
  useEffect(() => {
    if (status) setSignedIn(status.authenticated);
  }, [status]);
}

function App() {
  useReportingAuth();
  return (
    <BrowserRouter>
      <ErrorBoundary fullPage>
        <Routes>
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route path="/recover" element={<RecoverPage />} />
          <Route path="/join/group/:id" element={<JoinPage />} />
          <Route path="/join/:code" element={<JoinPage />} />
          <Route path="/*" element={<Gate />} />
        </Routes>
      </ErrorBoundary>
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
