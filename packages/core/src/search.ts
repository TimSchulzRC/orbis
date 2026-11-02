import MiniSearch from "minisearch";
import { type Item, isContent, mapWikiLinks, stripQueryBlocks } from "./model";
import { foldUmlauts, plainVowels } from "./text";
import { headingAt, outline } from "./outline";

// Shared by server (agents) and devices (offline) so both find the same.
//
// Spellings: terms are folded (lower case, ä→ae, ö→oe, ü→ue, ß→ss) when indexing and when
// searching, and indexed once more with plain vowels (ö→o), so "Juergen" finds "Jürgen" and
// "Grossenordnung" finds "Größenordnung". Hyphenated words are indexed as their parts and
// joined ("e-rechnung" → e, rechnung, erechnung); a hyphenated query searches the joined
// form, so "e-marketing" finds "Relaunch". Identifiers with underscores are indexed whole and
// as their parts ("Lieferschein_Muster_4711.pdf" → lieferschein, muster, 4711, the whole),
// a query searches their parts. Single letters are never prefixes ("C++"); terms with digits
// are never fuzzy (an invoice number must not find its neighbour).

const WORD = /[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu;

const foldTerm = foldUmlauts;

function tokenizeForIndex(text: string): string[] {
  const out: string[] = [];
  for (const [w] of text.matchAll(WORD)) {
    const segs = w.split("_").filter(Boolean);
    for (const seg of segs) {
      const parts = seg.split("-");
      out.push(...parts);
      if (parts.length > 1) out.push(parts.join(""));
    }
    if (segs.length > 1) out.push(w.replace(/-/g, ""));
  }
  return out;
}

/** Ids of the shipped status and priority options (st_*, pr_*): stored values, not words to search for. */
const OPTION_ID = /^(st|pr)_/;

function bodyText(doc: Item): string {
  return stripQueryBlocks(doc.body) + (doc.file ? ` ${doc.file.name} ${doc.file.text ?? ""}` : "") + (doc.schema ? ` ${doc.schema.description}` : "");
}

function propsText(doc: Item): string {
  const values = Object.values(doc.props).filter((v) => typeof v === "string" && !OPTION_ID.test(v));
  const free = Object.entries(doc.extra).map(([k, v]) => `${k} ${v.v}`);
  return [...values, ...free].join(" ");
}

function tokenizeForSearch(text: string): string[] {
  return [...text.matchAll(WORD)].flatMap(([w]) => w.split("_").filter(Boolean).map((seg) => seg.replace(/-/g, "")));
}

export function createIndex() {
  return new MiniSearch<Item>({
    fields: ["title", "tagText", "body", "props"],
    storeFields: ["id"],
    tokenize: tokenizeForIndex,
    processTerm: (term) => {
      const a = foldTerm(term);
      const b = plainVowels(term);
      return a === b ? a : [a, b];
    },
    extractField: (doc, field) => {
      if (field === "tagText") return doc.tags.join(" ");
      if (field === "body") return bodyText(doc);
      if (field === "props") return propsText(doc);
      return field === "title" || field === "id" ? doc[field] : "";
    },
    searchOptions: {
      tokenize: tokenizeForSearch,
      processTerm: foldTerm,
      boost: { title: 4, tagText: 2, props: 1.5 },
      prefix: (term) => term.length >= 3,
      fuzzy: (term) => (term.length >= 5 && !/\p{N}/u.test(term) ? 0.15 : false),
      combineWith: "AND",
    },
  });
}

export type SearchIndex = ReturnType<typeof createIndex>;

export function indexRecord(idx: SearchIndex, rec: Item) {
  if (idx.has(rec.id)) idx.discard(rec.id);
  if (isContent(rec)) idx.add(rec);
}

export function searchIds(idx: SearchIndex, query: string, limit = 20): string[] {
  return searchHits(idx, query, limit).map((h) => h.id);
}

/** The hits with the indexed terms each one matched (for excerpts of prefix and fuzzy matches). */
export function searchHits(idx: SearchIndex, query: string, limit = 20): { id: string; terms: string[] }[] {
  const q = query.trim();
  if (!q) return [];
  let res = idx.search(q);
  if (res.length === 0) res = idx.search(q, { combineWith: "OR" });
  return res.slice(0, limit).map((r) => ({ id: r.id as string, terms: r.terms }));
}

const TABLE_DELIMITER = /^[ \t]*\|?([ \t]*:?-+:?[ \t]*\|)+([ \t]*:?-+:?[ \t]*)?$/;

/** Tables as their cells ("a · b"): the header above a delimiter row and the rows below it up to a blank line. */
function tableCells(text: string): string {
  if (!text.includes("|")) return text;
  const lines = text.split("\n");
  const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").trim().split(/\s*(?<!\\)\|\s*/).join(" · ");
  for (let i = 1; i < lines.length; i++) {
    if (!TABLE_DELIMITER.test(lines[i]!) || !lines[i - 1]!.includes("|")) continue;
    lines[i - 1] = cells(lines[i - 1]!);
    lines[i] = "";
    // up to a blank line or another block (a heading, a quote, a list, a fence)
    for (i++; i < lines.length && lines[i]!.trim() && !/^\s*(#{1,6}\s|>|```|~~~|[-*+]\s|\d+[.)]\s)/.test(lines[i]!); i++) lines[i] = cells(lines[i]!);
  }
  return lines.join("\n");
}

/** Without Markdown marks, on one line. */
export function plainText(body: string): string {
  const marks = stripQueryBlocks(body)
    .replace(/^\s*```.*$/gm, "") // code fences (the code itself stays)
    .replace(/<br\s*\/?>/gi, " ") // line breaks (in table cells)
    .replace(/<[^>\n]+>/g, "") // html tags
    .replace(/!\[\[[^\]]*\]\]/g, "") // embedded files show as files, not as their name
    .replace(/!\[[^\]\n]*\](\([^)\n]*\))?/g, "") // markdown images and stray ![…]
    .replace(/^(\s*[-*+]\s+)\[[ xX]\]\s+/gm, "$1") // task list boxes
  return mapWikiLinks(tableCells(marks), (l) => l.label || l.target + l.section)
    .replace(/\\\|/g, "|")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+\.|#{1,6}|>)\s+/gm, "")
    .replace(/[*`~]{1,3}/g, "")
    // emphasis with underscores, not those inside words (identifiers, file names)
    .replace(/(^|[^\p{L}\p{N}_])_{1,3}(?=\S)/gu, "$1")
    .replace(/(?<=\S)_{1,3}(?![\p{L}\p{N}_])/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of a query as a text shows them: each whole (folded) and its parts at - and _. */
function textTerms(query: string): string[] {
  const out: string[] = [];
  for (const [w] of query.matchAll(WORD)) out.push(w, ...w.split(/[-_]+/));
  return [...new Set(out.map(foldTerm))].filter((t) => t.length > 1);
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** `text` folded letter by letter, with where each folded letter came from. */
function foldWithMap(text: string, fold: (s: string) => string): { folded: string; from: number[] } {
  let folded = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]!);
    folded += f;
    for (let k = 0; k < f.length; k++) from.push(i);
  }
  return { folded, from };
}

/**
 * Where in `text` the query is: an occurrence of its first word that occurs (the whole word
 * before its parts), the one with the most other words near it. Words are looked for where a word
 * starts (words under three letters whole), as the index matches them; only when none does,
 * anywhere. -1: none occurs.
 */
function hitIn(text: string, terms: string[], near: number): number {
  const folds = [foldTerm, plainVowels].map((fold) => ({ ...foldWithMap(text, fold), ts: terms.map(fold) }));
  for (const atStart of [true, false])
    for (const { folded, from, ts } of folds) {
      const find = (t: string, after: number) => {
        // short words are no prefixes in the index (see createIndex): they end where the word ends
        const whole = t.length < 3;
        for (let at = folded.indexOf(t, after); at >= 0; at = folded.indexOf(t, at + 1))
          if (!atStart || ((at === 0 || !WORD_CHAR.test(folded[at - 1]!)) && (!whole || !WORD_CHAR.test(folded[at + t.length] ?? "")))) return at;
        return -1;
      };
      const first = ts.find((t) => find(t, 0) >= 0);
      if (!first) continue;
      const others = ts.filter((t) => t !== first && !first.includes(t));
      let best = -1;
      let score = -1;
      for (let at = find(first, 0), n = 0; at >= 0 && n < 200; at = find(first, at + 1), n++) {
        const around = folded.slice(Math.max(0, at - near), at + near);
        const s = others.filter((t) => around.includes(t)).length;
        if (s > score) [best, score] = [at, s];
        if (score === others.length) break;
      }
      return from[best]!;
    }
  return -1;
}

export interface Excerpt {
  /** A short plain excerpt around the hit (the start of the text when no word of the query is in it). */
  text: string;
  /** The heading path the hit is under ("Status > Offene Punkte"), when it is under one. */
  heading?: string;
}

/**
 * A short plain excerpt of `body` centred on where the query is, and the heading it is under.
 * `matched`: the terms the index matched (a prefix or fuzzy match spelt as in the text), looked
 * for after the query's own words.
 */
export function excerpt(body: string, query: string, len = 160, matched: string[] = []): Excerpt {
  const terms = [...new Set([...textTerms(query), ...matched.map(foldTerm).filter((t) => t.length > 1)])];
  const pos = terms.length ? hitIn(body, terms, len / 2) : -1;
  if (pos < 0) {
    const flat = plainText(body);
    return { text: flat.slice(0, len) + (flat.length > len ? "…" : "") };
  }
  // the lines around the hit as plain text (whole lines, so Markdown marks are not cut), then the hit again inside them
  const lineStart = body.lastIndexOf("\n", Math.max(0, pos - len)) + 1;
  const lineEnd = body.indexOf("\n", Math.min(body.length, pos + len));
  const from = Math.max(lineStart, pos - len * 2);
  const to = Math.min(lineEnd < 0 ? body.length : lineEnd, pos + len * 2);
  const flat = plainText(body.slice(from, to));
  const at = Math.max(0, hitIn(flat, terms, len / 2));
  const start = Math.max(0, Math.min(at - Math.floor(len * 0.4), flat.length - len));
  const text = (start > 0 || from > 0 ? "…" : "") + flat.slice(start, start + len) + (start + len < flat.length || to < body.length ? "…" : "");
  const h = headingAt(outline(body), pos);
  return { text, heading: h?.path };
}

/** A short excerpt of `body` around the first matching term. */
export function snippet(body: string, query: string, len = 160): string {
  return excerpt(body, query, len).text;
}
