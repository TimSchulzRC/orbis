// Data for the "Today" page. Dormant entries (done above them) are left out, as the
// focus lists do.
import { type Item, META_TYPE } from "./model";
import type { Index } from "./graph";
import { dueOf, isDone, statusOf } from "./traits";
import { isInInbox } from "./placement";
import { cmpKey } from "./sortkey";

export function dueBy(ix: Index, today: string): { item: Item; due: string }[] {
  const out: { item: Item; due: string }[] = [];
  for (const item of ix.live) {
    if (item.kind !== "note") continue;
    const schema = ix.schemaOf(item);
    const due = dueOf(item, schema)?.slice(0, 10);
    if (!due || due > today || isDone(item, schema) || ix.isDormant(item)) continue;
    out.push({ item, due });
  }
  return out.sort((a, b) => cmpKey(a.due, b.due) || a.item.title.localeCompare(b.item.title));
}

/**
 * A project is an active-status item whose main child type differs from its own. Nested active
 * projects are left out; `touched` counts edits anywhere below.
 */
/** The latest edit on the item or anywhere below it. */
function lastTouched(ix: Index, item: Item): number {
  return [...ix.descendants(item.id)].reduce((latest, id) => Math.max(latest, ix.get(id)?.updated ?? 0), item.updated);
}

/** Entries of any type whose status is in the active group, the topmost only: a running sub-entry shows under its parent. */
export function running(ix: Index): { item: Item; touched: number }[] {
  const active = ix.live.filter((i) => statusOf(i, ix.schemaOf(i))?.group === "active" && !ix.isDormant(i));
  const ids = new Set(active.map((i) => i.id));
  return active
    .filter((i) => !ix.homePath(i.id).some((p) => ids.has(p)))
    .map((item) => ({ item, touched: lastTouched(ix, item) }))
    .sort((a, b) => b.touched - a.touched);
}

/** Excludes types and what still waits in the inbox. */
export function recentlyChanged(ix: Index, limit: number): Item[] {
  return ix.live
    .filter((i) => i.type !== META_TYPE && !isInInbox(i, ix))
    .sort((a, b) => b.updated - a.updated)
    .slice(0, limit);
}
