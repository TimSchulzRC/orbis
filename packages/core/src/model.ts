// The data model shared by server, devices and agents. Every item is one Yjs document (guid = item id).
// Kinds: "note" (a type is a note of type META_TYPE plus a `schema` map), "file" (metadata only,
// content on the server by SHA-256), "drawing" (a block in a note, kept as a document
// of its own below that note, its content an Excalidraw scene, see drawing.ts), "op" (a reversible
// bulk operation), "settings" (the one shared settings doc).
//
// Top-level Yjs types of a document:
//   meta     Y.Map   scalars: kind, title, type, home, pinned, created, updated, deleted, later …
//                    No inbox field, the inbox is computed.
//   parents  Y.Map   parentId -> { sort, at }  (sort is per parent, at = when added)
//   props    Y.Map   propId -> value
//   extra    Y.Map   name -> { k, v }          (left over from a removed type or property; k "list": v is string[])
//   rels     Y.Map   propId -> Y.Map<targetId, true>
//   tags     Y.Map   tag -> true
//   refs     Y.Map   targetId -> sort key      (explicit only; links in the text are derived)
//   body     Y.Text  Markdown with [[links]] and ```query blocks
//   rules    Y.Text  "Rules for agents": Markdown, binding for agents on this item and all below it
//                    (see rules.ts); in the settings doc: the rules of the whole workspace
//   updates  Y.Array { id, at, text, by, status? }
//   schema   Y.Map   types only; capabilities and each property are nested Y.Maps
//   tabs     Y.Map   types only: tabId -> Y.Map (ViewTab); empty means the default views
//   file     Y.Map   files only: hash, name, mime, filetype, size, width, height, pages, duration,
//                    display, thumb, text, extracted, history
//   op, settings  Y.Map  only in documents of that kind
//   drawing, drawingFiles, drawingState  only in drawings (see drawing.ts)
import * as Y from "yjs";
import { DRAWING, DRAWING_FILES, DRAWING_STATE, type DrawingInfo, drawingInfo } from "./drawing";
import type { Cond } from "./query";
import { cmpKey, keyBetween } from "./sortkey";
import { escapeRe } from "./text";

/** The type of every type document ("Type"). Not a document itself, so it cannot be deleted. */
export const META_TYPE = "sys:type";
export const SETTINGS_ID = "sys:settings";

export type Kind = "note" | "file" | "drawing" | "op" | "settings";
export type FileType = "image" | "pdf" | "audio" | "video" | "document" | "other";
export const FILE_TYPES: FileType[] = ["image", "pdf", "audio", "video", "document", "other"];

export type StatusGroup = "todo" | "active" | "done";
export const STATUS_GROUPS: StatusGroup[] = ["todo", "active", "done"];

/**
 * "select" covers single and multiple choice. "status" is a single choice whose options each sit in
 * a group; a type has at most one.
 */
export type PropKind =
	| "text"
	| "number"
	| "date"
	| "checkbox"
	| "url"
	| "select"
	| "status"
	| "relation"
	| "computed";
export const PROP_KINDS: PropKind[] = [
	"text",
	"number",
	"date",
	"checkbox",
	"url",
	"select",
	"status",
	"relation",
	"computed",
];
/** Free properties hold values left over when a type or property goes. Never added by hand. "list" holds a former multiple choice. */
export type FreeKind = "text" | "number" | "date" | "checkbox" | "url" | "select" | "list";

export interface OptionDef {
	id: string;
	name: string;
	group?: StatusGroup; // status options only
	color?: string;
}

export interface ComputedDef {
	fn: "progress" | "count";
	of?: string; // type filter
}

export interface PropDef {
	id: string;
	name: string;
	kind: PropKind;
	description?: string;
	options?: OptionDef[];
	multiple?: boolean; // relation: several targets; select: several options
	default?: string; // select with one value: the option new items get – then it is never empty
	target?: string; // relation: query in text form (e.g. "type:Person"), only a hint
	inverseName?: string;
	symmetric?: boolean;
	range?: boolean; // date: start/end
	computed?: ComputedDef;
	blocks?: boolean; // relation and text: holds the item up while set (a relation: while a target is open)
	removed?: boolean; // removed from the type; kept so its values still have a name
	/**
	 * Names it had before, newest last. Views and queries name properties by text (so one column can
	 * mean the same name across types); a view written with an old name on a device that missed the
	 * rename still finds the property (see propByName).
	 */
	formerNames?: string[];
	sort: string;
}

/** Read only through traits.ts. */
export interface Capabilities {
	due?: string; // propId of the due date property ("Due date")
	updates?: boolean;
	template?: { body?: string; values?: Record<string, Value> };
}

export interface TypeSchema {
	name: string;
	plural?: string; // the list name ("Books"); unset: guessed by typePlural
	pos?: string; // order among the types in the sidebar; unset: at the end
	views?: ViewTab[]; // unset: the default views
	icon: string;
	color: string;
	description: string;
	capabilities: Capabilities;
	properties: PropDef[]; // sorted, active only
	removedProperties: PropDef[]; // their values stay in `props` ("Weitere Eigenschaften")
}

export type Value = string | number | boolean | string[];
export interface FreeValue {
	k: FreeKind;
	v: string | number | boolean | string[];
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
	status?: string; // option id set with this update
}

export const VIEW_KINDS = [
	"list",
	"table",
	"board",
	"tree",
	"gallery",
	"triage",
	"calendar",
	"timeline",
] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

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
	text?: string; // extracted text (PDF, Office, text files, a ZIP's entries)
	extracted?: string; // the server read the text of this content: its hash prefix
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
 * Every item belongs to exactly one area, the unit of sync and later of rights. Until teams exist
 * there is only this one.
 */
export const PERSONAL = "personal";

/**
 * An older app that meets newer data still reads it but asks for an update before it writes.
 * 2: the status is a property kind, no longer the capability `status` on a select.
 * 3: dates may carry a time (2026-10-30T14:30), free properties may hold lists, properties
 *    keep their former names; an older app would drop times and lists on edit.
 * 4: stored names in English: kinds note, file, drawing; file types image, document, other;
 *    query fences ```query. An older app would write the old names, which this one no longer reads.
 */
export const FORMAT = 4;

export interface SettingsRecord {
	setupLang?: string;
	format?: number;
	captureTypes: string[]; // pinned types in the capture type picker
	inbox?: Cond; // what lands in the inbox; unset: the default
	filesPos?: string; // where "Files" stands among the types in the sidebar
}

/**
 * One view shown as a tab. `where` is ANDed with the base query; grouping, sorting and columns are
 * its own. An empty name shows the kind's name.
 */
export interface ViewTab {
	id: string;
	pos: string; // sort key
	name?: string;
	kind: ViewKind;
	where?: Cond;
	sort?: { key: string; desc?: boolean }[];
	order?: string[]; // entries put in order by hand; counts while the view has no sort
	group?: string; // "status" | "statusGroup" | "type" | "path" | field or property name
	subgroup?: string; // boards: rows ("swimlanes") within the columns
	hideEmpty?: boolean; // hide empty groups
	hiddenGroups?: string[]; // group ids hidden by hand
	groupOrder?: string[]; // group ids put in order by hand; the others follow
	columns?: string[]; // shown properties in this order (table columns, card lines)
	widths?: Record<string, number>; // table column widths in px
	date?: string; // calendar and timeline: the date property
}

/** The tab a query block with a single view is read as. */
export const MAIN_TAB = "main";
export function singleTab(view: {
	display?: ViewKind;
	sort?: { key: string; desc?: boolean }[];
	group?: string;
	columns?: string[];
}): ViewTab {
	const tab: ViewTab = { id: MAIN_TAB, pos: "V", kind: view.display ?? "list" };
	if (view.sort?.length) tab.sort = view.sort;
	if (view.group) tab.group = view.group;
	if (view.columns?.length) tab.columns = view.columns;
	return tab;
}

export interface Item {
	id: string;
	kind: Kind;
	area: string;
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
	/** "Rules for agents" (see rules.ts); "" when there are none. */
	rules: string;
	updates: UpdateEntry[];
	schema?: TypeSchema;
	file?: FileMeta;
	drawing?: DrawingInfo;
	op?: OpRecord;
	settings?: SettingsRecord;
	suggestion?: Suggestion;
	/** Out of the inbox until then ("Back tomorrow"). */
	later?: number;
	created: number;
	updated: number;
	createdBy?: string;
	/** In the trash: deleted itself, or together with a deleted root. */
	deleted: boolean;
	/** meta.deleted = "via:<root>": deleted together with that root (raw mark). */
	deletedVia?: string;
	/** meta.done: when the status last entered the group done (read it via traits.doneAt). */
	doneAt?: number;
	source?: string;
}

export type TypeItem = Item & { schema: TypeSchema };

/** meta.deleted is true, or "via:<root>" when deleted together with that root. */
export const VIA = "via:";
function viaRoot(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.startsWith(VIA) ? raw.slice(VIA.length) : undefined;
}

function plain(v: unknown): unknown {
	return v instanceof Y.AbstractType ? v.toJSON() : v;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The top-level maps of a document. */
export const DOC_MAPS = [
	"meta",
	"parents",
	"props",
	"extra",
	"rels",
	"tags",
	"refs",
	"schema",
	"tabs",
	"file",
	"op",
	"settings",
	DRAWING,
	DRAWING_FILES,
	DRAWING_STATE,
] as const;

/** Narrow on reading: the data comes from other devices. */
export type MetaValue = string | number | boolean | Suggestion;

export function metaMap(doc: Y.Doc): Y.Map<MetaValue> {
	return doc.getMap<MetaValue>("meta");
}

export function schemaMap(doc: Y.Doc): Y.Map<unknown> {
	return doc.getMap<unknown>("schema");
}

/** A status is single, never empty (its first option is the default) and every option has a group. */
function asStatus(p: PropDef): PropDef {
	const options = p.options?.map((o) => ({ ...o, group: o.group ?? ("todo" as const) }));
	const keeps = p.default && options?.some((o) => o.id === p.default);
	return { ...p, multiple: undefined, options, default: keeps ? p.default : options?.[0]?.id };
}

export function readSchema(doc: Y.Doc): TypeSchema {
	const s = schemaMap(doc);
	const text = (k: string) => {
		const v = s.get(k);
		return typeof v === "string" ? v : undefined;
	};
	const caps = plain(s.get("capabilities"));
	const props = s.get("properties");
	const defs: [string, Partial<PropDef>][] = [];
	if (props instanceof Y.Map) {
		for (const [id, p] of props) {
			const o = plain(p);
			if (!isObject(o)) continue;
			const def = o as Partial<PropDef>;
			if (def.name || def.kind) defs.push([id, def]);
		}
	}
	const properties = defs.map(
		([id, def]): PropDef => ({
			...def,
			id,
			name: def.name ?? "",
			kind: def.kind ?? "text",
			sort: def.sort ?? "V",
		}),
	);
	properties.sort((a, b) => cmpKey(a.sort, b.sort) || a.id.localeCompare(b.id));
	// Two devices may each add a status at once: the first live one counts, the others read as selects.
	const statusId = properties.find((p) => !p.removed && p.kind === "status")?.id;
	for (const [i, p] of properties.entries())
		if (p.kind === "status")
			properties[i] =
				p.id === statusId ? asStatus(p) : { ...p, kind: "select", multiple: undefined };
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

/**
 * Bump when readItem returns something else for the same document. Server and devices store
 * readItem's result next to each document's state, and read every document again once this changes.
 */
export const RECORD_VERSION = 2;

export function readItem(id: string, doc: Y.Doc): Item | null {
	const meta = metaMap(doc);
	const kind = meta.get("kind");
	// half-synced
	if (typeof kind !== "string" || !kind) return null;
	const rels: Record<string, string[]> = {};
	for (const [p, m] of doc.getMap<unknown>("rels"))
		if (m instanceof Y.Map && m.size) rels[p] = [...m.keys()];
	const str = (k: string) => {
		const v = meta.get(k);
		return v === undefined || v === null || v === "" ? undefined : String(v);
	};
	const num = (k: string) => {
		const v = meta.get(k);
		return typeof v === "number" ? v : undefined;
	};
	const deletedVia = viaRoot(meta.get("deleted"));
	const item: Item = {
		id,
		kind: kind as Kind,
		area: str("area") ?? PERSONAL, // initItem always sets it; the default only guards a malformed document
		title: str("title") ?? "",
		type: str("type") ?? null,
		home: str("home") ?? null,
		pinned: str("pinned"),
		parents: doc.getMap<ParentLink>("parents").toJSON() as Record<string, ParentLink>,
		props: doc.getMap<Value>("props").toJSON() as Record<string, Value>,
		extra: doc.getMap<FreeValue>("extra").toJSON() as Record<string, FreeValue>,
		rels,
		tags: [...doc.getMap("tags").keys()].sort(),
		refs: refOrder(doc),
		body: doc.getText("body").toString(),
		rules: doc.getText("rules").toString(),
		updates: doc.getArray<UpdateEntry>("updates").toArray().slice(),
		created: Number(meta.get("created") ?? 0),
		updated: Number(meta.get("updated") ?? meta.get("created") ?? 0),
		createdBy: str("createdBy"),
		deleted: meta.get("deleted") === true || deletedVia !== undefined,
		deletedVia,
		doneAt: num("done"),
		source: str("source"),
	};
	const later = num("later");
	if (later !== undefined) item.later = later;
	const sug = meta.get("suggestion");
	if (sug && typeof sug === "object") item.suggestion = sug;
	if (item.type === META_TYPE) {
		item.schema = readSchema(doc);
		if (doc.getMap("tabs").size) item.schema.views = readTabs(doc);
	}
	if (kind === "file") item.file = doc.getMap("file").toJSON() as FileMeta;
	if (kind === "drawing") item.drawing = drawingInfo(doc);
	if (kind === "op") item.op = doc.getMap("op").toJSON() as OpRecord;
	if (kind === "settings") {
		const s: Partial<SettingsRecord> = doc.getMap("settings").toJSON();
		item.settings = {
			setupLang: s.setupLang,
			format: typeof s.format === "number" ? s.format : undefined,
			captureTypes: s.captureTypes ?? [],
			inbox: s.inbox ?? undefined,
			filesPos: s.filesPos ?? undefined,
		};
	}
	return item;
}

export function readTabs(doc: Y.Doc): ViewTab[] {
	const tabs: ViewTab[] = [];
	for (const [id, v] of doc.getMap<unknown>("tabs")) {
		const o = plain(v);
		if (!isObject(o)) continue;
		const t = o as Partial<ViewTab>;
		if (t.kind) tabs.push({ ...t, id, pos: t.pos ?? "V", kind: t.kind });
	}
	tabs.sort((a, b) => cmpKey(a.pos, b.pos) || a.id.localeCompare(b.id));
	return tabs;
}

// Writers: call inside doc.transact.

export interface ItemInit {
	kind?: Kind;
	area?: string; // default: PERSONAL
	title?: string;
	type?: string | null;
	body?: string;
	rules?: string;
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
	meta.set("kind", init.kind ?? "note");
	meta.set("area", init.area ?? PERSONAL);
	meta.set("title", init.title ?? "");
	if (init.type) meta.set("type", init.type);
	if (init.pinned) meta.set("pinned", init.pinned);
	if (init.source) meta.set("source", init.source);
	if (init.createdBy) meta.set("createdBy", init.createdBy);
	meta.set("created", init.created ?? now);
	meta.set("updated", init.updated ?? init.created ?? now);
	if (init.body) doc.getText("body").insert(0, init.body);
	if (init.rules?.trim()) doc.getText("rules").insert(0, init.rules);
	for (const t of init.tags ?? []) setMember(doc, "tags", t, true);
	for (const r of init.refs ?? []) setMember(doc, "refs", r, true);
	for (const [i, p] of (init.parents ?? []).entries())
		addParent(doc, p, undefined, (init.created ?? now) + i);
	for (const [k, v] of Object.entries(init.props ?? {})) setProp(doc, k, v);
	for (const [k, v] of Object.entries(init.extra ?? {})) setExtra(doc, k, v);
	for (const [p, ids] of Object.entries(init.rels ?? {}))
		for (const t of ids) setRel(doc, p, t, true);
}

export type MetaField =
	| "title"
	| "type"
	| "home"
	| "pinned"
	| "deleted"
	| "source"
	| "suggestion"
	| "later";

/** null, "" or false clears a field. */
export function setMeta(
	doc: Y.Doc,
	fields: Partial<Record<MetaField, MetaValue | null>>,
	now = Date.now(),
) {
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
 * Local text edits move meta.updated right away, then at most every `every` ms (the last edit of a
 * burst counts too). Remote edits don't, they bring their own time. Stamps in a separate
 * transaction so it stays out of the text's undo history. Returns a stop function.
 */
const TOUCH_ORIGIN = "touch";

export function touchOnTextEdit(
	doc: Y.Doc,
	every = 3000,
	clock: () => number = Date.now,
): () => void {
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
		if (timer) {
			clearTimeout(timer);
			stamp();
		}
	};
}

/** The first parent becomes the home. */
export function addParent(doc: Y.Doc, parentId: string, sort?: string, at = Date.now()) {
	const parents = doc.getMap<ParentLink>("parents");
	if (parents.has(parentId)) return;
	// a file has exactly one parent (other uses show under "Used in"), so a new place replaces the old one
	const meta = metaMap(doc);
	if (meta.get("kind") === "file") for (const k of [...parents.keys()]) parents.delete(k);
	parents.set(parentId, { sort: sort ?? keyBetween(null, null), at });
	const home = meta.get("home");
	if (typeof home !== "string" || !home || !parents.has(home)) meta.set("home", parentId);
}

export function setParentSort(doc: Y.Doc, parentId: string, sort: string) {
	const parents = doc.getMap<ParentLink>("parents");
	const cur = parents.get(parentId);
	if (cur) parents.set(parentId, { ...cur, sort });
}

/** If it was the home, the oldest remaining parent becomes home. */
export function removeParent(doc: Y.Doc, parentId: string) {
	const parents = doc.getMap<ParentLink>("parents");
	if (!parents.has(parentId)) return;
	parents.delete(parentId);
	const meta = metaMap(doc);
	if (meta.get("home") === parentId) {
		const next = [...parents.entries()].sort(
			(a, b) => a[1].at - b[1].at || a[0].localeCompare(b[0]),
		)[0];
		if (next) meta.set("home", next[0]);
		else meta.delete("home");
	}
}

export function setHome(doc: Y.Doc, parentId: string) {
	if (doc.getMap("parents").has(parentId)) metaMap(doc).set("home", parentId);
}

export function setProp(doc: Y.Doc, propId: string, value: Value | null | undefined) {
	const props = doc.getMap<Value>("props");
	if (
		value === null ||
		value === undefined ||
		value === "" ||
		(Array.isArray(value) && !value.length)
	)
		props.delete(propId);
	else if (JSON.stringify(props.get(propId)) !== JSON.stringify(value)) props.set(propId, value);
}

export function setExtra(doc: Y.Doc, name: string, value: FreeValue | null | undefined) {
	const extra = doc.getMap<FreeValue>("extra");
	const key = name.trim();
	if (!key) return;
	if (!value || value.v === "" || value.v === null || (Array.isArray(value.v) && !value.v.length))
		extra.delete(key);
	else extra.set(key, value);
}

export function setRel(doc: Y.Doc, propId: string, target: string, on: boolean) {
	const rels = doc.getMap<unknown>("rels");
	const found = rels.get(propId);
	let m: Y.Map<unknown>;
	if (found instanceof Y.Map) m = found;
	else {
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
	if (on && set === "refs") addRef(doc, k);
	else if (on) m.set(k, true);
	else m.delete(k);
}

/** The refs in their order, by sort key. */
export function refOrder(doc: Y.Doc): string[] {
	return [...doc.getMap<string>("refs").entries()]
		.sort((a, b) => cmpKey(a[1], b[1]) || cmpKey(a[0], b[0]))
		.map(([k]) => k);
}

/** Gives a new key to each ref that shares its place with the one before (added at once on two
 * devices), so one can go between two. Other refs keep theirs: rewriting a ref would bring it back
 * if another device removed it meanwhile. */
function keyedRefs(doc: Y.Doc): Y.Map<string> {
	const m = doc.getMap<string>("refs");
	let prev: string | null = null;
	for (const k of refOrder(doc)) {
		const v = m.get(k)!;
		if (prev === null || cmpKey(v, prev) > 0) prev = v;
		else {
			prev = keyBetween(prev, null);
			m.set(k, prev);
		}
	}
	return m;
}

/** A ref at the front (a link from the text, pinned) or the end (set by hand); one already there
 * keeps its place. Writes no other ref, see keyedRefs. */
export function addRef(doc: Y.Doc, target: string, front = false) {
	const m = doc.getMap<string>("refs");
	if (m.has(target)) return;
	const keys = [...m.values()].sort(cmpKey);
	m.set(target, front ? keyBetween(null, keys[0] ?? null) : keyBetween(keys.at(-1) ?? null, null));
}

/** Moves a ref in front of `before`, or to the end. */
export function moveRef(doc: Y.Doc, target: string, before: string | null) {
	const m = keyedRefs(doc);
	if (!m.has(target) || target === before) return;
	const rest = refOrder(doc).filter((k) => k !== target);
	const at = before === null ? rest.length : rest.indexOf(before);
	if (at < 0) return;
	const lo = rest[at - 1];
	const hi = rest[at];
	m.set(
		target,
		keyBetween(lo === undefined ? null : m.get(lo)!, hi === undefined ? null : m.get(hi)!),
	);
}

/** The texts of a document (Y.Text): the body and the rules for agents. */
export const DOC_TEXTS = ["body", "rules"] as const;
export type DocText = (typeof DOC_TEXTS)[number];

/** Replace body text with minimal edits (common prefix/suffix), so concurrent edits elsewhere merge. */
export function replaceBody(doc: Y.Doc, next: string) {
	replaceText(doc, "body", next);
}

/** "Rules for agents": only blank lines or spaces count as none. */
export function setRules(doc: Y.Doc, next: string | null) {
	replaceText(doc, "rules", next?.trim() ? next : "");
}

/** Replace one text of the document with minimal edits (see replaceBody). */
export function replaceText(doc: Y.Doc, name: DocText, next: string) {
	const text = doc.getText(name);
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

/** Takes an update out; returns it and where it was, to put it back. */
export function removeUpdate(
	doc: Y.Doc,
	id: string,
): { entry: UpdateEntry; at: number } | undefined {
	const arr = doc.getArray<UpdateEntry>("updates");
	const at = arr.toArray().findIndex((u) => u?.id === id);
	if (at < 0) return undefined;
	const entry = arr.get(at);
	arr.delete(at, 1);
	return { entry, at };
}

/** Puts a removed update back where it was (or at the end, if the list got shorter). */
export function putBackUpdate(doc: Y.Doc, entry: UpdateEntry, at: number) {
	const arr = doc.getArray<UpdateEntry>("updates");
	if (arr.toArray().some((u) => u?.id === entry.id)) return;
	arr.insert(Math.min(at, arr.length), [entry]);
}

export function initSchema(
	doc: Y.Doc,
	s: Partial<Omit<TypeSchema, "properties" | "removedProperties">> & {
		properties?: Omit<PropDef, "sort">[];
	},
) {
	const schema = schemaMap(doc);
	for (const k of ["name", "icon", "color", "description"] as const)
		if (s[k] !== undefined) schema.set(k, s[k]);
	if (s.plural) schema.set("plural", s.plural);
	if (!(schema.get("capabilities") instanceof Y.Map)) schema.set("capabilities", new Y.Map());
	if (!(schema.get("properties") instanceof Y.Map)) schema.set("properties", new Y.Map());
	for (const [k, v] of Object.entries(s.capabilities ?? {}))
		setCapability(doc, k as keyof Capabilities, v);
	let prev: string | null = null;
	for (const p of s.properties ?? []) {
		prev = keyBetween(prev, null);
		upsertProp(doc, p.id, { ...p, sort: prev });
	}
}

export function initType(
	doc: Y.Doc,
	s: Parameters<typeof initSchema>[1] & { name: string },
	init: Pick<ItemInit, "createdBy" | "created" | "source"> = {},
	now = Date.now(),
) {
	initItem(doc, { kind: "note", type: META_TYPE, title: s.name, ...init }, now);
	initSchema(doc, { ...s, icon: s.icon ?? "box", description: s.description ?? "" });
}

export function setSchemaField(
	doc: Y.Doc,
	field: "name" | "plural" | "icon" | "color" | "description" | "pos",
	value: string,
) {
	if (value) schemaMap(doc).set(field, value);
	else schemaMap(doc).delete(field);
}

export function setCapability<K extends keyof Capabilities>(
	doc: Y.Doc,
	key: K,
	value: Capabilities[K] | null | undefined,
) {
	const caps = ensureSubMap(schemaMap(doc), "capabilities");
	if (value === null || value === undefined || value === false) caps.delete(key);
	else caps.set(key, value);
}

/** A change of a record: undefined leaves a field, null clears it. */
export type Patch<T> = { [K in keyof T]?: T[K] | null };

/** Each property is its own Y.Map, so two devices can change different properties at once. */
export function upsertProp(doc: Y.Doc, propId: string, patch: Patch<Omit<PropDef, "id">>) {
	const props = ensureSubMap(schemaMap(doc), "properties");
	const found = props.get(propId);
	const prop: Y.Map<unknown> = found instanceof Y.Map ? found : new Y.Map<unknown>();
	if (prop !== found) {
		props.set(propId, prop);
		if (!patch.sort) prop.set("sort", keyBetween(lastSortKey(props), null));
	}
	// a rename keeps the old name, so views that still name it keep working (see propByName)
	const was = prop.get("name");
	if (
		typeof patch.name === "string" &&
		typeof was === "string" &&
		was.trim() &&
		titleKey(was) !== titleKey(patch.name) &&
		patch.formerNames === undefined
	) {
		const former = (prop.get("formerNames") as string[] | undefined) ?? [];
		const next = [
			...former.filter(
				(n) => titleKey(n) !== titleKey(was) && titleKey(n) !== titleKey(patch.name!),
			),
			was,
		].slice(-5);
		prop.set("formerNames", next);
	}
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		if (v === null || v === "") prop.delete(k);
		else prop.set(k, v);
	}
}

/**
 * The property a view or query means by `name`: the current name first, then the id, then a
 * former name (a view written on a device that missed a rename). Removed properties don't count.
 */
export function propByName(
	schema: Pick<TypeSchema, "properties"> | undefined,
	name: string,
	ok: (p: PropDef) => boolean = () => true,
): PropDef | undefined {
	const props = schema?.properties.filter(ok) ?? [];
	const key = titleKey(name);
	return (
		props.find((p) => titleKey(p.name) === key) ??
		props.find((p) => p.id === name) ??
		props.find((p) => p.formerNames?.some((n) => titleKey(n) === key))
	);
}

/** The highest sort key among the properties, null when none has one. */
function lastSortKey(props: Y.Map<unknown>): string | null {
	const keys = [...props.values()]
		.map((p) => (p instanceof Y.Map ? p.get("sort") : undefined))
		.filter((k): k is string => typeof k === "string" && !!k);
	return keys.sort().at(-1) ?? null;
}

/** Keeps the values and the definition as a tombstone, so they still show by name under "Weitere Eigenschaften". */
export function removeProp(doc: Y.Doc, propId: string) {
	upsertProp(doc, propId, { removed: true });
}

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

/** `null` as the patch removes the tab. */
export function setTab(doc: Y.Doc, id: string, patch: Patch<Omit<ViewTab, "id">> | null) {
	const tabs = doc.getMap<unknown>("tabs");
	if (patch === null) tabs.delete(id);
	else {
		const found = tabs.get(id);
		let m: Y.Map<unknown>;
		if (found instanceof Y.Map) m = found;
		else {
			const o = plain(found);
			m = toMap(isObject(o) ? o : {});
			tabs.set(id, m);
		}
		for (const [k, v] of Object.entries(patch)) {
			if (v === undefined) continue;
			if (v === null || (Array.isArray(v) && !v.length)) m.delete(k);
			else m.set(k, v);
		}
	}
	touch(doc);
}

/** An empty list goes back to the default views. */
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

function ensureSubMap(parent: Y.Map<unknown>, key: string): Y.Map<unknown> {
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
	for (const [k, v] of Object.entries(patch)) {
		if (v === null) s.delete(k);
		else if (v !== undefined) s.set(k, v);
	}
}

export function normalizeTag(t: string): string {
	return t.trim().replace(/^#+/, "").replace(/\s+/g, "-").toLowerCase();
}

// Time-sortable ids: 9 chars of time + 8 random chars, base36.
export function newId(): string {
	const time = Date.now().toString(36).padStart(9, "0");
	const random = Array.from(crypto.getRandomValues(new Uint8Array(8)))
		.map((b) => (b % 36).toString(36))
		.join("");
	return time + random;
}

export function shortId(prefix: string): string {
	return `${prefix}_${newId().slice(-8)}`;
}

export function titleKey(title: string) {
	return title.trim().toLowerCase();
}

export { addDaysISO, todayISO } from "./date";

/** A date range as stored: "2026-03-01/2026-06-30", either side may be empty. */
export function parseRange(v: unknown): { start: string; end: string } {
	const [start = "", end = ""] = typeof v === "string" && v ? v.split("/") : [];
	return { start, end };
}
/** The stored form of a range; "" when both sides are empty. */
export const formatRange = (start: string, end: string) => (start || end ? `${start}/${end}` : "");

export function displayTitle(item: Pick<Item, "title" | "file">): string {
	return item.title || item.file?.name || "";
}

export function areaOf(doc: Y.Doc | undefined): string {
	const a = doc && metaMap(doc).get("area");
	return typeof a === "string" ? a : PERSONAL;
}

/** An unknown option id stays as is. */
export function optionNames(p: PropDef, v: Value): string[] {
	return (Array.isArray(v) ? v : [v]).map(
		(id) => p.options?.find((o) => o.id === id)?.name ?? String(id),
	);
}

/** A note, file or drawing rather than an op or the settings. */
export function isContentKind(kind: Kind) {
	return kind === "note" || kind === "file" || kind === "drawing";
}

/** Not deleted, and content (isContentKind). */
export function isContent(i: Item) {
	return !i.deleted && isContentKind(i.kind);
}

/**
 * [[Page]], [[Page#Section]], [[Page|text]], ![[file.png|320]]: groups embed mark, target,
 * "#section", "|text". In a table the "|" is escaped ("[[Page\|text]]"); the "\" belongs to no group.
 */
const WIKILINK = /(!?)\[\[([^\]|#\n]+?)\\?(#[^\]|\n]*?)?\\?(\|[^\]\n]*)?\]\]/g;

/** A fresh copy of the wikilink pattern (its own lastIndex); `anchored` matches only at the start. */
export function wikiLinkRe(anchored = false): RegExp {
	return anchored ? new RegExp(`^${WIKILINK.source}`) : new RegExp(WIKILINK.source, "g");
}

export interface WikiLinkMatch {
	raw: string;
	embed: boolean;
	target: string; // as written, not trimmed
	section: string; // "#Section" or ""
	label?: string; // the text after "|"
}

export function mapWikiLinks(text: string, fn: (l: WikiLinkMatch) => string): string {
	if (!text.includes("[[")) return text;
	return text.replace(
		WIKILINK,
		(raw, bang: string, target: string, section?: string, label?: string) =>
			fn({ raw, embed: bang === "!", target, section: section ?? "", label: label?.slice(1) }),
	);
}

/** Matches `oldTitle` in any case, with or without section or label; null when nothing changes. */
export function renameLinksIn(body: string, oldTitle: string, newTitle: string): string | null {
	if (!newTitle.trim() || !body.includes("[[")) return null;
	const re = new RegExp(`(!?\\[\\[)${escapeRe(oldTitle)}(?=\\\\?[\\]|#])`, "gi");
	const next = body.replace(re, (_m, open: string) => open + newTitle);
	return next === body ? null : next;
}

export interface WikiLink {
	target: string;
	embed: boolean;
	size?: number; // ![[x.png|320]]
	alias?: string;
}

/** Wikilinks outside of ```query blocks. */
export function parseWikiLinks(body: string): WikiLink[] {
	const out: WikiLink[] = [];
	if (!body.includes("[[")) return out;
	const text = stripQueryBlocks(body);
	for (const m of text.matchAll(WIKILINK)) {
		const target = m[2]!.trim();
		const afterPipe = m[4]?.slice(1).trim();
		const size =
			afterPipe && /^\d+(x\d+)?$/.test(afterPipe) ? Number(afterPipe.split("x")[0]) : undefined;
		out.push({
			target,
			embed: m[1] === "!",
			size,
			alias: size ? undefined : afterPipe || undefined,
		});
	}
	return out;
}

export const QUERY_FENCE = /^```query[ \t]*(.*)\n([\s\S]*?)^```[ \t]*$/gm;

export function stripQueryBlocks(body: string) {
	return body.includes("```") ? body.replace(QUERY_FENCE, "") : body;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i;

export function looksLikeFileName(name: string) {
	return /\.[a-z0-9]{2,5}$/i.test(name) && !/\s\.[a-z]+$/i.test(name);
}

export function fileTypeOf(name: string, mime = ""): FileType {
	const n = name.toLowerCase();
	if (mime.startsWith("image/") || IMAGE_EXT.test(n)) return "image";
	if (mime === "application/pdf" || n.endsWith(".pdf")) return "pdf";
	if (mime.startsWith("audio/") || /\.(mp3|m4a|wav|ogg|oga|flac|aac|opus)$/.test(n)) return "audio";
	if (mime.startsWith("video/") || /\.(mp4|mov|webm|mkv|m4v)$/.test(n)) return "video";
	if (/\.(docx?|xlsx?|pptx?|odt|ods|odp|txt|md|csv|rtf|pages|numbers|key|excalidraw)$/.test(n))
		return "document";
	return "other";
}

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	heic: "image/heic",
	pdf: "application/pdf",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	wav: "audio/wav",
	ogg: "audio/ogg",
	flac: "audio/flac",
	opus: "audio/opus",
	mp4: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	txt: "text/plain",
	md: "text/markdown",
	csv: "text/csv",
};

export function mimeOf(name: string): string {
	const ext = name.toLowerCase().split(".").pop() ?? "";
	return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
