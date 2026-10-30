// UI language per device: switchable in the menu, the device language is preselected.
import { useSyncExternalStore } from "react";
import { type Lang, type T, type Values, LANGS, detectLang, makeT } from "@obtion/core/i18n";
import { type Item, displayTitle } from "@obtion/core/model";

const KEY = "obtion.lang";
function stored(): Lang | undefined {
  const v = localStorage.getItem(KEY);
  return LANGS.find((l) => l === v);
}

let lang: Lang = stored() ?? detectLang(navigator.language);
let t: T = makeT(lang);
const listeners = new Set<() => void>();
document.documentElement.lang = lang;

export function getLang() {
  return lang;
}
export function setLang(l: Lang) {
  lang = l;
  t = makeT(l);
  localStorage.setItem(KEY, l);
  document.documentElement.lang = l;
  listeners.forEach((f) => f());
}
/** Translate outside of React (confirm dialogs, editor widgets). */
export function tr(key: string, values?: Values) {
  return t(key, values);
}

/** What an entry is called on screen: its title, a file's name, else "Unbenannt". */
export function titleOf(item: Pick<Item, "title" | "file">, translate: T = tr): string {
  return displayTitle(item) || translate("untitled");
}

export function useT(): { t: T; lang: Lang } {
  const l = useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => lang,
  );
  return { t: makeTCached(l), lang: l };
}

const cache = new Map<Lang, T>();
function makeTCached(l: Lang) {
  let x = cache.get(l);
  if (!x) cache.set(l, (x = makeT(l)));
  return x;
}
