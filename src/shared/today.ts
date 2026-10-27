// What the day holds, in one sentence on Start: due today, overdue, the inbox, and the first
// sensible step. Same rules as the start page's focus blocks: open entries with a due date that
// are not dormant (paused or done above them).
import type { Item } from "./model";
import type { Index } from "./graph";
import { dueOf, isDone, primaryChild, statusOf } from "./traits";
import { inbox } from "./placement";

export interface DayBrief {
  overdue: Item[]; // oldest due date first
  today: Item[];
  inbox: number;
  first?: Item; // the step to begin with: the oldest overdue, else the first due today
  next?: { item: Item; due: string }; // with nothing due: the next date ahead
  upcoming?: { item: Item; due: string }; // the next date after today, always ("nächster Termin")
  activeProjects: number; // active top projects (not below another active one), not paused or finished
}

export function dayBrief(ix: Index, today: string): DayBrief {
  const open: { item: Item; due: string }[] = [];
  for (const item of ix.live) {
    if (item.kind !== "info") continue;
    const schema = ix.schemaOf(item);
    const due = dueOf(item, schema)?.slice(0, 10);
    if (!due || isDone(item, schema) || ix.isDormant(item)) continue;
    open.push({ item, due });
  }
  open.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.item.title.localeCompare(b.item.title)));
  const overdue = open.filter((x) => x.due < today).map((x) => x.item);
  const dueToday = open.filter((x) => x.due === today).map((x) => x.item);
  const ahead = open.find((x) => x.due > today);
  return {
    overdue,
    today: dueToday,
    inbox: inbox(ix).length,
    first: overdue[0] ?? dueToday[0],
    next: overdue.length || dueToday.length || !ahead ? undefined : ahead,
    upcoming: ahead,
    activeProjects: activeTop(ix).length,
  };
}

/** Projects in progress that are not below another one in progress ("2 aktive Projekte"). */
export function activeTop(ix: Index): Item[] {
  const active = ix.live.filter((i) => {
    const schema = ix.schemaOf(i);
    const pc = primaryChild(schema);
    return !!pc && pc !== i.type && statusOf(i, schema)?.group === "active" && !ix.isDormant(i);
  });
  const ids = new Set(active.map((i) => i.id));
  return active.filter((i) => !ix.homePath(i.id).some((p) => ids.has(p)));
}
