import { useEffect, useState, useSyncExternalStore } from "react";
import { repo } from "./repo";

/** Re-render whenever the local replica changes. */
export function useRepo() {
  useSyncExternalStore(repo.subscribe, repo.getVersion);
  return repo;
}

/** The derived index (structure, links, aggregation) for the current data. */
export function useIndex() {
  useRepo();
  return repo.index();
}

// ---------- hash router ----------

export interface Route {
  path: string; // e.g. "/n/abc"
  parts: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = location.hash.replace(/^#/, "") || "/";
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
