// A page's updates as one feed: its own and those of everything below it, newest first.
import type { Index } from "./graph";
import type { Item, UpdateEntry } from "./model";
import { dateOf } from "./date";

export type FeedEntry = { u: UpdateEntry; from: Item };

/** Written by an agent, not by a person or an import. */
export function byAgent(by: string): boolean {
  return by !== "you" && !by.startsWith("import:");
}

export function updateFeed(ix: Index, id: string): FeedEntry[] {
  const item = ix.get(id);
  if (!item) return [];
  return [item, ...[...ix.descendants(id)].map((d) => ix.get(d)).filter((x): x is Item => !!x && !x.deleted)]
    .flatMap((from) => from.updates.map((u) => ({ u, from })))
    .sort((a, b) => b.u.at - a.u.at);
}

/**
 * What has been read of a page's updates: everything up to `at`, and the updates in `ids` after it
 * (read one by one, while older ones of the same page were still unread).
 */
export type ReadMark = { at: number; ids: string[] };

export const NOT_READ: ReadMark = { at: 0, ids: [] };

export function isRead(e: FeedEntry, mark: ReadMark): boolean {
  return e.u.at <= mark.at || mark.ids.includes(e.u.id);
}

/** Agent updates not yet read on the page they were written on. */
export function unread(feed: FeedEntry[], markOf: (pageId: string) => ReadMark): FeedEntry[] {
  return feed.filter((e) => byAgent(e.u.by) && !isRead(e, markOf(e.from.id)));
}

/**
 * A page's mark after `onScreen` was read: when nothing of the page is left unread, everything up to
 * `now` counts as read; otherwise the read ones are added one by one.
 */
export function markRead(feed: FeedEntry[], pageId: string, mark: ReadMark, onScreen: Set<string>, now: number): ReadMark {
  const open = feed.filter((e) => e.from.id === pageId && byAgent(e.u.by) && !isRead(e, mark));
  if (open.every((e) => onScreen.has(e.u.id))) return { at: Math.max(mark.at, now), ids: [] };
  const ids = new Set(mark.ids);
  for (const e of open) if (onScreen.has(e.u.id)) ids.add(e.u.id);
  return { at: mark.at, ids: [...ids] };
}

/** Entries by local calendar day, in the feed's order. */
export function byDay(feed: FeedEntry[]): [day: string, entries: FeedEntry[]][] {
  const days = new Map<string, FeedEntry[]>();
  for (const e of feed) {
    const day = dateOf(e.u.at);
    const list = days.get(day);
    if (list) list.push(e);
    else days.set(day, [e]);
  }
  return [...days];
}
