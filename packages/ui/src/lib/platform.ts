/** The modifier key as this platform names it: ⌘ on Apple devices, Strg/Ctrl elsewhere. */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";

/** A key hint as this platform and language name it: "⌘J" on Apple devices, "Strg J" / "Ctrl J" elsewhere. */
export function shortcut(key: string, lang: string): string {
  return MOD === "⌘" ? `⌘${key}` : `${modName(lang)} ${key}`;
}
export function modName(lang: string): string {
  return MOD === "⌘" ? "⌘" : lang === "de" ? "Strg" : "Ctrl";
}

/** A touch screen as the main pointer: bigger targets, pickers instead of typing. */
export const isCoarse = () => matchMedia("(pointer: coarse)").matches;
