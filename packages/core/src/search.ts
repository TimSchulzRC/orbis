import MiniSearch from "minisearch";
import { type Item, isContent, mapWikiLinks, stripQueryBlocks } from "./model";
import { foldUmlauts, plainVowels } from "./text";

// Shared by server (agents) and devices (offline) so both find the same.
//
// Terms are folded (ä→ae, ß→ss) when indexing and searching, and also indexed with plain vowels
// (ö→o), so "Juergen" finds "Jürgen" and "Grossenordnung" finds "Größenordnung". Hyphenated words
// are indexed as their parts and joined ("e-rechnung" → e, rechnung, erechnung); a hyphenated
// query searches the joined form.

const WORD = /[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu;

const foldTerm = foldUmlauts;

function tokenizeForIndex(text: string): string[] {
  const out: string[] = [];
  for (const [w] of text.matchAll(WORD)) {
    const parts = w.split("-");
    out.push(...parts);
    if (parts.length > 1) out.push(parts.join(""));
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
  return [...text.matchAll(WORD)].map(([w]) => w.replace(/-/g, ""));
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
      fuzzy: (term) => (term.length >= 5 ? 0.15 : false),
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
  const q = query.trim();
  if (!q) return [];
  let res = idx.search(q);
  if (res.length === 0) res = idx.search(q, { combineWith: "OR" });
  return res.slice(0, limit).map((r) => r.id as string);
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
    .replace(/[*_`~]{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SNIPPET_LEAD = 50;

/** Folds like foldTerm; `from[i]` is the index in `text` that folded letter i came from. */
function foldWithOffsets(text: string): { folded: string; from: number[] } {
  let folded = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = foldTerm(text[i]!);
    folded += f;
    for (let k = 0; k < f.length; k++) from.push(i);
  }
  return { folded, from };
}

/** An excerpt of `body` around the first matching term. */
export function snippet(body: string, query: string, len = 160): string {
  const flat = plainText(body);
  const terms = tokenizeForSearch(query).map(foldTerm).filter((t) => t.length > 1);
  const { folded, from } = foldWithOffsets(flat);
  let pos = -1;
  for (const t of terms) {
    const at = folded.indexOf(t);
    if (at >= 0) {
      pos = from[at]!;
      break;
    }
  }
  if (pos < 0) return flat.slice(0, len) + (flat.length > len ? "…" : "");
  const start = Math.max(0, pos - SNIPPET_LEAD);
  return (start > 0 ? "…" : "") + flat.slice(start, start + len) + (start + len < flat.length ? "…" : "");
}
