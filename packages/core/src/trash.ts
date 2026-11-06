// meta.deleted is `true` (deleted itself) or "via:<root>" (deleted with that root). A cascaded
// item only counts as deleted while the root is deleted, the root is still above it at any
// depth, and every parent of it is deleted. Every device computes this from the same data, so
// concurrent moves and deletes need no coordination: an item moved away from the root stays alive.
import { type Item, META_TYPE, VIA, setMeta, removeParent } from "./model";
import type { Index } from "./graph";
import type { Writer } from "./setup";

/** Ignores the record itself as its own parent. */
function knownParents(r: Item | undefined, records: Map<string, Item>): string[] {
  return r ? Object.keys(r.parents).filter((p) => p !== r.id && records.has(p)) : [];
}

/** Replaces changed records in `records`. */
export function resolveCascade(records: Map<string, Item>): void {
  const via = [...records.values()].filter((r) => r.deletedVia);
  if (!via.length) return;
  const memo = new Map<string, boolean>();
  const parentsOf = (id: string) => knownParents(records.get(id), records);
  const above = (root: string, id: string) => {
    const seen = new Set<string>();
    const stack = parentsOf(id);
    while (stack.length) {
      const parent = stack.pop()!;
      if (parent === root) return true;
      if (seen.has(parent)) continue;
      seen.add(parent);
      stack.push(...parentsOf(parent));
    }
    return false;
  };
  const deleted = (id: string): boolean => {
    const r = records.get(id);
    if (!r) return false;
    if (!r.deletedVia) return r.deleted;
    const known = memo.get(id);
    if (known !== undefined) return known;
    memo.set(id, false); // cycle guard
    const parents = parentsOf(id);
    const root = r.deletedVia;
    const result = records.has(root) && deleted(root) && above(root, id) && parents.length > 0 && parents.every(deleted);
    memo.set(id, result);
    return result;
  };
  for (const r of via) {
    const isDeleted = deleted(r.id);
    if (isDeleted !== r.deleted) records.set(r.id, { ...r, deleted: isDeleted });
  }
}

/** Descendants that hang only below `root` (all their parents go with it), deepest last. */
export function onlyBelow(ix: Index, root: string): string[] {
  const out: string[] = [];
  const gone = new Set([root]);
  const walk = (id: string) => {
    for (const c of ix.childrenOf(id)) {
      if (gone.has(c)) continue;
      if (ix.parentsOf(c).every((p) => gone.has(p))) {
        gone.add(c);
        out.push(c);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Children that hang only here either go along ("trash", restorable with the root) or lose this
 * parent ("inbox", so untyped ones land in the inbox). Children with a living parent outside the cascade stay.
 */
export function deleteItem(w: Writer, ix: Index, id: string, children: "trash" | "inbox" = "trash"): string[] {
  // types go through deleteType, which lets the user choose what becomes of the values
  if (ix.get(id)?.type === META_TYPE) throw new Error("Types are deleted on the type page, not moved to the trash.");
  const only = onlyBelow(ix, id);
  w.change(id, (doc) => setMeta(doc, { deleted: true }));
  if (children === "trash") for (const c of only) w.change(c, (doc) => setMeta(doc, { deleted: VIA + id }));
  else for (const c of only) if (ix.parentsOf(c).includes(id)) w.change(c, (doc) => removeParent(doc, id));
  return only;
}

/**
 * Restores exactly what was deleted with the item. An item that still hangs only below other
 * deleted entries (nested deletes) stays in the trash with them.
 */
export function restoreItem(w: Writer, records: Map<string, Item>, id: string): string[] {
  const after = new Map(records);
  const cur = after.get(id);
  if (cur) after.set(id, { ...cur, deleted: false, deletedVia: undefined });
  const mine = [...records.values()].filter((r) => r.deletedVia === id);
  for (const r of mine) after.set(r.id, { ...r, deleted: false, deletedVia: undefined });
  resolveCascade(after);
  w.change(id, (doc) => setMeta(doc, { deleted: null }));
  const back: string[] = [];
  for (const r of mine) {
    const parents = knownParents(r, after);
    const onlyDeletedParents = parents.length > 0 && parents.every((p) => after.get(p)!.deleted);
    if (onlyDeletedParents) {
      // still only below deleted entries: join their cascade
      const p = after.get(parents[0]!)!;
      w.change(r.id, (doc) => setMeta(doc, { deleted: VIA + (p.deletedVia ?? p.id) }));
    } else {
      w.change(r.id, (doc) => setMeta(doc, { deleted: null }));
      back.push(r.id);
    }
  }
  return back;
}

/** Items deleted with this root that are still in the trash. */
export function cascadeCount(records: Map<string, Item>, id: string): number {
  let n = 0;
  for (const r of records.values()) if (r.deletedVia === id && r.deleted) n++;
  return n;
}

/** What the trash lists: deleted items, except those deleted with a root that is still in the trash (they show with it). */
export function trashRoots(records: Map<string, Item>): Item[] {
  const withRoot = (i: Item) => !!i.deletedVia && !!records.get(i.deletedVia)?.deleted;
  return [...records.values()].filter((i) => i.deleted && !withRoot(i) && (i.kind === "info" || i.kind === "datei" || i.kind === "zeichnung"));
}

/**
 * The ids that purging the deleted item `id` removes for good: it, what was deleted with it, and
 * what was deleted with any root and hangs only below these (else it would come back without a
 * parent). Items deleted on their own stay in the trash.
 */
export function purgeSet(records: Map<string, Item>, id: string): string[] {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of records.values()) {
      if (out.has(r.id) || !r.deleted || !r.deletedVia) continue;
      const parents = knownParents(r, records);
      if (r.deletedVia === id || (parents.length > 0 && parents.every((p) => out.has(p)))) {
        out.add(r.id);
        grew = true;
      }
    }
  }
  return [...out];
}
