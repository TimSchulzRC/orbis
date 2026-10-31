// The data model shared by server, devices and agents.
//
// Everything is an *item*, stored as one Yjs document (guid = item id):
//   kind "info"      an information (a type, being an information with the system type
//                    META_TYPE, adds a `schema` map)
//   kind "datei"     a file: metadata here, content on the server by SHA-256
//   kind "op"        a reversible bulk operation (e.g. deleting a type), shown in Activity
//   kind "settings"  the one shared settings doc (start page, capture types, the inbox rule)
//   (documents of the former kind "sammlung" are ignored since 26.10.: see migrateCollections)
//
// Top-level Yjs types of a document:
//   meta     Y.Map   id-free scalars: kind, title, type, home, pinned (sort key | null), created,
//                    updated, deleted, kept, later …
//                    (no inbox field: the inbox is computed, see placement.ts; kept and later
//                    only set an entry aside, see inbox.ts)
//   parents  Y.Map   parentId -> { sort, at }  ("Teil von"; sort is per parent, at = when added)
//   props    Y.Map   propId -> value           (values of the type's properties)
//   extra    Y.Map   name -> { k, v }          (free properties, simple kinds only)
//   rels     Y.Map   propId -> Y.Map<targetId, true>
//   tags     Y.Map   tag -> true
//   refs     Y.Map   targetId -> true          (explicit only; links in the text are derived)
//   body     Y.Text  Markdown with [[links]] and ```abfrage blocks
//   updates  Y.Array { id, at, text, by, status? }
//   views    Y.Map   viewId -> view definition (query, display)
//   schema   Y.Map   types only: name, plural, icon, color, description, pos (order in the
//                    sidebar), capabilities (Y.Map), properties (Y.Map<propId, Y.Map>)
//   tabs     Y.Map   types only: tabId -> Y.Map, the views of the type's page (see ViewTab);
//                    empty: the default views
//   file     Y.Map   files only: hash, name, mime, filetype, size, width, height, pages, duration,
//                    display, thumb, history
//   op       Y.Map   ops only
//   settings Y.Map   settings only
import * as Y from "yjs";
import { cmpKey, keyBetween } from "./sortkey";
import type { Cond, QueryDef } from "./query";
import { escapeRe } from "./text";

/** The meta type "Typ": every type document has this as its type. Not a document, cannot be deleted. */
export const META_TYPE = "sys:type";
export const SETTINGS_ID = "sys:settings";

export type Kind = "info" | "datei" | "op" | "settings";
export type FileType = "bild" | "pdf" | "audio" | "video" | "dokument" | "sonstiges";
export const FILE_TYPES: FileType[] = ["bild", "pdf", "audio", "video", "dokument", "sonstiges"];

export type StatusGroup = "todo" | "active" | "done";
export const STATUS_GROUPS: StatusGroup[] = ["todo", "active", "done"];

/**
 * "select" is every choice from a list of options: one value or several (`multiple`), may stay
 * empty or not (`default`), and is the type's status when capabilities.status names it. Stored
 * schemas from before 30.10.2026 have the kinds "status" and "multiselect"; readSchema turns them
 * into this (see legacyKind).
 */
export type PropKind = "text" | "number" | "date" | "checkbox" | "url" | "select" | "relation" | "computed";
export const PROP_KINDS: PropKind[] = ["text", "number", "date", "checkbox", "url", "select", "relation", "computed"];
/** Free properties (without a type) only come in simple kinds. */
export type FreeKind = "text" | "number" | "date" | "checkbox" | "url" | "select";
export const FREE_KINDS: FreeKind[] = ["text", "number", "date", "checkbox", "url", "select"];

export interface OptionDef {
  id: string;
  name: string;
  group?: StatusGroup; // options of the status only
  state?: "paused" | "dropped"; // options of the status only: active but paused (nothing to do now), done but dropped
  color?: string;
}

export interface ComputedDef {
  fn: "progress" | "count";
  of?: string; // optional type filter
}

export interface PropDef {
  id: string;
  name: string;
  kind: PropKind;
  description?: string;
  options?: OptionDef[];
  multiple?: boolean; // relation: several targets; select: several options
  default?: string; // select with one value: the option new items get – then it is never empty
  target?: string; // relation: query in text form (e.g. "typ:Person"), only a hint
  inverseName?: string;
  symmetric?: boolean;
  range?: boolean; // date: start/end
  computed?: ComputedDef;
  hideEmpty?: boolean; // display: only on pages where it has a value (else behind "+ Eigenschaft")
  blocks?: boolean; // relation and text: holds the item up while set (a relation: while a target is open)
  removed?: boolean; // removed from the type; kept so its values still have a name
  sort: string;
}

/**
 * Capabilities as the plan describes them: status, progress, updates, due date ("Termin"),
 * main action and template. Status and due name the property they use. Read them only
 * through traits.ts.
 */
export interface Capabilities {
  status?: string; // propId of the main status property
  due?: string; // "Termin": propId of the date property that is the due date
  progress?: { of?: string }; // share of done descendants with a status (optional type filter)
  updates?: boolean;
  template?: { body?: string; values?: Record<string, Value> };
  primaryChild?: string; // main action: "+" on the page creates a child of this type
}

export interface TypeSchema {
  name: string;
  plural?: string; // the name of the list ("Bücher"); unset: a guess, see typePlural
  pos?: string; // order among the types in the sidebar; unset: at the end
  views?: ViewTab[]; // the views of the type's page; unset: the default views (setup.ts typeTabs)
  icon: string;
  color: string;
  description: string;
  capabilities: Capabilities;
  properties: PropDef[]; // sorted, active ones
  removedProperties: PropDef[]; // removed ones, values stay in `props` ("Weitere Eigenschaften")
}

export type Value = string | number | boolean | string[];
export interface FreeValue {
  k: FreeKind;
  v: string | number | boolean;
}

export interface ParentLink {
  sort: string;
  at: number;
}

export interface UpdateEntry {
  id: string;
  at: number;
  text: string;
  by: string;
  status?: string; // option id set together with this update
}

export const VIEW_KINDS = ["list", "table", "board", "tree", "gallery", "triage", "calendar", "timeline"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export interface ViewDef {
  query?: QueryDef; // stored as JSON with ids, see query.ts
  display?: ViewKind;
  scope?: "level" | "all"; // "Nur diese Ebene" / "Inkl. Unterprojekte"
  group?: string;
  showDone?: boolean;
}

export interface FileMeta {
  hash: string;
  name: string;
  mime: string;
  filetype: FileType;
  size: number;
  width?: number;
  height?: number;
  pages?: number;
  duration?: number;
  display?: string; // hash of the display version (images, 1600 px WebP)
  thumb?: string; // hash of the preview (320 px)
  text?: string; // extracted text (PDF)
  history?: { hash: string; at: number }[];
}

export interface Suggestion {
  type?: string;
  parents?: string[];
  props?: Record<string, Value>;
  note?: string;
  by: string;
  at: number;
}

export interface OpRecord {
  action: string; // e.g. "deleteType"
  label: string;
  payload: unknown;
  undone?: boolean;
}

/**
 * Areas ("Bereiche"): every information, type, file and change belongs to exactly one. The unit
 * of sync and, later, of storage and rights. Until teams come there is one, the personal area,
 * without any interface. Documents from before areas are read as personal.
 */
export const PERSONAL = "personal";

/**
 * Format of the data. A newer app upgrades older data once (setup.ts); an older app that meets
 * newer data still reads it but asks for an update before it writes (see the client's repo).
 */
export const FORMAT = 1;

export interface SettingsRecord {
  setupLang?: string;
  format?: number; // see FORMAT; unset: data from before format versions (0)
  captureTypes: string[]; // pinned types in the capture type picker
  upgrades?: string[]; // one-time data upgrades already applied (each runs once, even if the user later undoes its effect)
  inbox?: Cond; // what lands in the inbox; unset: the default (inbox.ts)
  filesPos?: string; // where "Dateien" stands among the types in the sidebar
}

/**
 * One view, shown as a tab (a type's page, a query block). Its filter is added to the base query
 * (AND); grouping, sorting and properties are its own. An empty name shows the kind's name.
 */
export interface ViewTab {
  id: string;
  pos: string; // sort key: the order of the tabs
  name?: string;
  kind: ViewKind;
  where?: Cond;
  sort?: { key: string; desc?: boolean }[];
  group?: string; // "status" | "statusGroup" | "type" | "path" | field or property name
  subgroup?: string; // boards: rows ("swimlanes") within the columns
  hideEmpty?: boolean; // hide empty groups
  hiddenGroups?: string[]; // groups hidden by hand (see groupId), shown again from "N ausgeblendete Gruppen"
  columns?: string[]; // shown properties in this order (table columns, card lines)
  widths?: Record<string, number>; // table column widths in px
  date?: string; // calendar and timeline: the date property
}

/** The tab a single view (a query block without tabs, an old collection) is read as. */
export const MAIN_TAB = "main";
export function legacyTab(view: { display?: ViewKind; sort?: { key: string; desc?: boolean }[]; group?: string; columns?: string[] }): ViewTab {
  const t: ViewTab = { id: MAIN_TAB, pos: "V", kind: view.display ?? "list" };
  if (view.sort?.length) t.sort = view.sort;
  if (view.group) t.group = view.group;
  if (view.columns?.length) t.columns = view.columns;
  return t;
}

export interface Item {
  id: string;
  kind: Kind;
  area: string; // see PERSONAL
  title: string;
  type: string | null;
  home: string | null; // stored; the effective home comes from the index
  pinned?: string; // sort key when pinned to the top of the sidebar (counts as a place)
  parents: Record<string, ParentLink>;
  props: Record<string, Value>;
  extra: Record<string, FreeValue>;
  rels: Record<string, string[]>;
  tags: string[];
  refs: string[];
  body: string;
  updates: UpdateEntry[];
  views: Record<string, ViewDef>;
  schema?: TypeSchema;
  file?: FileMeta;
  op?: OpRecord;
  settings?: SettingsRecord;
  suggestion?: Suggestion;
  /** Kept as it is, without a place (when): out of the inbox for good (inbox.ts). */
  kept?: number;
  /** Out of the inbox until then ("Morgen wieder", inbox.ts). */
  later?: number;
  created: number;
  updated: number;
  createdBy?: string;
  /** In the trash: deleted itself, or deleted together with a root that is (see trash.ts). */
  deleted: boolean;
  /** meta.deleted = "via:<root>": deleted together with that root (raw mark). */
  deletedVia?: string;
  /** meta.done: when the status last entered the group done (read it via traits.doneAt). */
  doneAt?: number;
  source?: string;
}

/** A type: an information of the meta type, always with its schema. */
export type TypeItem = Item & { schema: TypeSchema };

// ---------- reading ----------

/** meta.deleted is true or "via:<root>" (deleted together with that root, see trash.ts). */
export const VIA = "via:";
function viaRoot(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.startsWith(VIA) ? raw.slice(VIA.length) : undefined;
}

/** A JSON value or a nested Yjs type (a property, a tab, the capabilities). */
function plain(v: unknown): unknown {
  return v instanceof Y.AbstractType ? v.toJSON() : v;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The top-level maps of a document (see the list above; query, view and pin: former collections). */
export const DOC_MAPS = ["meta", "parents", "props", "extra", "rels", "tags", "refs", "views", "schema", "tabs", "file", "op", "settings", "query", "view", "pin"] as const;

/** What meta holds: scalars and the suggestion. Narrow on reading, the data comes from other devices. */
export type MetaValue = string | number | boolean | Suggestion;

export function metaMap(doc: Y.Doc): Y.Map<MetaValue> {
  return doc.getMap<MetaValue>("meta");
}

/** Scalars, and the capabilities and properties as nested maps. */
export function schemaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>("schema");
}

/**
 * The kinds "status" and "multiselect" as they were stored before 30.10.2026: a select. A status
 * never was empty – new items got its first option –, so the type's status keeps that as default.
 * Also for input (MCP, imports) that still names the old kinds.
 */
export function legacyKind(p: PropDef, isStatus: boolean): PropDef {
  const k = p.kind as string;
  if (k === "multiselect") return { ...p, kind: "select", multiple: true };
  if (k === "status") return { ...p, kind: "select", multiple: undefined, default: p.default ?? (isStatus ? p.options?.[0]?.id : undefined) };
  return p;
}

export function readSchema(doc: Y.Doc): TypeSchema {
  const s = schemaMap(doc);
  const text = (k: string) => {
    const v = s.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const caps = plain(s.get("capabilities"));
  const props = s.get("properties");
  const properties: PropDef[] = [];
  if (props instanceof Y.Map) {
    for (const [id, p] of props) {
      const o = plain(p);
      if (!isObject(o)) continue;
      const d = o as Partial<PropDef>;
      if (!d.name && !d.kind) continue;
      properties.push(legacyKind({ ...d, id, name: d.name ?? "", kind: d.kind ?? "text", sort: d.sort ?? "V" }, isObject(caps) && caps.status === id));
    }
  }
  properties.sort((a, b) => cmpKey(a.sort, b.sort) || a.id.localeCompare(b.id));
  return {
    removedProperties: properties.filter((p) => p.removed),
    name: text("name") ?? "",
    plural: text("plural") || undefined,
    pos: text("pos") || undefined,
    icon: text("icon") ?? "circle",
    color: text("color") ?? "slate",
    description: text("description") ?? "",
    capabilities: isObject(caps) ? (caps as Capabilities) : {},
    properties: properties.filter((p) => !p.removed),
  };
}

export function readItem(id: string, doc: Y.Doc): Item | null {
  const meta = metaMap(doc);
  const kind = meta.get("kind");
  // not initialised yet (half-synced), or a legacy document (a former collection)
  if (typeof kind !== "string" || !kind || kind === "sammlung") return null;
  const rels: Record<string, string[]> = {};
  for (const [p, m] of doc.getMap<unknown>("rels")) if (m instanceof Y.Map && m.size) rels[p] = [...m.keys()];
  const str = (k: string) => {
    const v = meta.get(k);
    return v === undefined || v === null || v === "" ? undefined : String(v);
  };
  const num = (k: string) => {
    const v = meta.get(k);
    return typeof v === "number" ? v : undefined;
  };
  const item: Item = {
    id,
    kind: kind as Kind,
    area: str("area") ?? PERSONAL,
    title: str("title") ?? "",
    type: str("type") ?? null,
    home: str("home") ?? null,
    pinned: str("pinned"),
    parents: doc.getMap<ParentLink>("parents").toJSON() as Record<string, ParentLink>,
    props: doc.getMap<Value>("props").toJSON() as Record<string, Value>,
    extra: doc.getMap<FreeValue>("extra").toJSON() as Record<string, FreeValue>,
    rels,
    tags: [...doc.getMap("tags").keys()].sort(),
    refs: [...doc.getMap("refs").keys()],
    body: doc.getText("body").toString(),
    updates: doc.getArray<UpdateEntry>("updates").toArray().slice(),
    views: doc.getMap<ViewDef>("views").toJSON() as Record<string, ViewDef>,
    created: Number(meta.get("created") ?? 0),
    updated: Number(meta.get("updated") ?? meta.get("created") ?? 0),
    createdBy: str("createdBy"),
    deleted: meta.get("deleted") === true || viaRoot(meta.get("deleted")) !== undefined,
    deletedVia: viaRoot(meta.get("deleted")),
    doneAt: num("done"),
    source: str("source"),
  };
  const kept = num("kept");
  const later = num("later");
  if (kept !== undefined) item.kept = kept;
  if (later !== undefined) item.later = later;
  const sug = meta.get("suggestion");
  if (sug && typeof sug === "object") item.suggestion = sug;
  if (item.type === META_TYPE) {
    item.schema = readSchema(doc);
    if (doc.getMap("tabs").size) item.schema.views = readTabs(doc);
  }
  if (kind === "datei") item.file = doc.getMap("file").toJSON() as FileMeta;
  if (kind === "op") item.op = doc.getMap("op").toJSON() as OpRecord;
  if (kind === "settings") {
    const s: Partial<SettingsRecord> = doc.getMap("settings").toJSON();
    item.settings = { setupLang: s.setupLang, format: typeof s.format === "number" ? s.format : undefined, captureTypes: s.captureTypes ?? [], upgrades: s.upgrades ?? [], inbox: s.inbox ?? undefined, filesPos: s.filesPos ?? undefined };
  }
  return item;
}

/** The stored tabs of a document, in order; none stored: its old single view (former collections). */
export function readTabs(doc: Y.Doc): ViewTab[] {
  const tabs: ViewTab[] = [];
  for (const [id, v] of doc.getMap<unknown>("tabs")) {
    const o = plain(v);
    if (!isObject(o)) continue;
    const t = o as Partial<ViewTab>;
    if (t.kind) tabs.push({ ...t, id, pos: t.pos ?? "V", kind: t.kind });
  }
  tabs.sort((a, b) => cmpKey(a.pos, b.pos) || a.id.localeCompare(b.id));
  return tabs.length ? tabs : [legacyTab(doc.getMap("view").toJSON())];
}

// ---------- writing (call inside doc.transact) ----------

export interface ItemInit {
  kind?: Kind;
  area?: string; // default: the personal area
  title?: string;
  type?: string | null;
  body?: string;
  tags?: string[];
  refs?: string[];
  parents?: string[]; // first one becomes the home
  props?: Record<string, Value>;
  extra?: Record<string, FreeValue>;
  rels?: Record<string, string[]>;
  pinned?: string;
  created?: number;
  updated?: number;
  createdBy?: string;
  source?: string;
}

export function initItem(doc: Y.Doc, init: ItemInit, now = Date.now()) {
  const meta = metaMap(doc);
  meta.set("kind", init.kind ?? "info");
  meta.set("area", init.area ?? PERSONAL);
  meta.set("title", init.title ?? "");
  if (init.type) meta.set("type", init.type);
  if (init.pinned) meta.set("pinned", init.pinned);
  if (init.source) meta.set("source", init.source);
  if (init.createdBy) meta.set("createdBy", init.createdBy);
  meta.set("created", init.created ?? now);
  meta.set("updated", init.updated ?? init.created ?? now);
  if (init.body) doc.getText("body").insert(0, init.body);
  for (const t of init.tags ?? []) setMember(doc, "tags", t, true);
  for (const r of init.refs ?? []) setMember(doc, "refs", r, true);
  (init.parents ?? []).forEach((p, i) => addParent(doc, p, undefined, (init.created ?? now) + i));
  for (const [k, v] of Object.entries(init.props ?? {})) setProp(doc, k, v);
  for (const [k, v] of Object.entries(init.extra ?? {})) setExtra(doc, k, v);
  for (const [p, ids] of Object.entries(init.rels ?? {})) for (const t of ids) setRel(doc, p, t, true);
}

export type MetaField = "title" | "type" | "home" | "pinned" | "deleted" | "source" | "suggestion" | "kept" | "later";

/** Set meta fields; null or "" clears. */
export function setMeta(doc: Y.Doc, fields: Partial<Record<MetaField, MetaValue | null>>, now = Date.now()) {
  const meta = metaMap(doc);
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v === null || v === "" || v === false) {
      if (meta.has(k)) meta.delete(k);
    } else if (meta.get(k) !== v) meta.set(k, v);
  }
  touch(doc, now);
}

export function touch(doc: Y.Doc, now = Date.now()) {
  metaMap(doc).set("updated", now);
}

/**
 * Typing is a change: local edits of the text move meta.updated ("geändert", "Zuletzt bearbeitet"),
 * right away and then at most every `every` ms (the last edit of a burst counts too). Edits that
 * arrive from other devices or tabs don't – they bring their own time. Runs in its own
 * transaction, outside the text's undo history. Returns a function that stops it.
 */
export function touchOnTextEdit(doc: Y.Doc, every = 3000, clock: () => number = Date.now): () => void {
  const text = doc.getText("body");
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stamp = () => {
    timer = undefined;
    last = clock();
    doc.transact(() => touch(doc, last), TOUCH_ORIGIN);
  };
  const onEdit = (_e: Y.YTextEvent, tr: Y.Transaction) => {
    if (!tr.local || timer) return;
    const wait = Math.max(0, last + every - clock());
    timer = setTimeout(stamp, wait);
  };
  text.observe(onEdit);
  return () => {
    text.unobserve(onEdit);
    if (timer) (clearTimeout(timer), stamp());
  };
}
const TOUCH_ORIGIN = "touch";

/** Add a parent. The first parent becomes the home. */
export function addParent(doc: Y.Doc, parentId: string, sort?: string, at = Date.now()) {
  const parents = doc.getMap<ParentLink>("parents");
  if (parents.has(parentId)) return;
  // a file has exactly one parent (where else it is used shows under "Verwendet in"): a new place replaces the old one
  const meta = metaMap(doc);
  if (meta.get("kind") === "datei") for (const k of [...parents.keys()]) parents.delete(k);
  parents.set(parentId, { sort: sort ?? keyBetween(null, null), at });
  const home = meta.get("home");
  if (typeof home !== "string" || !home || !parents.has(home)) meta.set("home", parentId);
}

export function setParentSort(doc: Y.Doc, parentId: string, sort: string) {
  const parents = doc.getMap<ParentLink>("parents");
  const cur = parents.get(parentId);
  if (cur) parents.set(parentId, { ...cur, sort });
}

/** Remove a parent; if it was the home, the oldest remaining parent becomes home. */
export function removeParent(doc: Y.Doc, parentId: string) {
  const parents = doc.getMap<ParentLink>("parents");
  if (!parents.has(parentId)) return;
  parents.delete(parentId);
  const meta = metaMap(doc);
  if (meta.get("home") === parentId) {
    const next = [...parents.entries()].sort((a, b) => a[1].at - b[1].at || a[0].localeCompare(b[0]))[0];
    if (next) meta.set("home", next[0]);
    else meta.delete("home");
  }
}

export function setHome(doc: Y.Doc, parentId: string) {
  if (doc.getMap("parents").has(parentId)) metaMap(doc).set("home", parentId);
}

export function setProp(doc: Y.Doc, propId: string, value: Value | null | undefined) {
  const props = doc.getMap<Value>("props");
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) props.delete(propId);
  else if (JSON.stringify(props.get(propId)) !== JSON.stringify(value)) props.set(propId, value);
}

export function setExtra(doc: Y.Doc, name: string, value: FreeValue | null | undefined) {
  const extra = doc.getMap<FreeValue>("extra");
  const key = name.trim();
  if (!key) return;
  if (!value || value.v === "" || value.v === null) extra.delete(key);
  else extra.set(key, value);
}

export function setRel(doc: Y.Doc, propId: string, target: string, on: boolean) {
  const rels = doc.getMap<unknown>("rels");
  let m = rels.get(propId);
  if (!(m instanceof Y.Map)) {
    if (!on) return;
    m = new Y.Map();
    rels.set(propId, m);
  }
  if (on) m.set(target, true);
  else m.delete(target);
}

export function setMember(doc: Y.Doc, set: "tags" | "refs", key: string, on: boolean) {
  const m = doc.getMap(set);
  const k = set === "tags" ? normalizeTag(key) : key;
  if (!k) return;
  if (on) m.set(k, true);
  else m.delete(k);
}

/** Replace body text with minimal edits (common prefix/suffix), so concurrent edits elsewhere merge. */
export function replaceBody(doc: Y.Doc, next: string) {
  const text = doc.getText("body");
  const prev = text.toString();
  if (prev === next) return;
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  if (endPrev > start) text.delete(start, endPrev - start);
  if (endNext > start) text.insert(start, next.slice(start, endNext));
}

export function appendUpdate(doc: Y.Doc, entry: Omit<UpdateEntry, "id"> & { id?: string }) {
  doc.getArray<UpdateEntry>("updates").push([{ ...entry, id: entry.id ?? newId() } as UpdateEntry]);
}

export function setView(doc: Y.Doc, viewId: string, def: ViewDef | null) {
  const views = doc.getMap<ViewDef>("views");
  if (def) views.set(viewId, def);
  else views.delete(viewId);
}

// ---------- types (schema) ----------

export function initSchema(doc: Y.Doc, s: Partial<Omit<TypeSchema, "properties" | "removedProperties">> & { properties?: Omit<PropDef, "sort">[] }) {
  const schema = schemaMap(doc);
  for (const k of ["name", "icon", "color", "description"] as const) if (s[k] !== undefined) schema.set(k, s[k]);
  if (s.plural) schema.set("plural", s.plural);
  if (!(schema.get("capabilities") instanceof Y.Map)) schema.set("capabilities", new Y.Map());
  if (!(schema.get("properties") instanceof Y.Map)) schema.set("properties", new Y.Map());
  for (const [k, v] of Object.entries(s.capabilities ?? {})) setCapability(doc, k as keyof Capabilities, v);
  let prev: string | null = null;
  for (const p of s.properties ?? []) {
    prev = keyBetween(prev, null);
    upsertProp(doc, p.id, { ...p, sort: prev });
  }
}

/** A new type: an information of the meta type, titled like the type, with its schema. */
export function initType(doc: Y.Doc, s: Parameters<typeof initSchema>[1] & { name: string }, init: Pick<ItemInit, "createdBy" | "created" | "source"> = {}, now = Date.now()) {
  initItem(doc, { kind: "info", type: META_TYPE, title: s.name, ...init }, now);
  initSchema(doc, { ...s, icon: s.icon ?? "box", description: s.description ?? "" });
}

export function setSchemaField(doc: Y.Doc, field: "name" | "plural" | "icon" | "color" | "description" | "pos", value: string) {
  if (value) schemaMap(doc).set(field, value);
  else schemaMap(doc).delete(field);
}

export function setCapability<K extends keyof Capabilities>(doc: Y.Doc, key: K, value: Capabilities[K] | null | undefined) {
  const caps = subMap(schemaMap(doc), "capabilities");
  if (value === null || value === undefined || value === false) caps.delete(key);
  else caps.set(key, value);
}

/** A change of a record: undefined leaves a field, null clears it. */
export type Patch<T> = { [K in keyof T]?: T[K] | null };

/** Each property is its own Y.Map, so two devices can change different properties at once. */
export function upsertProp(doc: Y.Doc, propId: string, patch: Patch<Omit<PropDef, "id">>) {
  const props = subMap(schemaMap(doc), "properties");
  const found = props.get(propId);
  const p = found instanceof Y.Map ? found : new Y.Map<unknown>();
  if (p !== found) {
    props.set(propId, p);
    if (!patch.sort) {
      const last = [...props.values()].map((x) => (x instanceof Y.Map ? x.get("sort") : undefined)).filter((x): x is string => typeof x === "string" && !!x).sort().at(-1);
      p.set("sort", keyBetween(last ?? null, null));
    }
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null || v === "") p.delete(k);
    else p.set(k, v);
  }
}

/** Removing a property keeps all values in `props` and the definition as a tombstone, so they still show up by name as "Weitere Eigenschaften". */
export function removeProp(doc: Y.Doc, propId: string) {
  upsertProp(doc, propId, { removed: true });
}

// ---------- files, ops, settings ----------

export function setFileMeta(doc: Y.Doc, patch: Patch<FileMeta>) {
  const f = doc.getMap<unknown>("file");
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) f.delete(k);
    else f.set(k, v);
  }
}

export function setOp(doc: Y.Doc, patch: Partial<OpRecord>) {
  const o = doc.getMap<unknown>("op");
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) o.set(k, v);
}

/** Change one tab: undefined leaves a field, null clears it; `null` as the patch removes the tab. */
export function setTab(doc: Y.Doc, id: string, patch: Patch<Omit<ViewTab, "id">> | null) {
  const tabs = doc.getMap<unknown>("tabs");
  if (patch === null) tabs.delete(id);
  else {
    let m = tabs.get(id);
    if (!(m instanceof Y.Map)) {
      const o = plain(m);
      tabs.set(id, (m = toMap(isObject(o) ? o : {})));
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null || (Array.isArray(v) && !v.length)) m.delete(k);
      else m.set(k, v);
    }
  }
  touch(doc);
}

/** Replace all tabs; an empty list goes back to the defaults ("Ansichten zurücksetzen"). */
export function setTabs(doc: Y.Doc, list: Omit<ViewTab, "pos">[]) {
  const tabs = doc.getMap<unknown>("tabs");
  for (const k of [...tabs.keys()]) tabs.delete(k);
  let pos: string | null = null;
  for (const { id, ...t } of list) {
    pos = keyBetween(pos, null);
    tabs.set(id, toMap({ ...t, pos }));
  }
  touch(doc);
}

/** The nested map under `key`, created if missing. */
function subMap(parent: Y.Map<unknown>, key: string): Y.Map<unknown> {
  const m = parent.get(key);
  if (m instanceof Y.Map) return m;
  const fresh = new Y.Map<unknown>();
  parent.set(key, fresh);
  return fresh;
}

function toMap(o: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) m.set(k, v);
  return m;
}

export function setSettings(doc: Y.Doc, patch: Patch<SettingsRecord>) {
  const s = doc.getMap<unknown>("settings");
  for (const [k, v] of Object.entries(patch)) if (v === null) s.delete(k);
  else if (v !== undefined) s.set(k, v);
}

// ---------- helpers ----------

export function normalizeTag(t: string): string {
  return t.trim().replace(/^#+/, "").replace(/\s+/g, "-").toLowerCase();
}

// Time-sortable ids: 9 chars of time + 8 random chars, base36.
export function newId(): string {
  const t = Date.now().toString(36).padStart(9, "0");
  const r = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => (b % 36).toString(36))
    .join("");
  return t + r;
}

export function shortId(prefix: string): string {
  return prefix + "_" + newId().slice(-8);
}

export function titleKey(title: string) {
  return title.trim().toLowerCase();
}

export { todayISO, addDaysISO } from "./date";

/** A date range as stored: "2026-03-01/2026-06-30", either side may be empty. */
export function parseRange(v: unknown): { start: string; end: string } {
  const [start = "", end = ""] = typeof v === "string" && v ? v.split("/") : [];
  return { start, end };
}
/** The stored form of a range; "" when both sides are empty. */
export const formatRange = (start: string, end: string) => (start || end ? `${start}/${end}` : "");

/** What an item is called: its title, else (a file) its file name; "" when it has neither. */
export function displayTitle(item: Pick<Item, "title" | "file">): string {
  return item.title || item.file?.name || "";
}

/** The area a document belongs to (see PERSONAL). */
export function areaOf(doc: Y.Doc | undefined): string {
  const a = doc && metaMap(doc).get("area");
  return typeof a === "string" ? a : PERSONAL;
}

/** The names of the options a select value holds, one or several (an unknown id as itself). */
export function optionNames(p: PropDef, v: Value): string[] {
  return (Array.isArray(v) ? v : [v]).map((id) => p.options?.find((o) => o.id === id)?.name ?? String(id));
}

/** Live means: not deleted and a real information or file (not an op or the settings). */
export function isContent(i: Item) {
  return !i.deleted && (i.kind === "info" || i.kind === "datei");
}

// ---------- links in the text ----------

/** [[Page]], [[Page#Section]], [[Page|text]], ![[file.png|320]]: groups embed mark, target, "#section", "|text". */
const WIKILINK = /(!?)\[\[([^\]|#\n]+)(#[^\]|\n]*)?(\|[^\]\n]*)?\]\]/g;

/** A fresh copy of the wikilink pattern (its own lastIndex); `anchored` matches only at the start. */
export function wikiLinkRe(anchored = false): RegExp {
  return anchored ? new RegExp("^" + WIKILINK.source) : new RegExp(WIKILINK.source, "g");
}

export interface WikiLinkMatch {
  raw: string;
  embed: boolean;
  target: string; // as written, not trimmed
  section: string; // "#Section" or ""
  label?: string; // the text after "|"
}

/** Replace every wikilink in `text` by what `fn` makes of it. */
export function mapWikiLinks(text: string, fn: (l: WikiLinkMatch) => string): string {
  if (!text.includes("[[")) return text;
  return text.replace(WIKILINK, (raw, bang: string, target: string, section?: string, label?: string) => fn({ raw, embed: bang === "!", target, section: section ?? "", label: label?.slice(1) }));
}

/**
 * The text with its [[links]] to `oldTitle` (any case, with section or label) pointing at
 * `newTitle`; null when nothing changes.
 */
export function renameLinksIn(body: string, oldTitle: string, newTitle: string): string | null {
  if (!newTitle.trim() || !body.includes("[[")) return null;
  const re = new RegExp(`(!?\\[\\[)${escapeRe(oldTitle)}(?=[\\]|#])`, "gi");
  const next = body.replace(re, (_m, open: string) => open + newTitle);
  return next === body ? null : next;
}

export interface WikiLink {
  target: string;
  embed: boolean;
  size?: number; // ![[x.png|320]]
  alias?: string;
}

/** Wikilinks outside of ```abfrage blocks. */
export function parseWikiLinks(body: string): WikiLink[] {
  const out: WikiLink[] = [];
  if (!body.includes("[[")) return out;
  const text = stripQueryBlocks(body);
  for (const m of text.matchAll(WIKILINK)) {
    const target = m[2]!.trim();
    const extra = m[4]?.slice(1).trim();
    const size = extra && /^\d+(x\d+)?$/.test(extra) ? Number(extra.split("x")[0]) : undefined;
    out.push({ target, embed: m[1] === "!", size, alias: size ? undefined : extra || undefined });
  }
  return out;
}

export const QUERY_FENCE = /^```(?:abfrage|query)[ \t]*(.*)\n([\s\S]*?)^```[ \t]*$/gm;

export function stripQueryBlocks(body: string) {
  return body.includes("```") ? body.replace(QUERY_FENCE, "") : body;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i;

/** Looks like a file name ("x.pdf", "y.png") rather than an information title. */
export function looksLikeFileName(name: string) {
  return /\.[a-z0-9]{2,5}$/i.test(name) && !/\s\.[a-z]+$/i.test(name);
}

export function fileTypeOf(name: string, mime = ""): FileType {
  const n = name.toLowerCase();
  if (mime.startsWith("image/") || IMAGE_EXT.test(n)) return "bild";
  if (mime === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("audio/") || /\.(mp3|m4a|wav|ogg|oga|flac|aac|opus)$/.test(n)) return "audio";
  if (mime.startsWith("video/") || /\.(mp4|mov|webm|mkv|m4v)$/.test(n)) return "video";
  if (/\.(docx?|xlsx?|pptx?|odt|ods|odp|txt|md|csv|rtf|pages|numbers|key|excalidraw)$/.test(n)) return "dokument";
  return "sonstiges";
}

export function mimeOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const m: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml", heic: "image/heic",
    pdf: "application/pdf", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", opus: "audio/opus",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", txt: "text/plain", md: "text/markdown", csv: "text/csv",
  };
  return m[ext] ?? "application/octet-stream";
}
