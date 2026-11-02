// Operations behind the MCP tools. No type is special in code: agents read the schema and work
// through names. The web app does not use this; it edits its replica directly.
import * as Y from "yjs";
import {
  type ViewTab,
  type Item,
  type OptionDef,
  type Patch,
  type PropDef,
  type PropKind,
  type TypeItem,
  type StatusGroup,
  type TypeSchema,
  type Value,
  META_TYPE,
  addParent,
  appendUpdate,
  fileTypeOf,
  initItem,
  displayTitle,
  initType,
  optionNames,
  renameLinksIn,
  mimeOf,
  newId,
  parseWikiLinks,
  removeParent,
  replaceBody,
  setCapability,
  setExtra,
  setFileMeta,
  setHome,
  setMember,
  setMeta,
  setProp,
  setRel,
  setSchemaField,
  setTabs,
  shortId,
  titleKey,
  todayISO,
  touch,
  upsertProp,
} from "@obtion/core/model";
import type { Index } from "@obtion/core/graph";
import { blocksAsText, matches, normalizeBlocks, parseQuery, printQuery, runQuery, relDate, tabDef, typesIn, type Cond, type QueryDef } from "@obtion/core/query";
import { inboxWhere } from "@obtion/core/inbox";
import { isInInbox, isOverview } from "@obtion/core/placement";
import { caps, doneAt, dueOf, dueProp, firstOfGroup, hasUpdates, initialProps, statusOf, statusProp, template, useAsStatus, writeProp } from "@obtion/core/traits";
import { previewTagToType, typeUsage } from "@obtion/core/typeops";
import { searchIds, snippet } from "@obtion/core/search";
import { keyBetween, nextPinKey } from "@obtion/core/sortkey";
import { DAY_MS, dateOf } from "@obtion/core/date";
import { freshColor } from "@obtion/core/palette";
import { DATE_HELP, InputError, matchOption, parseDate, parseNumber, statusGroupOf } from "@obtion/core/input";
import { type Writer, typeTabs } from "@obtion/core/setup";
import { deleteItem, onlyBelow, restoreItem } from "@obtion/core/trash";
import { fromB64 } from "@obtion/core/protocol";
import type { Store } from "./store";
import { type Blobs, sha256 } from "./blobs";
import { MAX_ATTACH } from "./config";
import type { AttachInput, CapInput, ConvertInput, CreateInput, DefineTypeInput, PlaceInput, PropInput, SuggestInput, UpdateInput, UpdateTypeInput, ViewInput } from "./schemas";
import { originText, parseOrigin } from "@obtion/core/origin";
import { createHash } from "node:crypto";
import { textDiff, unifiedDiff } from "@obtion/core/diff";
import type { ActivityEvent, FieldChange } from "@obtion/core/protocol";
import type { TextVersion } from "@obtion/core/api";

export interface ActivityOpts {
  /** an ISO time, an entry id or the cursor of the last call: the entries changed after it */
  since?: string;
  days?: number;
  ref?: string;
  under?: string;
  by?: string;
  limit?: number;
  /** text changes as diffs (default true) */
  diff?: boolean;
}

/** Diff lines per entry and per answer in the activity: the rest via the history tool. */
const DIFF_LINES = 40;
const DIFF_BUDGET = 400;

/** A value in a change, short: strings quoted, long ones cut. */
function short(x: unknown, max = 120): string {
  const s = typeof x === "string" ? x : JSON.stringify(x);
  return typeof x === "string" ? `"${s.length > max ? s.slice(0, max - 1) + "…" : s}"` : s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Who an activity filter means: "people" (in the app), "agents", "imports", "others" (anyone
 * but the caller), or a name – a person's own edits ("Tim"), an agent ("claude-code") or an
 * agent for a person ("claude-code for Tim"). Several with commas.
 */
export function byFilter(by: string, me: string): (origin: string) => boolean {
  const mine = parseOrigin(me);
  const sameAs = (o: string) => {
    const a = parseOrigin(o);
    return a.kind === mine.kind && a.name === mine.name && (a.person?.id ?? a.person?.name) === (mine.person?.id ?? mine.person?.name);
  };
  const tests = by
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .map((w): ((o: string) => boolean) => {
      if (["people", "persons", "humans", "person", "menschen", "personen"].includes(w)) return (o) => parseOrigin(o).kind === "web";
      if (["agents", "agent"].includes(w)) return (o) => parseOrigin(o).kind === "agent";
      if (["imports", "import"].includes(w)) return (o) => parseOrigin(o).kind === "import";
      if (["others", "andere"].includes(w)) return (o) => !sameAs(o);
      return (o) => {
        const a = parseOrigin(o);
        return (a.kind === "web" && a.name.toLowerCase() === w) || (a.kind === "agent" && a.name.toLowerCase() === w) || originText(o).toLowerCase() === w;
      };
    });
  // an entry can carry several origins ("web:…, agent:…"): it matches if one of them does
  return (origin) => origin.split(",").some((o) => tests.some((t) => t(o.trim())));
}

export class OpError extends Error {}

/** Objects with sorted keys, so the same content always serializes the same way. */
const canonical = (x: unknown): unknown =>
  Array.isArray(x) ? x.map(canonical) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonical((x as Record<string, unknown>)[k])])) : x;

/**
 * Version of what `update` can overwrite: title, type, body, properties, relations, tags, refs.
 * Places, pins, dated updates and timestamps are left out, so moving an item does not make a read
 * copy stale. `update` takes it as base_version.
 */
export function versionOf(i: Item): string {
  const content = canonical([i.title, i.type, i.body, i.props, i.rels, i.extra, i.tags, i.refs]);
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 12);
}

export const QUERY_HELP =
  "type:Name #tag under:[[X]] in:[[X]] linked:[[X]] linked:under:[[X]] status:open|new|active|done (open = new or active) property:value property<value property:empty without:type|parents|children|usage pinned inbox blocked dormant (it or something above it paused or done) file filetype:image|pdf; space=AND, |=OR, -=NOT, (…); sort:field group:path|status|type limit:n. German keywords work too.";

/** Characters that end or split a [[link]] target: such titles can't be linked by title. */
const UNLINKABLE = /[#|[\]^]/;
const UNLINKABLE_ALL = /[#|[\]^]/g;
const isDoneNow = (i: Item, schema: TypeSchema | undefined) => statusOf(i, schema)?.group === "done";
/** An option given as "Name (group)" or "Name (group, state)". */
const OPTION_GROUP = /\((todo|active|done)(?:,\s*(paused|dropped))?\)\s*$/;
const OPTION_PARTS = /^(.*?)(?:\s*\((todo|active|done)(?:,\s*(paused|dropped))?\))?$/;
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** What an untyped item is, by its place. */
const placeKind = (i: Item, ix: Index) => (isInInbox(i, ix) ? "inbox" : isOverview(i, ix) ? "overview" : "note");

/** An option name ("Pausiert") wins over the group it belongs to. */
function optionNamed(p: PropDef, name: string): OptionDef | undefined {
  try {
    return matchOption(p, name);
  } catch (e) {
    if (e instanceof InputError) return undefined;
    throw e;
  }
}

/** Joins new text to a body the way body_mode says. */
function joinBody(current: string, text: string, mode: UpdateInput["body_mode"] = "replace"): string {
  if (mode === "append") return (current.trimEnd() ? current.trimEnd() + "\n\n" : "") + text;
  if (mode === "prepend") return text + (current ? "\n\n" + current : "");
  return text;
}

/** "start/end", either side may be empty. Tries every slash, since a date itself may contain one. */
function splitRange(s: string, today: string): string | undefined {
  for (let i = s.indexOf("/"); i >= 0; i = s.indexOf("/", i + 1)) {
    const a = s.slice(0, i).trim();
    const b = s.slice(i + 1).trim();
    const da = a ? parseDate(a, today) : "";
    const db = b ? parseDate(b, today) : "";
    if (da !== undefined && db !== undefined && (da || db)) return `${da}/${db}`;
  }
  return undefined;
}

/** A relation value outside the property's target is kept, with a hint (like the app's ⚠). */
function offTargetHints(ix: Index, now: Item, prev: Item | undefined, schema: TypeSchema | undefined): string[] {
  const hints: string[] = [];
  for (const p of schema?.properties ?? []) {
    if (p.kind !== "relation" || !p.target || p.removed) continue;
    const added = (now.rels[p.id] ?? []).filter((r) => !(prev?.rels[p.id] ?? []).includes(r));
    if (!added.length) continue;
    const where = parseQuery(p.target, ix).def.where;
    const off = where ? added.map((r) => ix.get(r)).filter((x): x is Item => !!x && !matches(x, where, { ix, thisId: now.id })) : [];
    if (off.length) hints.push(`"${p.name}" of "${now.title}" is meant for ${p.target}; ${off.map((x) => `"${x.title}"`).join(", ")} ${off.length > 1 ? "don't" : "doesn't"} match. Saved anyway.`);
  }
  return hints;
}

/** For an item just marked done: the open items still below it. */
function openBelowHint(ix: Index, done: Item): string | undefined {
  const open = ix.items(ix.descendants(done.id)).filter((d) => {
    const s = statusOf(d, ix.schemaOf(d));
    return s && s.group !== "done";
  });
  if (!open.length) return undefined;
  return `"${done.title}" is marked done, but ${open.length} open item(s) are below it: ${open.slice(0, 5).map((x) => `"${x.title}"`).join(", ")}${open.length > 5 ? " …" : ""}.`;
}

export class Ops {
  constructor(
    private store: Store,
    private blobs?: Blobs,
  ) {}

  get ix(): Index {
    this.store.flush(); // tools always see edits that arrived moments ago
    return this.store.index();
  }

  private writer(origin: string): Writer {
    return { change: (id, fn) => this.store.change(id, origin, fn), get: (id) => this.store.records.get(id) };
  }

  /** By id, exact title or unique partial title. Ambiguity throws with candidates instead of guessing. */
  resolve(ref: string, opts: { files?: boolean } = {}): Item {
    const ix = this.ix;
    const r = ref.trim().replace(/^\[\[|\]\]$/g, "");
    const direct = ix.get(r);
    if (direct) return direct;
    const pool = ix.live.filter((i) => i.type !== META_TYPE && (opts.files !== false || i.kind !== "datei"));
    const key = titleKey(r);
    const exact = pool.filter((i) => titleKey(i.title) === key || titleKey(i.file?.name ?? "") === key);
    if (exact.length === 1) return exact[0]!;
    const candidates = (items: Item[]) => items.map((i) => `- ${this.label(i)} (id ${i.id})`).join("\n");
    if (exact.length > 1) throw new OpError(`Several items are titled "${r}". Use an id:\n` + candidates(exact));
    const contains = pool.filter((i) => titleKey(i.title).includes(key));
    if (contains.length === 1) return contains[0]!;
    const sugg = (contains.length ? contains : ix.items(searchIds(this.store.searchIndex, r, 8))).slice(0, 8);
    if (!sugg.length) throw new OpError(`Nothing matches "${r}".`);
    throw new OpError(`${contains.length ? `"${r}" matches several items` : `No item is titled "${r}"`}. Use one of these ids:\n` + candidates(sugg));
  }

  /** Refuses types: they change only through update_type and are deleted only in the app. */
  private target(ref: string, action: string): Item {
    const item = this.resolve(ref);
    if (item.type === META_TYPE)
      throw new OpError(
        action === "delete"
          ? `"${item.title}" is a type. Types are not deleted with delete: call update_type with delete_preview to see what it would affect; deleting is confirmed in the app (type page › … › Delete type), where values stay as free properties.`
          : `"${item.title}" is a type. Change types with update_type, not with ${action}.`,
      );
    return item;
  }

  resolveType(ref: string): TypeItem {
    const ix = this.ix;
    const t = ix.types.get(ref) ?? ix.types.get(ix.typeByName(ref) ?? "");
    if (!t) throw new OpError(`Unknown type "${ref}". Types: ${[...ix.types.values()].map((x) => x.schema.name).join(", ") || "none"}. Use schema, or define_type.`);
    return t;
  }

  label(i: Item) {
    const ix = this.store.index();
    const kind = i.kind === "datei" ? "file" : (ix.typeName(i.type) ?? placeKind(i, ix));
    return `${displayTitle(i) || "(untitled)"} [${kind}]`;
  }

  schema() {
    const ix = this.ix;
    return {
      ui_language: this.store.lang(),
      today: todayISO(),
      types: [...ix.types.values()].map((t) => this.typeInfo(t)),
      inbox: { query: printQuery({ where: inboxWhere(ix) }, this.store.lang(), ix) },
      notes: [
        "Items without a type, without a parent and not pinned are in the inbox (its query, see inbox.query, decides).",
        "Every type has its page: a list of its entries with views as tabs (see views; change them with update_type).",
        "Any item with children is an overview (not a type). Belonging comes from children (part of); [[links]] are only mentions.",
        "Pinned items form the top of the sidebar and count as a place.",
        "Property values are given by property name; options by name; relations by title or id.",
      ],
    };
  }

  typeInfo(t: TypeItem) {
    const s = t.schema;
    const c = caps(s);
    const name = (pid?: string) => s.properties.find((p) => p.id === pid)?.name;
    return {
      id: t.id,
      name: s.name,
      description: s.description || undefined,
      properties: s.properties.map((p) => this.propInfo(p)),
      capabilities: {
        status: name(c.status) ? `"${name(c.status)}" (tick off, status:open/done in queries)` : undefined,
        due_date: name(c.due) ? `"${name(c.due)}" (overdue / this week)` : undefined,
        progress: c.progress ? `share of done descendants${c.progress.of ? ` of type ${this.store.index().typeName(c.progress.of) ?? "(deleted)"}` : " with a status"}` : undefined,
        updates: c.updates ? "dated progress notes via add_update" : undefined,
        main_action: c.primaryChild ? `"+" on its page creates a ${this.store.index().typeName(c.primaryChild) ?? "(deleted type)"}` : undefined,
      },
      entries: this.store.index().itemsOfType(t.id).length,
      list: this.store.index().typePlural(t.id),
      views: typeTabs(t, this.store.lang()).map((v) => this.viewInfo(v)),
    };
  }

  propInfo(p: PropDef) {
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      description: p.description || undefined,
      options: p.options?.map((o) => (o.group ? `${o.name} (${o.group}${o.state ? `, ${o.state}` : ""})` : o.name)),
      multiple: p.multiple || undefined,
      default: p.default ? p.options?.find((o) => o.id === p.default)?.name : undefined,
      target: p.target || undefined,
      inverse: p.inverseName || undefined,
      symmetric: p.symmetric || undefined,
      hide_empty: p.hideEmpty || undefined,
      blocks: p.blocks || undefined,
      range: p.range || undefined,
      computed: p.computed ? `${p.computed.fn}${p.computed.of ? ` of ${this.store.index().typeName(p.computed.of)}` : ""}` : undefined,
    };
  }

  propValues(i: Item): Record<string, unknown> {
    const ix = this.store.index();
    const s = ix.schemaOf(i);
    const out: Record<string, unknown> = {};
    for (const p of s?.properties ?? []) {
      const v = i.props[p.id];
      if (p.kind === "relation") {
        const ids = ix.relValues(i, p.id, p.symmetric);
        if (ids.length) out[p.name] = ids.map((id) => ix.get(id)?.title);
      } else if (p.kind === "computed") {
        const pr = p.computed?.fn === "count" ? ix.countDescendants(i.id, p.computed.of) : ix.progress(i.id, p.computed?.of);
        out[p.name] = typeof pr === "number" ? pr : `${pr.done}/${pr.total}`;
      } else if (v !== undefined) {
        out[p.name] = p.options ? optionNames(p, v).join(", ") : v;
      }
    }
    return out;
  }

  brief(i: Item, base?: string) {
    const ix = this.store.index();
    const out: Record<string, unknown> = { id: i.id, title: i.title };
    const tn = ix.typeName(i.type);
    if (i.kind === "datei") out.file = `${i.file?.filetype} ${i.file?.name}`;
    else if (tn) out.type = tn;
    else out.kind = placeKind(i, ix);
    if (i.pinned) out.pinned = true;
    const st = statusOf(i, ix.schemaOf(i));
    if (st) out.status = `${st.option.name} (${st.group})`;
    const due = dueOf(i, ix.schemaOf(i));
    if (due) out.due = due;
    const path = base ? ix.relPath(base, i.id) : ix.homePath(i.id);
    if (path?.length) out.path = ix.pathText(path);
    if (i.tags.length) out.tags = i.tags;
    return out;
  }

  /** Tool answer format: Title [id] · Type · Status (group) · due … · Path › Home · ⚠ blocked by "X" */
  line(i: Item, base?: string): string {
    const ix = this.store.index();
    const schema = ix.schemaOf(i);
    const parts = [`${displayTitle(i) || "(untitled)"} [${i.id}]`];
    const tn = ix.typeName(i.type);
    parts.push(i.kind === "datei" ? `file ${i.file?.filetype ?? ""}`.trim() : (tn ?? placeKind(i, ix)));
    if (i.pinned) parts.push("pinned");
    const st = statusOf(i, schema);
    if (st) parts.push(`${st.option.name} (${st.group})`);
    const due = dueOf(i, schema);
    if (due && st?.group !== "done") parts.push(`due ${due}`);
    const done = doneAt(i, schema);
    if (done) parts.push(`done ${dateOf(done)}`);
    const pr = ix.progressOf(i);
    if (pr?.total) parts.push(`${pr.done}/${pr.total} done`);
    const path = base ? ix.relPath(base, i.id) : ix.homePath(i.id);
    if (path?.length) parts.push(ix.pathText(path));
    const b = ix.blockers(i);
    if (b.by.length) parts.push(`⚠ blocked by ${b.by.map((x) => `"${x.title}"`).join(", ")}`);
    if (b.waiting) parts.push(`⚠ waiting for "${b.waiting}"`);
    return parts.join(" · ");
  }

  lines(items: Item[], base?: string): string {
    return items.map((i) => "- " + this.line(i, base)).join("\n");
  }

  /** The answer of a writing tool: one line per entry, with its version (base_version for the next update). */
  written(items: Item[]): string {
    return items.map((i) => `- ${this.line(i)} · version ${versionOf(i)}`).join("\n");
  }

  /**
   * All or nothing, plus hints: unresolved [[links]], duplicate or unlinkable titles, done with
   * open items below, newly unblocked items.
   */
  call(origin: string, fn: () => string): string {
    return this.store.step(origin, (step) => {
      const out = this.callInStep(fn);
      return this.store.db.query("SELECT 1 FROM updates WHERE step = ? LIMIT 1").get(step) ? `${out}\n(step ${step} – undo it with the undo tool)` : out;
    });
  }

  private callInStep(fn: () => string): string {
    this.store.flush();
    const before = new Map(this.store.records);
    const ix0 = this.store.index();
    const blockedBefore = new Set(ix0.live.filter((i) => ix0.isBlocked(i)).map((i) => i.id));
    const out = this.store.atomic(fn);
    const ix = this.store.index();
    const hints: string[] = [];
    const unblocked: string[] = [];
    for (const [id, now] of this.store.records) {
      const prev = before.get(id);
      if (prev === now || !ix.get(id) || now.kind !== "info") continue;
      const missing = ix.missingLinks(now).filter((t) => !prev || !ix0.missingLinks(prev).includes(t));
      for (const t of [...new Set(missing)]) hints.push(`[[${t}]] in "${now.title}" does not match any item (yet).`);
      if (!prev || prev.title !== now.title) {
        const same = ix.live.filter((x) => x.id !== id && x.type !== META_TYPE && titleKey(x.title) === titleKey(now.title));
        if (now.title.trim() && same.length) hints.push(`Another item is also called "${now.title}" [${same[0]!.id}]: [[${now.title}]] links become ambiguous. Link exactly with [[id|Label]].`);
        if (UNLINKABLE.test(now.title)) hints.push(`"${now.title}" contains # | [ ] or ^ and can't be linked by title; link it as [[${id}|${now.title.replace(UNLINKABLE_ALL, " ").replace(/\s+/g, " ").trim()}]].`);
      }
      const schema = ix.schemaOf(now);
      hints.push(...offTargetHints(ix, now, prev, schema));
      if (isDoneNow(now, schema) && !(prev && isDoneNow(prev, ix0.schemaOf(prev)))) {
        const hint = openBelowHint(ix, now);
        if (hint) hints.push(hint);
      }
    }
    for (const id of blockedBefore) {
      const i = ix.get(id);
      if (i && !ix.isBlocked(i)) unblocked.push(`"${i.title}"`);
    }
    if (unblocked.length) hints.push(`No longer blocked: ${unblocked.join(", ")}.`);
    return hints.length ? `${out}\n\nHints:\n${hints.map((h) => "- " + h).join("\n")}` : out;
  }

  /** With `redo`, the step whose undo happened last. */
  lastStep(actor: string, redo: boolean): string {
    if (redo) {
      const undos = this.store.db.query("SELECT s.id, s.undoes FROM steps s JOIN steps t ON t.id = s.undoes WHERE t.actor = ? AND t.undoes IS NULL ORDER BY s.ts DESC, s.rowid DESC LIMIT 50").all(actor) as { id: string; undoes: string }[];
      const hit = undos.find((u) => this.store.activeUndo(u.undoes) === u.id);
      if (!hit) throw new OpError("Nothing of yours is undone.");
      return hit.undoes;
    }
    const rows = this.store.db.query("SELECT id FROM steps WHERE actor = ? AND undoes IS NULL ORDER BY ts DESC, rowid DESC LIMIT 50").all(actor) as { id: string }[];
    const hit = rows.find((r) => !this.store.activeUndo(r.id));
    if (!hit) throw new OpError("You have no step to undo.");
    return hit.id;
  }

  get(ref: string, includeBody = true) {
    const i = this.resolve(ref);
    const ix = this.store.index();
    const out: Record<string, unknown> = { ...this.brief(i), version: versionOf(i) };
    delete out.path;
    const parents = ix.parentsOf(i.id);
    if (parents.length) out.part_of = parents.map((p) => `${ix.get(p)?.title}${p === ix.home(i.id) && parents.length > 1 ? " (home)" : ""}`);
    out.path = ix.pathText(ix.homePath(i.id)) || undefined;
    const props = this.propValues(i);
    if (Object.keys(props).length) out.properties = props;
    if (Object.keys(i.extra).length) out.free_properties = Object.fromEntries(Object.entries(i.extra).map(([k, v]) => [k, v.v]));
    const pr = ix.progressOf(i);
    if (pr) out.progress = `${pr.done}/${pr.total} done`;
    const done = doneAt(i, ix.schemaOf(i));
    if (done) out.done = dateOf(done);
    const b = ix.blockers(i);
    if (b.by.length) out.blocked_by = b.by.map((x) => `${x.title} [${x.id}]`);
    if (b.waiting) out.waiting_for = b.waiting;
    if (i.file) {
      const f = i.file;
      out.file = { name: f.name, filetype: f.filetype, size: f.size, pages: f.pages, width: f.width, height: f.height, duration: f.duration };
      out.used_in = ix.usedIn(i.id).map((b) => `${ix.get(b.from)?.title} (${b.kind})`);
      if (f.text) out.text = f.text.slice(0, 20000);
    }
    const refs = [...new Set([...ix.textLinks(i).map((l) => l.to), ...i.refs])].map((x) => ix.get(x)?.title).filter(Boolean);
    if (refs.length) out.refs = refs;
    const back = ix.backlinks(i.id).filter((b) => b.kind !== "rel");
    if (back.length) out.linked_from = [...new Set(back.map((b) => ix.get(b.from)?.title))];
    const inverse = ix.backlinks(i.id).filter((b) => b.kind === "rel");
    if (inverse.length)
      out.related_by = inverse.map((b) => {
        const from = ix.get(b.from)!;
        const p = ix.schemaOf(from)?.properties.find((x) => x.id === b.prop);
        return `${p?.inverseName || p?.name}: ${from.title}`;
      });
    const kids = ix.childrenOf(i.id).map((c) => ix.get(c)!);
    if (kids.length) out.children = kids.slice(0, 60).map((c) => this.brief(c, i.id));
    const desc = [...ix.descendants(i.id)].length;
    if (desc > kids.length) out.descendants_total = desc;
    if (i.updates.length) out.updates = i.updates.slice(-15).map((u) => ({ at: new Date(u.at).toISOString().slice(0, 16), by: u.by, text: u.text }));
    if (includeBody && i.body) out.body = blocksAsText(i.body, this.store.lang(), ix);
    if (i.suggestion) out.suggestion = i.suggestion;
    out.created = dateOf(i.created);
    out.updated = new Date(i.updated).toISOString().slice(0, 16);
    return out;
  }

  /** `q` may also be a type name: its list as its first view shows it. */
  query(q: string, opts: { context?: string; limit?: number } = {}) {
    const ix = this.ix;
    const typeId = ix.typeByName(q.trim().replace(/^\[\[|\]\]$/g, ""));
    let def: QueryDef;
    if (typeId) def = tabDef({ type: typeId }, typeTabs(ix.types.get(typeId)!, this.store.lang())[0]!);
    else {
      const p = parseQuery(q, ix);
      if (p.errors.length) throw new OpError(`Query not understood: ${p.errors.join(", ")}. Syntax: ${QUERY_HELP}`);
      def = p.def;
    }
    const thisId = opts.context ? this.resolve(opts.context).id : undefined;
    const res = runQuery(def, { ix, thisId });
    return {
      query: printQuery(def, this.store.lang(), ix),
      list: typeId ? ix.typePlural(typeId) : undefined,
      total: res.total,
      missing_types: res.missingTypes.length ? res.missingTypes : undefined,
      base: thisId,
      items: res.items.slice(0, opts.limit ?? def.limit ?? 60),
    };
  }

  search(q: string, limit = 15) {
    const ix = this.ix;
    const ids = q.trim() ? searchIds(this.store.searchIndex, q, 100) : ix.live.sort((a, b) => b.updated - a.updated).map((i) => i.id);
    return ids
      .map((id) => ix.get(id))
      .filter((i): i is Item => !!i && i.type !== META_TYPE)
      .slice(0, limit)
      .map((i) => ({ item: i, snippet: q.trim() ? snippet(i.body || i.file?.text || "", q) || undefined : undefined }));
  }

  /** Mirrors the focus section of the start page. */
  focus() {
    const ix = this.ix;
    const today = todayISO();
    const in7 = relDate("+7d", today)!;
    // nothing from paused or finished projects in the urgent lists
    const withDue = ix.live.map((i) => ({ i, due: dueOf(i, ix.schemaOf(i)), st: statusOf(i, ix.schemaOf(i)) })).filter((x) => x.st?.group !== "done" && !(x.due && ix.isDormant(x.i)));
    return {
      today,
      overdue: withDue.filter((x) => x.due && x.due < today).map((x) => this.line(x.i)),
      due_next_7_days: withDue.filter((x) => x.due && x.due >= today && x.due <= in7).map((x) => this.line(x.i)),
      active: ix.live.filter((i) => statusOf(i, ix.schemaOf(i))?.group === "active" && !dueProp(ix.schemaOf(i)) && !ix.isDormant(i)).map((i) => {
        const next = ix.nextTask(i.id, today);
        return this.line(i) + (next ? ` · next: “${next.title}”` : "") + (i.updates.length ? ` · last update: “${i.updates.at(-1)!.text}”` : "");
      }),
      blocked: ix.live.filter((i) => statusOf(i, ix.schemaOf(i))?.group !== "done" && ix.isBlocked(i)).map((i) => this.line(i)),
      inbox: runQuery({ where: { inbox: true } }, { ix }).total,
      changed_by_people_last_3_days: this.peopleChanged(),
      recent_activity: this.activityFeed({ days: 3, limit: 10 }).entries.map((e) => `${this.entryHead(e)}${e.changes.length ? ": " + this.changeTexts(e).join("; ") : ""}`),
    };
  }

  // ---------- activity and history ----------

  /** Items people changed by hand in the app lately (what an agent should look at first), with the way to see how. */
  private peopleChanged(): string | undefined {
    const { entries } = this.activityFeed({ days: 3, by: "people", limit: 200 });
    const titles = [...new Set(entries.filter((e) => e.doc).map((e) => `"${this.store.records.get(e.doc)?.title || e.title}"`))];
    if (!titles.length) return undefined;
    return `${titles.slice(0, 15).join(", ")}${titles.length > 15 ? ` and ${titles.length - 15} more` : ""} – see what changed with activity days=3 by="people"`;
  }

  /**
   * Activity entries, newest first – or, with `since` (an ISO time or the cursor of the last
   * call), the entries changed after it, oldest first, and the cursor to pass next time.
   * `under`: an item and everything below it ("part of"), deleted items included; `by`: who.
   */
  activityFeed(opts: ActivityOpts, me = ""): { entries: ActivityEvent[]; cursor: string; more: boolean } {
    const now = Date.now();
    this.ix; // flushed: entries for edits that arrived moments ago are written
    const docs = opts.under ? [...this.subtree(this.anyItem(opts.under).id)] : opts.ref ? [this.anyItem(opts.ref).id] : undefined;
    const match = opts.by ? byFilter(opts.by, me) : () => true;
    const after = opts.since !== undefined ? this.feedPosition(opts.since) : undefined;
    const limit = opts.limit ?? (after ? 100 : 40);
    const entries: ActivityEvent[] = [];
    let more = false;
    const PAGE = 200;
    let pos = after;
    let before: number | undefined;
    const since = after ? undefined : now - (opts.days ?? 7) * DAY_MS;
    while (!more) {
      const page = this.store.events({ after: pos, since, before, docs, limit: PAGE });
      for (const e of page) {
        if (pos) pos = { ts: e.ts, id: e.id };
        else before = e.id;
        if (!match(e.origin)) continue;
        if (entries.length === limit) {
          more = true;
          break;
        }
        entries.push(e);
      }
      if (page.length < PAGE) break;
    }
    // more to come: on from the last entry given; else from now (an entry changed later moves past it)
    const last = entries.at(-1);
    const cursor = more && after && last ? `${last.ts}-${last.id}` : `${now}-0`;
    return { entries, cursor, more };
  }

  /** `since` as a feed position: a cursor ("<time>-<id>"), an entry id, or a date/time. */
  private feedPosition(since: string): { ts: number; id: number } {
    const s = since.trim();
    const cur = /^(\d+)-(\d+)$/.exec(s);
    if (cur) return { ts: Number(cur[1]), id: Number(cur[2]) };
    if (/^\d+$/.test(s)) {
      const row = this.store.db.query("SELECT ts FROM events WHERE id = ?").get(Number(s)) as { ts: number } | null;
      if (!row) throw new OpError(`No activity entry has the id ${s}. since takes the cursor of the last call, an entry id or an ISO time.`);
      return { ts: row.ts, id: Number(s) };
    }
    const t = Date.parse(s);
    if (isNaN(t)) throw new OpError(`since "${since}" is neither a cursor nor a time. Use the cursor of the last call or an ISO time like 2026-11-01T08:00.`);
    return { ts: t, id: 0 };
  }

  /** An item and everything below it over all parents, deleted items included (their removal is a change too). */
  private subtree(root: string): Set<string> {
    const kids = new Map<string, string[]>();
    for (const r of this.store.records.values()) for (const p of Object.keys(r.parents)) kids.set(p, [...(kids.get(p) ?? []), r.id]);
    const out = new Set<string>();
    const stack = [root];
    while (stack.length) {
      const x = stack.pop()!;
      if (out.has(x)) continue;
      out.add(x);
      stack.push(...(kids.get(x) ?? []));
    }
    return out;
  }

  /** The activity as text for agents: one block per entry, changes readable, text changes as diffs. */
  activity(opts: ActivityOpts, me = ""): string {
    const { entries, cursor, more } = this.activityFeed(opts, me);
    const scope = [
      opts.since !== undefined ? `since ${opts.since}` : `in the last ${opts.days ?? 7} day(s)`,
      opts.under && `under "${this.anyItem(opts.under).title}"`,
      opts.ref && `of "${this.anyItem(opts.ref).title}"`,
      opts.by && `by ${opts.by}`,
    ].filter(Boolean);
    const head = `${entries.length}${more ? "+" : ""} change(s) ${scope.join(" · ")}${opts.since !== undefined ? " (oldest first)" : " (newest first)"}`;
    let budget = DIFF_BUDGET;
    const blocks = entries.map((e) => {
      const lines = [this.entryHead(e), ...this.changeTexts(e).map((c) => "  " + c)];
      const body = e.changes.find((c) => c.field === "body");
      if (body?.diff && opts.diff !== false) {
        const t = this.store.eventText(e.id);
        if (t) {
          const more = `history ref=${t.doc} from=${t.from ?? 0} to=${t.to}`;
          if (budget <= 0) lines.push(`  (diff left out, the answer is long: ${more})`);
          else {
            const u = unifiedDiff(textDiff(t.before, t.after), { maxLines: Math.min(DIFF_LINES, budget), maxWidth: 240 });
            budget -= u.shown;
            lines.push(...u.text.split("\n").map((l) => "    " + l));
            if (u.total > u.shown) lines.push(`    … ${u.total - u.shown} more line(s): ${more}`);
          }
        }
      }
      return lines.join("\n");
    });
    const windowStart = new Date(Date.now() - (opts.days ?? 7) * DAY_MS).toISOString();
    const next = !more
      ? `cursor: ${cursor} – pass it as since next time to get only what changed after this call.`
      : opts.since !== undefined
        ? `More changes after these: call activity again with since="${cursor}".`
        : `More, older changes than these: raise limit, or go through all of them oldest first with since="${windowStart}". For your next session: cursor ${cursor}.`;
    return [head, next, ...blocks].join("\n\n");
  }

  /** "2026-11-01 10:23 · Tim · updated "Mapping" [id] · Task (step s…)". */
  private entryHead(e: ActivityEvent): string {
    const item = this.store.records.get(e.doc);
    const at = new Date(e.ts).toISOString().slice(0, 16).replace("T", " ");
    const verb = e.undoes ? (e.redo ? "redid (undo of an undo) – " : "undid a step – ") : "";
    const what = !e.doc ? e.title : `${verb}${e.kind} "${item ? displayTitle(item) || "(untitled)" : e.title}" [${e.doc}]${item ? ` · ${this.kindOf(item)}` : ""}`;
    return `${at} · ${originText(e.origin)} · ${what}${e.step ? ` (step ${e.step})` : ""}`;
  }

  private kindOf(i: Item): string {
    const ix = this.store.index();
    if (i.type === META_TYPE) return "type";
    if (i.kind === "datei") return "file";
    return this.typeName(i.type) ?? (isInInbox(i, ix) ? "inbox" : isOverview(i, ix) ? "overview" : "note");
  }

  /** A type's name, also of a deleted type. */
  private typeName(id?: string | null): string | undefined {
    return id ? this.store.records.get(id)?.schema?.name : undefined;
  }

  /** The changes of an entry in plain words: names instead of ids, from → to. */
  changeTexts(e: ActivityEvent): string[] {
    const item = this.store.records.get(e.doc);
    const schema = item?.type ? this.store.records.get(item.type)?.schema : undefined;
    const prop = (pid: string) => schema?.properties.find((p) => p.id === pid) ?? schema?.removedProperties.find((p) => p.id === pid);
    const title = (id: string) => `"${this.store.records.get(id)?.title ?? id}"`;
    const list = (x: unknown) => ((x as string[] | undefined) ?? []).map(title).join(", ");
    const plusMinus = (name: string, c: FieldChange, fmt: (x: unknown) => string = list) => {
      const add = (c.to as unknown[] | undefined) ?? [];
      const rem = (c.from as unknown[] | undefined) ?? [];
      return [add.length && `${name} + ${fmt(add)}`, rem.length && `${name} − ${fmt(rem)}`].filter(Boolean).join(", ");
    };
    const out: string[] = [];
    for (const c of e.changes) {
      const f = c.field;
      if (f.startsWith("p:")) {
        const p = prop(f.slice(2));
        const v = (x: unknown) => (x === undefined || x === null || x === "" ? "–" : p?.options ? optionNames(p, x as Value).join(", ") || "–" : short(x));
        out.push(`${p?.name ?? f.slice(2)}: ${v(c.from)} → ${v(c.to)}`);
      } else if (f.startsWith("x:")) out.push(`${f.slice(2)}: ${c.from === undefined ? "–" : short(c.from)} → ${c.to === undefined ? "–" : short(c.to)}`);
      else if (f.startsWith("r:")) out.push(plusMinus(prop(f.slice(2))?.name ?? f.slice(2), c));
      else if (f === "title") out.push(`title: ${c.from === undefined ? "–" : short(c.from)} → ${short(c.to ?? "")}`);
      else if (f === "type") out.push(`type: ${this.typeName(c.from as string) ?? "–"} → ${this.typeName(c.to as string) ?? "–"}`);
      else if (f === "home") out.push(`home: ${c.from ? title(c.from as string) : "–"} → ${c.to ? title(c.to as string) : "–"}`);
      else if (f === "pinned") out.push(c.to ? "pinned" : "unpinned");
      else if (f === "parents") out.push(plusMinus("part of", c));
      else if (f === "tags") out.push(plusMinus("tags", c, (x) => (x as string[]).map((t) => "#" + t).join(" ")));
      else if (f === "refs") out.push(plusMinus("refs", c));
      else if (f === "body") out.push(`text: ${c.from ?? 0} → ${c.to ?? 0} characters`);
      else if (f === "update") out.push(`update posted: ${short(c.to, 400)}`);
      else if (f === "schema") out.push("type definition changed (properties or capabilities)");
      else if (f === "views") out.push("views of the type's page changed");
      else if (f === "file") out.push(`file replaced: ${short(c.from ?? "")} → ${short(c.to ?? "")}`);
      else if (f === "suggestion") out.push(c.to ? "suggestion made" : "suggestion accepted or dismissed");
      else if (f === "op") out.push(c.to === "undone" ? "operation undone" : "operation changed");
      else out.push(f);
    }
    return out.filter(Boolean);
  }

  /** An item by id also when it is in the trash (its history and activity stay readable); else as resolve(). */
  private anyItem(ref: string): Item {
    const byId = this.store.records.get(ref.trim().replace(/^\[\[|\]\]$/g, ""));
    return byId && (byId.kind === "info" || byId.kind === "datei") ? byId : this.resolve(ref);
  }

  /**
   * The kept versions of an item's text: the list, one version's text, or a diff between two
   * (from 0 = the empty text; to omitted = the text now).
   */
  history(ref: string, opts: { version?: number; from?: number; to?: number } = {}): string {
    this.ix;
    const item = this.anyItem(ref);
    const name = `"${displayTitle(item) || "(untitled)"}" [${item.id}]`;
    const versions = this.store.versions(item.id);
    const pick = (n: number) => {
      const v = versions[n - 1];
      if (!v) throw new OpError(`${name} has no version ${n}; it has ${versions.length ? `versions 1 to ${versions.length}` : "no versions yet"}.`);
      return v;
    };
    const textOf = (n: number) => (n === 0 ? "" : this.store.versionText(pick(n).id)!);
    const label = (v: TextVersion) => `#${v.n} · ${new Date(v.ts).toISOString().slice(0, 16).replace("T", " ")} · ${v.base ? "earlier state (from before versions were kept)" : originText(v.origin) || "unknown"}`;
    if (opts.version !== undefined) {
      const v = pick(opts.version);
      return `Version ${label(v)} · ${v.len} characters of ${name}:\n\n${textOf(v.n)}`;
    }
    if (opts.from !== undefined || opts.to !== undefined) {
      const from = opts.from ?? Math.max(0, (opts.to ?? versions.length) - 1);
      const a = textOf(from);
      const b = opts.to === undefined ? item.body : textOf(opts.to);
      const d = textDiff(a, b);
      const u = unifiedDiff(d, { maxLines: 3000 });
      const names = `${from === 0 ? "empty text" : `#${from}`} → ${opts.to === undefined ? "the text now" : `#${opts.to}`}`;
      if (!d.hunks.length) return `${name}: ${names} – no difference.`;
      return `${name}: ${names}, +${d.added} −${d.removed} line(s)\n${u.text}${u.total > u.shown ? `\n… ${u.total - u.shown} more line(s) left out; compare closer versions` : ""}`;
    }
    if (!versions.length) return `${name} has no versions yet: its text has not changed since versions are kept. Its text now: get ref=${item.id}.`;
    const shown = versions
      .slice(-50)
      .reverse()
      .map((v) => {
        const d = textDiff(v.n > 1 ? textOf(v.n - 1) : "", textOf(v.n));
        return `${label(v)} · ${v.len} characters · +${d.added} −${d.removed} line(s)${v.step ? ` (step ${v.step})` : ""}`;
      });
    const latest = textOf(versions.length);
    const now = latest === item.body ? `The text now is version ${versions.length}.` : `The text now differs from version ${versions.length} (changes moments ago).`;
    return [
      `${versions.length} version(s) of the text of ${name}, newest first${versions.length > shown.length ? ` (the newest 50)` : ""}:`,
      ...shown.map((r) => "- " + r),
      now,
      "version=N shows a version's text; from=N (and to=M, default the text now) shows a diff. To go back to a version, update the body with it (body_mode replace).",
    ].join("\n");
  }

  toValue(p: PropDef, raw: unknown, ctx: Item | undefined): { value?: Value | null; rels?: string[] } {
    if (raw === null || raw === "") {
      if (p.kind === "select" && !p.multiple && p.default) throw new OpError(`"${p.name}" has a default and cannot be empty; set another option.`);
      return { value: null };
    }
    switch (p.kind) {
      case "text":
      case "url":
        return { value: String(raw) };
      case "number": {
        // plain notation first (1234.5), then German (1.234,5 / 1,5)
        const s = String(raw).trim();
        const plain = Number(s);
        let n: number | undefined;
        if (typeof raw === "number") n = raw;
        else n = isNaN(plain) ? parseNumber("de", s) : plain;
        if (n === undefined || isNaN(n)) throw new OpError(`"${p.name}" needs a number, got "${raw}".`);
        return { value: n };
      }
      case "checkbox":
        return { value: raw === true || ["true", "yes", "ja", "1", "x"].includes(String(raw).toLowerCase()) };
      case "date": {
        const s = String(raw).trim();
        const today = todayISO();
        const whole = parseDate(s, today);
        if (whole) return { value: whole };
        const range = p.range ? splitRange(s, today) : undefined;
        if (range) return { value: range };
        throw new OpError(`"${p.name}" needs ${DATE_HELP}${p.range ? ", or start/end" : ""}; got "${raw}".`);
      }
      case "select": {
        if (!p.multiple) return { value: matchOption(p, String(raw)).id };
        const list = Array.isArray(raw) ? raw : String(raw).split(",");
        return { value: list.map((x) => matchOption(p, String(x)).id) };
      }
      case "relation": {
        const list = Array.isArray(raw) ? raw : [raw];
        const ids = list.map((x) => this.resolve(String(x)).id);
        if (ctx && ids.includes(ctx.id)) throw new OpError(`"${p.name}" of "${ctx.title}" cannot point to itself.`);
        return { rels: ids };
      }
      case "computed":
        throw new OpError(`"${p.name}" is computed and cannot be set.`);
    }
    return {};
  }

  private noSelfLink(body: string, id: string, title: string) {
    const ix = this.store.index();
    for (const l of parseWikiLinks(body)) {
      const to = ix.resolveTitle(l.target);
      if (l.target === id || titleKey(l.target) === titleKey(title) || to === id)
        throw new OpError(`The text of "${title}" links to itself ([[${l.target}]]). Links to the item itself are not allowed; remove the brackets or link another item.`);
    }
  }

  private prop(schema: TypeSchema | undefined, name: string): PropDef {
    const p = schema?.properties.find((x) => titleKey(x.name) === titleKey(name) || x.id === name);
    if (!p) throw new OpError(`Unknown property "${name}"${schema ? ` on type ${schema.name}. Properties: ${schema.properties.map((x) => x.name).join(", ") || "none"}` : " (no type)"}. Properties belong to a type: add it to the type with update_type, or give the item a type that has it.`);
    return p;
  }

  private applyProps(doc: Y.Doc, item: Item | undefined, schema: TypeSchema | undefined, props: Record<string, unknown> | undefined) {
    for (const [name, raw] of Object.entries(props ?? {})) {
      const p = this.prop(schema, name);
      const { value, rels } = this.toValue(p, raw, item);
      if (rels) {
        if (!p.multiple) for (const old of item?.rels[p.id] ?? []) setRel(doc, p.id, old, false);
        for (const r of rels) setRel(doc, p.id, r, true);
      } else if (value !== undefined) writeProp(doc, schema, p.id, value);
    }
  }

  /** Product decision: in the inbox agents only suggest, the user accepts with one click. */
  private guardInbox(item: Item, what: string) {
    if (isInInbox(item, this.store.index()))
      throw new OpError(`"${item.title}" is in the inbox. Agents don't sort the inbox themselves (${what}); use suggest to propose a type and place – the user accepts with one click.`);
  }

  create(input: CreateInput, origin: string): Item {
    const title = input.title.trim();
    if (!title) throw new OpError("title is required.");
    const ix = this.ix;
    const type = input.type ? this.resolveType(input.type) : undefined;
    const schema = type?.schema;
    const parents = (input.parents ?? []).map((p) => this.resolve(p).id);
    const refs = (input.refs ?? []).map((r) => this.resolve(r).id);
    const id = newId();
    const body = input.body ? normalizeBlocks(input.body, ix) : (template(schema)?.body ?? "");
    this.noSelfLink(body, id, title);
    this.store.change(id, origin, (doc) => {
      const pinned = input.pin ? nextPinKey(this.store.live()) : undefined;
      initItem(doc, { title, type: type?.id ?? null, body, tags: input.tags, refs, parents, pinned, props: initialProps(schema), createdBy: origin });
      this.applyProps(doc, undefined, schema, input.properties);
    });
    this.store.flush();
    return this.store.records.get(id)!;
  }

  update(ref: string, input: UpdateInput, origin: string): Item {
    const item = this.target(ref, "update");
    const ix = this.store.index();
    if (input.type !== undefined) {
      if (input.type && item.kind !== "info") throw new OpError(`"${item.title}" is a file. Files have no type, only the file type (filetype).`);
      this.guardInbox(item, "giving it a type");
    }
    // null or "" removes the type
    const newType = input.type === undefined ? undefined : input.type ? this.resolveType(input.type) : null;
    const schema = newType === undefined ? ix.schemaOf(item) : newType?.schema;
    if (input.title !== undefined && !input.title.trim()) throw new OpError("Title cannot be empty.");
    this.checkVersion(item, input);
    let body: string | undefined;
    if (input.old_text !== undefined && input.body !== undefined) throw new OpError("Use either old_text/new_text or body.");
    if (input.old_text !== undefined) {
      if (!input.old_text) throw new OpError("old_text must not be empty.");
      const count = item.body.split(input.old_text).length - 1;
      if (count === 0) throw new OpError("old_text was not found in the body.");
      if (count > 1) throw new OpError(`old_text occurs ${count} times; include more context.`);
      body = item.body.replace(input.old_text, () => input.new_text ?? "");
    } else if (input.body !== undefined) body = joinBody(item.body, input.body, input.body_mode);
    if (body !== undefined) body = normalizeBlocks(body, ix);
    if (body !== undefined || input.title !== undefined) this.noSelfLink(body ?? item.body, item.id, input.title?.trim() || item.title);
    const refsAdd = (input.refs_add ?? []).map((r) => this.resolve(r).id);
    if (refsAdd.includes(item.id)) throw new OpError(`"${item.title}" cannot refer to itself.`);
    const refsRem = (input.refs_remove ?? []).map((r) => this.resolve(r).id);
    const oldTitle = item.title;
    const ownsTitle = ix.ownsTitle(item);
    this.store.change(item.id, origin, (doc) => {
      if (input.title !== undefined) setMeta(doc, { title: input.title.trim() });
      if (newType !== undefined) {
        setMeta(doc, { type: newType?.id ?? null });
        for (const [k, v] of Object.entries(initialProps(schema))) if (item.props[k] === undefined) setProp(doc, k, v);
      }
      this.applyProps(doc, item, schema, input.properties);
      for (const k of input.free_properties_remove ?? []) {
        const name = Object.keys(item.extra).find((n) => titleKey(n) === titleKey(k));
        if (name) setExtra(doc, name, null);
      }
      for (const t of input.tags_add ?? []) setMember(doc, "tags", t, true);
      for (const t of input.tags_remove ?? []) setMember(doc, "tags", t, false);
      for (const r of refsAdd) setMember(doc, "refs", r, true);
      for (const r of refsRem) setMember(doc, "refs", r, false);
      if (body !== undefined) replaceBody(doc, body);
      touch(doc);
    });
    if (ownsTitle && input.title && input.title.trim() !== oldTitle) this.renameLinks(oldTitle, input.title.trim(), origin);
    this.store.flush();
    return this.store.records.get(item.id)!;
  }

  /**
   * Protection against lost updates: replacing the whole body needs the version the agent read
   * (base_version). Given with any other change, base_version is checked as well. A stale one is
   * rejected with who changed the item, when, and – for a body – the lines that differ.
   */
  private checkVersion(item: Item, input: UpdateInput) {
    const base = input.base_version?.trim();
    const replaces = input.body !== undefined && (input.body_mode ?? "replace") === "replace";
    if (!base) {
      if (replaces)
        throw new OpError(
          `Replacing the whole body of "${item.title}" needs base_version, so no one else's edit is lost. Read the item first (get shows its version) and pass it as base_version, or change only a part: old_text/new_text, or body with body_mode "append" or "prepend".`,
        );
      return;
    }
    const now = versionOf(item);
    if (base === now) return;
    const ix = this.store.index();
    const parts = [`"${item.title}" [${item.id}] changed since you read it (base_version ${base}, now ${now}).`];
    const events = this.store.events({ doc: item.id, limit: 3 });
    if (events.length) parts.push(`Last changes:\n${events.map((e) => `- ${new Date(e.ts).toISOString().slice(0, 16)} by ${originText(e.origin)}${e.changes.length ? `: ${this.changeTexts(e).join(", ")}` : ` (${e.kind})`}`).join("\n")}`);
    if (replaces) {
      const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
      const current = lines(blocksAsText(item.body, this.store.lang(), ix));
      const yours = lines(input.body!);
      const excerpt = (xs: string[]) => xs.slice(0, 6).map((l) => `  ${l.length > 160 ? l.slice(0, 159) + "…" : l}`).join("\n") + (xs.length > 6 ? `\n  … ${xs.length - 6} more line(s)` : "");
      const lost = current.filter((l) => !yours.includes(l));
      const added = yours.filter((l) => !current.includes(l));
      if (lost.length) parts.push(`Only in the current body (your replace would drop it):\n${excerpt(lost)}`);
      if (added.length) parts.push(`Only in your body:\n${excerpt(added)}`);
    }
    parts.push(`Get it again, merge your change into what is there now, and pass the new version as base_version – or change only your part with old_text/new_text or body_mode "append".`);
    throw new OpError(parts.join("\n"));
  }

  renameLinks(oldTitle: string, newTitle: string, origin: string) {
    for (const r of this.store.live()) {
      const body = renameLinksIn(r.body, oldTitle, newTitle);
      if (body !== null) this.store.change(r.id, origin, (doc) => replaceBody(doc, body));
    }
  }

  place(ref: string, input: PlaceInput, origin: string) {
    const item = this.target(ref, "place");
    const ix = this.store.index();
    if (input.add?.length || input.pin) this.guardInbox(item, input.pin ? "pinning it" : "placing it");
    const add = (input.add ?? []).map((p) => this.resolve(p));
    for (const p of add) if (ix.wouldCycle(item.id, p.id)) throw new OpError(`"${item.title}" cannot go below "${p.title}": that is part of it (a cycle).`);
    const rem = (input.remove ?? []).map((p) => this.resolve(p).id);
    const home = input.home ? this.resolve(input.home).id : undefined;
    if (item.kind === "datei") {
      const after = new Set(ix.parentsOf(item.id));
      for (const p of add) after.add(p.id);
      for (const p of rem) after.delete(p);
      if (home) after.add(home);
      if (after.size > 1) {
        const now = ix.parentsOf(item.id).map((p) => `"${ix.get(p)?.title ?? p}"`).join(", ");
        throw new OpError(`"${item.title}" is a file, and a file has exactly one parent; where else it is used shows under "used in" by itself. To move it, add the new parent and remove the current one${now ? ` (${now})` : ""} in the same call.`);
      }
    }
    this.store.change(item.id, origin, (doc) => {
      for (const p of add) addParent(doc, p.id);
      for (const p of rem) removeParent(doc, p);
      if (home) {
        if (!doc.getMap("parents").has(home)) addParent(doc, home);
        setHome(doc, home);
      }
      if (input.pin === true && !item.pinned) setMeta(doc, { pinned: nextPinKey(this.store.live()) });
      if (input.pin === false) setMeta(doc, { pinned: null });
      touch(doc);
    });
    this.store.flush();
    const after = this.store.index();
    const now = this.store.records.get(item.id)!;
    return { now, part_of: after.parentsOf(item.id).map((p) => after.get(p)?.title ?? p), in_inbox: isInInbox(now, after) };
  }

  addUpdate(ref: string, text: string, status: string | undefined, by: string, origin: string) {
    if (!text.trim()) throw new OpError("The update text is empty.");
    const item = this.target(ref, "add_update");
    const schema = this.store.index().schemaOf(item);
    if (!hasUpdates(schema)) {
      const capable = [...this.store.index().types.values()].filter((t) => hasUpdates(t.schema)).map((t) => t.schema.name);
      throw new OpError(`"${item.title}" has no updates (its type doesn't have that capability). Types with updates: ${capable.join(", ") || "none"}. Add the text to the body instead, or to a parent that has updates.`);
    }
    let opt: string | undefined;
    const sp = statusProp(schema);
    if (status) {
      if (!sp) throw new OpError(`"${item.title}" has no status.`);
      opt = this.toValue(sp, status, item).value as string;
    }
    const at = Date.now();
    this.store.change(item.id, origin, (doc) => {
      appendUpdate(doc, { at, text: text.trim(), by, status: opt });
      if (opt && sp) writeProp(doc, schema, sp.id, opt, at);
      touch(doc);
    });
    this.store.flush();
    return this.store.records.get(item.id)!;
  }

  /** `group` is a status group or an option name. All or nothing. */
  setStatusGroup(refs: string[], group: string, origin: string): Item[] {
    const g = statusGroupOf(group);
    const plan: { item: Item; schema: TypeSchema | undefined; prop: string; id: string }[] = [];
    const errors: string[] = [];
    for (const r of refs) {
      try {
        const item = this.target(r, "set_status");
        const schema = this.store.index().schemaOf(item);
        const sp = statusProp(schema);
        if (!sp) throw new OpError(`"${item.title}" has no status.`);
        const id = optionNamed(sp, group)?.id ?? (g ? firstOfGroup(schema, g)?.id : undefined) ?? (this.toValue(sp, group, item).value as string);
        plan.push({ item, schema, prop: sp.id, id });
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    if (errors.length) throw new OpError(errors.join(" "));
    for (const p of plan)
      this.store.change(p.item.id, origin, (doc) => {
        writeProp(doc, p.schema, p.prop, p.id);
        touch(doc);
      });
    this.store.flush();
    return plan.map((p) => this.store.records.get(p.item.id)!);
  }

  suggest(ref: string, input: SuggestInput, by: string, origin: string) {
    const item = this.target(ref, "suggest");
    if (input.type && item.kind !== "info") throw new OpError(`"${item.title}" is a file. Files have no type; suggest a place instead.`);
    if (item.kind === "datei" && (input.parents?.length ?? 0) > 1) throw new OpError(`"${item.title}" is a file, and a file has exactly one parent. Suggest one place.`);
    const type = input.type ? this.resolveType(input.type).id : undefined;
    const parents = (input.parents ?? []).map((p) => this.resolve(p).id);
    const schema = type ? this.store.index().types.get(type)?.schema : this.store.index().schemaOf(item);
    const props: Record<string, Value> = {};
    for (const [name, raw] of Object.entries(input.properties ?? {})) {
      const p = this.prop(schema, name);
      const v = this.toValue(p, raw, item).value;
      if (v !== undefined && v !== null) props[p.id] = v;
    }
    this.store.change(item.id, origin, (doc) => setMeta(doc, { suggestion: { type, parents, props: Object.keys(props).length ? props : undefined, note: input.note, by, at: Date.now() } }));
    this.store.flush();
    return `Suggested for "${item.title}": ${[type ? this.store.index().typeName(type) : null, ...parents.map((p) => this.store.index().get(p)?.title)].filter(Boolean).join(" · ")}. The user accepts it in the inbox.`;
  }

  /** Children that hang only here go along to the trash or lose this place; if any exist, the caller must choose. */
  remove(ref: string, children: "trash" | "inbox" | undefined, origin: string) {
    const item = this.target(ref, "delete");
    const only = onlyBelow(this.ix, item.id);
    if (only.length && !children)
      throw new OpError(`${only.length} item(s) hang only below "${item.title}" (e.g. ${only.slice(0, 3).map((id) => `"${this.ix.get(id)?.title}"`).join(", ")}). Say children: "trash" to delete them too or "inbox" to keep them without this place.`);
    deleteItem(this.writer(origin), this.ix, item.id, children ?? "trash");
    this.store.flush();
    return { item, only: children === "inbox" ? 0 : only.length };
  }

  /** Brings back exactly what was deleted together with it. */
  restore(ref: string, origin: string) {
    const item = this.store.records.get(ref) ?? [...this.store.records.values()].find((x) => x.deleted && titleKey(x.title) === titleKey(ref));
    if (!item || !item.deleted) throw new OpError(`Nothing in the trash matches "${ref}".`);
    const back = restoreItem(this.writer(origin), this.store.records, item.id);
    this.store.flush();
    return { item, back: back.length };
  }

  defineType(input: DefineTypeInput, origin: string) {
    if (!input.name.trim()) throw new OpError("name is required.");
    if (this.ix.typeByName(input.name)) throw new OpError(`A type "${input.name}" exists already. Use update_type.`);
    const id = newId();
    this.store.change(id, origin, (doc) => initType(doc, { name: input.name.trim(), icon: input.icon, color: input.color ?? freshColor([...this.ix.types.values()].map((x) => x.schema.color)), description: input.description }, { createdBy: origin }));
    this.store.flush();
    this.updateType(id, { add_properties: input.properties, capabilities: input.capabilities }, origin);
    return this.typeInfo(this.store.index().types.get(id)!);
  }

  deletePreview(ref: string) {
    const t = this.resolveType(ref);
    const u = typeUsage(this.store.index(), t.id);
    return { type: t.schema.name, entries: u.items.length, would_land_in_inbox: u.inboxAfterRemove, used_in_queries: u.queries.map((q) => q.title), relations: u.relations.map((r) => r.name), progress: u.progress.map((p) => p.name), main_action_of: u.childOf.map((c) => c.name), note: "Deleting is confirmed in the app (type page › … › Delete type): into a tag, into another type, or remove. Values stay as free properties." };
  }

  updateType(ref: string, input: UpdateTypeInput, origin: string) {
    const t = this.resolveType(ref);
    const s = t.schema;
    const find = (name: string) => {
      const p = s.properties.find((x) => titleKey(x.name) === titleKey(name) || x.id === name);
      if (!p) throw new OpError(`Type ${s.name} has no property "${name}".`);
      return p;
    };
    // "status" and "multiselect" are selects now; agents may still name them
    const legacy = (k?: PropInput["kind"]): PropKind | undefined => (k === "status" || k === "multiselect" ? "select" : k);
    const toDef = (p: PropInput, cur?: PropDef): Patch<Omit<PropDef, "id">> => {
      const kind = legacy(p.kind) ?? cur?.kind;
      const grouped = p.kind === "status" || (!!cur && statusProp(s)?.id === cur.id) || !!p.options?.some((o) => OPTION_GROUP.test(o));
      const options = p.options?.map((o) => {
        const m = OPTION_PARTS.exec(o)!;
        const existing = cur?.options?.find((x) => x.name === m[1]);
        const state = grouped ? ((m[3] as OptionDef["state"]) ?? (m[2] ? undefined : existing?.state)) : undefined;
        return { id: existing?.id ?? shortId("o"), name: m[1]!.trim(), group: grouped ? ((m[2] as StatusGroup | undefined) ?? existing?.group ?? "todo") : undefined, ...(state ? { state } : {}), color: existing?.color ?? "gray" };
      });
      const opts = options ?? cur?.options ?? [];
      let def: string | null | undefined;
      if (p.default === null || p.default === "") def = null;
      else if (p.default !== undefined) {
        def = opts.find((o) => titleKey(o.name) === titleKey(p.default!))?.id;
        if (!def) throw new OpError(`Default "${p.default}" is not an option of "${p.name ?? cur?.name}".`);
      }
      let computed = cur?.computed;
      if (p.computed) computed = { fn: p.computed.startsWith("count") ? "count" : "progress", of: p.computed.includes(":") ? this.resolveType(p.computed.split(":")[1]!.trim()).id : undefined };
      let multiple: boolean | null | undefined = p.multiple;
      if (p.kind === "multiselect") multiple = true;
      else if (p.kind === "status") multiple = null;
      return { name: p.name, kind, description: p.description, options, multiple, default: def, target: p.target, inverseName: p.inverse, symmetric: p.symmetric, range: p.range, computed, hideEmpty: p.hide_empty, blocks: p.blocks };
    };
    // properties given the old kind "status" become the type's status below, once they exist
    const asStatus = [...(input.add_properties ?? []), ...(input.change_properties ?? [])].filter((p) => p.kind === "status").map((p): string => p.name ?? ("property" in p && typeof p.property === "string" ? p.property : ""));
    this.store.change(t.id, origin, (doc) => {
      if (input.name) {
        setSchemaField(doc, "name", input.name);
        setMeta(doc, { title: input.name });
      }
      if (input.plural !== undefined) setSchemaField(doc, "plural", input.plural);
      if (input.views) setTabs(doc, this.toTabs(input.views, t));
      if (input.description !== undefined) setSchemaField(doc, "description", input.description);
      if (input.icon) setSchemaField(doc, "icon", input.icon);
      if (input.color) setSchemaField(doc, "color", input.color);
      let last = s.properties.at(-1)?.sort ?? null;
      for (const p of input.add_properties ?? []) {
        if (!p.name || !p.kind) throw new OpError("New properties need name and kind.");
        if (s.properties.some((x) => titleKey(x.name) === titleKey(p.name!))) throw new OpError(`Property "${p.name}" exists already; use change_properties.`);
        last = keyBetween(last, null);
        upsertProp(doc, shortId("p"), { ...toDef(p), sort: last });
      }
      for (const p of input.change_properties ?? []) {
        const cur = find(p.property);
        upsertProp(doc, cur.id, toDef(p, cur));
      }
      for (const r of input.remove_properties ?? []) upsertProp(doc, find(r).id, { removed: true });
    });
    this.store.flush();
    const s2 = this.store.index().types.get(t.id)!.schema;
    const c: CapInput | undefined = input.capabilities ?? (asStatus.length ? {} : undefined);
    if (c && c.status === undefined && asStatus.length) c.status = asStatus.at(-1)!;
    if (c) {
      const pid = (name: string | null | undefined, kind: string) => {
        if (!name) return null;
        const p = s2.properties.find((x) => titleKey(x.name) === titleKey(name));
        if (!p || p.kind !== kind) throw new OpError(`"${name}" must be a ${kind} property of ${s2.name}.`);
        return p.id;
      };
      this.store.change(t.id, origin, (doc) => {
        if (c.status === null) setCapability(doc, "status", null);
        else if (c.status !== undefined) {
          const p = s2.properties.find((x) => titleKey(x.name) === titleKey(c.status!) && x.kind === "select" && !x.multiple);
          if (!p) throw new OpError(`"${c.status}" must be a select property with one value of ${s2.name}.`);
          useAsStatus(doc, p);
        }
        if (c.due_date !== undefined) setCapability(doc, "due", pid(c.due_date, "date"));
        if (c.progress !== undefined) setCapability(doc, "progress", c.progress === false || c.progress === null ? null : { of: typeof c.progress === "string" ? this.resolveType(c.progress).id : undefined });
        if (c.updates !== undefined) setCapability(doc, "updates", c.updates || null);
        if (c.main_action !== undefined) setCapability(doc, "primaryChild", c.main_action ? this.resolveType(c.main_action).id : null);
        if (c.template !== undefined) setCapability(doc, "template", c.template === null ? null : { body: c.template });
      });
      this.store.flush();
    }
    return this.typeInfo(this.store.index().types.get(t.id)!);
  }

  /** A view with the same name keeps its id. */
  toTabs(views: ViewInput[], type: Item): Omit<ViewTab, "pos">[] {
    const ix = this.ix;
    const where: Cond = { type: type.id };
    const current = typeTabs(type, this.store.lang());
    if (!views.length) throw new OpError("A type's page needs at least one view.");
    return views.map((v, n) => {
      const p = v.query ? parseQuery(v.query, ix) : { def: {} as QueryDef, errors: [] };
      if (p.errors.length) throw new OpError(`View "${v.name ?? n + 1}": query not understood: ${p.errors.join(", ")}.`);
      const kind = v.view ?? p.def.view ?? "table";
      const same = current.find((t) => (t.name ?? "") === (v.name ?? "") && (v.name || t.kind === kind));
      const hiddenGroups = v.hidden_groups?.length ? v.hidden_groups.map((name) => this.groupKey(p.def.group, name, where)) : undefined;
      return { id: same?.id ?? shortId("v"), name: v.name || undefined, kind, where: p.def.where, sort: p.def.sort, group: p.def.group, columns: p.def.columns, subgroup: v.subgroup, hideEmpty: v.hide_empty_groups || undefined, hiddenGroups, date: v.date };
    });
  }

  /** Returns how a view stores the group: option id, entry id or status group. */
  groupKey(by: string | undefined, name: string, where: Cond | undefined): string {
    const ix = this.ix;
    const k = titleKey(name);
    if (by === "statusGroup") return statusGroupOf(name) ?? name;
    const types = typesIn(where).map((id) => ix.types.get(id)?.schema).filter(Boolean);
    for (const sc of types.length ? types : [...ix.types.values()].map((x) => x.schema)) {
      const p = by === "status" ? statusProp(sc) : sc?.properties.find((x) => titleKey(x.name) === titleKey(by ?? ""));
      const o = p?.options?.find((x) => titleKey(x.name) === k);
      if (o) return o.id;
    }
    return ix.resolveTitle(name) ?? name;
  }

  viewInfo(t: ViewTab) {
    return { name: t.name ?? null, hidden_groups: t.hiddenGroups, query: printQuery({ where: t.where, sort: t.sort, group: t.group, columns: t.columns, view: t.kind }, this.store.lang(), this.ix), subgroup: t.subgroup, hide_empty_groups: t.hideEmpty, date: t.date };
  }

  /** Preview only; the user runs the conversion in the app. */
  convertPreview(input: ConvertInput) {
    const t = this.resolveType(input.type);
    const ix = this.ix;
    if (input.direction === "tag_to_type") {
      if (!input.tag) throw new OpError("tag is required.");
      const p = previewTagToType(ix, input.tag, t.id);
      return { would_become_type: p.untyped.map((id) => ix.get(id)!.title), conflicts_with_other_types: p.typedOther.map((id) => this.label(ix.get(id)!)), already: p.already.length, note: `Run it in the app: type "${t.schema.name}" › … › "Take over items from a tag".` };
    }
    const u = typeUsage(ix, t.id);
    return { would_lose_type: u.items.length, values_become_free_properties: true, relations_become_refs: true, used_in_queries: u.queries.map((q) => q.title), progress_filters: u.progress.map((p) => p.name), land_in_inbox: u.inboxAfterRemove, note: `Run it in the app: type "${t.schema.name}" › … › "Turn into a tag".` };
  }

  async attach(input: AttachInput, origin: string) {
    if (!this.blobs) throw new OpError("Files are not available.");
    let data: Uint8Array;
    if (input.base64) data = fromB64(input.base64);
    else if (input.url) {
      const u = new URL(input.url);
      if (!["http:", "https:"].includes(u.protocol)) throw new OpError("Only http(s) URLs.");
      const res = await fetch(u, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) throw new OpError(`Download failed: ${res.status}`);
      data = new Uint8Array(await res.arrayBuffer());
    } else throw new OpError("Give url or base64.");
    if (data.length > MAX_ATTACH) throw new OpError(`File too large (max ${MAX_ATTACH / 1024 / 1024} MB via agent).`);
    const hash = sha256(data);
    await this.blobs.put(hash, data);
    const parent = input.parent ? this.resolve(input.parent).id : undefined;
    const id = newId();
    const mime = mimeOf(input.name);
    this.store.change(id, origin, (doc) => {
      initItem(doc, { kind: "datei", title: input.name, parents: parent ? [parent] : [], tags: input.tags, body: input.description, createdBy: origin });
      setFileMeta(doc, { hash, name: input.name, mime, filetype: fileTypeOf(input.name, mime), size: data.length });
    });
    this.store.flush();
    this.blobs.schedule(id);
    return this.store.records.get(id)!;
  }
}
