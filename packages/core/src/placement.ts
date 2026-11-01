// Where an item belongs and how the sidebar is built.
//
// - An overview is not a type: any information with children is an overview.
// - Pinned items (meta.pinned) form the top level of the sidebar, in their own order;
//   below each entry all its children, one level deeper, whatever their type. Done
//   items (status group done) are hidden – they stay in "Darunter", the type's page and search.
// - The inbox: membership is always its stored rule (inbox.ts). Pinning counts as a place,
//   so pinned items are never in the inbox.
import { type Item, META_TYPE, isContent } from "./model";
import type { Index } from "./graph";
import { isDone } from "./traits";
import { matches } from "./query";
import { inboxWhere } from "./inbox";
import { cmpKey } from "./sortkey";

export function isOverview(item: Item, ix: Index): boolean {
  return item.kind === "info" && ix.childrenOf(item.id).length > 0;
}

/** Has a place: a parent or pinned. */
export function hasPlace(item: Item, ix: Index): boolean {
  return !!item.pinned || ix.parentsOf(item.id).length > 0;
}

export function isInInbox(item: Item, ix: Index): boolean {
  if (!isContent(item) || item.type === META_TYPE) return false;
  return matches(item, { inbox: true }, { ix });
}

export function inbox(ix: Index): Item[] {
  return ix.live.filter((i) => isInInbox(i, ix));
}

/** Set aside with "Morgen wieder", not back yet: what the inbox rule takes, waiting until tomorrow. */
export function laterItems(ix: Index, now = Date.now()): Item[] {
  return ix.live.filter((i) => isContent(i) && i.type !== META_TYPE && !i.pinned && (i.later ?? 0) > now && matches(i, inboxWhere(ix), { ix, inInbox: true }));
}

/** Can `item` go below `target`: an information it is not yet below and that is not part of it (no cycle). */
export function canPlaceIn(item: Item, target: Item, ix: Index): boolean {
  return target.kind === "info" && !item.parents[target.id] && !ix.wouldCycle(item.id, target.id);
}

/** Top level of the sidebar: everything pinned (informations and type pages), in its own order. */
export function sidebarRoots(ix: Index): Item[] {
  return ix.live
    .filter((i) => i.pinned)
    .sort((a, b) => cmpKey(a.pinned!, b.pinned!) || a.title.localeCompare(b.title));
}

/** All children of an entry, in the order kept for this parent; done ones not – except the way to the open page (`keep`). */
export function sidebarChildren(id: string, ix: Index, keep: string[] = []): Item[] {
  return ix
    .childrenOf(id)
    .map((c) => ix.get(c)!)
    .filter((c) => keep.includes(c.id) || !isDone(c, ix.schemaOf(c)));
}
