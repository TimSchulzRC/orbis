// What a type can do. Behaviour hangs on these traits – never on a type id or name.
// Everything that reads capabilities goes through this module.
import type * as Y from "yjs";
import { type Capabilities, type Item, type OptionDef, type PropDef, type StatusGroup, type TypeSchema, type Value, metaMap, setCapability, setProp, upsertProp } from "./model";
import type { Index } from "./graph";

export function caps(schema?: TypeSchema): Capabilities {
  return schema?.capabilities ?? {};
}

function propById(schema: TypeSchema | undefined, id?: string): PropDef | undefined {
  return id ? schema?.properties.find((p) => p.id === id) : undefined;
}

/** The status property that drives ticking off, "open" in queries, boards and progress: a select with one value. */
export function statusProp(schema?: TypeSchema): PropDef | undefined {
  const p = propById(schema, caps(schema).status);
  return p?.kind === "select" && !p.multiple ? p : undefined;
}

export function isStatusProp(schema: TypeSchema | undefined, p: PropDef): boolean {
  return statusProp(schema)?.id === p.id;
}

/** A select with several values (once "Mehrfachauswahl"). */
export function isMulti(p: PropDef): boolean {
  return p.kind === "select" && !!p.multiple;
}

/** A select with one value. */
export function isSingle(p: PropDef): boolean {
  return p.kind === "select" && !p.multiple;
}

/** The chosen options of a select as a list – also a value from before the number of values changed. */
export function optionIds(v: Value | undefined | null): string[] {
  return Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : [];
}

/**
 * Make a select the type's status (one per type; the one before is a plain select again): one
 * value, never empty – its default stays or the first option is –, every option in a group.
 * `fresh`: options for a select that has none yet.
 */
export function useAsStatus(doc: Y.Doc, p: PropDef, fresh: OptionDef[] = []) {
  const options = (p.options?.length ? p.options : fresh).map((o) => ({ ...o, group: o.group ?? ("todo" as const) }));
  setCapability(doc, "status", p.id);
  upsertProp(doc, p.id, { kind: "select", multiple: null as any, options, default: p.default && options.some((o) => o.id === p.default) ? p.default : (options[0]?.id ?? (null as any)) });
}

/** The option new items get; a select with one is never empty. The status always has one. */
export function defaultOption(p: PropDef, schema?: TypeSchema): string | undefined {
  if (p.kind !== "select" || p.multiple) return undefined;
  const d = p.default && p.options?.some((o) => o.id === p.default) ? p.default : undefined;
  return d ?? (isStatusProp(schema, p) ? p.options?.[0]?.id : undefined);
}

/** "Termin": the date property marked as due date – "overdue" and "this week" work for any type. */
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
  const id = item.props[p.id];
  const option = p.options?.find((o) => o.id === id);
  if (!option) return undefined;
  return { option, group: option.group ?? "todo" };
}

export function isDone(item: Item, schema?: TypeSchema): boolean {
  return statusOf(item, schema)?.group === "done";
}

/** "Erledigt am": when the status last entered the group done (only while it is done). */
export function doneAt(item: Item, schema?: TypeSchema): number | undefined {
  return isDone(item, schema) ? item.doneAt : undefined;
}

/**
 * Write a property value. For the main status this keeps "erledigt am" (meta.done) in step:
 * set when the status enters the group done (at `at`, e.g. the date of an update), removed
 * when it leaves it. Moving between two done options keeps the first date.
 */
export function writeProp(doc: Y.Doc, schema: TypeSchema | undefined, propId: string, value: Value | null | undefined, at = Date.now()) {
  const sp = statusProp(schema);
  if (!sp || sp.id !== propId) return setProp(doc, propId, value);
  const groupOf = (v: unknown) => (v == null ? undefined : (sp.options?.find((o) => o.id === v)?.group ?? "todo"));
  const was = groupOf(doc.getMap("props").get(propId));
  setProp(doc, propId, value);
  const meta = metaMap(doc);
  if (groupOf(value) === "done") {
    if (was !== "done" || !meta.has("done")) meta.set("done", at);
  } else if (meta.has("done")) meta.delete("done");
}

/** The properties that hold an item up while set ("Blockiert durch", "Wartet auf" …): relations and texts marked so. */
export function blockingProps(schema?: TypeSchema): PropDef[] {
  return schema?.properties.filter((p) => p.blocks && (p.kind === "relation" || p.kind === "text")) ?? [];
}

/** First option of a group – what "tick off" sets. */
export function firstOfGroup(schema: TypeSchema | undefined, group: StatusGroup): OptionDef | undefined {
  return statusOptions(schema).find((o) => (o.group ?? "todo") === group);
}

/** ISO date the item is due (end of a range), if its type marks a due date. */
export function dueOf(item: Item, schema?: TypeSchema): string | undefined {
  const p = dueProp(schema);
  if (!p) return undefined;
  const v = item.props[p.id];
  return typeof v === "string" && v ? dateEnd(v) : undefined;
}

export function dateStart(v: string) {
  return v.split("/")[0]!;
}
export function dateEnd(v: string) {
  return v.split("/").at(-1)!;
}

export function hasUpdates(schema?: TypeSchema): boolean {
  return caps(schema).updates === true;
}

export function progressSpec(schema?: TypeSchema): { of?: string } | undefined {
  return caps(schema).progress;
}

export function template(schema?: TypeSchema): { body?: string; values?: Record<string, Value> } | undefined {
  return caps(schema).template;
}

/** Main action of a page: "+" creates a child of type X (e.g. project → task). */
export function primaryChild(schema?: TypeSchema): string | undefined {
  return caps(schema).primaryChild;
}

/** Initial values for a new item of this type: template values, else the selects' defaults. */
export function initialProps(schema?: TypeSchema): Record<string, Value> {
  const out: Record<string, Value> = { ...(template(schema)?.values ?? {}) };
  for (const p of schema?.properties ?? []) {
    const d = defaultOption(p, schema);
    if (d && out[p.id] === undefined) out[p.id] = d;
  }
  return out;
}

/** Has this property a value on the item? (Computed ones: something to show.) */
export function hasValue(item: Item, p: PropDef, ix: Pick<Index, "relValues" | "progress">): boolean {
  if (p.kind === "relation") return ix.relValues(item, p.id, p.symmetric).length > 0;
  if (p.kind === "computed") return p.computed?.fn === "count" ? true : ix.progress(item.id, p.computed?.of).total > 0;
  const v = item.props[p.id];
  return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
}

/**
 * Which properties a page shows: every property of the type – an empty one as a quiet "–" to
 * click –, computed ones only once they have something to show.
 */
export function visibleProps(item: Item, schema: TypeSchema, ix: Pick<Index, "relValues" | "progress">): PropDef[] {
  return schema.properties.filter((p) => p.kind !== "computed" || hasValue(item, p, ix));
}
