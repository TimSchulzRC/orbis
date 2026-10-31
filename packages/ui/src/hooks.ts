import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { repo } from "./repo";
import { files } from "./files";
import { activeSpace } from "./accounts";
import { ScopeContext } from "./scope";

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

/**
 * "#/w/<workspace>/i/<id>": the workspace is taken off (accounts.ts opens it); the rest is the route.
 * An item's title after its id ("/i/<id>/<title>") is only for people reading the address.
 */
function parse(): Route {
  const hash = location.hash.replace(/^#/, "");
  const space = /^\/w\/([^/?]+)/.exec(hash)?.[1];
  const raw = hash.replace(/^\/w\/[^/?]+/, "") || "/";
  const [whole, qs] = raw.split("?");
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

export function go(path: string) {
  location.hash = path;
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

/** A path in another workspace than the open one ("/i/<id>" → "#/w/<space>/i/<id>"). */
export const spaceHref = (space: string | undefined, path: string) => (space ? `#/w/${space}${path}` : `#${path}`);

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

export function useLocalStorage<T>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s ? (JSON.parse(s) as T) : init;
    } catch {
      return init;
    }
  });
  return [
    v,
    (n: T) => {
      setV(n);
      localStorage.setItem(key, JSON.stringify(n));
    },
  ];
}
