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

/** Agent updates newer than the last look at the page they were written on (`seenAt`, 0 for never). */
export function unread(feed: FeedEntry[], seenAt: (pageId: string) => number): FeedEntry[] {
  return feed.filter((e) => byAgent(e.u.by) && e.u.at > seenAt(e.from.id));
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
