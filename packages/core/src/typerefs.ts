// Views, query blocks and relation targets name properties and types by their text, not by id.
// When a type changes, these functions carry the change over to every place that names it, so a
// removed property leaves the table and a renamed one keeps its column, sort and filter.
import { type Item, type PropDef, type ViewDef, type ViewTab, SETTINGS_ID, replaceBody, setCapability, setProp, setSettings, setTab, setTabs, setView, titleKey, upsertProp } from "./model";
import { mapValue } from "./typeops";
import type { Index } from "./graph";
import { type Cond, type QueryDef, FIELDS, blockSource, findBlocks, queryFence, readBlock, typesIn } from "./query";
import { type Lang, LANGS, words } from "./i18n";
import { escapeRe, foldUmlauts as fold } from "./text";
import { type Writer, typeTabs } from "./setup";

/** What happens to a property name: `to` is the new name, null drops every use of it. */
export interface PropChange {
  type: string;
  prop: string;
  from: string;
  to: string | null;
}

// Built-in keys are stored language-neutral and lowercase ("status" groups by the status
// capability); a property named "Status" is stored with its own spelling and is not one of them.
const BUILTIN = new Set<string>([...FIELDS, "path", "status", "statusGroup", "type", "tags"]);

function matchesName(stored: string, c: PropChange): boolean {
  return !BUILTIN.has(stored) && titleKey(stored) === titleKey(c.from);
}

/** The new name, null to drop, or the name unchanged. */
function mapName(stored: string, c: PropChange): string | null {
  return matchesName(stored, c) ? c.to : stored;
}

/** Undefined when the condition only filtered on the dropped property. */
export function mapCond(cond: Cond | undefined, c: PropChange): Cond | undefined {
  if (!cond) return cond;
  if ("and" in cond || "or" in cond) {
    const key = "and" in cond ? "and" : "or";
    const parts = ((cond as Record<string, Cond[]>)[key] ?? []).map((x) => mapCond(x, c)).filter((x): x is Cond => !!x);
    if (!parts.length) return undefined;
    return parts.length === 1 ? parts[0] : ({ [key]: parts } as Cond);
  }
  if ("not" in cond) {
    const inner = mapCond(cond.not, c);
    return inner ? { not: inner } : undefined;
  }
  if ("prop" in cond && matchesName(cond.prop, c)) return c.to ? { ...cond, prop: c.to } : undefined;
  return cond;
}

/** The parts of a tab that name properties; the rest stays as it is. */
export function mapTab<T extends Partial<ViewTab>>(tab: T, c: PropChange): T {
  const out: T = { ...tab };
  if (tab.columns) out.columns = tab.columns.map((x) => mapName(x, c)).filter((x): x is string => !!x);
  if (tab.sort) out.sort = tab.sort.flatMap((s) => (mapName(s.key, c) === null ? [] : [{ ...s, key: mapName(s.key, c)! }]));
  if (tab.widths) out.widths = Object.fromEntries(Object.entries(tab.widths).flatMap(([k, w]) => (mapName(k, c) === null ? [] : [[mapName(k, c)!, w]])));
  if (tab.where) out.where = mapCond(tab.where, c);
  if (tab.date) out.date = mapName(tab.date, c) ?? undefined;
  if (tab.subgroup) out.subgroup = mapName(tab.subgroup, c) ?? undefined;
  if (tab.group) {
    const group = mapName(tab.group, c);
    if (group === null) {
      // no grouping left: the hidden option ids and the rows within the columns go with it
      out.group = out.subgroup = out.hiddenGroups = out.hideEmpty = undefined;
    } else out.group = group;
  }
  return dropEmpty(out);
}

export function mapQuery(def: QueryDef, c: PropChange): QueryDef {
  const out: QueryDef = { ...def };
  if (def.columns) out.columns = def.columns.map((x) => mapName(x, c)).filter((x): x is string => !!x);
  if (def.sort) out.sort = def.sort.flatMap((s) => (mapName(s.key, c) === null ? [] : [{ ...s, key: mapName(s.key, c)! }]));
  if (def.group) out.group = mapName(def.group, c) ?? undefined;
  if (def.where) out.where = mapCond(def.where, c);
  if (def.tabs) out.tabs = def.tabs.map((t) => mapTab(t, c));
  return dropEmpty(out);
}

function dropEmpty<T extends object>(o: T): T {
  for (const [k, v] of Object.entries(o)) if (v === undefined || (Array.isArray(v) && !v.length)) delete (o as Record<string, unknown>)[k];
  return o;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Properties match by name across all types, so a query that does not name this type, or names
 * another type with a property of the same name, may mean that other one: those stay untouched.
 */
function belongs(where: Cond | undefined, c: PropChange, ix: Index): boolean {
  const named = typesIn(where).filter((id) => ix.types.has(id));
  const scope = named.length ? named : [...ix.types.keys()];
  if (!scope.includes(c.type)) return false;
  const key = titleKey(c.from);
  return !scope.some((id) => id !== c.type && ix.types.get(id)!.schema.properties.some((p) => titleKey(p.name) === key));
}

/**
 * Carries a property rename or removal over to the type's own views (the default views are stored
 * first so they can change), to the views and query blocks of every page, and to the inbox rule.
 * On removal it also leaves the template and the due capability (a removed status property is simply gone).
 */
export function followPropChange(w: Writer, ix: Index, c: PropChange, lang: Lang) {
  if (c.to !== null && c.to.trim() === c.from.trim()) return;
  const type = ix.types.get(c.type);
  if (type) {
    const tabs = typeTabs(type, lang);
    const next = tabs.map((t) => mapTab(t, c));
    if (!same(tabs, next))
      w.change(type.id, (doc) => {
        // the default views are not stored yet; stored ones change tab by tab, so an edit to another tab on another device survives
        if (!type.schema.views) return setTabs(doc, next);
        next.forEach(({ id, pos: _pos, ...t }, i) => same(tabs[i], next[i]) || setTab(doc, id, fill(t)));
      });
    if (c.to === null) {
      const caps = type.schema.capabilities;
      const values = caps.template?.values;
      w.change(type.id, (doc) => {
        if (values && c.prop in values) {
          const { [c.prop]: _gone, ...rest } = values;
          setCapability(doc, "template", { ...caps.template, values: rest });
        }
        if (caps.due === c.prop) setCapability(doc, "due", null);
      });
    }
  }
  for (const item of ix.all.values()) {
    if (item.deleted) continue;
    followInItem(w, ix, item, c);
  }
}

/** setTab leaves fields it gets as undefined: fields that went away are set to null. */
function fill(t: Omit<ViewTab, "id" | "pos">) {
  const out: Record<string, unknown> = { ...t };
  for (const k of ["where", "sort", "group", "subgroup", "hideEmpty", "hiddenGroups", "columns", "widths", "date"]) if (out[k] === undefined) out[k] = null;
  return out;
}

function followInItem(w: Writer, ix: Index, item: Item, c: PropChange) {
  const views: [string, ViewDef][] = [];
  for (const [id, v] of Object.entries(item.views)) {
    if (!v.query || !belongs(v.query.where, c, ix)) continue;
    const query = mapQuery(v.query, c);
    const group = v.group ? (mapName(v.group, c) ?? undefined) : undefined;
    const next = dropEmpty({ ...v, query, group });
    if (!same(v, next)) views.push([id, next]);
  }
  let body: string | null = null;
  const blocks = findBlocks(item.body);
  if (blocks.length) {
    let out = "";
    let pos = 0;
    for (const b of blocks) {
      // text-form blocks become JSON when the page is saved next; until then they stay as typed
      const { def, wasText } = readBlock(b.src, ix);
      const next = !wasText && belongs(def.where, c, ix) ? mapQuery(def, c) : def;
      out += item.body.slice(pos, b.from) + (same(def, next) ? item.body.slice(b.from, b.to) : queryFence(blockSource(next)));
      pos = b.to;
    }
    out += item.body.slice(pos);
    if (out !== item.body) body = out;
  }
  // an inbox rule left empty would mean the default rule, so one that only filtered on it stays
  const rule = item.id === SETTINGS_ID ? item.settings?.inbox : undefined;
  const inbox = rule && belongs(rule, c, ix) ? mapCond(rule, c) : undefined;
  const inboxChanged = inbox !== undefined && !same(inbox, rule);
  if (!views.length && body === null && !inboxChanged) return;
  w.change(item.id, (doc) => {
    for (const [id, v] of views) setView(doc, id, v);
    if (body !== null) replaceBody(doc, body);
    if (inboxChanged) setSettings(doc, { inbox });
  });
}

// The words for "type" in every language: `typ:Aufgabe`, `type:Task`.
let typeKeys: Set<string> | null = null;
function isTypeKey(word: string): boolean {
  typeKeys ??= new Set(["type", ...LANGS.flatMap((l) => words(l, "q.key.type"))].map(fold));
  return typeKeys.has(fold(word));
}

/** The relation target text with the type's old name replaced; null when nothing changes. */
export function renameTypeIn(target: string, oldName: string, newName: string): string | null {
  if (!oldName.trim() || !newName.trim()) return null;
  const re = new RegExp(`(^|[\\s(|-])([\\p{L}]+)(:\\s*)("${escapeRe(oldName)}"|${escapeRe(oldName)})(?=\\s|$|\\)|\\|)`, "giu");
  const value = /[\s()|"]/.test(newName) ? `"${newName.replaceAll('"', "")}"` : newName;
  const next = target.replace(re, (m, pre: string, key: string, colon: string) => (isTypeKey(key) ? pre + key + colon + value : m));
  return next === target ? null : next;
}

/** Relation targets of every type that name the renamed type by its old name. */
export function followTypeRename(w: Writer, ix: Index, oldName: string, newName: string) {
  if (oldName.trim() === newName.trim()) return;
  for (const t of ix.types.values()) {
    if (t.deleted) continue;
    const changes: [string, string][] = [];
    for (const p of t.schema.properties) {
      const next = p.kind === "relation" && p.target ? renameTypeIn(p.target, oldName, newName) : null;
      if (next !== null) changes.push([p.id, next]);
    }
    if (changes.length) w.change(t.id, (doc) => changes.forEach(([id, target]) => upsertProp(doc, id, { target })));
  }
}

/**
 * Stored values in the new kind, where `mapValue` can carry them over (an option becomes its name
 * as text and back). A value it cannot carry stays as it was, so changing the kind back restores it.
 */
export function followKindChange(w: Writer, ix: Index, typeId: string, from: PropDef, to: PropDef) {
  if (from.kind === to.kind && !!from.multiple === !!to.multiple) return;
  if ([from.kind, to.kind].some((k) => k === "relation" || k === "computed")) return;
  for (const item of ix.all.values()) {
    if (item.type !== typeId) continue;
    const v = item.props[from.id];
    if (v === undefined) continue;
    const next = mapValue(from, to, v);
    if (next !== undefined && !same(next, v)) w.change(item.id, (doc) => setProp(doc, from.id, next));
  }
}
