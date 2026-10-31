import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

/** How a framed field (input, textarea, select) shows focus: its border takes the accent, with a soft halo around it. */
export const framedFocus = "focus-visible:border-focus/80 focus-visible:ring-[3px] focus-visible:ring-focus/20";

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
