// Light, dark, or whatever the system uses: remembered per browser.
// index.html applies the stored choice before the first paint (the same key
// and attribute), so a page never flashes the other theme; this module
// changes it afterwards.
import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "farmslicer.theme";
const CHANGED = "farmslicer:theme";

export function themeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** The theme actually showing. */
export function effectiveTheme(choice = themeChoice()): "light" | "dark" {
  if (choice !== "system") return choice;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  // The browser's own chrome (the address bar on phones, the installed
  // app's title bar) follows: the sidebar's colour.
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", effectiveTheme(choice) === "light" ? "#ffffff" : "#131823");
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
  apply(choice);
  window.dispatchEvent(new Event(CHANGED));
}

/** The next choice for a one-button toggle: system → light → dark → system. */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return choice === "system" ? "light" : choice === "light" ? "dark" : "system";
}

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState(themeChoice);
  useEffect(() => {
    const update = () => setChoice(themeChoice());
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    const onSystem = () => apply(themeChoice());
    window.addEventListener(CHANGED, update);
    window.addEventListener("storage", update);
    media?.addEventListener("change", onSystem);
    apply(themeChoice());
    return () => {
      window.removeEventListener(CHANGED, update);
      window.removeEventListener("storage", update);
      media?.removeEventListener("change", onSystem);
    };
  }, []);
  return [choice, setThemeChoice];
}
