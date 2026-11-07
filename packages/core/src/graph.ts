// Derived indexes over all items. Devices, server and agents run the same code, so everyone sees
// the same structure (including how cycles resolve).
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
import { blockingProps, dueOf, isDone, progressSpec, statusOf } from "./traits";
import { sameTypeName } from "./input";
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
  let links = linkCache.get(i);
  if (!links) linkCache.set(i, (links = parseWikiLinks(i.body)));
  return links;
}

function pushTo<V>(map: Map<string, V[]>, key: string, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export class Index {
  /** Includes deleted records (for "type deleted", trash, restore). */
  readonly all: Map<string, Item>;
  /** Live notes, files and drawings, types included. */
  readonly live: Item[];
  readonly byId = new Map<string, Item>();
  readonly types = new Map<string, TypeItem>();

  private _titles?: Map<string, string>;
  private _files?: Map<string, string>;
  /** Title and file name keys that more than one entry answers to. */
  private _shared?: Set<string>;
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

  /** In order; ids of gone items are skipped. */
  items(ids: Iterable<string>): Item[] {
    const out: Item[] = [];
    for (const id of ids) {
      const x = this.byId.get(id);
      if (x) out.push(x);
    }
    return out;
  }

  /** "Arbeit › Relaunch" */
  pathText(ids: string[]): string {
    return ids.map((id) => this.get(id)?.title ?? "").join(" › ");
  }

  schemaOf(item: Item | undefined): TypeSchema | undefined {
    return item?.type ? this.types.get(item.type)?.schema : undefined;
  }

  /** A deleted type counts as no type. */
  typeOf(item: Item): string | null {
    return item.type && this.types.has(item.type) ? item.type : null;
  }

  typeName(id?: string | null): string | undefined {
    if (!id) return undefined;
    if (id === META_TYPE) return undefined;
    return this.all.get(id)?.schema?.name;
  }

  /** The stored plural ("Books"), else a guess in the setup language. */
  typePlural(id: string): string {
    const s = this.types.get(id)?.schema;
    if (!s) return "";
    return s.plural || pluralOf(s.name, this.all.get(SETTINGS_ID)?.settings?.setupLang ?? "de");
  }

  /** Sidebar order; types without a pos come last. */
  typesInOrder(): TypeItem[] {
    return [...this.types.values()].sort((a, b) => cmpKey(a.schema.pos ?? "~", b.schema.pos ?? "~") || a.created - b.created);
  }

  typesByName(): TypeItem[] {
    return [...this.types.values()].sort((a, b) => a.schema.name.localeCompare(b.schema.name));
  }

  captureTypes(): string[] {
    return (this.all.get(SETTINGS_ID)?.settings?.captureTypes ?? []).filter((id) => this.types.has(id));
  }

  /** Singular and plural both match (Task/Tasks, Project/Projects). */
  typeByName(name: string): string | undefined {
    const k = titleKey(name);
    for (const t of this.types.values()) if (titleKey(t.schema.name) === k || titleKey(t.title) === k) return t.id;
    for (const t of this.types.values()) if (sameTypeName(t.schema.name, name) || titleKey(this.typePlural(t.id)) === k) return t.id;
    return undefined;
  }

  /** A filter on a deleted type is ignored. */
  private liveType(of?: string): string | undefined {
    return of && this.types.has(of) ? of : undefined;
  }

  private titles() {
    if (!this._titles) {
      const byTitle = new Map<string, string>();
      const byFileName = new Map<string, string>();
      const seen = new Set<string>();
      const shared = new Set<string>();
      // Older first so the most recently edited wins on duplicate titles.
      for (const r of [...this.live].sort((a, b) => a.updated - b.updated)) {
        const keys = new Set([r.title.trim() ? titleKey(r.title) : "", r.file?.name ? titleKey(r.file.name) : ""]);
        for (const k of keys) if (k) (seen.has(k) ? shared : seen).add(k);
        if (r.title.trim()) byTitle.set(titleKey(r.title), r.id);
        if (r.file?.name) byFileName.set(titleKey(r.file.name), r.id);
      }
      this._titles = byTitle;
      this._files = byFileName;
      this._shared = shared;
    }
    return this._titles;
  }

  /** File names resolve too, so ![[name.png]] keeps working after a rename. */
  resolveTitle = (title: string): string | undefined => {
    const k = titleKey(title);
    const byTitle = this.titles();
    const file = this._files!.get(k);
    if (looksLikeFileName(title) && file) return file;
    // [[id|Label]] links exactly, also to titles that can't be linked by name
    return byTitle.get(k) ?? file ?? (this.byId.has(title.trim()) ? title.trim() : undefined);
  };

  /**
   * How a [[link]] to the item is written: its title when that leads to it and to nothing
   * else, else its id (two entries with one title, or # | [ ] in it), so the link stays exact.
   */
  linkTarget(item: Item): string {
    const title = item.title.trim();
    const unique = !!title && !/[\]|#[\n]/.test(title) && this.resolveTitle(title) === item.id && !this._shared!.has(titleKey(title));
    return unique ? title : item.id;
  }

  /** True when [[links]] by this title lead to the item, so renaming it renames them too. */
  ownsTitle(item: Item): boolean {
    return item.title.trim() !== "" && this.resolveTitle(item.title) === item.id;
  }

  private structure() {
    if (this._parents) return;
    const edges: ParentEdge[] = [];
    for (const r of this.live)
      for (const [p, link] of Object.entries(r.parents)) if (p !== r.id && this.byId.has(p)) edges.push({ child: r.id, parent: p, at: link.at ?? 0 });
    // Oldest first, skipping edges that would close a cycle, so cycles made offline resolve the same
    // way everywhere: the newest edge loses.
    edges.sort((a, b) => a.at - b.at || a.child.localeCompare(b.child) || a.parent.localeCompare(b.parent));
    const parents = new Map<string, string[]>();
    const children = new Map<string, string[]>();
    const cycles: ParentEdge[] = [];
    const hasAncestorOrSelf = (from: string, to: string) => {
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
      if (hasAncestorOrSelf(e.parent, e.child)) {
        cycles.push(e);
        continue;
      }
      pushTo(parents, e.child, e.parent);
      pushTo(children, e.parent, e.child);
    }
    for (const [p, list] of children) {
      list.sort((a, b) => {
        const itemA = this.byId.get(a)!;
        const itemB = this.byId.get(b)!;
        return cmpKey(itemA.parents[p]?.sort ?? "", itemB.parents[p]?.sort ?? "") || itemA.title.localeCompare(itemB.title);
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

  /** Edges ignored because they closed a cycle ("Part of" made offline on two devices). */
  cycleEdgesOf(id: string): string[] {
    this.structure();
    return this._cycleEdges!.filter((e) => e.child === id).map((e) => e.parent);
  }

  /** Effective home: the stored one if still a parent, else the oldest remaining parent. */
  home(id: string): string | undefined {
    const parents = this.parentsOf(id);
    if (!parents.length) return undefined;
    const item = this.byId.get(id)!;
    if (item.home && parents.includes(item.home)) return item.home;
    return [...parents].sort((a, b) => (item.parents[a]?.at ?? 0) - (item.parents[b]?.at ?? 0) || a.localeCompare(b))[0];
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

  /**
   * All ancestors over all parents, each once, from the top down: every ancestor comes after
   * those above it, the home's line before the other parents.
   */
  ancestors(id: string): string[] {
    const out: string[] = [];
    const seen = new Set([id]);
    const visit = (x: string) => {
      const home = this.home(x);
      for (const p of home ? [home, ...this.parentsOf(x).filter((q) => q !== home)] : this.parentsOf(x)) {
        if (seen.has(p)) continue;
        seen.add(p);
        visit(p);
        out.push(p);
      }
    };
    visit(id);
    return out;
  }

  /** Over all parents, not just the home. */
  descendants(id: string): Set<string> {
    const cached = this._desc.get(id);
    if (cached) return cached;
    const found = new Set<string>();
    const stack = [...this.childrenOf(id)];
    while (stack.length) {
      const x = stack.pop()!;
      if (found.has(x) || x === id) continue;
      found.add(x);
      stack.push(...this.childrenOf(x));
    }
    this._desc.set(id, found);
    return found;
  }

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
      const parents = this.parentsOf(x);
      const homeFirst = home ? [home, ...parents.filter((q) => q !== home)] : parents;
      for (const p of homeFirst) {
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

  textLinks(item: Item): { to: string; embed: boolean; size?: number }[] {
    const out: { to: string; embed: boolean; size?: number }[] = [];
    for (const l of linksOf(item)) {
      const to = this.resolveTitle(l.target);
      if (to && to !== item.id) out.push({ to, embed: l.embed, size: l.size });
    }
    return out;
  }

  /** Entries linked (not embedded) in the text, plus refs. */
  mentions(item: Item): string[] {
    return [...this.textLinks(item).filter((l) => !l.embed).map((l) => l.to), ...item.refs];
  }

  missingLinks(item: Item): string[] {
    return linksOf(item)
      .filter((l) => !this.resolveTitle(l.target))
      .map((l) => l.target);
  }

  private backlinkIndex() {
    if (!this._backlinks) {
      const m = new Map<string, Backlink[]>();
      const add = (to: string, b: Backlink) => pushTo(m, to, b);
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

  /** "Area": the first pinned entry on the home path (Work, Personal …). */
  area(id: string): string | undefined {
    return this.homePath(id).find((p) => this.byId.get(p)?.pinned);
  }

  /** Embedded, linked or referenced from a note; relations don't count. */
  usedIn(fileId: string): Backlink[] {
    return this.backlinks(fileId).filter((b) => b.kind !== "rel" && this.byId.get(b.from)?.kind === "note");
  }

  /** Everything this item is connected to (for linked:). */
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

  /**
   * Counts only descendants with a status. A filter on a deleted type is ignored, so progress
   * survives deleting a type.
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

  progressOf(item: Item): { done: number; total: number } | undefined {
    const spec = progressSpec(this.schemaOf(item));
    return spec ? this.progress(item.id, spec.of) : undefined;
  }

  /**
   * Open targets of blocking relations ("Blocked by") and blocking texts ("Waiting for"). Done
   * or deleted blockers don't count.
   */
  blockers(item: Item): { by: Item[]; waiting?: string } {
    const by: Item[] = [];
    const waiting: string[] = [];
    for (const p of blockingProps(this.schemaOf(item))) {
      if (p.kind === "relation") {
        for (const x of this.items(this.relValues(item, p.id))) if (!isDone(x, this.schemaOf(x)) && !by.includes(x)) by.push(x);
      } else {
        const w = item.props[p.id];
        if (typeof w === "string" && w.trim()) waiting.push(w.trim());
      }
    }
    return { by, waiting: waiting.length ? waiting.join("; ") : undefined };
  }

  isBlocked(item: Item): boolean {
    const b = this.blockers(item);
    return b.by.length > 0 || !!b.waiting;
  }

  /** Children without a status don't count ("open subtasks"). */
  openChildren(id: string): Item[] {
    return this.childrenOf(id)
      .map((c) => this.byId.get(c)!)
      .filter((c) => {
        const s = statusOf(c, this.schemaOf(c));
        return !!s && s.group !== "done";
      });
  }

  /**
   * "Dormant": the item or something above it is done, so tasks of a finished project stay out of
   * the focus lists.
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
      if (s?.group === "done") return true;
      stack.push(...this.parentsOf(id));
    }
    return false;
  }

  /**
   * An open entry below the item that is not blocked and has no open entries below. Due by today comes first, then in progress, then by due date.
   */
  nextTask(id: string, today: string): Item | undefined {
    const candidates = [...this.descendants(id)]
      .map((d) => this.byId.get(d)!)
      .filter((x) => {
        const s = statusOf(x, this.schemaOf(x));
        return !!s && s.group !== "done" && !this.isBlocked(x) && this.openChildren(x.id).length === 0;
      });
    const key = (x: Item) => {
      const due = dueOf(x, this.schemaOf(x));
      const s = statusOf(x, this.schemaOf(x))!;
      const dueByToday = !!due && due <= today;
      return [dueByToday ? 0 : 1, dueByToday ? due : "", s.group === "active" ? 0 : 1, due ?? "9999", x.title.toLowerCase()] as const;
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

  itemsOfType(typeId: string): Item[] {
    return this.live.filter((r) => r.type === typeId);
  }

  tags(): { tag: string; count: number }[] {
    const m = new Map<string, number>();
    for (const r of this.live) for (const t of r.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }
}
