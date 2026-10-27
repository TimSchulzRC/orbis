// UI language per device: switchable in the menu, the device language is preselected.
import { useSyncExternalStore } from "react";
import { type Lang, type T, detectLang, makeT } from "@obtion/core/i18n";

const KEY = "obtion.lang";
let lang: Lang = (localStorage.getItem(KEY) as Lang | null) ?? detectLang(navigator.language);
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
export function tr(key: string, values?: Record<string, unknown>) {
  return t(key, values);
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
