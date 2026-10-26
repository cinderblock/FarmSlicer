import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../auth";
import { useJson } from "../api";
import { FEEDBACK_CHANGED, newCount, prefillFor, type Counts, type FeedbackPrefill } from "../feedback";
import ErrorBoundary from "./ErrorBoundary";
import FeedbackDialog from "./FeedbackDialog";
import InstallApp from "./InstallApp";
import UpdateBanner from "./UpdateBanner";
import WhatsNewDialog from "./WhatsNewDialog";
import { notifyLocation, reloadedQuietly } from "../appUpdate";
import { CHANGELOG, type ChangelogEntry } from "../changelog";
import { localDay, markSeen, seenId, unseenEntries } from "../whatsNew";

const navItems = [
  { to: "/", label: "Printers" },
  { to: "/slice", label: "Slice" },
  { to: "/jobs", label: "Jobs" },
  { to: "/queue", label: "Queue" },
  { to: "/prints", label: "Prints" },
  { to: "/projects", label: "Projects" },
  { to: "/profiles", label: "Profiles" },
  { to: "/library", label: "Library" },
  { to: "/groups", label: "Groups" },
  { to: "/guide", label: "Guide" },
];

const adminItems = [
  { to: "/users", label: "Users" },
  { to: "/feedback", label: "Feedback" },
  { to: "/reports", label: "Reports" },
  { to: "/integrations", label: "Integrations" },
  { to: "/settings", label: "Settings" },
];

/** How often admins' sidebar checks for new feedback. */
const FEEDBACK_POLL_MS = 60_000;

export default function Layout() {
  const { user, isAdmin, status, logout } = useAuth();
  const location = useLocation();
  const items = isAdmin ? [...navItems, ...adminItems] : navItems;
  const [feedback, setFeedback] = useState<FeedbackPrefill | null>(null);
  const [poll, setPoll] = useState(0);
  useEffect(() => {
    if (!isAdmin) return;
    const reload = () => setPoll((p) => p + 1);
    const id = setInterval(reload, FEEDBACK_POLL_MS);
    window.addEventListener(FEEDBACK_CHANGED, reload);
    return () => {
      clearInterval(id);
      window.removeEventListener(FEEDBACK_CHANGED, reload);
    };
  }, [isAdmin]);
  const fresh = newCount(useJson<Counts>(isAdmin ? "/api/feedback/counts" : null, poll).data);

  // What's new: opens by itself with what this browser hasn't seen, unless
  // the page was reloaded for an update nobody was watching (then the
  // sidebar link carries a dot until someone opens it).
  const [start] = useState(() => ({
    entries: unseenEntries(CHANGELOG, seenId(), localDay(user?.created_at)),
    quiet: reloadedQuietly(),
  }));
  const [whatsNew, setWhatsNew] = useState<{ entries: ChangelogEntry[] | null } | null>(() =>
    start.entries.length > 0 && !start.quiet ? { entries: start.entries } : null,
  );
  const [unseen, setUnseen] = useState(() => start.entries.length > 0 && start.quiet);
  const closeWhatsNew = () => {
    if (CHANGELOG[0]) markSeen(CHANGELOG[0].id);
    setUnseen(false);
    setWhatsNew(null);
  };

  // A new build loads when someone goes to another page (appUpdate.ts):
  // the path, not the query, which pages change for their own reasons
  // (the Slice page's ?from= when taking a slice's settings back).
  useEffect(() => {
    notifyLocation(location.pathname);
  }, [location.pathname]);

  // Narrow screens: the sidebar is a drawer behind the top bar's menu button.
  // It is open for the location it was opened at, so any navigation (a link,
  // the back button) closes it.
  const [menuAt, setMenuAt] = useState<string | null>(null);
  const menuOpen = menuAt === location.key;
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuAt(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className={`app${menuOpen ? " menu-open" : ""}`}>
      <header className="topbar">
        <button
          className="topbar-menu"
          aria-label="Menu"
          aria-expanded={menuOpen}
          aria-controls="sidebar"
          onClick={() => setMenuAt(menuOpen ? null : location.key)}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {fresh > 0 && <span className="feedback-count">{fresh}</span>}
        </button>
        <span className="topbar-title">FarmSlicer</span>
      </header>
      <div className="sidebar-backdrop" onClick={() => setMenuAt(null)} />
      <nav className="sidebar" id="sidebar">
        <div className="sidebar-header">
          <h1>FarmSlicer</h1>
        </div>
        <ul className="nav-list">
          {items.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  `nav-link ${isActive ? "active" : ""}`
                }
              >
                {item.label}
                {item.to === "/feedback" && fresh > 0 && (
                  <span className="feedback-count" title={`${fresh} new`}>
                    {fresh}
                  </span>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="sidebar-user">
          <div className="sidebar-whats-new">
            <button
              className="link-button"
              onClick={() => {
                setMenuAt(null);
                setWhatsNew({ entries: null });
              }}
            >
              What's new
            </button>
            {unseen && <span className="whats-new-dot" title="Something changed since you last looked" />}
          </div>
          <InstallApp />
          <div className="sidebar-feedback">
            <button
              className="btn-sm"
              onClick={() => {
                setMenuAt(null);
                setFeedback(prefillFor(location.pathname, location.search));
              }}
              title="Report a problem or suggest something"
            >
              Send feedback
            </button>
            {!isAdmin && (
              <NavLink to="/feedback" className="link-button">
                My feedback
              </NavLink>
            )}
          </div>
          {status?.auth_disabled ? (
            <span className="hint" title="FARMSLICER_NO_AUTH is set on the server">
              auth disabled
            </span>
          ) : (
            <>
              <NavLink to="/account" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
                {user?.username ?? "account"}
                <span className="hint"> · {user?.kind === "guest" ? "guest" : user?.role}</span>
              </NavLink>
              <button className="btn-sm" onClick={() => logout()}>
                Log out
              </button>
            </>
          )}
        </div>
      </nav>
      <main className="content">
        <UpdateBanner />
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      {feedback && <FeedbackDialog prefill={feedback} onClose={() => setFeedback(null)} />}
      {whatsNew && <WhatsNewDialog entries={whatsNew.entries} onClose={closeWhatsNew} />}
    </div>
  );
}
