// Bulk changes on types. Every run is recorded as an "op" document so it shows in Activity and
// can be reverted. Values are never lost: what no typed property can hold becomes a free
// property, and relations become refs.
import type * as Y from "yjs";
import { Index } from "./graph";
import {
	type FreeValue,
	type Item,
	initItem,
	META_TYPE,
	newId,
	normalizeTag,
	type PropDef,
	setExtra,
	setMember,
	setMeta,
	setOp,
	setProp,
	setRel,
	type TypeSchema,
	titleKey,
	type Value,
} from "./model";
import { isInInbox } from "./placement";
import { findBlocks, readBlock, typesIn } from "./query";
import type { Writer } from "./setup";
import { escapeRe } from "./text";
import { initialProps, isMulti, isSingle, optionIds, progressSpec } from "./traits";

export type DeleteMode =
	| { mode: "tag"; tag: string }
	| { mode: "type"; target: string }
	| { mode: "remove" };

export interface TypeUsage {
	items: string[];
	inboxAfterRemove: number;
	queries: { id: string; title: string }[]; // pages whose query blocks use the type
	relations: { type: string; prop: string; name: string }[]; // relation targets naming the type
	progress: { type: string; name: string }[]; // progress/computed filters on the type
}

export function typeUsage(ix: Index, typeId: string): TypeUsage {
	const items = ix.live.filter((i) => i.type === typeId).map((i) => i.id);
	const name = ix.typeName(typeId) ?? "";
	const queries: TypeUsage["queries"] = [];
	for (const i of ix.all.values()) {
		if (i.deleted) continue;
		const blockTypes = findBlocks(i.body).flatMap((b) => typesIn(readBlock(b.src, ix).def.where));
		if (blockTypes.includes(typeId))
			queries.push({ id: i.id, title: i.kind === "settings" ? "Start" : i.title });
	}
	const relations: TypeUsage["relations"] = [];
	const progress: TypeUsage["progress"] = [];
	// the type's name in a relation target such as `type:Task | type:Project` or `typ:"Aufgabe"` (German)
	const namesType = name ? new RegExp(`:\\s*"?${escapeRe(name)}"?(\\s|$|\\))`, "i") : undefined;
	for (const t of ix.types.values()) {
		const s = t.schema;
		for (const p of s.properties) {
			if (p.kind === "relation" && p.target && namesType?.test(p.target))
				relations.push({ type: t.id, prop: p.id, name: `${s.name} › ${p.name}` });
			if (p.kind === "computed" && p.computed?.of === typeId)
				progress.push({ type: t.id, name: `${s.name} › ${p.name}` });
		}
		if (progressSpec(s)?.of === typeId && !progress.some((x) => x.type === t.id))
			progress.push({ type: t.id, name: s.name });
	}
	const inboxAfterRemove = wouldBeInInbox(ix, items, (i) => ({ ...i, type: null }));
	return { items, inboxAfterRemove, queries, relations, progress };
}

/** Evaluated against the stored inbox rule. `also` are further changed records, e.g. a parent about to be deleted. */
export function wouldBeInInbox(
	ix: Index,
	ids: string[],
	change: (i: Item) => Item,
	also: Item[] = [],
): number {
	const next = new Map(ix.all);
	for (const id of ids) next.set(id, change(ix.get(id)!));
	for (const i of also) next.set(i.id, i);
	const after = new Index(next);
	return ids.filter((id) => isInInbox(after.get(id)!, after)).length;
}

/** A typed value as a free property (simple kinds only). */
export function toFree(p: PropDef, v: Value | undefined): FreeValue | undefined {
	if (v === undefined || v === null || v === "") return undefined;
	switch (p.kind) {
		case "text":
		case "number":
		case "date":
		case "checkbox":
		case "url":
			return { k: p.kind, v: v as string | number | boolean };
		case "select":
		case "status": {
			const names = optionIds(v).map((id) => p.options?.find((o) => o.id === id)?.name ?? id);
			return p.multiple ? { k: "list", v: names } : { k: "select", v: names[0] ?? String(v) };
		}
		default:
			return undefined;
	}
}

/** A free value read as a property, for mapValue: a list is a multiple choice whose options are its texts. */
export function freeDef(name: string, fv: FreeValue): PropDef {
	if (fv.k === "list")
		return { id: "", name, kind: "select", multiple: true, options: [], sort: "" };
	return { id: "", name, kind: fv.k === "select" ? "text" : fv.k, sort: "" };
}

/**
 * Options match by name; a status option falls back to its group; a multi select keeps the options
 * that match. `byId` (moving between workspaces) tries the option id first and is all or nothing:
 * one unmatched option makes the value not fit; several values into a single select keep the first.
 */
export function mapValue(
	from: PropDef,
	to: PropDef,
	v: Value,
	opts: { byId?: boolean } = {},
): Value | undefined {
	if (from.kind === to.kind && !from.options) return v;
	const optName = (id: string) => from.options?.find((o) => o.id === id)?.name;
	const option = (x: string) => {
		if (opts.byId && to.options?.some((o) => o.id === x)) return x;
		const name = optName(x) ?? x;
		return to.options?.find((o) => titleKey(o.name) === titleKey(name))?.id;
	};
	if (isSingle(to) && typeof v === "string") {
		const hit = option(v);
		if (hit || opts.byId) return hit;
		const group = from.options?.find((o) => o.id === v)?.group;
		if (group && to.options?.some((o) => o.group))
			return to.options?.find((o) => (o.group ?? "todo") === group)?.id;
		return undefined;
	}
	if (isSingle(to) && Array.isArray(v) && (opts.byId || to.kind === "status")) {
		const ids = v.map((x) => option(String(x)));
		// into the status (one value): the first option that matches
		return opts.byId ? (ids.every(Boolean) ? ids[0] : undefined) : ids.find(Boolean);
	}
	if (isMulti(to)) {
		const ids = (Array.isArray(v) ? v : [v]).map((x) => option(String(x)));
		if (opts.byId) return ids.every(Boolean) ? (ids as string[]) : undefined;
		const out = ids.filter(Boolean) as string[];
		return out.length ? out : undefined;
	}
	if (["text", "url"].includes(to.kind))
		return Array.isArray(v)
			? v.map((x) => optName(x) ?? x).join(", ")
			: typeof v === "string"
				? (optName(v) ?? v)
				: String(v);
	if (to.kind === "number" && typeof v === "number") return v;
	if (to.kind === "date" && typeof v === "string" && /^\d{4}-/.test(v)) return v;
	if (to.kind === "checkbox" && typeof v === "boolean") return v;
	return undefined;
}

interface Undo {
	id: string;
	type: string | null;
	props: Record<string, Value | null>; // previous values of touched props
	extra: Record<string, FreeValue | null>; // previous values of touched free properties
	tagAdded?: string;
	tagRemoved?: string;
	refsAdded: string[];
	rels: { prop: string; target: string }[]; // relations added
}

interface OpPayload {
	typeDeleted?: string;
	items: Undo[];
}

function convertItem(
	doc: Y.Doc,
	item: Item,
	from: TypeSchema | undefined,
	ix: Index,
	to: { type: string | null; schema?: TypeSchema; tag?: string; removeTag?: string },
): Undo {
	const undo: Undo = {
		id: item.id,
		type: item.type,
		props: {},
		extra: {},
		refsAdded: [],
		rels: [],
	};
	setMeta(doc, { type: to.type });
	if (to.tag && !item.tags.includes(normalizeTag(to.tag))) {
		setMember(doc, "tags", to.tag, true);
		undo.tagAdded = normalizeTag(to.tag);
	}
	if (to.removeTag && item.tags.includes(to.removeTag)) {
		setMember(doc, "tags", to.removeTag, false);
		undo.tagRemoved = to.removeTag;
	}
	const setTyped = (pid: string, v: Value | undefined) => {
		if (!(pid in undo.props)) undo.props[pid] = item.props[pid] ?? null;
		setProp(doc, pid, v ?? null);
	};
	const setFree = (name: string, v: FreeValue | null) => {
		if (!(name in undo.extra)) undo.extra[name] = item.extra[name] ?? null;
		setExtra(doc, name, v);
	};
	const target = to.schema;
	for (const p of from?.properties ?? []) {
		const match = target?.properties.find(
			(q) => titleKey(q.name) === titleKey(p.name) && q.kind !== "computed",
		);
		if (p.kind === "relation") {
			const ids = item.rels[p.id] ?? [];
			for (const t of ids) {
				if (match?.kind === "relation") {
					if (item.rels[match.id]?.includes(t)) continue;
					setRel(doc, match.id, t, true);
					undo.rels.push({ prop: match.id, target: t });
				} else if (!item.refs.includes(t)) {
					setMember(doc, "refs", t, true);
					undo.refsAdded.push(t);
				}
			}
			continue;
		}
		const v = item.props[p.id];
		if (v === undefined || p.kind === "computed") continue;
		const mapped = match ? mapValue(p, match, v) : undefined;
		if (match && mapped !== undefined) {
			setTyped(match.id, mapped);
		} else {
			const fv = toFree(p, v);
			if (fv) setFree(p.name, fv);
		}
	}
	// Free properties that the target type defines become typed values.
	if (target) {
		for (const [name, fv] of Object.entries(item.extra)) {
			const q = target.properties.find((x) => titleKey(x.name) === titleKey(name));
			if (!q || q.kind === "computed" || q.kind === "relation") continue;
			const v = mapValue(freeDef(name, fv), q, fv.v as Value);
			if (v === undefined) continue;
			setTyped(q.id, v);
			setFree(name, null);
		}
		for (const [pid, v] of Object.entries(initialProps(target)))
			if (item.props[pid] === undefined && !(pid in undo.props)) setTyped(pid, v);
	}
	return undo;
}

function recordOp(
	w: Writer,
	label: string,
	action: string,
	payload: OpPayload,
	origin?: string,
): string {
	const id = `op_${newId()}`;
	w.change(id, (doc) => {
		initItem(doc, { kind: "op", title: label, createdBy: origin });
		setOp(doc, { action, label, payload });
	});
	return id;
}

/** Items become tagged, another type, or untyped. Returns the op id. */
export function deleteType(
	w: Writer,
	ix: Index,
	typeId: string,
	m: DeleteMode,
	label: string,
	origin?: string,
): string {
	const typeItem = ix.types.get(typeId);
	if (!typeItem) throw new Error("Unknown type");
	const from = typeItem.schema;
	const target = m.mode === "type" ? ix.types.get(m.target)?.schema : undefined;
	if (m.mode === "type" && (!target || m.target === typeId)) throw new Error("Unknown target type");
	const items: Undo[] = [];
	for (const item of ix.live.filter((i) => i.type === typeId)) {
		w.change(item.id, (doc) => {
			items.push(
				convertItem(doc, item, from, ix, {
					type: m.mode === "type" ? m.target : null,
					schema: target,
					tag: m.mode === "tag" ? m.tag : undefined,
				}),
			);
		});
	}
	w.change(typeId, (doc) => setMeta(doc, { deleted: true }));
	return recordOp(w, label, "deleteType", { typeDeleted: typeId, items }, origin);
}

export interface TagTakeoverPreview {
	candidates: string[]; // items with the tag
	untyped: string[];
	typedOther: string[]; // already have another type (conflict)
	already: string[];
}

export function previewTagToType(ix: Index, tag: string, typeId: string): TagTakeoverPreview {
	const t = normalizeTag(tag);
	const candidates = ix.live.filter(
		(i) => i.kind === "note" && i.tags.includes(t) && i.type !== META_TYPE,
	);
	return {
		candidates: candidates.map((i) => i.id),
		untyped: candidates.filter((i) => !ix.typeOf(i)).map((i) => i.id),
		typedOther: candidates.filter((i) => ix.typeOf(i) && i.type !== typeId).map((i) => i.id),
		already: candidates.filter((i) => i.type === typeId).map((i) => i.id),
	};
}

/** "Take over items from a tag": items with the tag get the type. */
export function tagToType(
	w: Writer,
	ix: Index,
	tag: string,
	typeId: string,
	opts: { replaceTypes: boolean; removeTag: boolean },
	label: string,
	origin?: string,
): string {
	const target = ix.types.get(typeId)?.schema;
	if (!target) throw new Error("Unknown type");
	const p = previewTagToType(ix, tag, typeId);
	const ids = [
		...p.untyped,
		...(opts.replaceTypes ? p.typedOther : []),
		...(opts.removeTag ? p.already : []),
	];
	const items: Undo[] = [];
	for (const id of ids) {
		const item = ix.get(id)!;
		w.change(id, (doc) => {
			items.push(
				convertItem(doc, item, ix.schemaOf(item), ix, {
					type: typeId,
					schema: item.type === typeId ? undefined : target,
					removeTag: opts.removeTag ? normalizeTag(tag) : undefined,
				}),
			);
		});
	}
	return recordOp(w, label, "tagToType", { items }, origin);
}
