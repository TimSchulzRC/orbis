// The inbox: whatever its rule matches – stored in the settings (`settings.inbox`), the default
// from the code while unset. Whether something is in the inbox is always checked against this
// rule (placement.ts), never against one rebuilt elsewhere.
//
// Two decisions on an entry win over any rule: kept (it stays as it is, without a place) and
// later (back tomorrow). They are the entry's own state, not part of the rule, so "Behalten" and
// "Morgen wieder" work whatever the rule says.
import { type Item, SETTINGS_ID, titleKey } from "./model";
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

/** Kept, or not back yet: out of the inbox whatever the rule says. */
export function setAside(item: Item, now = Date.now()): boolean {
  return !!item.kept || (item.later ?? 0) > now;
}

/** When "Morgen wieder" brings an entry back: the start of the next day, local time. */
export function tomorrow(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}

/**
 * What a capture could be added to instead of becoming an entry of its own: an entry still in the
 * inbox (`entries`, newest first). "@Urlaub …" names it by the start of its title (the mention
 * leaves the text); without "@" it is the one put down or opened last (`opened`: which, when).
 * A mention that is exactly the title of anything else (`resolve`, a place) is no append. Nothing
 * for an empty text.
 */
export function appendTarget(text: string, entries: Item[], opened?: { id: string; at: number }, resolve?: (title: string) => string | undefined): { id: string; text: string } | undefined {
  const t = text.trim();
  if (!t || !entries.length) return;
  const at = /(^|\s)@([^@\n]+)/.exec(t);
  if (!at) {
    const newest = entries[0]!;
    const seen = opened && opened.at > newest.created && entries.some((e) => e.id === opened.id);
    return { id: seen ? opened.id : newest.id, text: t };
  }
  const words = at[2]!.trim().split(/\s+/);
  for (let n = words.length; n > 0; n--) {
    const name = words.slice(0, n).join(" ").replace(/[.,;:!?]+$/, "");
    const exact = resolve?.(name);
    const hit = exact ? entries.find((e) => e.id === exact) : titleKey(name) && entries.find((e) => titleKey(e.title).startsWith(titleKey(name)));
    if (exact && !hit) return; // a place: placing it is offered instead
    if (!hit) continue;
    // the mention leaves, the rest of the text stays as it was typed (its lines too)
    const span = new RegExp(`^\\s*\\S+(?:\\s+\\S+){${n - 1}}`).exec(at[2]!)![0];
    const before = t.slice(0, at.index + at[1]!.length).replace(/[ \t]+$/, "");
    let after = (at[2]!.slice(span.length) + t.slice(at.index + at[0].length)).replace(/^[ \t]+/, "");
    if (before.endsWith("\n") && after.startsWith("\n")) after = after.slice(1); // a line of only the mention goes
    const rest = (before && after && !before.endsWith("\n") && !after.startsWith("\n") ? `${before} ${after}` : before + after).trim();
    return rest ? { id: hit.id, text: rest } : undefined;
  }
  return;
}
