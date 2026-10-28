// Light or dark, per device: "System" (default) follows the device, "Hell"/"Dunkel" stay.
// index.html sets <html data-theme> before the first paint (no flash); this keeps it current.
import { useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "obtion.theme";
/** The page background per mode: browser bar and PWA status bar take it on. */
const BAR = { light: "#f7f6f3", dark: "#191919" } as const;

const media = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

export function themeChoice(): ThemeChoice {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function resolve(c = themeChoice()): "light" | "dark" {
  return c === "system" ? (media.matches ? "dark" : "light") : c;
}

function apply() {
  const r = resolve();
  document.documentElement.dataset.theme = r;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR[r]);
  document.querySelector('link[rel="icon"]')?.setAttribute("href", r === "dark" ? "/icon-dark.svg" : "/icon.svg");
  listeners.forEach((l) => l());
}

export function setTheme(c: ThemeChoice) {
  if (c === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, c);
  apply();
}

media.addEventListener("change", () => themeChoice() === "system" && apply());
window.addEventListener("storage", (e) => e.key === KEY && apply()); // another tab chose
apply();

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
/** The choice and what it shows now (for canvas drawings that read colours once). */
export function useTheme(): { choice: ThemeChoice; resolved: "light" | "dark" } {
  const choice = useSyncExternalStore(subscribe, themeChoice);
  const resolved = useSyncExternalStore(subscribe, () => resolve());
  return { choice, resolved };
}
