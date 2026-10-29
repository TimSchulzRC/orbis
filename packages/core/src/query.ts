// Query engine: stored as JSON with ids, typed and shown as text in any UI language.
//
//   typ:Task status:offen unter:[[Relaunch]] fällig<=+7d sort:fällig gruppe:pfad
//   (typ:Person | #people) #autor
//   typ:Projekt in:diese -status:erledigt ansicht:board gruppe:status
//
// Space = AND, | = OR, - = NOT, parentheses group. Properties are found by name across all
// types and free properties. The same code runs on devices, the server and for agents.
import { type ViewTab, type FileType, type Item, type OptionDef, type PropDef, type ViewKind, FILE_TYPES, META_TYPE, titleKey, todayISO } from "./model";
import type { Index } from "./graph";
import { inboxWhere } from "./inbox";
import { type Lang, LANGS, words } from "./i18n";
import { dateEnd, dateStart, doneAt, dueOf, statusOf, statusProp } from "./traits";
import { optionMatches, parseDate, statusGroupOf } from "./input";

/** Is this word the name of a status option of some type? Then it means that option, not a group. */
function byOptionName(ix: Index, word: string): boolean {
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
  | { linkedUnder: Ref } // verknüpft:unter:[[X]] – connected to X or to a descendant of X
  | { prop: string; op: Op; value?: FieldValue }
  | { status: StatusKey }
  | { inbox: true } // whatever the inbox rule matches (inbox.ts)
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
  /** query blocks with more than one view: the views as tabs (the fields above mirror the first) */
  tabs?: ViewTab[];
}

// Built-in fields, stored neutral.
export const FIELDS = ["title", "created", "updated", "due", "done", "next", "area", "project", "subtasks", "progress"] as const;
const GROUPS = ["path", "status", "statusGroup", "type"] as const;
const VIEWS: ViewKind[] = ["list", "table", "board", "tree", "gallery", "triage", "calendar", "timeline"];
const STATUS_KEYS: StatusKey[] = ["open", "new", "active", "done"];

// ---------- keywords ----------

type KwTable = Map<string, string>; // word -> neutral key
let kwCache: Record<string, KwTable> | null = null;

const KW_KEYS = {
  key: ["type", "under", "in", "linked", "status", "filetype", "without", "sort", "group", "view", "columns", "limit", "collapsed"],
  bare: ["inbox", "file", "pinned", "blocked", "dormant"],
  value: ["this", "empty", "today", "yes"],
  field: [...FIELDS],
  status: STATUS_KEYS,
  groupBy: [...GROUPS],
  view: VIEWS,
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

function fold(s: string) {
  return s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
}

const kw = (cat: keyof typeof KW_KEYS, word: string) => tables()[cat]!.get(fold(word));
const say = (lang: Lang, cat: string, key: string) => words(lang, `q.${cat}.${key}`)[0] ?? key;

// ---------- parsing ----------

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
    if (c === "-" && i + 1 < src.length && !/\s/.test(src[i + 1]!) && (out.length === 0 || out.at(-1)!.t !== "term" || /\s|\(|\|/.test(src[i - 1] ?? " "))) {
      out.push({ t: "-" });
      i++;
      continue;
    }
    let j = i;
    let v = "";
    while (j < src.length) {
      const ch = src[j]!;
      if (src.startsWith("[[", j)) {
        const end = src.indexOf("]]", j);
        const stop = end < 0 ? src.length : end + 2;
        v += src.slice(j, stop);
        j = stop;
        continue;
      }
      if (ch === '"') {
        const end = src.indexOf('"', j + 1);
        const stop = end < 0 ? src.length : end + 1;
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
        const mt = words("de", "q.metaType").concat(words("en", "q.metaType")).some((w) => fold(w) === fold(value));
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
        if (sub && kw("key", sub[1]!) === "under") {
          const r = ref(sub[2]!);
          if ("unresolved" in r) {
            errors.push(`link:${r.unresolved}`);
            return { unresolved: r.unresolved };
          }
          return { linkedUnder: r };
        }
        const r = ref(value);
        if ("unresolved" in r) {
          errors.push(`link:${r.unresolved}`);
          return { unresolved: r.unresolved };
        }
        return key === "under" ? { under: r } : key === "in" ? { in: r } : { linked: r };
      }
      case "status": {
        const s = kw("status", value) as StatusKey | undefined;
        if (s) return { status: s };
        // a synonym of a whole group ("in Arbeit", "fertig") is the group; option names stay names
        const g = statusGroupOf(value);
        if (g && !byOptionName(ix, value)) return { status: g === "todo" ? "new" : g };
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
        // zu:ja – the block starts closed (a card on the start page: "Kürzlich erledigt")
        if (kw("value", value) === "yes") def.collapsed = true;
        return null;
    }
    // property (by name) or built-in field
    const prop = kw("field", keyRaw) ?? keyRaw;
    if (kw("value", value) === "empty") return { prop, op: "empty" };
    if (value.startsWith("[[") || kw("value", value) === "this") {
      const r = ref(value);
      if ("unresolved" in r) {
        errors.push(`link:${r.unresolved}`);
        return { unresolved: r.unresolved };
      }
      return { prop, op, value: { ref: r } };
    }
    const today = kw("value", value) === "today";
    return { prop, op, value: today ? "+0d" : value };
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
    return parts.length === 0 ? null : parts.length === 1 ? parts[0]! : { or: parts };
  };
  const parseAnd = (): Cond | null => {
    const parts: Cond[] = [];
    while (pos < toks.length && toks[pos]!.t !== ")" && toks[pos]!.t !== "|") {
      const c = parseUnary();
      if (c) parts.push(c);
    }
    return parts.length === 0 ? null : parts.length === 1 ? parts[0]! : { and: parts };
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
    if (c) where = where ? { and: [...("and" in where ? where.and : [where]), c] } : c;
    if (toks[pos]?.t === ")") pos++;
  }
  if (where) def.where = where;
  return { def, errors };
}

// ---------- printing ----------

export function printQuery(def: QueryDef, lang: Lang, ix: Index): string {
  const parts: string[] = [];
  if (def.where) parts.push(printCond(def.where, lang, ix, true));
  const k = (key: string) => say(lang, "key", key);
  const field = (f: string) => ((FIELDS as readonly string[]).includes(f) ? say(lang, "field", f) : quoteIf(f));
  if (def.sort?.length) parts.push(`${k("sort")}:${def.sort.map((s) => (s.desc ? "-" : "") + field(s.key)).join(",")}`);
  if (def.group) parts.push(`${k("group")}:${(GROUPS as readonly string[]).includes(def.group) ? say(lang, "groupBy", def.group) : field(def.group)}`);
  if (def.view) parts.push(`${k("view")}:${say(lang, "view", def.view)}`);
  if (def.columns?.length) parts.push(`${k("columns")}:${def.columns.map(field).join(",")}`);
  if (def.limit) parts.push(`${k("limit")}:${def.limit}`);
  if (def.collapsed) parts.push(`${k("collapsed")}:${say(lang, "value", "yes")}`);
  return parts.filter(Boolean).join(" ");
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
  const name = (FIELDS as readonly string[]).includes(c.prop) ? say(lang, "field", c.prop) : quoteIf(c.prop);
  if (c.op === "empty") return `${name}:${say(lang, "value", "empty")}`;
  const v = c.value;
  let vs = typeof v === "object" && v ? printRef(v.ref, lang, ix) : String(v ?? "");
  if (vs === "+0d") vs = say(lang, "value", "today");
  else if (typeof v === "string") vs = quoteIf(vs);
  return `${name}${c.op}${vs}`;
}

// ---------- evaluation ----------

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

/** The value of a field (built-in, type property or free property) on an item, by name. */
export function fieldOf(item: Item, name: string, ix: Index): FieldHit | undefined {
  switch (name) {
    case "title":
      return { kind: "text", value: item.title };
    case "created":
      return { kind: "date", value: todayISO(new Date(item.created)) };
    case "updated":
      return { kind: "date", value: todayISO(new Date(item.updated)) };
    case "due": {
      const d = dueOf(item, ix.schemaOf(item));
      return d ? { kind: "date", value: d } : undefined;
    }
    case "done": {
      const d = doneAt(item, ix.schemaOf(item));
      return d ? { kind: "date", value: todayISO(new Date(d)) } : undefined;
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
      const p = ix.project(item.id);
      return p ? { kind: "item", value: p } : undefined;
    }
    case "progress": {
      // done share of what lies below (with a status), as a percentage
      const pr = ix.progressOf(item);
      return pr && pr.total ? { kind: "number", value: Math.round((pr.done / pr.total) * 100) } : undefined;
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
    if (p.kind === "computed") {
      const c = p.computed;
      const v = c?.fn === "count" ? ix.countDescendants(item.id, c.of) : (() => {
        const pr = ix.progress(item.id, c?.of);
        return pr.total ? Math.round((pr.done / pr.total) * 100) : undefined;
      })();
      return { kind: "number", value: v, prop: p };
    }
    return { kind: p.kind, value: item.props[p.id], prop: p };
  }
  for (const [n, fv] of Object.entries(item.extra)) if (titleKey(n) === key) return { kind: fv.k, value: fv.v };
  // the other side of a relation, by its inverse name ("Blockiert diese")
  for (const t of ix.types.values())
    for (const p of t.schema!.properties)
      if (p.kind === "relation" && !p.symmetric && p.inverseName && titleKey(p.inverseName) === key)
        return { kind: "relation", value: ix.backlinks(item.id).filter((b) => b.kind === "rel" && b.prop === p.id && ix.get(b.from)?.type === t.id).map((b) => b.from), prop: { ...p, name: p.inverseName }, inverse: true };
  return undefined;
}

/** A date in a query (+7d, heute, 30.10.2026, 10/30/2026 …) → ISO; "2026-10" stays a month. */
export function relDate(v: string, today: string): string | undefined {
  if (/^\d{4}-\d{2}$/.test(v.trim())) return v.trim();
  return parseDate(v, today);
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return undefined;
  const n = Number(v.replace(/\s/g, "").replace(",", "."));
  return isNaN(n) ? undefined : n;
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

function matchField(item: Item, c: { prop: string; op: Op; value?: FieldValue }, ctx: EvalCtx): boolean {
  const hit = fieldOf(item, c.prop, ctx.ix);
  if (c.op === "empty") return !hit || isEmpty(hit.value);
  if (!hit || isEmpty(hit.value)) return c.op === "!=";
  const v = c.value;
  if (typeof v === "object" && v && "ref" in v) {
    const target = resolveRef(v.ref, ctx);
    const vals = Array.isArray(hit.value) ? (hit.value as string[]) : [String(hit.value)];
    const has = !!target && vals.includes(target);
    return c.op === "!=" ? !has : c.op === ":" && has;
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
      const b = ["ja", "yes", "true", "1", "wahr", "x"].includes(want.toLowerCase());
      return cmp(hit.value === true ? 1 : 0, b ? 1 : 0, c.op === ":" ? ":" : c.op);
    }
    case "select": {
      const ids = Array.isArray(hit.value) ? (hit.value as string[]) : [String(hit.value)];
      const names = hit.prop ? ids.map((id) => hit.prop!.options?.find((o) => o.id === id)?.name ?? id) : ids;
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
      return c.op === "!=" ? !has : c.op === ":" && has;
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
  if ("inbox" in c) return !ctx.inInbox && matches(item, inboxWhere(ix), { ...ctx, thisId: undefined, inInbox: true });
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

/** Type ids a query refers to that no longer exist ("Typ gelöscht"). */
export function missingTypes(c: Cond | undefined, ix: Index): string[] {
  const out: string[] = [];
  const walk = (x: Cond) => {
    if ("and" in x) x.and.forEach(walk);
    else if ("or" in x) x.or.forEach(walk);
    else if ("not" in x) walk(x.not);
    else if ("type" in x && x.type !== META_TYPE && !ix.types.has(x.type)) out.push(x.type);
    else if ("typeName" in x) out.push(x.typeName);
  };
  if (c) walk(c);
  return out;
}

function mentionsType(c: Cond | undefined, id: string): boolean {
  if (!c) return false;
  if ("and" in c) return c.and.some((x) => mentionsType(x, id));
  if ("or" in c) return c.or.some((x) => mentionsType(x, id));
  if ("not" in c) return mentionsType(c.not, id);
  return "type" in c && c.type === id;
}

export function typesIn(c: Cond | undefined): string[] {
  const out: string[] = [];
  const walk = (x: Cond) => {
    if ("and" in x) x.and.forEach(walk);
    else if ("or" in x) x.or.forEach(walk);
    else if ("not" in x) walk(x.not);
    else if ("type" in x) out.push(x.type);
  };
  if (c) walk(c);
  return out;
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
  const wantTypes = mentionsType(def.where, META_TYPE);
  let items = ix.live.filter((i) => (wantTypes || i.type !== META_TYPE) && (!def.where || matches(i, def.where, ctx)));
  items = sortItems(items, def.sort, ix);
  const total = items.length;
  if (def.limit) items = items.slice(0, def.limit);
  return { items, total, missingTypes: missing };
}

const GROUP_RANK: Record<string, number> = { active: 0, todo: 1, done: 3 };

export function sortItems(items: Item[], sort: QueryDef["sort"], ix: Index): Item[] {
  const keyed = items.map((i) => ({ i, k: sortKeys(i, sort, ix) }));
  keyed.sort((a, b) => {
    for (let n = 0; n < a.k.length; n++) {
      const x = a.k[n]!;
      const y = b.k[n]!;
      const desc = sort?.[n]?.desc;
      if (x.v === y.v) continue;
      if (x.v === undefined) return 1; // empty values last, in both directions
      if (y.v === undefined) return -1;
      const r = typeof x.v === "number" && typeof y.v === "number" ? x.v - y.v : String(x.v).localeCompare(String(y.v), undefined, { numeric: true });
      return desc ? -r : r;
    }
    return a.i.title.localeCompare(b.i.title);
  });
  return keyed.map((x) => x.i);
}

function sortKeys(item: Item, sort: QueryDef["sort"], ix: Index): { v: string | number | undefined }[] {
  if (!sort?.length) {
    // Default: active before not started before done, then due date, then title.
    const s = statusOf(item, ix.schemaOf(item));
    return [{ v: s ? GROUP_RANK[s.group] : 2 }, { v: dueOf(item, ix.schemaOf(item)) }, { v: item.title.toLowerCase() }];
  }
  return sort.map((s) => {
    if (s.key === "created") return { v: item.created };
    if (s.key === "updated") return { v: item.updated };
    if (s.key === "title") return { v: item.title.toLowerCase() };
    if (titleKey(s.key) === "status") {
      const st = statusOf(item, ix.schemaOf(item));
      return { v: st ? GROUP_RANK[st.group]! * 100 + (statusProp(ix.schemaOf(item))?.options?.indexOf(st.option) ?? 0) : undefined };
    }
    const hit = fieldOf(item, s.key, ix);
    if (!hit || isEmpty(hit.value)) return { v: undefined };
    if (hit.prop?.options && typeof hit.value === "string") return { v: hit.prop.options.findIndex((o) => o.id === hit.value) };
    if (Array.isArray(hit.value)) return { v: hit.value.join(",") };
    return { v: typeof hit.value === "number" ? hit.value : typeof hit.value === "boolean" ? (hit.value ? 1 : 0) : String(hit.value).toLowerCase() };
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

/** How a group is remembered (hidden groups): the option or entry it stands for, so a rename keeps it. */
export function groupId(g: Group): string {
  return g.option?.id ?? g.ref ?? g.key;
}

/**
 * Group results. Path groups use the way below `base`; sub-items (whose parent is in the list)
 * stay with that parent. Status groups follow the flow (open, active, done; within a group the
 * order of the options); entries without a value come last. With `empty`, every option of the
 * grouped property (in these types) is a group, also without entries – unless the query's
 * status condition rules it out.
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
  const ranked = (p: PropDef | undefined) => p?.options?.forEach((o, n) => !rank.has(o.name) && rank.set(o.name, (by === "status" || by === "statusGroup" ? (FLOW[o.group ?? "todo"] ?? 0) * 100 : 0) + n));
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
        const ids = Array.isArray(hit.value) ? (hit.value as string[]) : [String(hit.value)];
        const opts = ids.map((id) => hit.prop!.options!.find((o) => o.id === id));
        const label = opts.map((o, n) => o?.name ?? ids[n]).join(", ");
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
  // every option a group of its own, also an empty one (a place to drag to, "+ Neu" in it)
  if (empty?.types.length && by !== "path" && by !== "type") {
    const schemas = empty.types.map((id) => ix.types.get(id)?.schema).filter(Boolean);
    if (by === "statusGroup") {
      if (schemas.some((sc) => statusProp(sc))) for (const g of ["todo", "active", "done"]) add(g, { statusGroup: g });
    } else
      for (const sc of schemas) {
        const p = by === "status" ? statusProp(sc) : sc!.properties.find((x) => titleKey(x.name) === titleKey(by) && x.kind === "select");
        ranked(p);
        for (const o of p?.options ?? []) add(o.name, { label: o.name, statusGroup: by === "status" ? (o.group ?? "todo") : undefined, option: o });
      }
  }
  const allowed = statusGroupsAllowed(empty?.where);
  const out = [...groups.values()].filter((g) => g.items.length || !allowed || !g.statusGroup || allowed.has(g.statusGroup));
  const last = (a: Group, b: Group) => (a.key === "" ? 1 : 0) - (b.key === "" ? 1 : 0);
  if (by === "path") out.sort((a, b) => (a.key === "" ? -1 : b.key === "" ? 1 : pathLabel(a, ix).localeCompare(pathLabel(b, ix))));
  else if (by === "statusGroup") out.sort((a, b) => last(a, b) || (FLOW[a.key] ?? 3) - (FLOW[b.key] ?? 3));
  else if (rank.size) out.sort((a, b) => last(a, b) || (rank.get(a.key) ?? 9999) - (rank.get(b.key) ?? 9999) || a.key.localeCompare(b.key));
  else out.sort((a, b) => last(a, b) || (a.label ?? a.key).localeCompare(b.label ?? b.key, undefined, { numeric: true }));
  return out;
}

/**
 * The status groups a query lets through (status:offen → todo and active), read from its
 * top-level conditions; undefined when it does not say. Empty option groups outside of it are
 * not shown – "Erledigt · 0" under "offene Tasks" says nothing.
 */
export function statusGroupsAllowed(where: Cond | undefined): Set<string> | undefined {
  let out: Set<string> | undefined;
  for (const c of where ? ("and" in where ? where.and : [where]) : []) {
    if (!("status" in c)) continue;
    const g = new Set(c.status === "open" ? ["todo", "active"] : c.status === "new" ? ["todo"] : [c.status]);
    out = out ? new Set([...out].filter((x) => g.has(x))) : g;
  }
  return out;
}

const pathLabel = (g: Group, ix: Index) => (g.path ?? []).map((id) => ix.get(id)?.title ?? "").join(" › ");

// ---------- helpers ----------

/** Parse a stored block: JSON (normal) or text form (typed by hand or by an agent). */
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

/** All ```abfrage blocks in a body, with their positions. */
export function findBlocks(body: string): { from: number; to: number; src: string }[] {
  const out: { from: number; to: number; src: string }[] = [];
  const re = /^```(?:abfrage|query)[ \t]*(.*)\n([\s\S]*?)^```[ \t]*$/gm;
  for (const m of body.matchAll(re)) out.push({ from: m.index!, to: m.index! + m[0].length, src: ((m[1] ?? "") + "\n" + (m[2] ?? "")).trim() });
  // single-line form: ```abfrage typ:Task```
  const inline = /```(?:abfrage|query)[ \t]+([^`\n]+)```/g;
  for (const m of body.matchAll(inline)) if (!out.some((b) => m.index! >= b.from && m.index! < b.to)) out.push({ from: m.index!, to: m.index! + m[0].length, src: m[1]!.trim() });
  return out.sort((a, b) => a.from - b.from);
}

/** Replace text-form blocks with JSON (what agents and fast typists write → what is stored). */
export function normalizeBlocks(body: string, ix: Index): string {
  const blocks = findBlocks(body);
  if (!blocks.length) return body;
  let out = "";
  let pos = 0;
  for (const b of blocks) {
    const { def, wasText } = readBlock(b.src, ix);
    out += body.slice(pos, b.from) + (wasText ? "```abfrage\n" + blockSource(def) + "\n```" : body.slice(b.from, b.to));
    pos = b.to;
  }
  return out + body.slice(pos);
}

/** Show blocks in text form (for agents and the Markdown mirror). */
export function blocksAsText(body: string, lang: Lang, ix: Index): string {
  const blocks = findBlocks(body);
  if (!blocks.length) return body;
  let out = "";
  let pos = 0;
  for (const b of blocks) {
    const { def } = readBlock(b.src, ix);
    out += body.slice(pos, b.from) + "```abfrage\n" + printQuery(def, lang, ix) + "\n```";
    pos = b.to;
  }
  return out + body.slice(pos);
}

/** What a query block in the text already shows (blocks with in:diese or unter:diese), so the page lists it once. */
export function shownByBlocks(item: Item, ix: Index): Set<string> {
  const out = new Set<string>();
  const usesIn = (c: Cond | undefined): boolean =>
    !!c && ("and" in c ? c.and.some(usesIn) : "or" in c ? c.or.some(usesIn) : "not" in c ? false : ("in" in c && "this" in c.in) || ("under" in c && "this" in c.under));
  for (const b of findBlocks(item.body)) {
    const { def } = readBlock(b.src, ix);
    if (!usesIn(def.where)) continue;
    for (const i of runQuery(def, { ix, thisId: item.id }).items) out.add(i.id);
  }
  return out;
}

/** Both conditions (flat: an AND stays one list, so it reads as one line of chips). */
export function andWhere(a: Cond | undefined, b: Cond | undefined): Cond | undefined {
  if (!a || !b) return a ?? b;
  return { and: [...("and" in a ? a.and : [a]), ...("and" in b ? b.and : [b])] };
}

/** What a view shows: the base query AND the tab's filter, with the tab's look. */
export function tabDef(base: Cond | undefined, tab: ViewTab): QueryDef {
  return { where: base ? andWhere(base, tab.where) : undefined, sort: tab.sort, group: tab.group, columns: tab.columns, view: tab.kind };
}
