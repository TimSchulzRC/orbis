// The inbox: whatever its rule matches – stored in the settings (`settings.inbox`), the default
// from the code while unset. Whether something is in the inbox is always checked against this
// rule (placement.ts), never against one rebuilt elsewhere.
//
// Two states of an entry win over any rule: pinned (in the sidebar, a place) and later (back
// tomorrow). They are the entry's own state, not part of the rule, so "Anheften" and "Morgen
// wieder" work whatever the rule says. There is no "kept without a place": an entry is in the
// sidebar, in the inbox or in its type's list (an old "kept" from before 01.11. is ignored).
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

/** Pinned, or not back yet: out of the inbox whatever the rule says. */
export function setAside(item: Item, now = Date.now()): boolean {
  return !!item.pinned || (item.later ?? 0) > now;
}

/** When "Morgen wieder" brings an entry back: the start of the next day, local time. */
export function tomorrow(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}
