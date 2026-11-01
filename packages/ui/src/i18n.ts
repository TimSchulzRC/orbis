// UI language per device; defaults to the device language.
import { useSyncExternalStore } from "react";
import { type Lang, type T, type Values, LANGS, detectLang, makeT } from "@obtion/core/i18n";
import { type Item, displayTitle } from "@obtion/core/model";
import { KEYS } from "./ui/storage";

const KEY = KEYS.lang;
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
/** For use outside React (confirm dialogs, editor widgets). */
export function tr(key: string, values?: Values) {
  return t(key, values);
}

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
