// Done items are hidden in the sidebar but stay in "Below", the type's page and search. Pinning
// counts as a place: the inbox rule never takes a pinned item, but an entry kept in the inbox stays
// there pinned too (see inbox.ts).

import type * as Y from "yjs";
import type { Index } from "./graph";
import { type Item, isContent, META_TYPE, setMeta } from "./model";
import { liesInInbox, matches } from "./query";
import { cmpKey } from "./sortkey";
import { isDone } from "./traits";

export function hasPlace(item: Item, ix: Index): boolean {
	return !!item.pinned || ix.parentsOf(item.id).length > 0;
}

/** Can be in the inbox at all. A drawing is part of the note it is drawn in, never sorted on its own. */
function inboxable(item: Item): boolean {
	return isContent(item) && item.type !== META_TYPE;
}

export function isInInbox(item: Item, ix: Index): boolean {
	return inboxable(item) && matches(item, { inbox: true }, { ix });
}

export function inbox(ix: Index): Item[] {
	return ix.live.filter((i) => isInInbox(i, ix));
}

/** Inbox items set aside with "Back tomorrow" that are not back yet. */
export function laterItems(ix: Index, now = Date.now()): Item[] {
	return ix.live.filter((i) => inboxable(i) && (i.later ?? 0) > now && liesInInbox(i, { ix }));
}

/**
 * Sorting never takes an entry out of the inbox: one there by the rule alone (also one back
 * tomorrow) is kept from now on, since it was made. Call in the change that gives it a type, a
 * place or a pin, with the item as it was before.
 */
export function keepInInbox(doc: Y.Doc, item: Item | undefined, ix: Index) {
	if (item && !item.inbox && inboxable(item) && liesInInbox(item, { ix }))
		setMeta(doc, { inbox: item.created });
}

/**
 * "Done" takes an entry kept in the inbox out of it. Not one the rule would take straight back (a
 * note without a type or a place): it would be found nowhere else.
 */
export function canCheckOff(item: Item, ix: Index): boolean {
	return !!item.inbox && !liesInInbox({ ...item, inbox: undefined }, { ix });
}

export function canPlaceIn(item: Item, target: Item, ix: Index): boolean {
	return target.kind === "note" && !item.parents[target.id] && !ix.wouldCycle(item.id, target.id);
}

export function sidebarRoots(ix: Index): Item[] {
	return ix.live
		.filter((i) => i.pinned)
		.sort((a, b) => cmpKey(a.pinned!, b.pinned!) || a.title.localeCompare(b.title));
}

/** "Below": what sits below an item. */
export function belowOf(id: string, ix: Index): Item[] {
	return ix.items(ix.childrenOf(id)).filter((c) => !c.deleted);
}

/** Done children are hidden, except those in `keep` (the path to the open page). */
export function sidebarChildren(id: string, ix: Index, keep: string[] = []): Item[] {
	return ix
		.childrenOf(id)
		.map((c) => ix.get(c)!)
		.filter((c) => keep.includes(c.id) || !isDone(c, ix.schemaOf(c)));
}
