import {
	type KeyboardEvent as ReactKeyboardEvent,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { activeSpace } from "./accounts";
import { files } from "./files";
import { PHONE } from "./lib/platform";
import { repo } from "./repo";
import { ScopeContext } from "./scope";
import { readJSON, writeJSON } from "./ui/storage";

/** Re-renders on changes to the replica of this part of the page (it may be another workspace's). */
export function useRepo() {
	const scoped = useContext(ScopeContext)?.repo ?? repo;
	useSyncExternalStore(scoped.subscribe, scoped.getVersion);
	return scoped;
}

export function useIndex() {
	return useRepo().index();
}

export const useFiles = () => useContext(ScopeContext)?.files ?? files;
export const useSpaceId = () => useContext(ScopeContext)?.id ?? activeSpace()?.id;

interface Route {
	path: string; // without the title slug after an item's id
	parts: string[];
	query: URLSearchParams;
	space?: string;
}

/** "#/w/<workspace>/i/<id>?x" → { space, rest: "/i/<id>?x" } */
export function parseHash(hash = location.hash): { space?: string; rest: string } {
	const raw = hash.replace(/^#/, "");
	const named = /^\/w\/([^/?]+)/.exec(raw);
	return { space: named?.[1], rest: (named ? raw.slice(named[0].length) : raw) || "/" };
}

// The title after an item's id ("/i/<id>/<title>") is only for people reading the address.
function parse(): Route {
	const { space, rest } = parseHash();
	const [whole, qs] = rest.split("?");
	const path = whole!.startsWith("/i/") ? whole!.split("/").slice(0, 3).join("/") : whole!;
	return {
		path,
		parts: path.split("/").filter(Boolean).map(safeDecode),
		query: new URLSearchParams(qs ?? ""),
		space,
	};
}

function safeDecode(s: string) {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

let route = parse();
const routeListeners = new Set<() => void>();
const reroute = () => {
	route = parse();
	routeListeners.forEach((f) => f());
};
window.addEventListener("hashchange", reroute);

export function useRoute(): Route {
	return useSyncExternalStore(
		(f) => (routeListeners.add(f), () => routeListeners.delete(f)),
		() => route,
	);
}

export function navigate(path: string, opts: { space?: string; replace?: boolean } = {}) {
	const href = spaceHref(opts.space, path);
	if (opts.replace) location.replace(href);
	else location.hash = href;
}

function replaceHash(hash: string) {
	history.replaceState(history.state, "", "#" + hash);
	reroute();
}

/** `null` removes a parameter; no history entry. */
export function setParams(params: Record<string, string | null>) {
	const [path, qs] = location.hash.replace(/^#/, "").split("?");
	const query = new URLSearchParams(qs ?? "");
	for (const [k, v] of Object.entries(params)) v === null ? query.delete(k) : query.set(k, v);
	const next = query.toString();
	if (next !== (qs ?? "")) replaceHash(path + (next ? "?" + next : ""));
}

/** Ids like "sys:project" keep their colon: allowed in a path and easier to read. */
const seg = (s: string) => encodeURIComponent(s).replace(/%3A/gi, ":");

export const itemPath = (id: string) => `/i/${seg(id)}`;
export const itemHref = (id: string) => "#" + itemPath(id);

/** "Projektplan Q4" → "projektplan-q4" */
const MAX_SLUG = 60;

export function slug(title: string) {
	const umlauts: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };
	return title
		.toLowerCase()
		.replace(/[äöüß]/g, (c) => umlauts[c]!)
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, MAX_SLUG)
		.replace(/^-+|-+$/g, "");
}

/** Puts the title after the item's id in the address, so a shared link says where it leads. */
export function showTitle(title: string) {
	const [path, qs] = location.hash.replace(/^#/, "").split("?");
	const at = /^((?:\/w\/[^/?]+)?\/i\/[^/]+)/.exec(path!)?.[1];
	if (!at) return;
	const titleSlug = slug(title);
	const next = at + (titleSlug ? "/" + titleSlug : "") + (qs ? "?" + qs : "");
	if (next !== location.hash.replace(/^#/, "")) replaceHash(next);
}

export const openItem = (
	id: string,
	opts: { space?: string; replace?: boolean; query?: string } = {},
) => navigate(itemPath(id) + (opts.query ?? ""), opts);

/** For a page that is gone (deleted, left). */
export const leavePage = () => (history.length > 1 ? history.back() : navigate("/"));

// A function declaration (hoisted), like parseHash: accounts.ts calls both while hooks.ts is still loading.
export function spaceHref(space: string | undefined, path: string) {
	return space ? `#/w/${space}${path}` : `#${path}`;
}

/** Names the workspace, so a link opened in a new tab lands there too. */
export function useItemHref() {
	const space = useSpaceId();
	return (id: string) => spaceHref(space, itemPath(id));
}

export function useMediaQuery(q: string) {
	const [matches, setMatches] = useState(() => matchMedia(q).matches);
	useEffect(() => {
		const mq = matchMedia(q);
		const on = () => setMatches(mq.matches);
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, [q]);
	return matches;
}

/** The phone/desktop breakpoint where the sidebar shows (Tailwind `lg`). */
export const useDesktop = () => useMediaQuery("(min-width: 1024px)");
export const usePhone = () => useMediaQuery(PHONE);
/** Below Tailwind `sm`: too narrow for side-by-side columns. */
export const useNarrow = () => useMediaQuery("(max-width: 640px)");

export function useDocumentTitle(title: string | undefined) {
	useEffect(() => void (title && (document.title = title)), [title]);
}

/** One listener for the component's lifetime; `on` still sees the latest render's state. */
export function useWindowKeys(on: (e: KeyboardEvent) => void) {
	const latest = useRef(on);
	latest.current = on;
	useEffect(() => {
		const f = (e: KeyboardEvent) => latest.current(e);
		addEventListener("keydown", f);
		return () => removeEventListener("keydown", f);
	}, []);
}

/** Single-key page shortcuts stay off while focus is here. */
export const isTypingTarget = (el: Element) =>
	!!el.closest("input, textarea, select, [contenteditable=true], .cm-editor, [role=dialog]");

/**
 * While focused, the field keeps its own draft so a sync doesn't overwrite what is typed.
 * Enter leaves the field, Escape reverts and leaves.
 */
export function useFocusDraft<V>(value: V) {
	const [draft, setDraft] = useState(value);
	const focused = useRef(false);
	useEffect(() => {
		if (!focused.current) setDraft(value);
	}, [value]);
	return {
		draft,
		setDraft,
		focused,
		onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
			const el = e.currentTarget;
			if (e.key === "Enter") {
				e.preventDefault();
				el.blur();
			}
			if (e.key === "Escape") {
				setDraft(value);
				setTimeout(() => el.blur());
			}
		},
	};
}

export function useLocalStorage<T>(key: string, init: T): [T, (v: T) => void] {
	const [value, setValue] = useState<T>(() => readJSON(key, init));
	return [
		value,
		(next: T) => {
			setValue(next);
			writeJSON(key, next);
		},
	];
}

export function useStoredSet(
	key: string,
): [Set<string>, (id: string, on: boolean) => void, (ids: string[]) => void] {
	const [ids, setIds] = useLocalStorage<string[]>(key, []);
	const set = new Set(ids);
	return [set, (id, on) => setIds(on ? [...set.add(id)] : ids.filter((x) => x !== id)), setIds];
}
