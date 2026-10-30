import { type KeyboardEvent as ReactKeyboardEvent, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { repo } from "./repo";
import { files } from "./files";
import { activeSpace } from "./accounts";
import { ScopeContext } from "./scope";
import { readJSON, writeJSON } from "./ui/storage";
import { PHONE } from "./lib/platform";

/** Re-render whenever the replica of this part of the page changes. */
export function useRepo() {
  const r = useContext(ScopeContext)?.repo ?? repo;
  useSyncExternalStore(r.subscribe, r.getVersion);
  return r;
}

/** The derived index (structure, links, aggregation) for the current data. */
export function useIndex() {
  return useRepo().index();
}

export const useFiles = () => useContext(ScopeContext)?.files ?? files;
export const useSpaceId = () => useContext(ScopeContext)?.id ?? activeSpace()?.id;

// ---------- hash router ----------

interface Route {
  path: string; // e.g. "/i/abc" (an item's address without the title after its id)
  parts: string[];
  query: URLSearchParams;
  /** The workspace named in the address ("#/w/<space>/…"), if one is. */
  space?: string;
}

/** "#/w/<workspace>/i/<id>?x": the workspace, if the address names one, and the rest ("/i/<id>?x"). */
export function parseHash(hash = location.hash): { space?: string; rest: string } {
  const raw = hash.replace(/^#/, "");
  const named = /^\/w\/([^/?]+)/.exec(raw);
  return { space: named?.[1], rest: (named ? raw.slice(named[0].length) : raw) || "/" };
}

/**
 * The workspace is taken off (accounts.ts opens it); the rest is the route.
 * An item's title after its id ("/i/<id>/<title>") is only for people reading the address.
 */
function parse(): Route {
  const { space, rest } = parseHash();
  const [whole, qs] = rest.split("?");
  const path = whole!.startsWith("/i/") ? whole!.split("/").slice(0, 3).join("/") : whole!;
  return { path, parts: path.split("/").filter(Boolean).map(safeDecode), query: new URLSearchParams(qs ?? ""), space };
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The route, one for the whole app. */
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

/** Opens a path ("/i/<id>"), in workspace `space` if given; `replace` leaves the current page out of the history. */
export function navigate(path: string, opts: { space?: string; replace?: boolean } = {}) {
  const href = spaceHref(opts.space, path);
  if (opts.replace) location.replace(href);
  else location.hash = href;
}

/** Another address for the page shown, without a step in the history (a filter, a view, a title). */
function replaceHash(hash: string) {
  history.replaceState(history.state, "", "#" + hash);
  reroute();
}

/** Set or remove parameters of the address ("?view=…"), as the page changes what it shows. */
export function setParams(params: Record<string, string | null>) {
  const [path, qs] = location.hash.replace(/^#/, "").split("?");
  const query = new URLSearchParams(qs ?? "");
  for (const [k, v] of Object.entries(params)) v === null ? query.delete(k) : query.set(k, v);
  const next = query.toString();
  if (next !== (qs ?? "")) replaceHash(path + (next ? "?" + next : ""));
}

/** A part of an address: ids like "sys:project" keep their colon (allowed there, and easier to read). */
const seg = (s: string) => encodeURIComponent(s).replace(/%3A/gi, ":");

export const itemPath = (id: string) => `/i/${seg(id)}`;
export const itemHref = (id: string) => "#" + itemPath(id);

/** A title as it reads in an address: "Projektplan Q4" → "projektplan-q4". */
export function slug(title: string) {
  const umlauts: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };
  return title
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => umlauts[c]!)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
}

/** The item's title after its id in the address ("#/w/<space>/i/<id>/<title>"), so a shared link says where it leads. */
export function showTitle(title: string) {
  const [path, qs] = location.hash.replace(/^#/, "").split("?");
  const at = /^((?:\/w\/[^/?]+)?\/i\/[^/]+)/.exec(path!)?.[1];
  if (!at) return;
  const s = slug(title);
  const next = at + (s ? "/" + s : "") + (qs ? "?" + qs : "");
  if (next !== location.hash.replace(/^#/, "")) replaceHash(next);
}

/** Opens an entry's page; `query` e.g. "?new=1". */
export const openItem = (id: string, opts: { space?: string; replace?: boolean; query?: string } = {}) => navigate(itemPath(id) + (opts.query ?? ""), opts);

/** Away from a page that is gone (deleted, left): back where one came from, else to the start. */
export const leavePage = () => (history.length > 1 ? history.back() : navigate("/"));

/**
 * A path in another workspace than the open one ("/i/<id>" → "#/w/<space>/i/<id>"). A function
 * declaration, like parseHash: accounts.ts uses both while hooks.ts is still loading.
 */
export function spaceHref(space: string | undefined, path: string) {
  return space ? `#/w/${space}${path}` : `#${path}`;
}

/** itemHref in the workspace this part of the page belongs to, so a link opened in a new tab lands there too. */
export function useItemHref() {
  const space = useSpaceId();
  return (id: string) => spaceHref(space, itemPath(id));
}

export function useMediaQuery(q: string) {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

/** The one breakpoint between phone and desktop layout: the sidebar shows from here (Tailwind `lg`). */
export const useDesktop = () => useMediaQuery("(min-width: 1024px)");
export const usePhone = () => useMediaQuery(PHONE);
/** Below Tailwind `sm`: too narrow for side-by-side columns (tables, timelines). */
export const useNarrow = () => useMediaQuery("(max-width: 640px)");

/** The page's title in the browser tab, in the current language. */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => void (title && (document.title = title)), [title]);
}

/** Keys on the whole window while the component lives: one listener, `on` sees the state of the last render. */
export function useWindowKeys(on: (e: KeyboardEvent) => void) {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => {
    const f = (e: KeyboardEvent) => latest.current(e);
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  }, []);
}

/** Focus is in a field, an editor or a dialog: single-key shortcuts of a page stay off. */
export const isTypingTarget = (el: Element) => !!el.closest("input, textarea, select, [contenteditable=true], .cm-editor, [role=dialog]");

/**
 * A field's own copy of `value` while it has the focus (what is typed is not overwritten by a sync
 * meanwhile); without the focus it follows `value`. Enter leaves the field, Escape reverts and leaves.
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
      if (e.key === "Enter") (e.preventDefault(), el.blur());
      if (e.key === "Escape") (setDraft(value), setTimeout(() => el.blur()));
    },
  };
}

/** A value this device keeps (ui/storage.ts names the keys). */
export function useLocalStorage<T>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => readJSON(key, init));
  return [
    v,
    (n: T) => {
      setV(n);
      writeJSON(key, n);
    },
  ];
}

/** A stored set of ids (folded groups, opened rows). */
export function useStoredSet(key: string): [Set<string>, (id: string, on: boolean) => void, (ids: string[]) => void] {
  const [ids, setIds] = useLocalStorage<string[]>(key, []);
  const set = new Set(ids);
  return [set, (id, on) => setIds(on ? [...set.add(id)] : ids.filter((x) => x !== id)), setIds];
}
