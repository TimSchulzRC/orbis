import { test, expect } from "bun:test";
import { MemRepo, fork, sync } from "../support/helpers";
import { runSetup, SYS } from "@obtion/core/setup";
import { addParent, removeParent, setMeta } from "@obtion/core/model";
import { deleteItem, restoreItem, cascadeCount, purgeSet, trashRoots } from "@obtion/core/trash";
import { isInInbox } from "@obtion/core/placement";

function repo() {
  const m = new MemRepo();
  runSetup(m.writer, "de");
  return m;
}
const del = (m: MemRepo, id: string, children: "trash" | "inbox" = "trash") => deleteItem(m.writer, m.index(), id, children);
const restore = (m: MemRepo, id: string) => restoreItem(m.writer, m.records(), id);
const alive = (m: MemRepo, id: string) => !!m.index().get(id);

function project(m: MemRepo) {
  const arbeit = m.add({ title: "Arbeit", pinned: "a" });
  const p = m.add({ title: "Relaunch", type: SYS.project, parents: [arbeit] });
  const t1 = m.add({ title: "Mapping", type: SYS.task, parents: [p] });
  const sub = m.add({ title: "Pflichtfelder", type: SYS.task, parents: [t1] });
  const note = m.add({ title: "Notiz", parents: [p] });
  return { arbeit, p, t1, sub, note };
}

test("deleting a project trashes what hangs only below it; restoring brings exactly that back", () => {
  const m = repo();
  const { p, t1, sub, note } = project(m);
  const earlier = m.add({ title: "Schon gelöscht", type: SYS.task, parents: [p] });
  m.change(earlier, (d) => setMeta(d, { deleted: true }));
  expect(del(m, p).sort()).toEqual([t1, sub, note].sort());
  for (const id of [p, t1, sub, note]) expect(alive(m, id)).toBe(false);
  expect(m.get(t1)!.deletedVia).toBe(p);
  expect(cascadeCount(m.records(), p)).toBe(3);
  expect(restore(m, p).sort()).toEqual([t1, sub, note].sort());
  for (const id of [p, t1, sub, note]) expect(alive(m, id)).toBe(true);
  expect(m.get(t1)!.deletedVia).toBeUndefined();
  // deleted on its own before: stays in the trash
  expect(alive(m, earlier)).toBe(false);
});

test("a child with another living parent is never deleted along", () => {
  const m = repo();
  const { p } = project(m);
  const kunde = m.add({ title: "Nordlicht", pinned: "b" });
  const both = m.add({ title: "Nordlicht · Frankreich", type: SYS.project, parents: [p, kunde] });
  const below = m.add({ title: "Task darunter", type: SYS.task, parents: [both] });
  const only = del(m, p);
  expect(only).not.toContain(both);
  expect(only).not.toContain(below);
  expect(alive(m, both)).toBe(true);
  expect(alive(m, below)).toBe(true);
  expect(m.index().parentsOf(both)).toEqual([kunde]);
});

test("\"back to the inbox\" removes the parent instead of deleting the children", () => {
  const m = repo();
  const { p, t1, sub, note } = project(m);
  del(m, p, "inbox");
  expect(alive(m, p)).toBe(false);
  for (const id of [t1, sub, note]) expect(alive(m, id)).toBe(true);
  expect(Object.keys(m.get(note)!.parents)).toEqual([]);
  expect(isInInbox(m.index().get(note)!, m.index())).toBe(true);
  // the subtask keeps its own parent
  expect(m.index().parentsOf(sub)).toEqual([t1]);
  // restoring the project does not pull them back under it
  restore(m, p);
  expect(m.index().parentsOf(note)).toEqual([]);
});

test("a task another device moved away while the project was deleted stays alive", () => {
  const laptop = repo();
  const { p, t1, sub } = project(laptop);
  const other = laptop.add({ title: "Anderes Projekt", type: SYS.project, pinned: "c" });
  const phone = fork(laptop);
  del(laptop, p);
  phone.change(t1, (d) => {
    addParent(d, other);
    removeParent(d, p);
  });
  sync(laptop, phone);
  for (const m of [laptop, phone]) {
    expect(alive(m, p)).toBe(false);
    expect(alive(m, t1)).toBe(true);
    expect(alive(m, sub)).toBe(true);
    expect(m.index().parentsOf(t1)).toEqual([other]);
  }
});

test("a task that got a second, living parent on another device stays alive", () => {
  const laptop = repo();
  const { p, t1 } = project(laptop);
  const kunde = laptop.add({ title: "Nordlicht", pinned: "b" });
  const phone = fork(laptop);
  del(laptop, p);
  phone.change(t1, (d) => addParent(d, kunde));
  sync(laptop, phone);
  expect(alive(laptop, t1)).toBe(true);
  expect(alive(phone, t1)).toBe(true);
});

test("nested projects deleted on two devices: everything stays hidden, restoring leaves no orphan", () => {
  const laptop = repo();
  const arbeit = laptop.add({ title: "Arbeit", pinned: "a" });
  const p = laptop.add({ title: "Relaunch", type: SYS.project, parents: [arbeit] });
  const s = laptop.add({ title: "Frankreich", type: SYS.project, parents: [p] });
  const t = laptop.add({ title: "Mapping", type: SYS.task, parents: [s] });
  const phone = fork(laptop);
  del(laptop, p); // marks s and t via p
  del(phone, s); // marks t via s
  sync(laptop, phone);
  for (const m of [laptop, phone]) for (const id of [p, s, t]) expect(alive(m, id)).toBe(false);
  // meta.deleted is one field: which mark of s won is up to Yjs. Either way both devices
  // agree, and the task is visible exactly when its project is.
  restore(laptop, p);
  sync(laptop, phone);
  const seen = [laptop, phone].map((m) => [p, s, t].map((id) => alive(m, id)));
  expect(seen[0]).toEqual(seen[1]!);
  expect(seen[0]![0]).toBe(true);
  expect(seen[0]![2]).toBe(seen[0]![1]!);
});

test("restoring an outer root keeps a subtree whose own root is still deleted", () => {
  const m = repo();
  const arbeit = m.add({ title: "Arbeit", pinned: "a" });
  const p = m.add({ title: "Relaunch", type: SYS.project, parents: [arbeit] });
  const s = m.add({ title: "Frankreich", type: SYS.project, parents: [p] });
  const t = m.add({ title: "Mapping", type: SYS.task, parents: [s] });
  // the merged state of two concurrent deletes: s deleted itself, t marked via the outer root
  m.change(p, (d) => setMeta(d, { deleted: true }));
  m.change(s, (d) => setMeta(d, { deleted: true }));
  m.change(t, (d) => setMeta(d, { deleted: "via:" + p }));
  restore(m, p);
  expect(alive(m, p)).toBe(true);
  expect(alive(m, s)).toBe(false);
  expect(alive(m, t)).toBe(false);
  expect(m.get(t)!.deletedVia).toBe(s);
  restore(m, s);
  expect(alive(m, s)).toBe(true);
  expect(alive(m, t)).toBe(true);
});

test("restoring a single cascaded item brings back only that item", () => {
  const m = repo();
  const { p, t1, note } = project(m);
  del(m, p);
  restore(m, note);
  expect(alive(m, note)).toBe(true);
  expect(alive(m, t1)).toBe(false);
  // its parent is still in the trash, so it has no place: untyped, it is in the inbox
  expect(isInInbox(m.index().get(note)!, m.index())).toBe(true);
});

test("purging takes what was deleted with the item, never what was deleted on its own or moved away", () => {
  const m = repo();
  const { arbeit, p, t1, sub, note } = project(m);
  const earlier = m.add({ title: "Schon gelöscht", type: SYS.task, parents: [p] });
  m.change(earlier, (d) => setMeta(d, { deleted: true }));
  del(m, p);
  // moved out of the trash by another device: alive again, stays alive
  m.change(note, (d) => (addParent(d, arbeit), removeParent(d, p)));
  expect(trashRoots(m.records()).map((r) => r.id).sort()).toEqual([p, earlier].sort());
  expect(purgeSet(m.records(), p).sort()).toEqual([p, t1, sub].sort());
  // a cascaded item on its own: takes what hangs only below it
  expect(purgeSet(m.records(), t1).sort()).toEqual([t1, sub].sort());
});
