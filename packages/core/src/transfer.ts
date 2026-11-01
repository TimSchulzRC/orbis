// Workspaces share nothing, so moving to another workspace copies the item and what hangs only
// below it with new ids; the originals go to the trash so "Wiederherstellen" brings them back.
// Parents, refs and relations to items left behind are dropped; [[id|…]] links to them become
// [[Label]] links. Types are matched by id or name, not merged; a missing type is copied. Values
// without a matching property become free properties.
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
  /** types created in the other workspace */
  types: string[];
}

/** The root and what hangs only below it, without types. */
export function movedItems(ix: Index, root: string): Item[] {
  return [root, ...onlyBelow(ix, root)].map((id) => ix.get(id)).filter((r): r is Item => !!r && r.type !== META_TYPE);
}

/** Shown before a move. Empty lists and 0 mean it goes over unchanged. */
export interface MovePlan {
  items: number;
  files: number;
  copiedTypes: string[];
  /** no fitting property or option there, so values become free properties */
  freeProps: string[];
  /** links, refs and relations to items that stay behind */
  droppedLinks: number;
}

/** Dry run of copyToWorkspace. */
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
 * The root lands below `place.parent`, pinned, or with neither in the inbox. The caller then
 * trashes the originals and copies the file contents (`hashes`).
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

/** Same id (shipped types), else same name. */
function sameType(id: string, from: TypeSchema, dst: Index): string | undefined {
  return dst.types.has(id) ? id : dst.typeByName(from.name);
}

/** Includes removed properties, whose values are still stored. */
function propOf(s: TypeSchema | undefined, id: string): PropDef | undefined {
  return s?.properties.find((x) => x.id === id) ?? s?.removedProperties.find((x) => x.id === id);
}

function target(p: PropDef, to: TypeSchema): PropDef | undefined {
  if (p.kind === "computed") return undefined;
  return to.properties.find((q) => q.id === p.id && q.kind === p.kind) ?? to.properties.find((q) => titleKey(q.name) === titleKey(p.name) && q.kind === p.kind);
}
