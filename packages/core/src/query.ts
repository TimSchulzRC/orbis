// Queries are stored as JSON with ids and typed and shown as text in any UI language:
//
//   typ:Task status:offen unter:[[Relaunch]] fällig<=+7d sort:fällig gruppe:pfad
//   (typ:Person | #people) #autor
//   typ:Projekt in:diese -status:erledigt ansicht:board gruppe:status
//
// Space = AND, | = OR, - = NOT, parentheses group. Properties match by name across all types and
// free properties.
import { type ViewTab, type ComputedDef, type FileType, type Item, type OptionDef, type PropDef, type ViewKind, FILE_TYPES, META_TYPE, QUERY_FENCE, STATUS_GROUPS, VIEW_KINDS, optionNames, titleKey } from "./model";
import { dateOf, todayISO } from "./date";
import { foldUmlauts as fold } from "./text";
import type { Index } from "./graph";
import { inboxWhere, setAside } from "./inbox";
import { type Lang, LANGS, words } from "./i18n";
import { dateEnd, dateStart, doneAt, dueOf, statusOf, statusProp } from "./traits";
import { optionMatches, parseDate, parseNumber, statusGroupOf } from "./input";

function isStatusOptionName(ix: Index, word: string): boolean {
  const k = titleKey(word);
  for (const t of ix.types.values()) if (statusProp(t.schema)?.options?.some((o) => titleKey(o.name) === k)) return true;
  return false;
}

export type Ref = { id: string } | { this: true };
export type Op = ":" | "!=" | "<" | ">" | "<=" | ">=" | "empty";
export type StatusKey = "open" | "new" | "active" | "done";
export type Without = "type" | "parents" | "children" | "usage" | "openChildren";
const WITHOUT: Without[] = ["type", "parents", "children", "usage", "openChildren"];
export type FieldValue = string | { ref: Ref };

export type Cond =
  | { and: Cond[] }
  | { or: Cond[] }
  | { not: Cond }
  | { type: string }
  | { typeName: string } // unknown name, kept so the text survives
  | { tag: string }
  | { under: Ref }
  | { in: Ref }
  | { linked: Ref }
  | { linkedUnder: Ref } // verknüpft:unter:[[X]] – connected to X or a descendant of X
  | { prop: string; op: Op; value?: FieldValue }
  | { status: StatusKey }
  | { inbox: true } // what the inbox rule matches, minus what is set aside
  | { pinned: true }
  | { blocked: true } // an open entry under "Blockiert durch" or "Wartet auf" is set
  | { dormant: true } // it or something above it is paused or done
  | { without: Without }
  | { file: true }
  | { filetype: FileType }
  | { text: string }
  | { unresolved: string }; // [[Title]] that does not exist

export interface QueryDef {
  where?: Cond;
  sort?: { key: string; desc?: boolean }[];
  group?: string; // "path" | "status" | "statusGroup" | "type" | field or property name
  view?: ViewKind;
  columns?: string[];
  limit?: number;
  // display-only, set in the block editor
  title?: string;
  hideEmpty?: boolean;
  collapsed?: boolean; // starts closed (start page cards)
  /** query blocks with several views; the fields above mirror the first tab */
  tabs?: ViewTab[];
}

// Built-in fields, stored language-neutral.
export const FIELDS = ["title", "created", "updated", "due", "done", "next", "area", "project", "subtasks", "progress"] as const;
const GROUPS = ["path", "status", "statusGroup", "type"] as const;
const STATUS_KEYS: StatusKey[] = ["open", "new", "active", "done"];

type KwTable = Map<string, string>; // word -> neutral key
let kwCache: Record<string, KwTable> | null = null;

const KW_KEYS = {
  key: ["type", "under", "in", "linked", "status", "filetype", "without", "sort", "group", "view", "columns", "limit", "collapsed"],
  bare: ["inbox", "file", "pinned", "blocked", "dormant"],
  value: ["this", "empty", "today", "yes"],
  field: [...FIELDS],
  status: STATUS_KEYS,
  groupBy: [...GROUPS],
  view: VIEW_KINDS,
  filetype: FILE_TYPES,
  without: WITHOUT,
} as const;

function tables(): Record<string, KwTable> {
  if (kwCache) return kwCache;
  const out: Record<string, KwTable> = {};
  for (const [cat, keys] of Object.entries(KW_KEYS)) {
    const m: KwTable = new Map();
    for (const lang of LANGS) for (const k of keys) for (const w of words(lang, `q.${cat}.${k}`)) m.set(fold(w), k);
    for (const k of keys) m.set(fold(k), k);
    out[cat] = m;
  }
  return (kwCache = out);
}

const kw = (cat: keyof typeof KW_KEYS, word: string) => tables()[cat]!.get(fold(word));
const say = (lang: Lang, cat: string, key: string) => words(lang, `q.${cat}.${key}`)[0] ?? key;

export interface ParseResult {
  def: QueryDef;
  errors: string[];
}

interface Tok {
  t: "(" | ")" | "|" | "-" | "term";
  v?: string;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(" || c === ")" || c === "|") {
      out.push({ t: c });
      i++;
      continue;
    }
    const beforeWord = i + 1 < src.length && !/\s/.test(src[i + 1]!);
    const afterGap = out.length === 0 || out.at(-1)!.t !== "term" || /\s|\(|\|/.test(src[i - 1] ?? " ");
    if (c === "-" && beforeWord && afterGap) {
      out.push({ t: "-" });
      i++;
      continue;
    }
    // the end of a [[link]] or "quote" opened at `from`, or the end of the source when unclosed
    const closeAt = (close: string, from: number) => {
      const end = src.indexOf(close, from);
      return end < 0 ? src.length : end + close.length;
    };
    let j = i;
    let v = "";
    while (j < src.length) {
      const ch = src[j]!;
      if (src.startsWith("[[", j) || ch === '"') {
        const stop = ch === '"' ? closeAt('"', j + 1) : closeAt("]]", j);
        v += src.slice(j, stop);
        j = stop;
        continue;
      }
      if (/\s/.test(ch) || ch === "(" || ch === ")" || ch === "|") break;
      v += ch;
      j++;
    }
    out.push({ t: "term", v });
    i = j;
  }
  return out;
}

const unquote = (s: string) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

export function parseQuery(src: string, ix: Index): ParseResult {
  const toks = tokenize(src);
  let pos = 0;
  const errors: string[] = [];
  const def: QueryDef = {};

  const ref = (raw: string): Ref | { unresolved: string } => {
    const v = unquote(raw.trim());
    if (kw("value", v) === "this") return { this: true };
    const title = v.replace(/^\[\[|\]\]$/g, "").trim();
    if (ix.get(title)) return { id: title };
    const id = ix.resolveTitle(title);
    return id ? { id } : { unresolved: title };
  };

  /** An unknown link target is reported and becomes an `unresolved` condition. */
  const linkCond = (raw: string, cond: (r: Ref) => Cond): Cond => {
    const r = ref(raw);
    if (!("unresolved" in r)) return cond(r);
    errors.push(`link:${r.unresolved}`);
    return { unresolved: r.unresolved };
  };

  const term = (raw: string): Cond | null => {
    if (raw.startsWith("#") && raw.length > 1) return { tag: raw.slice(1).toLowerCase() };
    const m = /^("[^"]*"|[^:<>!=]+)(<=|>=|!=|:|<|>|=)(.*)$/.exec(raw);
    if (!m) {
      const bare = kw("bare", raw);
      if (bare === "inbox") return { inbox: true };
      if (bare === "file") return { file: true };
      if (bare === "pinned") return { pinned: true };
      if (bare === "blocked") return { blocked: true };
      if (bare === "dormant") return { dormant: true };
      if (raw.startsWith("[[")) {
        const r = ref(raw);
        return "unresolved" in r ? { unresolved: r.unresolved } : { linked: r };
      }
      return { text: unquote(raw) };
    }
    const keyRaw = unquote(m[1]!);
    const op = (m[2] === "=" ? ":" : m[2]) as Op;
    const value = unquote(m[3]!);
    const key = op === ":" ? kw("key", keyRaw) : undefined;
    switch (key) {
      case "type": {
        if (!value) return null;
        const mt = LANGS.some((l) => words(l, "q.metaType").some((w) => fold(w) === fold(value)));
        if (mt) return { type: META_TYPE };
        if (ix.types.has(value)) return { type: value };
        const id = ix.typeByName(value);
        if (!id) errors.push(`type:${value}`);
        return id ? { type: id } : { typeName: value };
      }
      case "under":
      case "in":
      case "linked": {
        // verknüpft:unter:[[X]] / linked:under:[[X]]
        const sub = key === "linked" ? /^([^:[]+):(.*)$/.exec(value) : null;
        if (sub && kw("key", sub[1]!) === "under") return linkCond(sub[2]!, (r) => ({ linkedUnder: r }));
        return linkCond(value, (r) => {
          if (key === "under") return { under: r };
          if (key === "in") return { in: r };
          return { linked: r };
        });
      }
      case "status": {
        const s = kw("status", value) as StatusKey | undefined;
        if (s) return { status: s };
        // a synonym of a whole group ("in Arbeit", "fertig") is the group; option names stay names
        const g = statusGroupOf(value);
        if (g && !isStatusOptionName(ix, value)) return { status: g === "todo" ? "new" : g };
        return { prop: "status", op: ":", value };
      }
      case "without": {
        const w = kw("without", value) as Without | undefined;
        if (!w) errors.push(`without:${value}`);
        return w ? { without: w } : null;
      }
      case "filetype": {
        const f = kw("filetype", value) as FileType | undefined;
        if (!f) errors.push(`filetype:${value}`);
        return f ? { filetype: f } : null;
      }
      case "sort":
        def.sort = value
          .split(",")
          .filter(Boolean)
          .map((s) => {
            const desc = s.startsWith("-");
            const name = desc ? s.slice(1) : s;
            return { key: kw("field", name) ?? name, desc: desc || undefined };
          });
        return null;
      case "group":
        def.group = kw("groupBy", value) ?? kw("field", value) ?? value;
        return null;
      case "view": {
        const v = kw("view", value) as ViewKind | undefined;
        if (v) def.view = v;
        else errors.push(`view:${value}`);
        return null;
      }
      case "columns":
        def.columns = value
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
          .map((c) => kw("field", c) ?? c);
        return null;
      case "limit": {
        const n = Number(value);
        if (n > 0) def.limit = Math.floor(n);
        return null;
      }
      case "collapsed":
        if (kw("value", value) === "yes") def.collapsed = true;
        return null;
    }
    const prop = kw("field", keyRaw) ?? keyRaw;
    const valueKw = kw("value", value);
    if (valueKw === "empty") return { prop, op: "empty" };
    if (value.startsWith("[[") || valueKw === "this") return linkCond(value, (r) => ({ prop, op, value: { ref: r } }));
    return { prop, op, value: valueKw === "today" ? "+0d" : value };
  };

  const parseOr = (): Cond | null => {
    const parts: Cond[] = [];
    let cur = parseAnd();
    if (cur) parts.push(cur);
    while (toks[pos]?.t === "|") {
      pos++;
      cur = parseAnd();
      if (cur) parts.push(cur);
    }
    return joinParts(parts, "or");
  };
  const parseAnd = (): Cond | null => {
    const parts: Cond[] = [];
    while (pos < toks.length && toks[pos]!.t !== ")" && toks[pos]!.t !== "|") {
      const c = parseUnary();
      if (c) parts.push(c);
    }
    return joinParts(parts, "and");
  };
  const parseUnary = (): Cond | null => {
    const tok = toks[pos++]!;
    if (tok.t === "-") {
      const c = parseUnary();
      return c ? { not: c } : null;
    }
    if (tok.t === "(") {
      const c = parseOr();
      if (toks[pos]?.t === ")") pos++;
      return c;
    }
    if (tok.t === "term") return term(tok.v!);
    return null;
  };
  let where: Cond | null = null;
  while (pos < toks.length) {
    const c = parseOr();
    if (c) where = where ? { and: [...conjuncts(where), c] } : c;
    if (toks[pos]?.t === ")") pos++;
  }
  if (where) def.where = where;
  return { def, errors };
}

function joinParts(parts: Cond[], op: "and" | "or"): Cond | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  return op === "and" ? { and: parts } : { or: parts };
}

/** The top-level AND parts of a condition; any other condition is its own single part. */
function conjuncts(c: Cond): Cond[] {
  return "and" in c ? c.and : [c];
}

export function printQuery(def: QueryDef, lang: Lang, ix: Index): string {
  const parts: string[] = [];
  if (def.where) parts.push(printCond(def.where, lang, ix, true));
  const k = (key: string) => say(lang, "key", key);
  const field = (f: string) => printField(f, lang);
  if (def.sort?.length) parts.push(`${k("sort")}:${def.sort.map((s) => (s.desc ? "-" : "") + field(s.key)).join(",")}`);
  if (def.group) parts.push(`${k("group")}:${(GROUPS as readonly string[]).includes(def.group) ? say(lang, "groupBy", def.group) : field(def.group)}`);
  if (def.view) parts.push(`${k("view")}:${say(lang, "view", def.view)}`);
  if (def.columns?.length) parts.push(`${k("columns")}:${def.columns.map(field).join(",")}`);
  if (def.limit) parts.push(`${k("limit")}:${def.limit}`);
  if (def.collapsed) parts.push(`${k("collapsed")}:${say(lang, "value", "yes")}`);
  return parts.filter(Boolean).join(" ");
}

function printField(f: string, lang: Lang) {
  return (FIELDS as readonly string[]).includes(f) ? say(lang, "field", f) : quoteIf(f);
}

function quoteIf(s: string) {
  return /[\s:()|<>!=]/.test(s) ? `"${s}"` : s;
}

function printRef(r: Ref, lang: Lang, ix: Index) {
  if ("this" in r) return say(lang, "value", "this");
  const t = (ix.get(r.id) ?? ix.all.get(r.id))?.title;
  return `[[${t ?? r.id}]]`;
}

function printCond(c: Cond, lang: Lang, ix: Index, top = false): string {
  const k = (key: string) => say(lang, "key", key);
  if ("and" in c) return c.and.map((x) => printCond(x, lang, ix)).join(" ");
  if ("or" in c) {
    const s = c.or.map((x) => printCond(x, lang, ix)).join(" | ");
    return top ? s : `(${s})`;
  }
  if ("not" in c) return "-" + printCond(c.not, lang, ix);
  if ("type" in c) {
    if (c.type === META_TYPE) return `${k("type")}:${words(lang, "q.metaType")[0] ?? "Typ"}`;
    return `${k("type")}:${quoteIf(ix.typeName(c.type) ?? c.type)}`;
  }
  if ("typeName" in c) return `${k("type")}:${quoteIf(c.typeName)}`;
  if ("tag" in c) return `#${c.tag}`;
  if ("under" in c) return `${k("under")}:${printRef(c.under, lang, ix)}`;
  if ("in" in c) return `${k("in")}:${printRef(c.in, lang, ix)}`;
  if ("linked" in c) return `${k("linked")}:${printRef(c.linked, lang, ix)}`;
  if ("linkedUnder" in c) return `${k("linked")}:${k("under")}:${printRef(c.linkedUnder, lang, ix)}`;
  if ("status" in c) return `${k("status")}:${say(lang, "status", c.status)}`;
  if ("inbox" in c) return say(lang, "bare", "inbox");
  if ("pinned" in c) return say(lang, "bare", "pinned");
  if ("blocked" in c) return say(lang, "bare", "blocked");
  if ("dormant" in c) return say(lang, "bare", "dormant");
  if ("without" in c) return `${k("without")}:${say(lang, "without", c.without)}`;
  if ("file" in c) return say(lang, "bare", "file");
  if ("filetype" in c) return `${k("filetype")}:${say(lang, "filetype", c.filetype)}`;
  if ("text" in c) return quoteIf(c.text);
  if ("unresolved" in c) return `[[${c.unresolved}]]`;
  const name = printField(c.prop, lang);
  if (c.op === "empty") return `${name}:${say(lang, "value", "empty")}`;
  const v = c.value;
  let vs = typeof v === "object" && v ? printRef(v.ref, lang, ix) : String(v ?? "");
  if (vs === "+0d") vs = say(lang, "value", "today");
  else if (typeof v === "string") vs = quoteIf(vs);
  return `${name}${c.op}${vs}`;
}

export interface EvalCtx {
  ix: Index;
  thisId?: string;
  today?: string;
  inInbox?: boolean; // evaluating the inbox rule (it may not contain itself)
}

export interface FieldHit {
  kind: string; // property kind or "builtin"
  value: unknown; // raw stored value
  prop?: PropDef;
  inverse?: true; // read from the other side of a relation (not editable here)
}

/** Looks up a built-in field, type property or free property by name. */
export function fieldOf(item: Item, name: string, ix: Index): FieldHit | undefined {
  switch (name) {
    case "title":
      return { kind: "text", value: item.title };
    case "created":
      return { kind: "date", value: dateOf(item.created) };
    case "updated":
      return { kind: "date", value: dateOf(item.updated) };
    case "due": {
      const d = dueOf(item, ix.schemaOf(item));
      return d ? { kind: "date", value: d } : undefined;
    }
    case "done": {
      const d = doneAt(item, ix.schemaOf(item));
      return d ? { kind: "date", value: dateOf(d) } : undefined;
    }
    case "next": {
      const n = ix.nextTask(item.id, todayISO());
      return n ? { kind: "item", value: n.id } : undefined;
    }
    case "area": {
      const a = ix.area(item.id);
      return a ? { kind: "item", value: a } : undefined;
    }
    case "project": {
      const p = ix.home(item.id); // "Darüber": where the entry lives
      return p ? { kind: "item", value: p } : undefined;
    }
    case "progress": {
      // share of done descendants that have a status
      const pr = ix.progressOf(item);
      return pr && pr.total ? { kind: "number", value: percent(pr) } : undefined;
    }
    case "subtasks": {
      // children of the entry's own type (a task's sub-tasks); none: no value
      const n = item.type ? ix.childrenOf(item.id).filter((c) => ix.get(c)?.type === item.type).length : 0;
      return n ? { kind: "number", value: n } : undefined;
    }
  }
  const key = titleKey(name);
  const schema = ix.schemaOf(item);
  if (key === "status") {
    const sp = statusProp(schema);
    if (sp) return { kind: "select", value: item.props[sp.id], prop: sp };
  }
  const p = schema?.properties.find((x) => titleKey(x.name) === key);
  if (p) {
    if (p.kind === "relation") return { kind: "relation", value: ix.relValues(item, p.id, p.symmetric), prop: p };
    if (p.kind === "computed") return { kind: "number", value: computedValue(item, p.computed, ix), prop: p };
    return { kind: p.kind, value: item.props[p.id], prop: p };
  }
  for (const [n, fv] of Object.entries(item.extra)) if (titleKey(n) === key) return { kind: fv.k, value: fv.v };
  return inverseRelationHit(item, key, ix);
}

/** "count": the number of descendants; otherwise the percentage done, undefined when none has a status. */
function computedValue(item: Item, c: ComputedDef | undefined, ix: Index): number | undefined {
  if (c?.fn === "count") return ix.countDescendants(item.id, c.of);
  const pr = ix.progress(item.id, c?.of);
  return pr.total ? percent(pr) : undefined;
}

/** The other side of a relation, by its inverse name ("Blockiert diese"). */
function inverseRelationHit(item: Item, key: string, ix: Index): FieldHit | undefined {
  for (const t of ix.types.values())
    for (const p of t.schema.properties) {
      if (p.kind !== "relation" || p.symmetric || !p.inverseName || titleKey(p.inverseName) !== key) continue;
      const sources = ix.backlinks(item.id).filter((b) => b.kind === "rel" && b.prop === p.id && ix.get(b.from)?.type === t.id).map((b) => b.from);
      return { kind: "relation", value: sources, prop: { ...p, name: p.inverseName }, inverse: true };
    }
  return undefined;
}

const percent = (pr: { done: number; total: number }) => Math.round((pr.done / pr.total) * 100);

/** A date in a query (+7d, heute, 30.10.2026, 10/30/2026 …) → ISO; "2026-10" stays a month. */
export function relDate(v: string, today: string): string | undefined {
  if (/^\d{4}-\d{2}$/.test(v.trim())) return v.trim();
  return parseDate(v, today);
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return undefined;
  const n = Number(v.replace(/\s/g, ""));
  return isNaN(n) ? parseNumber("de", v) : n;
}

function cmp(a: number | string, b: number | string, op: Op): boolean {
  switch (op) {
    case ":":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    case ">=":
      return a >= b;
  }
  return false;
}

function resolveRef(r: Ref, ctx: EvalCtx): string | undefined {
  return "this" in r ? ctx.thisId : r.id;
}

function isEmpty(v: unknown) {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** A single value as a list, so single and multiple values compare alike. */
function asIds(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [String(value)];
}

/** For links and relations only ":" (contains) and "!=" (doesn't) can match. */
function membership(has: boolean, op: Op): boolean {
  return op === "!=" ? !has : op === ":" && has;
}

const TRUE_WORDS = ["ja", "yes", "true", "1", "wahr", "x"];

function matchField(item: Item, c: { prop: string; op: Op; value?: FieldValue }, ctx: EvalCtx): boolean {
  const hit = fieldOf(item, c.prop, ctx.ix);
  if (c.op === "empty") return !hit || isEmpty(hit.value);
  if (!hit || isEmpty(hit.value)) return c.op === "!=";
  const v = c.value;
  if (typeof v === "object" && v && "ref" in v) {
    const target = resolveRef(v.ref, ctx);
    const has = !!target && asIds(hit.value).includes(target);
    return membership(has, c.op);
  }
  const want = String(v ?? "");
  switch (hit.kind) {
    case "number": {
      const a = num(hit.value);
      const b = num(want);
      return a !== undefined && b !== undefined && cmp(a, b, c.op);
    }
    case "date": {
      const today = ctx.today ?? todayISO();
      const b = relDate(want, today);
      if (!b) return false;
      const raw = String(hit.value);
      const a = c.prop === "due" ? dateEnd(raw) : dateStart(raw);
      // "fällig:2026-10" matches the whole month
      if (c.op === ":" && b.length === 7) return a.startsWith(b);
      return cmp(a, b, c.op);
    }
    case "checkbox": {
      const b = TRUE_WORDS.includes(want.toLowerCase());
      return cmp(hit.value === true ? 1 : 0, b ? 1 : 0, c.op);
    }
    case "select": {
      const ids = asIds(hit.value);
      const names = hit.prop ? optionNames(hit.prop, ids) : ids;
      // option names in either language and status synonyms ("in Arbeit", "done") match too
      const opts = ids.map((id) => hit.prop?.options?.find((o) => o.id === id)).filter((o): o is NonNullable<typeof o> => !!o);
      const has = names.some((n) => titleKey(n) === titleKey(want)) || ids.includes(want) || opts.some((o) => optionMatches(hit.prop!, o, want));
      if (c.op === ":") return has;
      if (c.op === "!=") return !has;
      return names.some((n) => cmp(titleKey(n), titleKey(want), c.op));
    }
    case "relation": {
      const ids = hit.value as string[];
      const titles = ids.map((id) => ctx.ix.get(id)?.title ?? "");
      const has = titles.some((t) => titleKey(t) === titleKey(want));
      return membership(has, c.op);
    }
    default: {
      const a = String(hit.value).toLowerCase();
      const b = want.toLowerCase();
      if (c.op === ":") return a.includes(b);
      if (c.op === "!=") return !a.includes(b);
      const an = num(hit.value);
      const bn = num(want);
      if (an !== undefined && bn !== undefined) return cmp(an, bn, c.op);
      return cmp(a, b, c.op);
    }
  }
}

export function matches(item: Item, c: Cond, ctx: EvalCtx): boolean {
  const ix = ctx.ix;
  if ("and" in c) return c.and.every((x) => matches(item, x, ctx));
  if ("or" in c) return c.or.some((x) => matches(item, x, ctx));
  if ("not" in c) return !matches(item, c.not, ctx);
  if ("type" in c) return item.type === c.type && (c.type === META_TYPE || ix.types.has(c.type));
  if ("typeName" in c || "unresolved" in c) return false;
  if ("tag" in c) return item.tags.some((t) => t === c.tag || t.startsWith(c.tag + "/"));
  if ("under" in c) {
    const id = resolveRef(c.under, ctx);
    if (!id) return false;
    const area = ix.descendants(id);
    if (area.has(item.id)) return true;
    // a file also belongs where it is used: embedded or linked in an entry below (or in X itself)
    return item.kind === "datei" && ix.usedIn(item.id).some((b) => b.from === id || area.has(b.from));
  }
  if ("in" in c) {
    const id = resolveRef(c.in, ctx);
    return !!id && ix.parentsOf(item.id).includes(id);
  }
  if ("linked" in c) {
    const id = resolveRef(c.linked, ctx);
    return !!id && ix.connected(id).has(item.id);
  }
  if ("linkedUnder" in c) {
    const id = resolveRef(c.linkedUnder, ctx);
    if (!id) return false;
    const area = ix.descendants(id);
    for (const x of ix.connected(item.id)) if (x === id || area.has(x)) return true;
    return false;
  }
  if ("status" in c) {
    const s = statusOf(item, ix.schemaOf(item));
    if (!s) return false;
    if (c.status === "open") return s.group !== "done";
    if (c.status === "new") return s.group === "todo";
    return s.group === c.status;
  }
  if ("inbox" in c) return !ctx.inInbox && !setAside(item) && matches(item, inboxWhere(ix), { ...ctx, thisId: undefined, inInbox: true });
  if ("without" in c) {
    switch (c.without) {
      case "type":
        return item.kind === "info" && item.type !== META_TYPE && ix.typeOf(item) === null;
      case "parents":
        return ix.parentsOf(item.id).length === 0;
      case "children":
        return ix.childrenOf(item.id).length === 0;
      case "usage":
        return item.kind === "datei" ? ix.usedIn(item.id).length === 0 : !ix.backlinks(item.id).some((b) => b.kind !== "rel");
      case "openChildren":
        return ix.openChildren(item.id).length === 0;
    }
  }
  if ("file" in c) return item.kind === "datei";
  if ("pinned" in c) return !!item.pinned;
  if ("blocked" in c) return ix.isBlocked(item);
  if ("dormant" in c) return ix.isDormant(item);
  if ("filetype" in c) return item.file?.filetype === c.filetype;
  if ("text" in c) {
    const hay = (item.title + "\n" + item.tags.join(" ") + "\n" + item.body + "\n" + (item.file?.name ?? "")).toLowerCase();
    return c.text
      .toLowerCase()
      .split(/\s+/)
      .every((w) => hay.includes(w));
  }
  return matchField(item, c, ctx);
}

function leaves(c: Cond | undefined, out: Cond[] = []): Cond[] {
  if (!c) return out;
  if ("and" in c) c.and.forEach((x) => leaves(x, out));
  else if ("or" in c) c.or.forEach((x) => leaves(x, out));
  else if ("not" in c) leaves(c.not, out);
  else out.push(c);
  return out;
}

/** Type ids a query refers to that no longer exist ("Typ gelöscht"). */
export function missingTypes(c: Cond | undefined, ix: Index): string[] {
  return leaves(c).flatMap((x) => {
    if ("type" in x && x.type !== META_TYPE && !ix.types.has(x.type)) return [x.type];
    if ("typeName" in x) return [x.typeName];
    return [];
  });
}

export function typesIn(c: Cond | undefined): string[] {
  return leaves(c).flatMap((x) => ("type" in x ? [x.type] : []));
}

/** Types the query names plus those of the first `sample` items, existing ones only. */
export function viewTypeIds(where: Cond | undefined, items: Pick<Item, "type">[], ix: Index, sample = 200): string[] {
  return [...new Set([...typesIn(where), ...items.slice(0, sample).map((i) => i.type ?? "")])].filter((id) => ix.types.has(id));
}

/** The node paths are relative to: the under:/in: target of the query, else the page. */
export function pathBase(def: QueryDef, ctx: EvalCtx): string | undefined {
  let base: string | undefined;
  const walk = (x: Cond) => {
    if (base) return;
    if ("and" in x) x.and.forEach(walk);
    else if ("under" in x) base = resolveRef(x.under, ctx);
    else if ("in" in x) base = resolveRef(x.in, ctx);
  };
  if (def.where) walk(def.where);
  return base ?? ctx.thisId;
}

export interface QueryResult {
  items: Item[];
  total: number;
  missingTypes: string[];
}

export function runQuery(def: QueryDef, ctx: EvalCtx): QueryResult {
  const ix = ctx.ix;
  const missing = missingTypes(def.where, ix);
  const wantTypes = typesIn(def.where).includes(META_TYPE);
  let items = ix.live.filter((i) => (wantTypes || i.type !== META_TYPE) && (!def.where || matches(i, def.where, ctx)));
  items = sortItems(items, def.sort, ix);
  const total = items.length;
  if (def.limit) items = items.slice(0, def.limit);
  return { items, total, missingTypes: missing };
}

const GROUP_RANK: Record<string, number> = { active: 0, todo: 1, done: 3 };
const NO_STATUS_RANK = 2; // between not started and done

function sortItems(items: Item[], sort: QueryDef["sort"], ix: Index): Item[] {
  const keyed = items.map((i) => ({ i, k: sortKeys(i, sort, ix) }));
  keyed.sort((a, b) => {
    for (let n = 0; n < a.k.length; n++) {
      const x = a.k[n]!;
      const y = b.k[n]!;
      const desc = sort?.[n]?.desc;
      if (x.v === y.v) continue;
      if (x.v === undefined) return 1; // empty values last, in both directions
      if (y.v === undefined) return -1;
      const diff = typeof x.v === "number" && typeof y.v === "number" ? x.v - y.v : String(x.v).localeCompare(String(y.v), undefined, { numeric: true });
      return desc ? -diff : diff;
    }
    return a.i.title.localeCompare(b.i.title);
  });
  return keyed.map((x) => x.i);
}

function sortKeys(item: Item, sort: QueryDef["sort"], ix: Index): { v: string | number | undefined }[] {
  const schema = ix.schemaOf(item);
  if (!sort?.length) {
    const s = statusOf(item, schema);
    return [{ v: s ? GROUP_RANK[s.group] : NO_STATUS_RANK }, { v: dueOf(item, schema) }, { v: item.title.toLowerCase() }];
  }
  return sort.map((s) => {
    if (s.key === "created") return { v: item.created };
    if (s.key === "updated") return { v: item.updated };
    if (s.key === "title") return { v: item.title.toLowerCase() };
    if (titleKey(s.key) === "status") {
      const st = statusOf(item, schema);
      return { v: st ? GROUP_RANK[st.group]! * 100 + (statusProp(schema)?.options?.indexOf(st.option) ?? 0) : undefined };
    }
    const hit = fieldOf(item, s.key, ix);
    if (!hit || isEmpty(hit.value)) return { v: undefined };
    if (hit.prop?.options && typeof hit.value === "string") return { v: hit.prop.options.findIndex((o) => o.id === hit.value) };
    if (Array.isArray(hit.value)) return { v: hit.value.join(",") };
    if (typeof hit.value === "number") return { v: hit.value };
    if (typeof hit.value === "boolean") return { v: hit.value ? 1 : 0 };
    return { v: String(hit.value).toLowerCase() };
  });
}

export interface Group {
  key: string;
  path?: string[]; // ids, for group "path"
  label?: string; // for status/type/property groups
  statusGroup?: string;
  option?: OptionDef; // grouped by a status or select option: its color
  ref?: string; // grouped by an entry (project, area, relation): its id
  items: Item[];
}

const FLOW: Record<string, number> = { todo: 0, active: 1, done: 2 };
const UNRANKED = 9999;

/** Hidden groups are stored by option or entry id, so a rename keeps them hidden. */
export function groupId(g: Group): string {
  return g.option?.id ?? g.ref ?? g.key;
}

/**
 * Path groups are relative to `base`; sub-items stay with a listed parent. Status groups follow the
 * flow todo, active, done, then option order. Items without a value come last. With `empty`, every
 * option of the grouped property is a group even without items, unless the query's status rules it out.
 */
export function groupItems(items: Item[], by: string | undefined, ctx: EvalCtx, base?: string, empty?: { types: string[]; where?: Cond }): Group[] {
  if (!by) return [{ key: "", items }];
  const ix = ctx.ix;
  const groups = new Map<string, Group>();
  const add = (key: string, g: Omit<Group, "items" | "key">, item?: Item) => {
    let x = groups.get(key);
    if (!x) groups.set(key, (x = { key, ...g, items: [] }));
    if (item) x.items.push(item);
  };
  const rank = new Map<string, number>(); // option order, for status and select groups
  const byStatus = by === "status" || by === "statusGroup";
  const ranked = (p: PropDef | undefined) =>
    p?.options?.forEach((o, n) => {
      if (!rank.has(o.name)) rank.set(o.name, (byStatus ? (FLOW[o.group ?? "todo"] ?? 0) * 100 : 0) + n);
    });
  for (const i of items) {
    if (by === "path") {
      let path = base ? (ix.relPath(base, i.id) ?? ix.homePath(i.id)) : ix.homePath(i.id);
      // A sub-task shows with its parent task's group: cut the path at the first listed ancestor.
      const inList = path.findIndex((p) => items.some((x) => x.id === p));
      if (inList >= 0) path = path.slice(0, inList);
      add(path.join("/"), { path }, i);
    } else if (by === "status") {
      const s = statusOf(i, ix.schemaOf(i));
      ranked(statusProp(ix.schemaOf(i)));
      add(s ? s.option.name : "", { label: s?.option.name, statusGroup: s?.group, option: s?.option }, i);
    } else if (by === "statusGroup") {
      const s = statusOf(i, ix.schemaOf(i));
      add(s ? s.group : "", { statusGroup: s?.group }, i);
    } else if (by === "type") {
      add(i.type ?? "", { label: ix.typeName(i.type) }, i);
    } else {
      const hit = fieldOf(i, by, ix);
      if (hit?.prop?.options) ranked(hit.prop);
      if (!hit || isEmpty(hit.value)) add("", {}, i);
      else if (hit.prop?.options) {
        const ids = asIds(hit.value);
        const opts = ids.map((id) => hit.prop!.options!.find((o) => o.id === id));
        const label = optionNames(hit.prop, ids).join(", ");
        add(label, { label, option: opts.length === 1 ? opts[0] : undefined }, i);
      } else if (hit.kind === "item") {
        const id = String(hit.value);
        add(id, { label: ix.get(id)?.title ?? "", ref: id }, i);
      } else if (hit.kind === "relation") {
        const ids = hit.value as string[];
        add(ids.join(","), { label: ids.map((id) => ix.get(id)?.title ?? "").join(", "), ref: ids.length === 1 ? ids[0] : undefined }, i);
      } else add(String(hit.value), { label: String(hit.value) }, i);
    }
  }
  // empty option groups give a drop target and a "+ Neu" button
  if (empty?.types.length && by !== "path" && by !== "type") {
    const schemas = empty.types.map((id) => ix.types.get(id)?.schema).filter(Boolean);
    if (by === "statusGroup") {
      if (schemas.some((sc) => statusProp(sc))) for (const g of STATUS_GROUPS) add(g, { statusGroup: g });
    } else
      for (const sc of schemas) {
        const p = by === "status" ? statusProp(sc) : sc!.properties.find((x) => titleKey(x.name) === titleKey(by) && x.kind === "select");
        ranked(p);
        for (const o of p?.options ?? []) add(o.name, { label: o.name, statusGroup: by === "status" ? (o.group ?? "todo") : undefined, option: o });
      }
  }
  const allowed = statusGroupsAllowed(empty?.where);
  const out = [...groups.values()].filter((g) => g.items.length || !allowed || !g.statusGroup || allowed.has(g.statusGroup));
  const emptyLast = (a: Group, b: Group) => (a.key === "" ? 1 : 0) - (b.key === "" ? 1 : 0);
  const pathOrder = (a: Group, b: Group) => {
    if (a.key === "") return -1;
    if (b.key === "") return 1;
    return ix.pathText(a.path ?? []).localeCompare(ix.pathText(b.path ?? []));
  };
  if (by === "path") out.sort(pathOrder);
  else if (by === "statusGroup") out.sort((a, b) => emptyLast(a, b) || (FLOW[a.key] ?? 3) - (FLOW[b.key] ?? 3));
  else if (rank.size) out.sort((a, b) => emptyLast(a, b) || (rank.get(a.key) ?? UNRANKED) - (rank.get(b.key) ?? UNRANKED) || a.key.localeCompare(b.key));
  else out.sort((a, b) => emptyLast(a, b) || (a.label ?? a.key).localeCompare(b.label ?? b.key, undefined, { numeric: true }));
  return out;
}

/**
 * Status groups the query's top-level conditions allow; undefined when it has none. Hides empty
 * groups like "Erledigt · 0" under "offene Tasks".
 */
function statusGroupsAllowed(where: Cond | undefined): Set<string> | undefined {
  let out: Set<string> | undefined;
  for (const c of where ? conjuncts(where) : []) {
    if (!("status" in c)) continue;
    const g = new Set(statusKeyGroups(c.status));
    out = out ? new Set([...out].filter((x) => g.has(x))) : g;
  }
  return out;
}

function statusKeyGroups(key: StatusKey): string[] {
  if (key === "open") return ["todo", "active"];
  if (key === "new") return ["todo"];
  return [key];
}

/** Stored blocks are JSON; text form comes from typing by hand or from agents. */
export function readBlock(src: string, ix: Index): { def: QueryDef; errors: string[]; wasText: boolean } {
  const s = src.trim();
  if (s.startsWith("{")) {
    try {
      return { def: JSON.parse(s) as QueryDef, errors: [], wasText: false };
    } catch {
      /* fall through to text */
    }
  }
  const { def, errors } = parseQuery(s, ix);
  return { def, errors, wasText: true };
}

export function blockSource(def: QueryDef): string {
  return JSON.stringify(def);
}

export function queryFence(src: string): string {
  return "```abfrage\n" + src + "\n```";
}

/** The fence info string of a query block (```abfrage, ```query). */
export function isQueryInfo(info: string): boolean {
  return info === "abfrage" || info === "query";
}

type Block = { from: number; to: number; src: string };

export function findBlocks(body: string): Block[] {
  const out: Block[] = [];
  for (const m of body.matchAll(QUERY_FENCE)) out.push({ from: m.index!, to: m.index! + m[0].length, src: ((m[1] ?? "") + "\n" + (m[2] ?? "")).trim() });
  // single-line form: ```abfrage typ:Task```
  const inline = /```(?:abfrage|query)[ \t]+([^`\n]+)```/g;
  for (const m of body.matchAll(inline)) if (!out.some((b) => m.index! >= b.from && m.index! < b.to)) out.push({ from: m.index!, to: m.index! + m[0].length, src: m[1]!.trim() });
  return out.sort((a, b) => a.from - b.from);
}

/** Text-form blocks (from agents and fast typists) become the stored JSON. */
export function normalizeBlocks(body: string, ix: Index): string {
  return replaceBlocks(body, (b) => {
    const { def, wasText } = readBlock(b.src, ix);
    return wasText ? queryFence(blockSource(def)) : body.slice(b.from, b.to);
  });
}

/** For agents and the Markdown mirror. */
export function blocksAsText(body: string, lang: Lang, ix: Index): string {
  return replaceBlocks(body, (b) => queryFence(printQuery(readBlock(b.src, ix).def, lang, ix)));
}

/** Replaces each query block of the body with what `fn` returns for it. */
function replaceBlocks(body: string, fn: (b: Block) => string): string {
  const blocks = findBlocks(body);
  if (!blocks.length) return body;
  let out = "";
  let pos = 0;
  for (const b of blocks) {
    out += body.slice(pos, b.from) + fn(b);
    pos = b.to;
  }
  return out + body.slice(pos);
}

/** Items already shown by in:diese or unter:diese blocks, so the page lists them once. */
export function shownByBlocks(item: Item, ix: Index): Set<string> {
  const out = new Set<string>();
  for (const b of findBlocks(item.body)) {
    const { def } = readBlock(b.src, ix);
    if (!usesInThis(def.where)) continue;
    for (const i of runQuery(def, { ix, thisId: item.id }).items) out.add(i.id);
  }
  return out;
}

/** in:diese or unter:diese, outside of any negation. */
function usesInThis(c: Cond | undefined): boolean {
  if (!c) return false;
  if ("and" in c) return c.and.some(usesInThis);
  if ("or" in c) return c.or.some(usesInThis);
  if ("not" in c) return false;
  return ("in" in c && "this" in c.in) || ("under" in c && "this" in c.under);
}

/** Keeps AND flat so it reads as one line of chips. */
export function andWhere(a: Cond | undefined, b: Cond | undefined): Cond | undefined {
  if (!a || !b) return a ?? b;
  return { and: [...conjuncts(a), ...conjuncts(b)] };
}

export function tabDef(base: Cond | undefined, tab: ViewTab): QueryDef {
  return { where: andWhere(base, tab.where), sort: tab.sort, group: tab.group, columns: tab.columns, view: tab.kind };
}
