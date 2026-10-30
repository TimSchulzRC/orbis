// Derived indexes over all items: titles, "Teil von" (with cycle resolution), descendants,
// paths, links, backlinks, relation inverses, file usage, progress. The same code runs on
// devices, the server and for agents, so everyone sees the same structure.
import {
  type Item,
  type TypeItem,
  type TypeSchema,
  META_TYPE,
  SETTINGS_ID,
  isContent,
  looksLikeFileName,
  parseWikiLinks,
  titleKey,
} from "./model";
import { blockingProps, dueOf, isDone, primaryChild, priorityProp, progressSpec, statusOf, statusProp } from "./traits";
import { isPausedOption, sameTypeName } from "./input";
import { pluralOf } from "./plural";
import { cmpKey } from "./sortkey";

export interface Backlink {
  from: string;
  kind: "link" | "embed" | "ref" | "rel";
  prop?: string;
}

interface ParentEdge {
  child: string;
  parent: string;
  at: number;
}

const linkCache = new WeakMap<Item, { target: string; embed: boolean; size?: number }[]>();

function linksOf(i: Item) {
  let l = linkCache.get(i);
  if (!l) linkCache.set(i, (l = parseWikiLinks(i.body)));
  return l;
}

export class Index {
  /** All records, including deleted ones (needed for "Typ gelöscht", trash, restore). */
  readonly all: Map<string, Item>;
  /** Live informations and files (types included). */
  readonly live: Item[];
  readonly byId = new Map<string, Item>();
  readonly types = new Map<string, TypeItem>();

  private _titles?: Map<string, string>;
  private _files?: Map<string, string>;
  private _parents?: Map<string, string[]>;
  private _children?: Map<string, string[]>;
  private _cycleEdges?: ParentEdge[];
  private _backlinks?: Map<string, Backlink[]>;
  private _desc = new Map<string, Set<string>>();

  constructor(records: Map<string, Item> | Item[]) {
    this.all = records instanceof Map ? records : new Map(records.map((r) => [r.id, r]));
    this.live = [];
    for (const r of this.all.values()) {
      if (!isContent(r)) continue;
      this.live.push(r);
      this.byId.set(r.id, r);
      if (r.type === META_TYPE && r.schema) this.types.set(r.id, r as TypeItem);
    }
  }

  get(id?: string | null): Item | undefined {
    return id ? this.byId.get(id) : undefined;
  }

  /** The live items of these ids, in order; gone ones are left out. */
  items(ids: Iterable<string>): Item[] {
    const out: Item[] = [];
    for (const id of ids) {
      const x = this.byId.get(id);
      if (x) out.push(x);
    }
    return out;
  }

  /** Titles of these ids as a path ("Arbeit › Relaunch"). */
  pathText(ids: string[]): string {
    return ids.map((id) => this.get(id)?.title ?? "").join(" › ");
  }

  // ---------- types ----------

  schemaOf(item: Item | undefined): TypeSchema | undefined {
    return item?.type ? this.types.get(item.type)?.schema : undefined;
  }

  /** Type id if it points to a live type; a deleted type counts as no type. */
  typeOf(item: Item): string | null {
    return item.type && this.types.has(item.type) ? item.type : null;
  }

  typeName(id?: string | null): string | undefined {
    if (!id) return undefined;
    if (id === META_TYPE) return undefined;
    return this.all.get(id)?.schema?.name;
  }

  /** The name of a type's list: its plural ("Bücher"), a guess in the setup language while unset. */
  typePlural(id: string): string {
    const s = this.types.get(id)?.schema;
    if (!s) return "";
    return s.plural || pluralOf(s.name, this.all.get(SETTINGS_ID)?.settings?.setupLang ?? "de");
  }

  /** The types in their order (sidebar, phone bar): by their key, those without at the end. */
  typesInOrder(): TypeItem[] {
    return [...this.types.values()].sort((a, b) => cmpKey(a.schema.pos ?? "~", b.schema.pos ?? "~") || a.created - b.created);
  }

  /** The types by name (pickers, menus). */
  typesByName(): TypeItem[] {
    return [...this.types.values()].sort((a, b) => a.schema.name.localeCompare(b.schema.name));
  }

  /** The types pinned in the capture type picker (settings), those that still exist. */
  captureTypes(): string[] {
    return (this.all.get(SETTINGS_ID)?.settings?.captureTypes ?? []).filter((id) => this.types.has(id));
  }

  /** A type by name; singular and plural both work (Task/Tasks, Projekt/Projekte). */
  typeByName(name: string): string | undefined {
    const k = titleKey(name);
    for (const t of this.types.values()) if (titleKey(t.schema.name) === k || titleKey(t.title) === k) return t.id;
    for (const t of this.types.values()) if (sameTypeName(t.schema.name, name) || titleKey(this.typePlural(t.id)) === k) return t.id;
    return undefined;
  }

  /** A type id if it names a live type; else undefined (a filter on a deleted type is ignored). */
  private liveType(of?: string): string | undefined {
    return of && this.types.has(of) ? of : undefined;
  }

  // ---------- titles ----------

  private titles() {
    if (!this._titles) {
      const t = new Map<string, string>();
      const f = new Map<string, string>();
      // Older first so the most recently edited wins on duplicate titles.
      for (const r of [...this.live].sort((a, b) => a.updated - b.updated)) {
        if (r.title.trim()) t.set(titleKey(r.title), r.id);
        if (r.file?.name) f.set(titleKey(r.file.name), r.id);
      }
      this._titles = t;
      this._files = f;
    }
    return this._titles;
  }

  /** [[Title]] → id. File names resolve too, so ![[name.png]] from Obsidian keeps working after a rename. */
  resolveTitle = (title: string): string | undefined => {
    const k = titleKey(title);
    const t = this.titles();
    const byName = this._files!.get(k);
    if (looksLikeFileName(title) && byName) return byName;
    // [[id|Label]] links exactly, also to titles that can't be linked by name
    return t.get(k) ?? byName ?? (this.byId.has(title.trim()) ? title.trim() : undefined);
  };

  /** Do [[links]] by the item's title lead to it? Then renaming it renames them too. */
  ownsTitle(item: Item): boolean {
    return item.title.trim() !== "" && this.resolveTitle(item.title) === item.id;
  }

  // ---------- "Teil von" ----------

  private structure() {
    if (this._parents) return;
    const edges: ParentEdge[] = [];
    for (const r of this.live)
      for (const [p, link] of Object.entries(r.parents)) if (p !== r.id && this.byId.has(p)) edges.push({ child: r.id, parent: p, at: link.at ?? 0 });
    // Add edges oldest first; an edge that would close a cycle is skipped. So offline-made
    // cycles resolve deterministically: the edge added last does not count.
    edges.sort((a, b) => a.at - b.at || a.child.localeCompare(b.child) || a.parent.localeCompare(b.parent));
    const parents = new Map<string, string[]>();
    const children = new Map<string, string[]>();
    const cycles: ParentEdge[] = [];
    const reaches = (from: string, to: string) => {
      // is `to` an ancestor-or-self of `from`? walk up from `from`
      const seen = new Set<string>();
      const stack = [from];
      while (stack.length) {
        const x = stack.pop()!;
        if (x === to) return true;
        if (seen.has(x)) continue;
        seen.add(x);
        for (const p of parents.get(x) ?? []) stack.push(p);
      }
      return false;
    };
    for (const e of edges) {
      // child under parent closes a cycle if child is an ancestor-or-self of parent
      if (reaches(e.parent, e.child)) {
        cycles.push(e);
        continue;
      }
      (parents.get(e.child) ?? parents.set(e.child, []).get(e.child)!).push(e.parent);
      (children.get(e.parent) ?? children.set(e.parent, []).get(e.parent)!).push(e.child);
    }
    for (const [p, list] of children) {
      list.sort((a, b) => {
        const sa = this.byId.get(a)!.parents[p]?.sort ?? "";
        const sb = this.byId.get(b)!.parents[p]?.sort ?? "";
        return cmpKey(sa, sb) || this.byId.get(a)!.title.localeCompare(this.byId.get(b)!.title);
      });
    }
    this._parents = parents;
    this._children = children;
    this._cycleEdges = cycles;
  }

  parentsOf(id: string): string[] {
    this.structure();
    return this._parents!.get(id) ?? [];
  }

  childrenOf(id: string): string[] {
    this.structure();
    return this._children!.get(id) ?? [];
  }

  /** Edges ignored because they closed a cycle ("Teil von" made offline on two devices). */
  cycleEdgesOf(id: string): string[] {
    this.structure();
    return this._cycleEdges!.filter((e) => e.child === id).map((e) => e.parent);
  }

  /** Effective home: the stored one if still a parent, else the oldest remaining parent. */
  home(id: string): string | undefined {
    const ps = this.parentsOf(id);
    if (!ps.length) return undefined;
    const item = this.byId.get(id)!;
    if (item.home && ps.includes(item.home)) return item.home;
    return [...ps].sort((a, b) => (item.parents[a]?.at ?? 0) - (item.parents[b]?.at ?? 0) || a.localeCompare(b))[0];
  }

  /** Ancestors along the home chain, root first. */
  homePath(id: string): string[] {
    const out: string[] = [];
    const seen = new Set([id]);
    for (let p = this.home(id); p && !seen.has(p); p = this.home(p)) {
      out.unshift(p);
      seen.add(p);
    }
    return out;
  }

  /** All descendants over all parents, each once. */
  descendants(id: string): Set<string> {
    let d = this._desc.get(id);
    if (d) return d;
    d = new Set();
    const stack = [...this.childrenOf(id)];
    while (stack.length) {
      const x = stack.pop()!;
      if (d.has(x) || x === id) continue;
      d.add(x);
      stack.push(...this.childrenOf(x));
    }
    this._desc.set(id, d);
    return d;
  }

  /** Would putting `child` under `parent` create a cycle? */
  wouldCycle(child: string, parent: string): boolean {
    return child === parent || this.descendants(child).has(parent);
  }

  /**
   * Path from `ctx` down to `id`, excluding both: the shortest way, preferring the home.
   * Empty when `id` is a direct child; undefined when `id` is not below `ctx`.
   */
  relPath(ctx: string, id: string): string[] | undefined {
    if (ctx === id) return [];
    const prev = new Map<string, string>();
    const queue = [id];
    const seen = new Set([id]);
    while (queue.length) {
      const x = queue.shift()!;
      const home = this.home(x);
      const ps = this.parentsOf(x);
      for (const p of home ? [home, ...ps.filter((q) => q !== home)] : ps) {
        if (seen.has(p)) continue;
        seen.add(p);
        prev.set(p, x);
        if (p === ctx) {
          const path: string[] = [];
          for (let c = prev.get(ctx)!; c !== id; c = prev.get(c)!) path.push(c);
          return path;
        }
        queue.push(p);
      }
    }
    return undefined;
  }

  // ---------- links ----------

  /** Links in the text, resolved. */
  textLinks(item: Item): { to: string; embed: boolean; size?: number }[] {
    const out: { to: string; embed: boolean; size?: number }[] = [];
    for (const l of linksOf(item)) {
      const to = this.resolveTitle(l.target);
      if (to && to !== item.id) out.push({ to, embed: l.embed, size: l.size });
    }
    return out;
  }

  /** What an item mentions: the entries linked in its text (not embedded) and its refs. */
  mentions(item: Item): string[] {
    return [...this.textLinks(item).filter((l) => !l.embed).map((l) => l.to), ...item.refs];
  }

  /** Unresolved [[links]] (titles that don't exist yet). */
  missingLinks(item: Item): string[] {
    return linksOf(item)
      .filter((l) => !this.resolveTitle(l.target))
      .map((l) => l.target);
  }

  private backlinkIndex() {
    if (!this._backlinks) {
      const m = new Map<string, Backlink[]>();
      const add = (to: string, b: Backlink) => (m.get(to) ?? m.set(to, []).get(to)!).push(b);
      for (const r of this.live) {
        const seen = new Set<string>();
        for (const l of this.textLinks(r)) {
          const k = l.to + (l.embed ? "e" : "l");
          if (seen.has(k)) continue;
          seen.add(k);
          add(l.to, { from: r.id, kind: l.embed ? "embed" : "link" });
        }
        for (const x of r.refs) if (x !== r.id && this.byId.has(x)) add(x, { from: r.id, kind: "ref" });
        for (const [prop, ids] of Object.entries(r.rels)) for (const x of ids) if (this.byId.has(x)) add(x, { from: r.id, kind: "rel", prop });
      }
      this._backlinks = m;
    }
    return this._backlinks;
  }

  backlinks(id: string): Backlink[] {
    return this.backlinkIndex().get(id) ?? [];
  }

  /** Targets of a relation property, including the other side of a symmetric relation. */
  relValues(item: Item, propId: string, symmetric = false): string[] {
    const own = (item.rels[propId] ?? []).filter((x) => this.byId.has(x));
    if (!symmetric) return own;
    const back = this.backlinks(item.id).filter((b) => b.kind === "rel" && b.prop === propId).map((b) => b.from);
    return [...new Set([...own, ...back])];
  }

  /** "Bereich": the top place an entry lives in – the first pinned entry on its home path (Arbeit, Persönlich …). */
  area(id: string): string | undefined {
    return this.homePath(id).find((p) => this.byId.get(p)?.pinned);
  }

  /** The project of an entry: the nearest ancestor on its home path that has a status and another type (a sub-task's project, not its parent task). */
  project(id: string): string | undefined {
    const item = this.byId.get(id);
    const path = this.homePath(id);
    for (let n = path.length - 1; n >= 0; n--) {
      const p = this.byId.get(path[n]!);
      if (p && p.type !== item?.type && statusProp(this.schemaOf(p))) return p.id;
    }
    return undefined;
  }

  /** Where a file is used: embedded or linked in the text, or referenced. */
  usedIn(fileId: string): Backlink[] {
    return this.backlinks(fileId).filter((b) => b.kind !== "rel" && this.byId.get(b.from)?.kind === "info");
  }

  /** Everything this item is connected to (for verknüpft:/linked:). */
  connected(id: string): Set<string> {
    const item = this.byId.get(id);
    const out = new Set<string>();
    if (item) {
      for (const l of this.textLinks(item)) out.add(l.to);
      for (const r of item.refs) out.add(r);
      for (const ids of Object.values(item.rels)) for (const x of ids) out.add(x);
    }
    for (const b of this.backlinks(id)) out.add(b.from);
    out.delete(id);
    return out;
  }

  // ---------- aggregation ----------

  /**
   * Progress: done descendants among descendants that have a status. The type filter is
   * optional; a filter on a type that no longer exists is ignored, so progress survives
   * deleting or renaming a type.
   */
  progress(id: string, of?: string): { done: number; total: number } {
    const filter = this.liveType(of);
    let done = 0;
    let total = 0;
    for (const d of this.descendants(id)) {
      const x = this.byId.get(d)!;
      if (filter && x.type !== filter) continue;
      const schema = this.schemaOf(x);
      if (!statusOf(x, schema)) continue;
      total++;
      if (isDone(x, schema)) done++;
    }
    return { done, total };
  }

  /** Progress as the item's type defines it, if the type has the capability. */
  progressOf(item: Item): { done: number; total: number } | undefined {
    const spec = progressSpec(this.schemaOf(item));
    return spec ? this.progress(item.id, spec.of) : undefined;
  }

  /**
   * What blocks an item: open entries under "Blockiert durch" and the text of "Wartet auf".
   * Done or deleted blockers no longer count.
   */
  blockers(item: Item): { by: Item[]; waiting?: string } {
    const { by, waiting } = blockingProps(this.schemaOf(item));
    const open = by ? this.items(this.relValues(item, by.id)).filter((x) => !isDone(x, this.schemaOf(x))) : [];
    const w = waiting ? item.props[waiting.id] : undefined;
    return { by: open, waiting: typeof w === "string" && w.trim() ? w.trim() : undefined };
  }

  isBlocked(item: Item): boolean {
    const b = this.blockers(item);
    return b.by.length > 0 || !!b.waiting;
  }

  /** Direct children with a status that is not done ("offene Unteraufgaben"). */
  openChildren(id: string): Item[] {
    return this.childrenOf(id)
      .map((c) => this.byId.get(c)!)
      .filter((c) => {
        const s = statusOf(c, this.schemaOf(c));
        return !!s && s.group !== "done";
      });
  }

  /**
   * "Ruhend": the item or something above it is paused or done – nothing urgent comes from
   * here (tasks of a paused project stay out of the focus lists).
   */
  isDormant(item: Item): boolean {
    const seen = new Set<string>();
    const stack = [item.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const x = this.byId.get(id);
      const s = x && statusOf(x, this.schemaOf(x));
      if (s && (s.group === "done" || isPausedOption(s.option))) return true;
      stack.push(...this.parentsOf(id));
    }
    return false;
  }

  /**
   * The next thing to do in a project: an open entry below it (of the type its main action
   * creates, if it has one) that is not blocked, not paused and has no open entries below
   * itself. Order: due by today first, then in progress, then priority, then due date.
   */
  nextTask(id: string, today: string): Item | undefined {
    const kind = primaryChild(this.schemaOf(this.byId.get(id)));
    const prioRank = (x: Item) => {
      const p = priorityProp(this.schemaOf(x));
      const v = p ? x.props[p.id] : undefined;
      const i = p?.options?.findIndex((o) => o.id === v) ?? -1;
      return i < 0 ? 99 : i;
    };
    const candidates = [...this.descendants(id)]
      .map((d) => this.byId.get(d)!)
      .filter((x) => {
        if (kind && x.type !== kind) return false;
        const s = statusOf(x, this.schemaOf(x));
        return !!s && s.group !== "done" && !isPausedOption(s.option) && !this.isBlocked(x) && this.openChildren(x.id).length === 0;
      });
    const key = (x: Item) => {
      const due = dueOf(x, this.schemaOf(x));
      const s = statusOf(x, this.schemaOf(x))!;
      return [due && due <= today ? 0 : 1, due && due <= today ? due : "", s.group === "active" ? 0 : 1, prioRank(x), due ?? "9999", x.title.toLowerCase()] as const;
    };
    return candidates.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
      return 0;
    })[0];
  }

  countDescendants(id: string, of?: string): number {
    const filter = this.liveType(of);
    let n = 0;
    for (const d of this.descendants(id)) if (!filter || this.byId.get(d)!.type === filter) n++;
    return n;
  }

  /** Items of a type (its list). */
  itemsOfType(typeId: string): Item[] {
    return this.live.filter((r) => r.type === typeId);
  }

  tags(): { tag: string; count: number }[] {
    const m = new Map<string, number>();
    for (const r of this.live) for (const t of r.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }
}
