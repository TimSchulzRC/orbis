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

export interface Route {
  path: string; // e.g. "/n/abc"
  parts: string[];
  query: URLSearchParams;
}

/** "#/w/<workspace>/i/<id>": the workspace is taken off (accounts.ts opens it); the rest is the route. */
function parse(): Route {
  const raw = location.hash.replace(/^#/, "").replace(/^\/w\/[^/?]+/, "") || "/";
  const [path, qs] = raw.split("?");
  return { path: path!, parts: path!.split("/").filter(Boolean).map(safeDecode), query: new URLSearchParams(qs ?? "") };
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(path: string) {
  location.hash = path;
}

export const itemHref = (id: string) => `#/i/${encodeURIComponent(id)}`;

/** A path in another workspace than the open one ("/i/<id>" → "#/w/<space>/i/<id>"). */
export const spaceHref = (space: string | undefined, path: string) => (space ? `#/w/${space}${path}` : `#${path}`);

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
