// What a type can do. Behaviour hangs on these traits – never on a type id or name.
// Everything that reads capabilities goes through this module.
import type * as Y from "yjs";
import { type Capabilities, type Item, type ItemInit, type OptionDef, type PropDef, type StatusGroup, type TypeSchema, type Value, setProp, titleKey } from "./model";
import { LANGS, translate } from "./i18n";
import type { Index } from "./graph";

export function caps(schema?: TypeSchema): Capabilities {
  return schema?.capabilities ?? {};
}

export function propById(schema: TypeSchema | undefined, id?: string): PropDef | undefined {
  return id ? schema?.properties.find((p) => p.id === id) : undefined;
}

/** The status property that drives ticking off, "open" in queries, boards and progress. */
export function statusProp(schema?: TypeSchema): PropDef | undefined {
  const p = propById(schema, caps(schema).status);
  return p?.kind === "status" ? p : undefined;
}

/** "Termin": the date property marked as due date – "overdue" and "this week" work for any type. */
export function dueProp(schema?: TypeSchema): PropDef | undefined {
  const p = propById(schema, caps(schema).due);
  return p?.kind === "date" ? p : undefined;
}

export function statusOptions(schema?: TypeSchema): OptionDef[] {
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
  const meta = doc.getMap<any>("meta");
  if (groupOf(value) === "done") {
    if (was !== "done" || !meta.has("done")) meta.set("done", at);
  } else if (meta.has("done")) meta.delete("done");
}

/** Property ids of the shipped "Blockiert durch" and "Wartet auf" (both count for "blockiert"). */
export const BLOCKED_BY = "p_blocked";
export const WAITING_FOR = "p_waiting";

/**
 * "Blockiert durch" (relation) and "Wartet auf" (text): the shipped property ids, or a
 * property with that name in either language – so any type can have them.
 */
export function blockingProps(schema?: TypeSchema): { by?: PropDef; waiting?: PropDef } {
  const names = (key: string) => new Set(LANGS.map((l) => titleKey(translate(l, key))));
  const byNames = names("setup.prop.blockedBy");
  const waitNames = names("setup.prop.waitingFor");
  const props = schema?.properties ?? [];
  return {
    by: props.find((p) => p.kind === "relation" && (p.id === BLOCKED_BY || byNames.has(titleKey(p.name)))),
    waiting: props.find((p) => p.kind === "text" && (p.id === WAITING_FOR || waitNames.has(titleKey(p.name)))),
  };
}

/** The priority: a select property called "Priorität"/"Priority" (options ordered high → low). */
export function priorityProp(schema?: TypeSchema): PropDef | undefined {
  const names = new Set(LANGS.map((l) => titleKey(translate(l, "setup.prop.priority"))));
  return schema?.properties.find((p) => p.kind === "select" && (p.id === "p_priority" || names.has(titleKey(p.name))));
}

/** The language of an entry: a select property called "Sprache"/"Language"; its options name the languages. */
export function languageProp(schema?: TypeSchema): PropDef | undefined {
  const names = new Set(LANGS.map((l) => titleKey(translate(l, "setup.prop.language"))));
  return schema?.properties.find((p) => p.kind === "select" && !p.removed && names.has(titleKey(p.name)));
}

export function languageOf(item: Item, schema?: TypeSchema): string | undefined {
  const p = languageProp(schema);
  const v = p ? item.props[p.id] : undefined;
  return p?.options?.find((o) => o.id === v)?.name;
}

/** "Deutsch" → "DE", "en" → "EN": what the switch shows (the full name is its tooltip). */
export function languageCode(name: string): string {
  const n = name.trim();
  return (n.length <= 3 ? n : n.slice(0, 2)).toUpperCase();
}

/**
 * The versions of an entry in other languages: entries linked through a symmetric relation
 * ("Übersetzung") that have a language. The entry itself included, in a fixed order (by
 * language), so the switch looks the same on every version; empty if there are none.
 */
export function translations(item: Item, ix: Pick<Index, "get" | "schemaOf" | "relValues">): { item: Item; lang: string }[] {
  const schema = ix.schemaOf(item);
  const own = languageOf(item, schema);
  if (!own) return [];
  const out: { item: Item; lang: string }[] = [];
  for (const p of schema?.properties ?? []) {
    if (p.kind !== "relation" || !p.symmetric || p.removed) continue;
    for (const id of ix.relValues(item, p.id, true)) {
      const other = ix.get(id);
      const lang = other && languageOf(other, ix.schemaOf(other));
      if (other && lang && !out.some((x) => x.item.id === id)) out.push({ item: other, lang });
    }
  }
  if (!out.length) return [];
  return [{ item, lang: own }, ...out].sort((a, b) => languageCode(a.lang).localeCompare(languageCode(b.lang)) || a.item.title.localeCompare(b.item.title));
}

/**
 * A new language version can be made when the type has a language and a symmetric relation
 * (the translation). `missing`: the languages that have no version yet.
 */
export function translationPlan(item: Item, ix: Pick<Index, "get" | "schemaOf" | "relValues">): { language: PropDef; relation: PropDef; missing: OptionDef[] } | undefined {
  const schema = ix.schemaOf(item);
  const language = languageProp(schema);
  const relation = schema?.properties.find((p) => p.kind === "relation" && p.symmetric && !p.removed);
  if (!language || !relation) return undefined;
  const have = new Set([String(item.props[language.id] ?? ""), ...translations(item, ix).map((v) => String(v.item.props[language.id] ?? ""))]);
  const missing = (language.options ?? []).filter((o) => !have.has(o.id));
  return missing.length ? { language, relation, missing } : undefined;
}

/** The new version: same type and places, the other language, linked as translation. */
export function translationInit(item: Item, ix: Pick<Index, "get" | "schemaOf" | "relValues" | "parentsOf" | "home">, optionId: string): ItemInit | undefined {
  const plan = translationPlan(item, ix);
  const option = plan?.missing.find((o) => o.id === optionId);
  if (!plan || !option) return undefined;
  const home = ix.home(item.id);
  const parents = ix.parentsOf(item.id).sort((a, b) => (a === home ? -1 : b === home ? 1 : 0)); // the home stays the home
  return {
    type: item.type,
    title: `${item.title} (${languageCode(option.name)})`,
    parents,
    props: { [plan.language.id]: option.id },
    rels: { [plan.relation.id]: [item.id] },
  };
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

/** Initial values for a new item of this type: template values, else first status option. */
export function initialProps(schema?: TypeSchema): Record<string, Value> {
  const out: Record<string, Value> = { ...(template(schema)?.values ?? {}) };
  const sp = statusProp(schema);
  if (sp && out[sp.id] === undefined && sp.options?.[0]) out[sp.id] = sp.options[0].id;
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
 * click – except those marked "only when set" (hideEmpty) and computed ones without anything to
 * show. Those wait behind "+ Eigenschaft" (see AddField) until they have a value or are opened.
 */
export function visibleProps(item: Item, schema: TypeSchema, ix: Pick<Index, "relValues" | "progress">, opened: Set<string> = new Set()): PropDef[] {
  return schema.properties.filter((p) => (p.kind !== "computed" && !p.hideEmpty) || opened.has(p.id) || hasValue(item, p, ix));
}
