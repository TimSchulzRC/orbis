import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

/** Focus style for framed fields (input, textarea, select). */
export const framedFocus = "focus-visible:border-focus/80 focus-visible:ring-[3px] focus-visible:ring-focus/20";

export function toggled<K>(set: ReadonlySet<K>, key: K): Set<K> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** Moves the entry at `from` in front of the one at `at`; `at = list.length` moves it to the end. */
export function moveInArray<V>(list: readonly V[], from: number, at: number): V[] {
  const next = [...list];
  next.splice(from < at ? at - 1 : at, 0, ...next.splice(from, 1));
  return next;
}
