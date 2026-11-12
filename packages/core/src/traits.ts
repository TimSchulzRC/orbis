// Behaviour hangs on these type capabilities, never on a type id or name. Read capabilities only
// through this module.
import type * as Y from "yjs";
import { dayOf } from "./date";
import type { Index } from "./graph";
import type { T } from "./i18n";
import {
	type Capabilities,
	type Item,
	metaMap,
	type OptionDef,
	type Patch,
	type PropDef,
	type PropKind,
	type StatusGroup,
	setProp,
	shortId,
	type TypeSchema,
	type Value,
} from "./model";

export function caps(schema?: TypeSchema): Capabilities {
	return schema?.capabilities ?? {};
}

function propById(schema: TypeSchema | undefined, id?: string): PropDef | undefined {
	return id ? schema?.properties.find((p) => p.id === id) : undefined;
}

/** Drives "open" in queries, boards, progress and "In progress". readSchema leaves at most one. */
export function statusProp(schema?: TypeSchema): PropDef | undefined {
	return schema?.properties.find((p) => p.kind === "status");
}

export function isStatusProp(schema: TypeSchema | undefined, p: PropDef): boolean {
	return statusProp(schema)?.id === p.id;
}

export function isMulti(p: PropDef): boolean {
	return p.kind === "select" && !!p.multiple;
}

/** A single select or the status: one option id. */
export function isSingle(p: PropDef): boolean {
	return (p.kind === "select" && !p.multiple) || p.kind === "status";
}

/** Select or status: a property with options. */
export function hasOptions(p: PropDef): boolean {
	return p.kind === "select" || p.kind === "status";
}

/** Also accepts a value stored before the select switched between single and multiple. */
export function optionIds(v: Value | undefined | null): string[] {
	if (Array.isArray(v)) return v.map(String);
	return typeof v === "string" && v ? [v] : [];
}

/**
 * What to write when a property changes its kind. A status is single, never empty (its default or
 * the first option) and every option sits in a group; `fresh` is used if it has no options. Leaving
 * the status drops the groups. Values stay as they are.
 */
/** What a new status starts with: one option per group. */
export function defaultStatusOptions(t: T): OptionDef[] {
	return [
		{ id: shortId("st"), name: t("group.todo"), group: "todo", color: "gray" },
		{ id: shortId("st"), name: t("group.active"), group: "active", color: "amber" },
		{ id: shortId("st"), name: t("group.done"), group: "done", color: "green" },
	];
}

export function kindPatch(
	p: Pick<PropDef, "options" | "default">,
	kind: PropKind,
	fresh: OptionDef[] = [],
): Patch<Omit<PropDef, "id">> {
	if (kind === "status") {
		const options = (p.options?.length ? p.options : fresh).map((o) => ({
			...o,
			group: o.group ?? ("todo" as const),
		}));
		const keeps = p.default && options.some((o) => o.id === p.default);
		return { kind, multiple: null, options, default: keeps ? p.default : (options[0]?.id ?? null) };
	}
	if (kind === "select") return { kind, options: (p.options ?? []).map(({ group: _, ...o }) => o) };
	return { kind };
}

/** The status always gets one, even without a default. */
export function defaultOption(p: PropDef, schema?: TypeSchema): string | undefined {
	if (!isSingle(p)) return undefined;
	const d = p.default && p.options?.some((o) => o.id === p.default) ? p.default : undefined;
	return d ?? (p.kind === "status" ? p.options?.[0]?.id : undefined);
}

/** "Due date": lets "overdue" and "this week" work for any type. */
export function dueProp(schema?: TypeSchema): PropDef | undefined {
	const p = propById(schema, caps(schema).due);
	return p?.kind === "date" ? p : undefined;
}

function statusOptions(schema?: TypeSchema): OptionDef[] {
	return statusProp(schema)?.options ?? [];
}

export interface StatusValue {
	option: OptionDef;
	group: StatusGroup;
}

export function statusOf(item: Item, schema?: TypeSchema): StatusValue | undefined {
	const p = statusProp(schema);
	if (!p) return undefined;
	// no value (the status came later) or a removed option: the default, as in Notion
	const id = item.props[p.id];
	const option =
		p.options?.find((o) => o.id === id) ?? p.options?.find((o) => o.id === defaultOption(p));
	if (!option) return undefined;
	return { option, group: option.group ?? "todo" };
}

export function isDone(item: Item, schema?: TypeSchema): boolean {
	return statusOf(item, schema)?.group === "done";
}

/** "Erledigt am": when the status last entered the done group; undefined unless done. */
export function doneAt(item: Item, schema?: TypeSchema): number | undefined {
	return isDone(item, schema) ? item.doneAt : undefined;
}

/**
 * For the status this keeps meta.done in step: set to `at` when entering the done group, removed
 * when leaving it. Moving between two done options keeps the first date.
 */
export function writeProp(
	doc: Y.Doc,
	schema: TypeSchema | undefined,
	propId: string,
	value: Value | null | undefined,
	at = Date.now(),
) {
	const sp = statusProp(schema);
	if (!sp || sp.id !== propId) return setProp(doc, propId, value);
	const groupOf = (v: unknown) =>
		v == null ? undefined : (sp.options?.find((o) => o.id === v)?.group ?? "todo");
	const was = groupOf(doc.getMap("props").get(propId));
	setProp(doc, propId, value);
	const meta = metaMap(doc);
	if (groupOf(value) === "done") {
		if (was !== "done" || !meta.has("done")) meta.set("done", at);
	} else if (meta.has("done")) meta.delete("done");
}

/** Properties that block the item while set ("Blocked by", "Waiting for"). */
export function blockingProps(schema?: TypeSchema): PropDef[] {
	return (
		schema?.properties.filter((p) => p.blocks && (p.kind === "relation" || p.kind === "text")) ?? []
	);
}

/** The option a new card in a status group's column gets. */
export function firstOfGroup(
	schema: TypeSchema | undefined,
	group: StatusGroup,
): OptionDef | undefined {
	return statusOptions(schema).find((o) => (o.group ?? "todo") === group);
}

/** End of a date range. */
export function dueOf(item: Item, schema?: TypeSchema): string | undefined {
	const p = dueProp(schema);
	if (!p) return undefined;
	const v = item.props[p.id];
	return typeof v === "string" && v ? dateEnd(v) : undefined;
}

/** The first day of a date value or range, without its time. */
export function dateStart(v: string) {
	return dayOf(v.split("/")[0]!);
}
/** The last day of a date value or range, without its time. */
export function dateEnd(v: string) {
	return dayOf(v.split("/").at(-1)!);
}

export function hasUpdates(schema?: TypeSchema): boolean {
	return caps(schema).updates === true;
}

/** The type's progress: its first computed property "Fortschritt" (share of done descendants). */
export function progressProp(schema?: TypeSchema): PropDef | undefined {
	return schema?.properties.find(isProgressProp);
}

export function isProgressProp(p: PropDef): boolean {
	return p.kind === "computed" && p.computed?.fn !== "count";
}

/** What the progress counts: the bar in the page's head, `progress` in queries, a project's next task. */
export function progressSpec(schema?: TypeSchema): { of?: string } | undefined {
	const p = progressProp(schema);
	return p ? { of: p.computed?.of } : undefined;
}

export function template(
	schema?: TypeSchema,
): { body?: string; values?: Record<string, Value> } | undefined {
	return caps(schema).template;
}

/** Template values win over the selects' defaults. */
export function initialProps(schema?: TypeSchema): Record<string, Value> {
	const out: Record<string, Value> = { ...(template(schema)?.values ?? {}) };
	for (const p of schema?.properties ?? []) {
		const d = defaultOption(p, schema);
		if (d && out[p.id] === undefined) out[p.id] = d;
	}
	return out;
}

/** For computed properties: whether there is something to show. */
export function hasValue(
	item: Item,
	p: PropDef,
	ix: Pick<Index, "relValues" | "progress">,
): boolean {
	if (p.kind === "relation") return ix.relValues(item, p.id, p.symmetric).length > 0;
	if (p.kind === "computed")
		return p.computed?.fn === "count" || ix.progress(item.id, p.computed?.of).total > 0;
	const v = item.props[p.id];
	return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
}

/** Empty properties show (as a clickable "–"); computed ones only once they have a value. */
export function visibleProps(
	item: Item,
	schema: TypeSchema,
	ix: Pick<Index, "relValues" | "progress">,
): PropDef[] {
	return schema.properties.filter((p) => p.kind !== "computed" || hasValue(item, p, ix));
}
