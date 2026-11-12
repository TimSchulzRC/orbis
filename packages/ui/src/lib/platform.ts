import { type Lang, translate } from "@obtion/core/i18n";

export const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";

/** "⌘J" on Apple devices, "Ctrl J" elsewhere (in the language's own name for the key). */
export function shortcut(key: string, lang: Lang): string {
	return MOD === "⌘" ? `⌘${key}` : `${modName(lang)} ${key}`;
}
export function modName(lang: Lang): string {
	return MOD === "⌘" ? "⌘" : translate(lang, "key.ctrl");
}

/** Below Tailwind `md`. */
export const PHONE = "(max-width: 767px)";

/** Touch as the main pointer: use bigger targets and pickers instead of typing. */
export const isCoarse = () => matchMedia("(pointer: coarse)").matches;
