// Done items are hidden in the sidebar but stay in "Darunter", the type's page and search. Pinning counts as a place, so pinned
// items are never in the inbox.
import { type Item, META_TYPE, isContent } from "./model";
import type { Index } from "./graph";
import { isDone } from "./traits";
import { matches } from "./query";
import { inboxWhere } from "./inbox";
import { cmpKey } from "./sortkey";

export function hasPlace(item: Item, ix: Index): boolean {
  return !!item.pinned || ix.parentsOf(item.id).length > 0;
}

export function isInInbox(item: Item, ix: Index): boolean {
  // a drawing is part of the note it is drawn in, never sorted on its own
  if (!isContent(item) || item.type === META_TYPE || item.kind === "zeichnung") return false;
  return matches(item, { inbox: true }, { ix });
}

export function inbox(ix: Index): Item[] {
  return ix.live.filter((i) => isInInbox(i, ix));
}

/** Inbox items set aside with "Morgen wieder" that are not back yet. */
export function laterItems(ix: Index, now = Date.now()): Item[] {
  return ix.live.filter((i) => isContent(i) && i.type !== META_TYPE && !i.pinned && (i.later ?? 0) > now && matches(i, inboxWhere(ix), { ix, inInbox: true }));
}

export function canPlaceIn(item: Item, target: Item, ix: Index): boolean {
  return target.kind === "info" && !item.parents[target.id] && !ix.wouldCycle(item.id, target.id);
}

export function sidebarRoots(ix: Index): Item[] {
  return ix.live
    .filter((i) => i.pinned && i.kind !== "zeichnung")
    .sort((a, b) => cmpKey(a.pinned!, b.pinned!) || a.title.localeCompare(b.title));
}

/** "Darunter": what sits below an item. A diagram is a block of its note's text, not something below it. */
export function belowOf(id: string, ix: Index): Item[] {
  return ix.items(ix.childrenOf(id)).filter((c) => !c.deleted && c.kind !== "zeichnung");
}

/** Done children are hidden, except those in `keep` (the path to the open page). */
export function sidebarChildren(id: string, ix: Index, keep: string[] = []): Item[] {
  return ix
    .childrenOf(id)
    .map((c) => ix.get(c)!)
    .filter((c) => c.kind !== "zeichnung" && (keep.includes(c.id) || !isDone(c, ix.schemaOf(c))));
}
