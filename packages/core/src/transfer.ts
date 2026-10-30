// Moving items to another workspace. Workspaces share
// nothing, so a move is a copy: the item and everything that hangs only below it (what the trash
// would take along) are written into the other workspace with new ids, then the originals go to
// the trash (deleteItem, so "Wiederherstellen" brings them back). What points outside the moved
// items cannot come along: parents, refs and relations to items left behind are dropped, [[id|…]]
// links to them become [[Label]] links (by title, as typed links are).
//
// Types are matched, not merged: the same type id (the shipped types) or a type of the same name
// takes the values property by property (same id, else same name and kind; options by id, else by
// name). A type the other workspace does not have is copied there. Values without a place become
// free properties, as when a property is removed.
import { type Item, type PropDef, type TypeSchema, META_TYPE, addParent, appendUpdate, initItem, initType, mapWikiLinks, newId, setExtra, setFileMeta, setHome, setMeta, setProp, setRel, titleKey } from "./model";
import type { Index } from "./graph";
import type { Writer } from "./setup";
import { statusProp } from "./traits";
import { onlyBelow } from "./trash";
import { mapValue, toFree } from "./typeops";

export interface Moved {
  /** old id → new id, the root first */
  ids: Map<string, string>;
  /** file contents (originals, display versions, previews) the other workspace needs */
  hashes: string[];
  /** types created in the other workspace (it had none of that name) */
  types: string[];
}

/** The items a move of `root` takes along: the root and what hangs only below it (no types). */
export function movedItems(ix: Index, root: string): Item[] {
  return [root, ...onlyBelow(ix, root)].map((id) => ix.get(id)).filter((r): r is Item => !!r && r.type !== META_TYPE);
}

/** What a move would change on the way, to show before it happens. Empty lists, 0: it goes over as it is. */
export interface MovePlan {
  items: number;
  files: number;
  /** types the other workspace gets a copy of (it has none of that name) */
  copiedTypes: string[];
  /** properties whose values become free properties there (no fitting property or option) */
  freeProps: string[];
  /** links, refs and relations to items that stay behind */
  droppedLinks: number;
}

/** The plan of `copyToWorkspace` for `root` into a workspace with the index `dst`, without writing. */
export function planMove(src: Index, root: string, dst: Index): MovePlan {
  const items = movedItems(src, root);
  const inside = new Set(items.map((r) => r.id));
  const copiedTypes = new Set<string>();
  const freeProps = new Set<string>();
  let droppedLinks = 0;
  for (const r of items) {
    const from = r.type ? src.get(r.type)?.schema : undefined;
    let to = from;
    if (from) {
      const same = sameType(r.type!, from, dst);
      if (same) to = dst.types.get(same)!.schema;
      else copiedTypes.add(from.name);
    }
    for (const [pid, v] of Object.entries(r.props)) {
      const p = propOf(from, pid);
      const q = p && to ? target(p, to) : undefined;
      if (p && (!q || mapValue(p, q, v, { byId: true }) === undefined)) freeProps.add(p.name);
    }
    const outside = (id: string) => !inside.has(id);
    droppedLinks += r.refs.filter(outside).length + Object.values(r.rels).flat().filter(outside).length + src.textLinks(r).filter((l) => outside(l.to)).length;
  }
  return { items: items.length, files: items.filter((r) => r.file).length, copiedTypes: [...copiedTypes], freeProps: [...freeProps], droppedLinks };
}

/**
 * Copy `root` with what hangs only below it from `src` into another workspace. The root lands
 * below `place.parent`, pinned (`place.pinned` sort key) or – with neither – in the inbox.
 * The caller then trashes the originals and brings the file contents over (`hashes`).
 */
export function copyToWorkspace(src: Index, root: string, dst: { w: Writer; ix: Index }, place: { parent?: string; pinned?: string }, by: string): Moved {
  const items = movedItems(src, root);
  const ids = new Map(items.map((r) => [r.id, newId()]));
  const types = new Map<string, { id: string; from: TypeSchema; to: TypeSchema }>();
  const created: string[] = [];
  const now = Date.now();

  for (const t of new Set(items.map((r) => r.type).filter((t): t is string => !!t))) {
    const from = src.get(t)?.schema;
    if (!from) continue;
    const same = sameType(t, from, dst.ix);
    if (same) {
      types.set(t, { id: same, from, to: dst.ix.types.get(same)!.schema });
      continue;
    }
    const id = newId();
    dst.w.change(id, (doc) => {
      const { name, plural, icon, color, description, capabilities } = from;
      initType(doc, { name, plural, icon, color, description, capabilities, properties: from.properties.map(({ sort: _s, ...p }) => p) }, { createdBy: by }, now);
    });
    created.push(id);
    types.set(t, { id, from, to: from });
  }

  const relink = (body: string) =>
    mapWikiLinks(body, (l) => {
      const id = l.target.trim();
      if (!src.get(id)) return l.raw; // a title: resolves by name in the other workspace
      const open = l.embed ? "![[" : "[[";
      const to = ids.get(id);
      if (to) return `${open}${to}${l.section}${l.label !== undefined ? "|" + l.label : ""}]]`;
      return `${open}${l.label || src.get(id)!.title}${l.section}]]`;
    });

  for (const r of items) {
    const map = r.type ? types.get(r.type) : undefined;
    dst.w.change(ids.get(r.id)!, (doc) => {
      initItem(
        doc,
        {
          kind: r.kind,
          title: r.title,
          type: map?.id ?? null,
          body: relink(r.body),
          tags: r.tags,
          refs: r.refs.map((x) => ids.get(x)).filter((x): x is string => !!x),
          extra: r.extra,
          created: r.created,
          updated: now,
          createdBy: r.createdBy ?? by,
          source: r.source,
        },
        now,
      );
      if (r.id === root) {
        if (place.parent) addParent(doc, place.parent, undefined, now);
        if (place.pinned) setMeta(doc, { pinned: place.pinned }, now);
      } else {
        for (const [p, link] of Object.entries(r.parents)) if (ids.has(p)) addParent(doc, ids.get(p)!, link.sort, link.at);
        if (r.home && ids.has(r.home)) setHome(doc, ids.get(r.home)!);
      }
      if (r.file) {
        const { history: _h, ...file } = r.file;
        setFileMeta(doc, file);
      }
      // values of the type's properties, relations among the moved items
      for (const [pid, v] of Object.entries(r.props)) {
        const p = propOf(map?.from, pid);
        const q = p && map ? target(p, map.to) : undefined;
        const value = p && q ? mapValue(p, q, v, { byId: true }) : undefined;
        if (q && value !== undefined) setProp(doc, q.id, value);
        else if (p) {
          const free = toFree(p, v);
          if (free && r.extra[p.name] === undefined) setExtra(doc, p.name, free);
        }
      }
      for (const [pid, targets] of Object.entries(r.rels)) {
        const p = map?.from.properties.find((x) => x.id === pid);
        const q = p && map ? target(p, map.to) : undefined;
        for (const t of targets) if (q && ids.has(t)) setRel(doc, q.id, ids.get(t)!, true);
      }
      const p = statusProp(map?.from);
      const q = p ? target(p, map!.to) : undefined;
      for (const u of r.updates) {
        const opt = u.status && p && q ? mapValue(p, q, u.status, { byId: true }) : undefined;
        appendUpdate(doc, { at: u.at, text: u.text, by: u.by, ...(typeof opt === "string" ? { status: opt } : {}) });
      }
    });
  }

  const hashes = [...new Set(items.flatMap((r) => (r.file ? [r.file.hash, r.file.display, r.file.thumb] : [])).filter((h): h is string => !!h))];
  return { ids, hashes, types: created };
}

/** The type of the other workspace that takes items of type `id`: the same id (the shipped types), else the same name. */
function sameType(id: string, from: TypeSchema, dst: Index): string | undefined {
  return dst.types.has(id) ? id : dst.typeByName(from.name);
}

/** A property of the type by id, also a removed one (its values are still there). */
function propOf(s: TypeSchema | undefined, id: string): PropDef | undefined {
  return s?.properties.find((x) => x.id === id) ?? s?.removedProperties.find((x) => x.id === id);
}

/** The property of the other type that takes a value: same id and kind, else same name and kind. */
function target(p: PropDef, to: TypeSchema): PropDef | undefined {
  if (p.kind === "computed") return undefined;
  return to.properties.find((q) => q.id === p.id && q.kind === p.kind) ?? to.properties.find((q) => titleKey(q.name) === titleKey(p.name) && q.kind === p.kind);
}
