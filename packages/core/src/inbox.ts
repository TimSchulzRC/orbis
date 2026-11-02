// Inbox membership is always checked against this rule (settings.inbox or the default), never
// against one rebuilt elsewhere. Pinned and "later" are the entry's own state and win over any
// rule, so "Anheften" and "Morgen wieder" work whatever the user's rule says.
import { type Item, SETTINGS_ID } from "./model";
import type { Index } from "./graph";
import type { Cond } from "./query";

/** ohne:typ ohne:eltern -angeheftet | datei ohne:eltern ohne:verwendung */
export const DEFAULT_INBOX_WHERE: Cond = {
  or: [
    { and: [{ without: "type" }, { without: "parents" }, { not: { pinned: true } }] },
    { and: [{ file: true }, { without: "parents" }, { without: "usage" }] },
  ],
};

export function inboxWhere(ix: Index): Cond {
  return ix.all.get(SETTINGS_ID)?.settings?.inbox ?? DEFAULT_INBOX_WHERE;
}

/** Out of the inbox whatever the rule says. */
export function setAside(item: Item, now = Date.now()): boolean {
  return !!item.pinned || (item.later ?? 0) > now;
}

/** When "Morgen wieder" brings an entry back: start of the next local day. */
export function tomorrow(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}
