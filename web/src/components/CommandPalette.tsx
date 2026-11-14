import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useJson } from "../api";
import type { NavSection } from "../nav";
import type { ThemeChoice } from "../theme";
import Icon, { type IconName } from "./Icon";
import { matchScore } from "../search";

// Ctrl+K: go anywhere or do something by typing. Pages, a few actions, and
// the printers, jobs and projects this account can see, matched by every
// word typed (in any order) against each entry's name and keywords.

interface Entry {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: IconName;
  keywords?: string;
  run: () => void;
}

interface Named {
  id: string;
  name?: string;
  model_name?: string;
  machine_profile?: string;
  status?: string;
}

const LIMIT_PER_GROUP = 6;

export default function CommandPalette({
  sections,
  onClose,
  onFeedback,
  onWhatsNew,
  onTheme,
  onLogout,
}: {
  sections: NavSection[];
  onClose: () => void;
  onFeedback: () => void;
  onWhatsNew: () => void;
  onTheme: (choice: ThemeChoice) => void;
  onLogout?: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const printers = useJson<Named[]>("/api/printers").data;
  const jobs = useJson<Named[]>("/api/jobs").data;
  const projects = useJson<Named[]>("/api/projects").data;

  useEffect(() => {
    input.current?.focus();
  }, []);

  const entries = useMemo<Entry[]>(() => {
    const go = (to: string) => () => navigate(to);
    const out: Entry[] = [];
    for (const section of sections) {
      for (const item of section.items) {
        out.push({
          id: `page:${item.to}`,
          label: item.label,
          hint: section.title,
          group: "Pages",
          icon: item.icon,
          keywords: item.keywords,
          run: go(item.to),
        });
      }
    }
    out.push(
      { id: "act:slice", label: "Slice a model", group: "Actions", icon: "slice", keywords: "new upload stl", run: go("/slice") },
      { id: "act:account", label: "Account and passkeys", group: "Actions", icon: "user", keywords: "profile notifications api key", run: go("/account") },
      { id: "act:feedback", label: "Send feedback", group: "Actions", icon: "feedback", keywords: "bug report problem idea", run: onFeedback },
      { id: "act:new", label: "What's new", group: "Actions", icon: "sparkles", keywords: "changelog release notes", run: onWhatsNew },
      { id: "act:light", label: "Light theme", group: "Actions", icon: "sun", keywords: "appearance colour color mode", run: () => onTheme("light") },
      { id: "act:dark", label: "Dark theme", group: "Actions", icon: "moon", keywords: "appearance colour color mode", run: () => onTheme("dark") },
      { id: "act:system", label: "System theme", group: "Actions", icon: "monitor", keywords: "appearance colour color mode auto", run: () => onTheme("system") },
    );
    if (onLogout) out.push({ id: "act:logout", label: "Log out", group: "Actions", icon: "logout", keywords: "sign out", run: onLogout });
    for (const p of printers ?? []) {
      out.push({ id: `printer:${p.id}`, label: p.name ?? "Printer", hint: p.machine_profile, group: "Printers", icon: "printer", keywords: p.machine_profile, run: go("/") });
    }
    for (const j of jobs ?? []) {
      out.push({ id: `job:${j.id}`, label: j.model_name ?? "Job", hint: j.status, group: "Jobs", icon: "jobs", run: go(`/jobs/${j.id}`) });
    }
    for (const p of projects ?? []) {
      out.push({ id: `project:${p.id}`, label: p.name ?? "Project", hint: p.status, group: "Projects", icon: "projects", run: go(`/projects/${p.id}`) });
    }
    return out;
  }, [sections, printers, jobs, projects, navigate, onFeedback, onWhatsNew, onTheme, onLogout]);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = entries
      .map((e, i) => ({ e, s: matchScore(words, e.label, e.keywords), i }))
      .filter((x) => x.s > 0)
      // Without a query: pages and actions only, in their order.
      .filter((x) => words.length > 0 || x.e.group === "Pages" || x.e.group === "Actions")
      .sort((a, b) => b.s - a.s || a.i - b.i);
    const perGroup = new Map<string, number>();
    const kept: Entry[] = [];
    for (const { e } of scored) {
      const n = perGroup.get(e.group) ?? 0;
      if (words.length > 0 && n >= LIMIT_PER_GROUP) continue;
      perGroup.set(e.group, n + 1);
      kept.push(e);
    }
    // Grouped in the order each group's best entry came.
    const order = [...new Set(kept.map((e) => e.group))];
    return order.flatMap((g) => kept.filter((e) => e.group === g));
  }, [entries, query]);

  const index = Math.min(active, Math.max(0, results.length - 1));

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (e: Entry | undefined) => {
    if (!e) return;
    onClose();
    e.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((index + 1) % Math.max(1, results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((index - 1 + results.length) % Math.max(1, results.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[index]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = "";
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search and commands" onKeyDown={onKeyDown}>
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Go to a page, printer, job or project…"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={results[index] ? `palette-${index}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-results" id="palette-results" role="listbox" ref={list}>
          {results.length === 0 && <div className="palette-empty">Nothing matches “{query}”.</div>}
          {results.map((e, i) => {
            const header = e.group !== lastGroup ? e.group : null;
            lastGroup = e.group;
            return (
              <div key={e.id}>
                {header && <div className="palette-group">{header}</div>}
                <div
                  id={`palette-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === index}
                  className={`palette-item${i === index ? " active" : ""}`}
                  onMouseMove={() => i !== index && setActive(i)}
                  onClick={() => choose(e)}
                >
                  <Icon name={e.icon} className="palette-icon" />
                  <span className="palette-label">{e.label}</span>
                  {e.hint && <span className="palette-hint">{e.hint}</span>}
                  {i === index && <Icon name="arrowRight" className="palette-go" size={14} />}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open
          </span>
          <span>
            <kbd>/</kbd> or <kbd>Ctrl K</kbd> anywhere
          </span>
        </div>
      </div>
    </div>
  );
}
