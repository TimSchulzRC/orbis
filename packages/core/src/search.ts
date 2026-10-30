import MiniSearch from "minisearch";
import { type Item, isContent, stripQueryBlocks } from "./model";

// Same search on server (agents) and devices (offline), so both agree.
//
// Spellings: terms are folded (lower case, ä→ae, ö→oe, ü→ue, ß→ss) when indexing and when
// searching, and indexed once more with plain vowels (ö→o), so "Juergen" finds "Jürgen" and
// "Grossenordnung" finds "Größenordnung". Hyphenated words are indexed as their parts and
// joined ("e-rechnung" → e, rechnung, erechnung); a hyphenated query searches the joined
// form, so "e-marketing" finds "Relaunch". Single letters are never prefixes ("C++").

const WORD = /[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu;

/** Lower case, umlauts as two letters: the form every query term takes. */
function foldTerm(term: string): string {
  return term.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
}
const plainVowels = (term: string) => term.toLowerCase().replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss");

function tokenizeForIndex(text: string): string[] {
  const out: string[] = [];
  for (const [w] of text.matchAll(WORD)) {
    const parts = w.split("-");
    out.push(...parts);
    if (parts.length > 1) out.push(parts.join(""));
  }
  return out;
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
      if (field === "body") return stripQueryBlocks(doc.body) + (doc.file ? ` ${doc.file.name} ${doc.file.text ?? ""}` : "") + (doc.schema ? ` ${doc.schema.description}` : "");
      if (field === "props")
        return [...Object.values(doc.props).filter((v) => typeof v === "string" && !/^(st|pr)_/.test(v)), ...Object.entries(doc.extra).map(([k, v]) => `${k} ${v.v}`)].join(" ");
      return (doc as any)[field] ?? "";
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

/** A text without Markdown marks, on one line: for excerpts and previews. */
export function plainText(body: string): string {
  return stripQueryBlocks(body)
    .replace(/^\s*```.*$/gm, "") // code fences (the code itself stays)
    .replace(/<[^>\n]+>/g, "") // html tags
    .replace(/!\[\[[^\]]*\]\]/g, "") // embedded files show as files, not as their name
    .replace(/!\[[^\]\n]*\](\([^)\n]*\))?/g, "") // markdown images and stray ![…]
    .replace(/^(\s*[-*+]\s+)\[[ xX]\]\s+/gm, "$1") // task list boxes
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) => b ?? a)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+\.|#{1,6}|>)\s+/gm, "")
    .replace(/[*_`~]{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A short excerpt of `body` around the first matching term. */
export function snippet(body: string, query: string, len = 160): string {
  const flat = plainText(body);
  const terms = tokenizeForSearch(query).map(foldTerm).filter((t) => t.length > 1);
  // fold the text the same way, remembering where each folded letter came from
  let folded = "";
  const from: number[] = [];
  for (let i = 0; i < flat.length; i++) {
    const f = foldTerm(flat[i]!);
    folded += f;
    for (let k = 0; k < f.length; k++) from.push(i);
  }
  let pos = -1;
  for (const t of terms) {
    const at = folded.indexOf(t);
    if (at >= 0) {
      pos = from[at]!;
      break;
    }
  }
  if (pos < 0) return flat.slice(0, len) + (flat.length > len ? "…" : "");
  const start = Math.max(0, pos - 50);
  return (start > 0 ? "…" : "") + flat.slice(start, start + len) + (start + len < flat.length ? "…" : "");
}
