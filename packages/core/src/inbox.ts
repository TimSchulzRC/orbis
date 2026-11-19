// The inbox is where the user works. What lands there by itself is decided by the rule
// (settings.inbox or the default), never by one rebuilt elsewhere. An entry made in the inbox, or
// sorted while it lies there, is kept (meta.inbox): with whatever type, place or pin it gets, until
// it is checked off ("Done") or its status is done. "Later" is the entry's own state and wins over
// both, so "Back tomorrow" works whatever the rule says.

import type { Index } from "./graph";
import { type Item, SETTINGS_ID } from "./model";
import type { Cond } from "./query";

/** without:type without:parents -pinned | file without:parents without:usage */
export const DEFAULT_INBOX_WHERE: Cond = {
	or: [
		{ and: [{ without: "type" }, { without: "parents" }, { not: { pinned: true } }] },
		{ and: [{ file: true }, { without: "parents" }, { without: "usage" }] },
	],
};

export function inboxWhere(ix: Index): Cond {
	return ix.all.get(SETTINGS_ID)?.settings?.inbox ?? DEFAULT_INBOX_WHERE;
}

/** Out of the inbox until tomorrow ("Back tomorrow"), whatever the rule says. */
export function setAside(item: Item, now = Date.now()): boolean {
	return (item.later ?? 0) > now;
}

/** Since when an entry lies in the inbox: kept there since, else since it was made. */
export function inboxSince(item: Item): number {
	return item.inbox ?? item.created;
}

/** When "Back tomorrow" brings an entry back: start of the next local day. */
export function tomorrow(now = new Date()): number {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}
