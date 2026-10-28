// Where an item belongs and how the sidebar is built.
//
// - An overview is not a type: any information with children is an overview.
// - Pinned items (meta.pinned) form the top level of the sidebar, in their own order;
//   below each entry all its children, one level deeper, whatever their type. Done
//   items (status group done) are hidden – they stay in "Darunter", the type's page and search.
// - The inbox: membership is always its stored rule (inbox.ts). Pinning counts as a place,
//   so pinned items are never in the inbox.
import { type Item, META_TYPE } from "./model";
import type { Index } from "./graph";
import { isDone } from "./traits";
import { matches } from "./query";

export function isOverview(item: Item, ix: Index): boolean {
  return item.kind === "info" && ix.childrenOf(item.id).length > 0;
}

export function isPinned(item: Item): boolean {
  return !!item.pinned;
}

/** Has a place: a parent or pinned. */
export function hasPlace(item: Item, ix: Index): boolean {
  return isPinned(item) || ix.parentsOf(item.id).length > 0;
}

export function isInInbox(item: Item, ix: Index): boolean {
  if (item.deleted || (item.kind !== "info" && item.kind !== "datei") || item.type === META_TYPE) return false;
  return matches(item, { inbox: true }, { ix });
}

export function inbox(ix: Index): Item[] {
  return ix.live.filter((i) => isInInbox(i, ix));
}

/** Top level of the sidebar: everything pinned (informations and type pages), in its own order. */
export function sidebarRoots(ix: Index): Item[] {
  return ix.live
    .filter((i) => i.pinned)
    .sort((a, b) => (a.pinned! < b.pinned! ? -1 : a.pinned! > b.pinned! ? 1 : a.title.localeCompare(b.title)));
}

/** All children of an entry, in the order kept for this parent; done ones not – except the way to the open page (`keep`). */
export function sidebarChildren(id: string, ix: Index, keep: string[] = []): Item[] {
  return ix
    .childrenOf(id)
    .map((c) => ix.get(c)!)
    .filter((c) => keep.includes(c.id) || !isDone(c, ix.schemaOf(c)));
}
