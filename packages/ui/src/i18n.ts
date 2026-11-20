// UI language per device; defaults to the device language.

import { detectLang, LANGS, type Lang, makeT, type T, type Values } from "@obtion/core/i18n";
import { displayTitle, type Item } from "@obtion/core/model";
import { useSyncExternalStore } from "react";
import { KEYS } from "./ui/storage";

const KEY = KEYS.lang;
function stored(): Lang | undefined {
	const saved = localStorage.getItem(KEY);
	return LANGS.find((l) => l === saved);
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
	for (const f of listeners) f();
}
/** For use outside React (confirm dialogs, editor widgets). */
export function tr(key: string, values?: Values) {
	return t(key, values);
}

export function titleOf(
	item: Pick<Item, "title" | "file"> & { kind?: Item["kind"] },
	translate: T = tr,
): string {
	return displayTitle(item) || translate("untitled");
}

export function useT(): { t: T; lang: Lang } {
	const l = useSyncExternalStore(
		(f) => {
			listeners.add(f);
			return () => listeners.delete(f);
		},
		() => lang,
	);
	return { t: makeTCached(l), lang: l };
}

const cache = new Map<Lang, T>();
function makeTCached(l: Lang) {
	let cached = cache.get(l);
	if (!cached) {
		cached = makeT(l);
		cache.set(l, cached);
	}
	return cached;
}
