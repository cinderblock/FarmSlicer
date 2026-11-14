import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth";
import { useJson } from "../api";
import { FEEDBACK_CHANGED, newCount, prefillFor, type Counts, type FeedbackPrefill } from "../feedback";
import ErrorBoundary from "./ErrorBoundary";
import FeedbackDialog from "./FeedbackDialog";
import InstallApp from "./InstallApp";
import CommandPalette from "./CommandPalette";
import Icon, { BrandMark } from "./Icon";
import { pageTitle, visibleSections } from "../nav";
import { nextTheme, useTheme } from "../theme";
import UpdateBanner from "./UpdateBanner";
import WhatsNewDialog from "./WhatsNewDialog";
import { notifyLocation, reloadedQuietly } from "../appUpdate";
import { onOpenRequest } from "../serviceWorker";
import { sourceUrl } from "../source";
import { CHANGELOG, type ChangelogEntry } from "../changelog";
import { localDay, markSeen, seenId, unseenEntries } from "../whatsNew";

/** How often admins' sidebar checks for new feedback. */
const FEEDBACK_POLL_MS = 60_000;

export default function Layout() {
  const { user, can, status, logout } = useAuth();
  const triages = can("feedback.triage");
  const location = useLocation();
  const sections = visibleSections(can);
  const [feedback, setFeedback] = useState<FeedbackPrefill | null>(null);
  const [poll, setPoll] = useState(0);
  useEffect(() => {
    if (!triages) return;
    const reload = () => setPoll((p) => p + 1);
    const id = setInterval(reload, FEEDBACK_POLL_MS);
    window.addEventListener(FEEDBACK_CHANGED, reload);
    return () => {
      clearInterval(id);
      window.removeEventListener(FEEDBACK_CHANGED, reload);
    };
  }, [triages]);
  const fresh = newCount(useJson<Counts>(triages ? "/api/feedback/counts" : null, poll).data);

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

  useEffect(() => {
    document.title = pageTitle(location.pathname);
  }, [location.pathname]);

  // A tapped notification opens its page here (sw.js).
  const navigate = useNavigate();
  useEffect(() => onOpenRequest((path) => navigate(path)), [navigate]);

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

  const [theme, setTheme] = useTheme();
  const [palette, setPalette] = useState(false);
  // Ctrl+K / Cmd+K (and "/" outside a field) opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const field = e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable]");
      if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === "/" && !field && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (document.querySelector(".modal-backdrop")) return;
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const themeLabel = theme === "system" ? "System theme" : theme === "light" ? "Light theme" : "Dark theme";

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
          <Icon name="menu" size={22} />
          {fresh > 0 && <span className="feedback-count">{fresh}</span>}
        </button>
        <span className="topbar-title">
          <BrandMark size={22} />
          FarmSlicer
        </span>
        <button className="topbar-search" aria-label="Search" onClick={() => setPalette(true)}>
          <Icon name="search" size={20} />
        </button>
      </header>
      <div className="sidebar-backdrop" onClick={() => setMenuAt(null)} />
      <nav className="sidebar" id="sidebar">
        <div className="sidebar-header">
          <BrandMark size={30} />
          <h1>
            FarmSlicer<span className="tm">™</span>
          </h1>
        </div>
        <button
          className="sidebar-search"
          onClick={() => {
            setMenuAt(null);
            setPalette(true);
          }}
        >
          <Icon name="search" />
          <span>Search…</span>
          <kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <div className="nav-sections">
          {sections.map((section) => (
            <div className="nav-section" key={section.title}>
              <div className="nav-section-title">{section.title}</div>
              <ul className="nav-list">
                {section.items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === "/"}
                      className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
                    >
                      <Icon name={item.icon} className="nav-icon" />
                      <span className="nav-label">{item.label}</span>
                      {item.to === "/feedback" && fresh > 0 && (
                        <span className="feedback-count" title={`${fresh} new`}>
                          {fresh}
                        </span>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="sidebar-user">
          <div className="sidebar-actions">
            <button
              className="sidebar-action"
              onClick={() => {
                setMenuAt(null);
                setWhatsNew({ entries: null });
              }}
            >
              <Icon name="sparkles" />
              What's new
              {unseen && <span className="whats-new-dot" title="Something changed since you last looked" />}
            </button>
            <button
              className="sidebar-action"
              onClick={() => {
                setMenuAt(null);
                setFeedback(prefillFor(location.pathname, location.search));
              }}
              title="Report a problem or suggest something"
            >
              <Icon name="feedback" />
              Send feedback
            </button>
            {!triages && (
              <NavLink to="/feedback" className="sidebar-action">
                <Icon name="list" />
                My feedback
              </NavLink>
            )}
            <InstallApp />
          </div>
          <div className="sidebar-account">
            {status?.auth_disabled ? (
              <span className="sidebar-who" title="FARMSLICER_NO_AUTH is set on the server">
                <span className="avatar">
                  <Icon name="user" size={16} />
                </span>
                <span className="sidebar-who-text">
                  <span className="sidebar-who-name">dev</span>
                  <span className="sidebar-who-role">auth disabled</span>
                </span>
              </span>
            ) : (
              <NavLink
                to="/account"
                className={({ isActive }) => `sidebar-who ${isActive ? "active" : ""}`}
                title="Your account"
              >
                <span className="avatar">{(user?.username ?? "?").slice(0, 1).toUpperCase()}</span>
                <span className="sidebar-who-text">
                  <span className="sidebar-who-name">{user?.username ?? "account"}</span>
                  <span className="sidebar-who-role">{user?.kind === "guest" ? "guest" : (user?.role_name ?? user?.role)}</span>
                </span>
              </NavLink>
            )}
            <button
              className="btn-sm btn-ghost btn-icon"
              onClick={() => setTheme(nextTheme(theme))}
              title={`${themeLabel} (click to change)`}
              aria-label={themeLabel}
            >
              <Icon name={theme === "system" ? "monitor" : theme === "light" ? "sun" : "moon"} />
            </button>
            {!status?.auth_disabled && (
              <button className="btn-sm btn-ghost btn-icon" onClick={() => logout()} title="Log out" aria-label="Log out">
                <Icon name="logout" />
              </button>
            )}
          </div>
          <div className="sidebar-source">
            <a
              href={sourceUrl(status?.source_url)}
              target="_blank"
              rel="noopener noreferrer"
              title="FarmSlicer is free software (AGPL): the source code of this version"
            >
              Source code
            </a>
            <span aria-hidden="true">·</span>
            <a
              href="/THIRD-PARTY-NOTICES.txt"
              target="_blank"
              rel="noopener noreferrer"
              title="FarmSlicer's licence and those of the software it includes"
            >
              Licences
            </a>
          </div>
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
      {palette && (
        <CommandPalette
          sections={sections}
          onClose={() => setPalette(false)}
          onFeedback={() => setFeedback(prefillFor(location.pathname, location.search))}
          onWhatsNew={() => setWhatsNew({ entries: null })}
          onTheme={setTheme}
          onLogout={status?.auth_disabled ? undefined : logout}
        />
      )}
    </div>
  );
}
