export const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";

/** "⌘J" on Apple devices, "Strg J" / "Ctrl J" elsewhere. */
export function shortcut(key: string, lang: string): string {
  return MOD === "⌘" ? `⌘${key}` : `${modName(lang)} ${key}`;
}
export function modName(lang: string): string {
  return MOD === "⌘" ? "⌘" : lang === "de" ? "Strg" : "Ctrl";
}

/** Below Tailwind `md`. */
export const PHONE = "(max-width: 767px)";

/** Touch as the main pointer: use bigger targets and pickers instead of typing. */
export const isCoarse = () => matchMedia("(pointer: coarse)").matches;
