// What "Heute" shows of one workspace: what is due (today and overdue), the projects in progress
// and what was changed last. Due: open entries with a due date that are not dormant (paused or
// done above them), as the focus lists count them.
import { type Item, META_TYPE } from "./model";
import type { Index } from "./graph";
import { dueOf, isDone, primaryChild, statusOf } from "./traits";
import { isInInbox } from "./placement";

/** Due by today, oldest due date first. */
export function dueBy(ix: Index, today: string): { item: Item; due: string }[] {
  const out: { item: Item; due: string }[] = [];
  for (const item of ix.live) {
    if (item.kind !== "info") continue;
    const schema = ix.schemaOf(item);
    const due = dueOf(item, schema)?.slice(0, 10);
    if (!due || due > today || isDone(item, schema) || ix.isDormant(item)) continue;
    out.push({ item, due });
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.item.title.localeCompare(b.item.title)));
}

/**
 * Projects in progress (a status in the group "active", a main action that creates something
 * else) that are not below another one in progress; the last touched first, with when that was
 * (the project or anything below it).
 */
export function activeProjects(ix: Index): { item: Item; touched: number }[] {
  const active = ix.live.filter((i) => {
    const schema = ix.schemaOf(i);
    const pc = primaryChild(schema);
    return !!pc && pc !== i.type && statusOf(i, schema)?.group === "active" && !ix.isDormant(i);
  });
  const ids = new Set(active.map((i) => i.id));
  return active
    .filter((i) => !ix.homePath(i.id).some((p) => ids.has(p)))
    .map((item) => ({ item, touched: [...ix.descendants(item.id)].reduce((n, d) => Math.max(n, ix.get(d)?.updated ?? 0), item.updated) }))
    .sort((a, b) => b.touched - a.touched);
}

/** Changed last: informations and files, not types and not what still waits in the inbox. */
export function recentlyChanged(ix: Index, limit: number): Item[] {
  return ix.live
    .filter((i) => i.type !== META_TYPE && !isInInbox(i, ix))
    .sort((a, b) => b.updated - a.updated)
    .slice(0, limit);
}
