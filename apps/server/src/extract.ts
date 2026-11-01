// Text from file contents, for search and for agents (`get`). Stored in the file's `text`, like
// the text of a PDF. No programs and no extra packages: Office files and ZIPs are read with the
// ZIP reader below (zlib for the compressed parts), text files are decoded as they are.
//
//   Word, PowerPoint, Excel (docx, pptx, xlsx) and OpenDocument (odt, ods, odp): their text
//   ZIP and archives built on it (jar …): the list of entries
//   PDF: the pages' text and the files embedded in it (Factur-X/ZUGFeRD/XRechnung XML)
//   Outlook .msg: the readable strings in it
//   anything else that decodes as text (UTF-8, UTF-16 with BOM, else Windows-1252): the text,
//   HTML without its tags
import { inflateRawSync } from "node:zlib";

/** Raise when the extraction changes: every file is read again once. */
export const EXTRACT_VERSION = 1;
/** Stored text, in characters (it syncs to every device with the file's facts). */
export const TEXT_MAX = 100_000;
/** What is read of a text file. */
const TEXT_READ = 1024 * 1024;
/** One part of an Office file or an embedded file, unpacked. */
const PART_MAX = 32 * 1024 * 1024;
/** A ZIP's directory that is read at most. */
const DIRECTORY_MAX = 16 * 1024 * 1024;
/** Entries a ZIP's list shows. */
const LIST_MAX = 2000;

export interface Extracted {
  text?: string;
  pages?: number;
}

/** The mark stored in a file's facts once its content was read (version and content). */
export const extractMark = (hash: string) => `${EXTRACT_VERSION}:${hash.slice(0, 16)}`;

const cap = (s: string) => {
  const t = s.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > TEXT_MAX ? t.slice(0, TEXT_MAX) + "\n…" : t || undefined;
};

/** Text of the file at `path`; nothing for formats without text (images, audio, binaries). */
export async function extractText(path: string, name: string): Promise<Extracted> {
  const file = Bun.file(path);
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return pdfText(path); // %PDF
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    const zip = await Zip.open(path);
    if (!zip) return {};
    return { text: cap((await officeText(zip)) ?? zip.listing()) };
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0])) return ext === "msg" ? { text: cap(oleStrings(new Uint8Array(await file.slice(0, 16 * 1024 * 1024).arrayBuffer()))) } : {};
  const bytes = new Uint8Array(await file.slice(0, TEXT_READ).arrayBuffer());
  const text = decodeText(bytes, file.size > TEXT_READ);
  if (text === undefined) return {};
  return { text: cap(/^x?html?$/.test(ext) || /^\s*(<!doctype html|<html)/i.test(text.slice(0, 500)) ? htmlText(text) : text) };
}

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);

// ---------- text ----------

/**
 * Bytes as text, or undefined when they are not text (NUL bytes, many control characters).
 * `cut`: the bytes end inside the file, a character at the end may be cut in half.
 */
export function decodeText(b: Uint8Array, cut = false): string | undefined {
  if (startsWith(b, [0xef, 0xbb, 0xbf])) return new TextDecoder("utf-8").decode(b.subarray(3));
  if (startsWith(b, [0xff, 0xfe])) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (startsWith(b, [0xfe, 0xff])) return new TextDecoder("utf-16be").decode(b.subarray(2));
  const sample = b.subarray(0, 8192);
  let control = 0;
  for (const x of sample) {
    if (x === 0) return undefined;
    if (x < 9 || (x > 13 && x < 32 && x !== 27)) control++;
  }
  if (control > sample.length / 100) return undefined;
  try {
    // streaming: a UTF-8 character cut at the end of what was read is held back, not an error
    return new TextDecoder("utf-8", { fatal: true }).decode(b, { stream: cut });
  } catch {
    return new TextDecoder("windows-1252").decode(b);
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", euro: "€", ndash: "–", mdash: "—", hellip: "…" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** An HTML page as its readable text: no scripts, styles, tags; blocks on their own lines. */
export function htmlText(html: string): string {
  const s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/table|\/section|\/article|\/pre|\/blockquote|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, "\t")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(s)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, (w) => (w.includes("\t") ? "\t" : " ")).trim())
    .join("\n");
}

/** Readable runs in an Outlook message (OLE file): its body and headers are stored as UTF-16 or 8-bit text. */
function oleStrings(b: Uint8Array): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const t = s.trim();
    if (t.length >= 6 && /[a-zA-Zäöü]{3}/.test(t) && !seen.has(t)) (seen.add(t), out.push(t));
  };
  // UTF-16LE: printable character, 0
  let run = "";
  for (let i = 0; i + 1 < b.length; i += 2) {
    const c = b[i]! | (b[i + 1]! << 8);
    if ((c >= 32 && c < 0xd800 && c !== 0xfffd) || c === 10 || c === 13 || c === 9) run += String.fromCharCode(c);
    else (add(run), (run = ""));
  }
  add(run);
  return out.join("\n");
}

// ---------- ZIP ----------

interface Entry {
  name: string;
  method: number;
  csize: number;
  usize: number;
  offset: number;
  encrypted: boolean;
}

/** A ZIP file read from disk in pieces: the directory, then single entries. No ZIP64. */
export class Zip {
  /** What all entries read from this ZIP may unpack to together. */
  private budget = PART_MAX * 2;

  private constructor(
    private path: string,
    public entries: Entry[],
  ) {}

  static async open(path: string): Promise<Zip | undefined> {
    const file = Bun.file(path);
    const size = file.size;
    const tailLen = Math.min(size, 65_557);
    const tail = new Uint8Array(await file.slice(size - tailLen).arrayBuffer());
    const dv = new DataView(tail.buffer);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--)
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    if (eocd < 0) return undefined;
    const count = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    if (cdOffset === 0xffffffff || cdSize > DIRECTORY_MAX || cdOffset + cdSize > size) return undefined;
    const cd = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const c = new DataView(cd.buffer);
    const entries: Entry[] = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length && c.getUint32(p, true) === 0x02014b50; n++) {
      const flags = c.getUint16(p + 8, true);
      const nameLen = c.getUint16(p + 28, true);
      const extraLen = c.getUint16(p + 30, true);
      const commentLen = c.getUint16(p + 32, true);
      const raw = cd.subarray(p + 46, p + 46 + nameLen);
      const name = new TextDecoder(flags & 0x800 ? "utf-8" : "windows-1252").decode(raw);
      entries.push({ name, method: c.getUint16(p + 10, true), csize: c.getUint32(p + 20, true), usize: c.getUint32(p + 24, true), offset: c.getUint32(p + 42, true), encrypted: !!(flags & 1) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new Zip(path, entries);
  }

  find(name: string) {
    return this.entries.find((e) => e.name === name);
  }

  /** One entry's content; undefined when it can't be read (encrypted, unknown method, too large). */
  async read(e: Entry | string | undefined): Promise<Uint8Array | undefined> {
    const entry = typeof e === "string" ? this.find(e) : e;
    if (!entry || entry.encrypted || entry.csize > PART_MAX || entry.usize > PART_MAX || this.budget <= 0) return undefined;
    const file = Bun.file(this.path);
    const local = new DataView(await file.slice(entry.offset, entry.offset + 30).arrayBuffer());
    if (local.byteLength < 30 || local.getUint32(0, true) !== 0x04034b50) return undefined;
    const start = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    const data = new Uint8Array(await file.slice(start, start + entry.csize).arrayBuffer());
    let out: Uint8Array | undefined;
    if (entry.method === 0) out = data;
    else if (entry.method === 8) {
      try {
        out = new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.min(PART_MAX, this.budget) }));
      } catch {
        this.budget -= Math.min(PART_MAX, this.budget); // broken or larger than declared: what was unpacked counts
        return undefined;
      }
    }
    if (out) this.budget -= out.length;
    return out;
  }

  async text(e: Entry | string | undefined): Promise<string | undefined> {
    const b = await this.read(e);
    return b && new TextDecoder("utf-8").decode(b);
  }

  /** The entries as a list: name and size, folders left out. */
  listing(): string {
    const files = this.entries.filter((e) => !e.name.endsWith("/"));
    const lines = files.slice(0, LIST_MAX).map((e) => `${e.name}\t${e.usize}`);
    if (files.length > LIST_MAX) lines.push(`… ${files.length - LIST_MAX} more`);
    return `ZIP archive, ${files.length} file(s):\n${lines.join("\n")}`;
  }
}

// ---------- Office ----------

/** Walks the tags and texts of an XML document. */
function* xmlTokens(xml: string): Generator<{ tag?: string; close?: boolean; self?: boolean; attrs?: string; text?: string }> {
  const re = /<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|([^<]+)/g;
  for (const m of xml.matchAll(re)) {
    if (m[2]) yield { tag: m[2], close: !!m[1], self: !!m[4], attrs: m[3] };
    else if (m[5] !== undefined) yield { text: m[5] };
    else if (m[6] !== undefined) yield { text: decodeEntities(m[6]) };
  }
}

const attr = (attrs: string | undefined, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs ?? "")?.[1];

/**
 * Text of WordprocessingML/DrawingML/OpenDocument: `text` tags carry the words, `para` tags end a
 * line, `cell` tags end with a tab, `tab`/`br` are what they say.
 */
function markupText(xml: string, k: { text: Set<string>; para: Set<string>; cell: Set<string>; tab: Set<string>; br: Set<string> }): string {
  let out = "";
  let inText = 0;
  for (const t of xmlTokens(xml)) {
    if (t.text !== undefined) {
      if (inText) out += t.text;
      continue;
    }
    const tag = t.tag!;
    if (k.text.has(tag) && !t.self) inText = Math.max(0, inText + (t.close ? -1 : 1));
    if (out.length > TEXT_MAX) break; // more is cut anyway
    if (t.close || t.self) {
      if (k.para.has(tag)) out += "\n";
      else if (k.text.has(tag)) continue;
      else if (k.cell.has(tag)) out = out.replace(/\n$/, "") + "\t";
      else if (k.tab.has(tag)) out += "\t";
      else if (k.br.has(tag)) out += "\n";
      else if (tag === "w:tr" || tag === "a:tr" || tag === "table:table-row") out = out.replace(/\t$/, "") + "\n";
    }
  }
  return out;
}

const WORD = { text: new Set(["w:t", "w:delText"]), para: new Set(["w:p"]), cell: new Set(["w:tc"]), tab: new Set(["w:tab"]), br: new Set(["w:br", "w:cr"]) };
const DRAWING = { text: new Set(["a:t"]), para: new Set(["a:p"]), cell: new Set(["a:tc"]), tab: new Set(["a:tab"]), br: new Set(["a:br"]) };
const ODF = { text: new Set(["text:p", "text:h", "text:span", "text:a"]), para: new Set(["text:p", "text:h"]), cell: new Set(["table:table-cell"]), tab: new Set(["text:tab"]), br: new Set(["text:line-break"]) };

const byNumber = (re: RegExp) => (a: string, b: string) => Number(re.exec(a)?.[1] ?? 0) - Number(re.exec(b)?.[1] ?? 0);

/** Text of an Office or OpenDocument file; undefined for other ZIPs. */
async function officeText(zip: Zip): Promise<string | undefined> {
  if (zip.find("word/document.xml")) {
    const parts = ["word/document.xml", ...zip.entries.map((e) => e.name).filter((n) => /^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(n))];
    const texts: string[] = [];
    for (const p of parts) {
      const t = markupText((await zip.text(p)) ?? "", WORD);
      if (t.trim()) texts.push(t);
      if (texts.join("").length > TEXT_MAX) break;
    }
    return texts.join("\n\n");
  }
  if (zip.find("ppt/presentation.xml")) {
    const slides = zip.entries.map((e) => e.name).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber(/slide(\d+)\.xml$/));
    const out: string[] = [];
    for (const [i, s] of slides.entries()) {
      if (out.join("").length > TEXT_MAX) break;
      const text = markupText((await zip.text(s)) ?? "", DRAWING).trim();
      const notes = markupText((await zip.text(s.replace("slides/slide", "notesSlides/notesSlide"))) ?? "", DRAWING).trim();
      out.push(`Slide ${i + 1}\n${text}${notes ? `\n\nNotes: ${notes}` : ""}`);
    }
    return out.join("\n\n");
  }
  if (zip.find("xl/workbook.xml")) return xlsxText(zip);
  if (zip.find("content.xml") && /^application\/vnd\.oasis\.opendocument\./.test((await zip.text("mimetype")) ?? "")) {
    const xml = (await zip.text("content.xml")) ?? "";
    // a sheet starts with its name; repeated empty cells are left out
    return markupText(xml.replace(/<table:table\s[^>]*?table:name="([^"]*)"[^>]*>/g, (m, n: string) => `${m}<text:p>${n.replace(/</g, "&lt;")}</text:p>`), ODF);
  }
  return undefined;
}

/** Each sheet with its name, a row per line, cells separated by tabs. */
async function xlsxText(zip: Zip): Promise<string> {
  const shared: string[] = [];
  const sst = await zip.text("xl/sharedStrings.xml");
  if (sst) {
    let cur: string | undefined;
    let inT = 0;
    let rph = 0; // phonetic runs are not part of the value
    for (const t of xmlTokens(sst)) {
      if (t.text !== undefined) {
        if (cur !== undefined && inT && !rph) cur += t.text;
      } else if (t.tag === "si") {
        if (t.close) (shared.push(cur ?? ""), (cur = undefined));
        else if (t.self) shared.push("");
        else cur = "";
      } else if (t.tag === "t" && !t.self) inT += t.close ? -1 : 1;
      else if (t.tag === "rPh" && !t.self) rph += t.close ? -1 : 1;
    }
  }
  const book = (await zip.text("xl/workbook.xml")) ?? "";
  const rels = (await zip.text("xl/_rels/workbook.xml.rels")) ?? "";
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], "Id");
    const to = attr(m[1], "Target");
    if (id && to) target.set(id, to.startsWith("/") ? to.slice(1) : "xl/" + to.replace(/^\.\//, ""));
  }
  const sheets = [...book.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({ name: decodeEntities(attr(m[1], "name") ?? ""), path: target.get(attr(m[1], "r:id") ?? "") }));
  const out: string[] = [];
  for (const sheet of sheets) {
    const xml = sheet.path ? await zip.text(sheet.path) : undefined;
    if (!xml) continue;
    const rows: string[] = [];
    let size = 0;
    let next = 0; // the column of a cell without reference
    let row: string[] = [];
    let col = 0;
    let type = "";
    let value: string | undefined;
    let inV = 0;
    for (const t of xmlTokens(xml)) {
      if (t.text !== undefined) {
        if (inV) value = (value ?? "") + t.text;
        continue;
      }
      if (t.tag === "row") {
        if (t.close || t.self) {
          rows.push(row.join("\t").replace(/\t+$/, ""));
          row = [];
          next = 0;
          if ((size += rows.at(-1)!.length + 1) > TEXT_MAX) break;
        } else {
          row = [];
          next = 0;
        }
      } else if (t.tag === "c") {
        if (!t.close) {
          const ref = attr(t.attrs, "r");
          col = Math.min(ref ? colIndex(ref) : next, MAX_COLUMN); // Excel has 16384 columns
          type = attr(t.attrs, "t") ?? "";
          value = undefined;
        }
        if (t.close || t.self) {
          next = col + 1;
          const v = value === undefined ? "" : type === "s" ? (shared[Number(value)] ?? "") : type === "b" ? (value === "1" ? "TRUE" : "FALSE") : value;
          // empty cells need no place: a far column alone pads nothing
          if (v && col < MAX_COLUMN) {
            while (row.length < col) row.push("");
            row[col] = v.replace(/[\t\n]+/g, " ");
          }
        }
      } else if ((t.tag === "v" || t.tag === "t") && !t.self) inV += t.close ? -1 : 1;
    }
    while (rows.length && !rows.at(-1)) rows.pop();
    out.push(`Sheet: ${sheet.name}\n${rows.join("\n")}`);
    if (out.join("").length > TEXT_MAX) break;
  }
  return out.join("\n\n");
}

const MAX_COLUMN = 16384;

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
    if (n > MAX_COLUMN) return MAX_COLUMN;
  }
  return Math.max(0, n - 1);
}

// ---------- PDF ----------

let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs") | undefined;
async function pdfText(path: string): Promise<Extracted> {
  pdfjs ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await Bun.file(path).arrayBuffer());
  const task = pdfjs.getDocument({ data, disableFontFace: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages = doc.numPages;
    let text = "";
    for (let i = 1; i <= Math.min(pages, 60) && text.length < 40_000; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      text += tc.items.map((x) => ("str" in x ? x.str : "")).join(" ").replace(/\s+/g, " ") + "\n";
    }
    text = text.trim().slice(0, 40_000);
    // embedded files: an e-invoice's XML (Factur-X, ZUGFeRD, XRechnung) and other attachments
    const attachments = await doc.getAttachments().catch(() => null);
    if (attachments?.size) {
      const list: string[] = [];
      const bodies: string[] = [];
      for (const [id, a] of attachments) {
        const content = a.content ?? (await doc.getAttachmentContent(id).catch(() => null));
        list.push(`${a.filename}\t${content?.length ?? 0}`);
        const inner = content && content.length <= PART_MAX ? decodeText(content) : undefined;
        if (inner?.trim()) bodies.push(`--- ${a.filename} ---\n${inner.trim()}`);
      }
      text += `${text ? "\n\n" : ""}Embedded files (${list.length}):\n${list.join("\n")}${bodies.length ? "\n\n" + bodies.join("\n\n") : ""}`;
    }
    return { pages, text: cap(text) };
  } finally {
    await task.destroy();
  }
}
