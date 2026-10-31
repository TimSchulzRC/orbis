import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

/** A copy of `set` with `key` added, or taken out if it was in. */
export function toggled<K>(set: ReadonlySet<K>, key: K): Set<K> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** A copy of `list` with the entry at `from` moved in front of the one at `at` (`list.length`: to the end). */
export function moveInArray<V>(list: readonly V[], from: number, at: number): V[] {
  const next = [...list];
  next.splice(from < at ? at - 1 : at, 0, ...next.splice(from, 1));
  return next;
}
