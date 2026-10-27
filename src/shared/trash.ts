// Trash with cascade. meta.deleted is `true` (deleted itself) or "via:<root>" (deleted
// together with that root). A cascaded item only counts as deleted while
//   - the root is deleted,
//   - the root is still above it ("Teil von", over all levels), and
//   - every parent it has is deleted (another living parent always keeps it).
// Every device computes this from the same data, so concurrent moves and deletes need no
// coordination: an item another device moved away from the root simply stays alive.
import { type Item, META_TYPE, VIA, setMeta, removeParent } from "./model";
import type { Index } from "./graph";
import type { Writer } from "./setup";

/** Recompute `deleted` of cascaded items from their roots. Replaces changed records in place. */
export function resolveCascade(records: Map<string, Item>): void {
  const via = [...records.values()].filter((r) => r.deletedVia);
  if (!via.length) return;
  const memo = new Map<string, boolean>();
  const parentsOf = (id: string) => Object.keys(records.get(id)?.parents ?? {}).filter((p) => p !== id && records.has(p));
  const above = (root: string, id: string) => {
    const seen = new Set<string>();
    const stack = parentsOf(id);
    while (stack.length) {
      const x = stack.pop()!;
      if (x === root) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...parentsOf(x));
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
    const ps = parentsOf(id);
    const root = r.deletedVia;
    const v = records.has(root) && deleted(root) && above(root, id) && ps.length > 0 && ps.every(deleted);
    memo.set(id, v);
    return v;
  };
  for (const r of via) {
    const d = deleted(r.id);
    if (d !== r.deleted) records.set(r.id, { ...r, deleted: d });
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
 * Delete an item. Children that hang only here either go along ("trash", marked via the
 * root, restorable together) or lose this place ("inbox": the parent is removed, so untyped
 * ones land in the inbox). Children with another living parent are never touched.
 */
export function deleteItem(w: Writer, ix: Index, id: string, children: "trash" | "inbox" = "trash"): string[] {
  // a type goes only through deleteType (typeops.ts), with its preview and the choice what becomes of the values
  if (ix.get(id)?.type === META_TYPE) throw new Error("Types are deleted on the type page, not moved to the trash.");
  const only = onlyBelow(ix, id);
  w.change(id, (doc) => setMeta(doc, { deleted: true }));
  if (children === "trash") for (const c of only) w.change(c, (doc) => setMeta(doc, { deleted: VIA + id }));
  else for (const c of only) if (ix.parentsOf(c).includes(id)) w.change(c, (doc) => removeParent(doc, id));
  return only;
}

/**
 * Restore an item and exactly what was deleted with it. An item that still only hangs
 * below other deleted entries (nested deletes) stays in the trash with them.
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
    const ps = Object.keys(r.parents).filter((p) => p !== r.id && after.has(p));
    const deadParent = ps.length > 0 && ps.every((p) => after.get(p)!.deleted) ? ps.map((p) => after.get(p)!) : undefined;
    if (deadParent) {
      // still only below deleted entries: it now belongs to their cascade
      const p = deadParent[0]!;
      w.change(r.id, (doc) => setMeta(doc, { deleted: VIA + (p.deletedVia ?? p.id) }));
    } else {
      w.change(r.id, (doc) => setMeta(doc, { deleted: null }));
      back.push(r.id);
    }
  }
  return back;
}

/** How many items were deleted together with this root and are still in the trash with it. */
export function cascadeCount(records: Map<string, Item>, id: string): number {
  let n = 0;
  for (const r of records.values()) if (r.deletedVia === id && r.deleted) n++;
  return n;
}
