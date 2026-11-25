// An Excel workbook (xlsx, xlsm, xltx, xltm) read on the device to view it: its sheets with the
// values Excel saved, number formats, merged cells, column widths, row heights, frozen panes,
// fonts, fills and alignment. Formulas are shown, not calculated. Charts, pictures and comments
// are left out. A sheet is read when it is opened.

const PART_MAX = 256 * 1024 * 1024;
/** Cells read per sheet at most; the rest is cut (`cut`). */
export const CELL_MAX = 2_000_000;
/** Excel's limits. */
const MAX_ROWS = 1_048_576;
const MAX_COLS = 16_384;

export interface CellStyle {
	/** The number format's code. */
	fmt: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	/** Font size in points, when not the workbook's default. */
	size?: number;
	color?: string;
	fill?: string;
	align?: "left" | "center" | "right" | "justify" | "fill" | "centerContinuous" | "distributed";
	valign?: "top" | "center" | "bottom";
	wrap?: boolean;
	indent?: number;
	rotate?: number;
}

export type CellValue =
	| { t: "n"; v: number }
	| { t: "s"; v: string }
	| { t: "b"; v: boolean }
	| { t: "e"; v: string };

export type Cell = CellValue & {
	/** Index into the workbook's styles. */
	s: number;
	/** The formula, without "=". */
	f?: string;
};

export interface Range {
	r1: number;
	c1: number;
	r2: number;
	c2: number;
}

export interface SheetInfo {
	name: string;
	hidden: boolean;
	/** A sheet with cells, or a chart on a sheet of its own (not shown). */
	kind: "cells" | "chart";
	path?: string;
}

export interface SheetData {
	/** Rows and columns up to the last cell, merge or sized row/column that holds something. */
	rows: number;
	cols: number;
	/** cells[row][col], both from 0. */
	cells: (Cell | undefined)[][];
	merges: Range[];
	/** Column widths in pixels (0: hidden); the default for the rest. */
	widths: Map<number, number>;
	defaultWidth: number;
	/** Row heights in pixels (0: hidden); the default for the rest. */
	heights: Map<number, number>;
	defaultHeight: number;
	/** Rows and columns frozen at the top and left. */
	frozen: { rows: number; cols: number };
	/** More cells than CELL_MAX: the rest is left out. */
	cut: boolean;
}

export interface Workbook {
	sheets: SheetInfo[];
	/** The sheet open when the file was saved. */
	active: number;
	styles: CellStyle[];
	date1904: boolean;
	/** The sheet's cells; read once, then kept. */
	sheet(index: number): Promise<SheetData>;
}

// ---------- ZIP ----------

interface Entry {
	method: number;
	csize: number;
	offset: number;
	encrypted: boolean;
}

/** The entries of a ZIP in memory. No ZIP64: xlsx files stay below 4 GB. */
function zipEntries(b: Uint8Array): Map<string, Entry> | undefined {
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	let eocd = -1;
	for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--)
		if (dv.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	if (eocd < 0) return undefined;
	const count = dv.getUint16(eocd + 10, true);
	let p = dv.getUint32(eocd + 16, true);
	const out = new Map<string, Entry>();
	for (let n = 0; n < count && p + 46 <= b.length && dv.getUint32(p, true) === 0x02014b50; n++) {
		const flags = dv.getUint16(p + 8, true);
		const nameLen = dv.getUint16(p + 28, true);
		const extraLen = dv.getUint16(p + 30, true);
		const commentLen = dv.getUint16(p + 32, true);
		const name = new TextDecoder(flags & 0x800 ? "utf-8" : "windows-1252").decode(
			b.subarray(p + 46, p + 46 + nameLen),
		);
		out.set(name.replace(/\\/g, "/"), {
			method: dv.getUint16(p + 10, true),
			csize: dv.getUint32(p + 20, true),
			offset: dv.getUint32(p + 42, true),
			encrypted: !!(flags & 1),
		});
		p += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new DecompressionStream("deflate-raw"));
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > PART_MAX) {
			await reader.cancel();
			throw new Error("part too large");
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

async function readEntry(b: Uint8Array, e: Entry | undefined): Promise<string | undefined> {
	if (!e || e.encrypted) return undefined;
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	if (e.offset + 30 > b.length || dv.getUint32(e.offset, true) !== 0x04034b50) return undefined;
	const start =
		e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
	const data = b.subarray(start, start + e.csize);
	let raw: Uint8Array;
	if (e.method === 0) raw = data;
	else if (e.method === 8) {
		try {
			raw = await inflate(data);
		} catch {
			return undefined;
		}
	} else return undefined;
	return new TextDecoder("utf-8").decode(raw);
}

// ---------- XML ----------

interface Tok {
	tag?: string;
	close?: boolean;
	self?: boolean;
	attrs?: string;
	text?: string;
}

const TOKEN =
	/<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|([^<]+)/g;

/** Walks the tags and texts of an XML document; prefixes ("x:", "main:") are dropped. */
function* xmlTokens(xml: string): Generator<Tok> {
	for (const m of xml.matchAll(TOKEN)) {
		if (m[2]) {
			const tag = m[2].includes(":") ? m[2].slice(m[2].indexOf(":") + 1) : m[2];
			yield { tag, close: !!m[1], self: !!m[4], attrs: m[3] };
		} else if (m[5] !== undefined) yield { text: m[5] };
		else if (m[6] !== undefined) yield { text: decode(m[6]) };
	}
}

function decode(s: string): string {
	if (!s.includes("&")) return s;
	return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const n =
				e[1] === "x" || e[1] === "X"
					? Number.parseInt(e.slice(2), 16)
					: Number.parseInt(e.slice(1), 10);
			return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
		}
		return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()] ?? m;
	});
}

/** An attribute's value; `name` without prefix also matches a prefixed one ("r:id" by "id" is not wanted, so pass the full name). */
const attrPatterns = new Map<string, RegExp>();
function attr(attrs: string | undefined, name: string): string | undefined {
	if (!attrs) return undefined;
	let re = attrPatterns.get(name);
	if (!re) {
		re = new RegExp(`(?:^|\\s)${name.replace(/[.:]/g, "\\$&")}\\s*=\\s*("([^"]*)"|'([^']*)')`);
		attrPatterns.set(name, re);
	}
	const m = re.exec(attrs);
	return m ? decode(m[2] ?? m[3] ?? "") : undefined;
}

/** An attribute in double quotes found by `indexOf`, for the many cells of a sheet. */
function quick(attrs: string | undefined, name: string): string | undefined {
	if (!attrs) return undefined;
	const start = ` ${name}="`;
	const at = attrs.indexOf(start);
	if (at < 0) return attrs.includes(`${name}=`) ? attr(attrs, name) : undefined;
	return attrs.slice(at + start.length, attrs.indexOf('"', at + start.length));
}

const on = (v: string | undefined) => v === "1" || v === "true";

/** Excel's escaped characters in strings: "_x000D_" is a carriage return. */
const unescapeX = (s: string) =>
	s.includes("_x")
		? s.replace(/_x([0-9a-fA-F]{4})_/g, (_, h: string) =>
				String.fromCharCode(Number.parseInt(h, 16)),
			)
		: s;

/** "AB12" → column 27 (from 0) and row 11 (from 0). */
export function parseRef(ref: string): { r: number; c: number } | undefined {
	let i = ref.charCodeAt(0) === 36 ? 1 : 0; // $
	let c = 0;
	let letters = 0;
	for (; i < ref.length; i++) {
		const ch = ref.charCodeAt(i) & ~32; // upper case
		if (ch < 65 || ch > 90) break;
		c = c * 26 + ch - 64;
		letters++;
	}
	if (!letters || letters > 3) return undefined;
	if (ref.charCodeAt(i) === 36) i++;
	let r = 0;
	const digits = i;
	for (; i < ref.length; i++) {
		const d = ref.charCodeAt(i) - 48;
		if (d < 0 || d > 9) return undefined;
		r = r * 10 + d;
	}
	if (i === digits) return undefined;
	return { r: r - 1, c: c - 1 };
}

/** Column 0 → "A", 27 → "AB". */
export function colName(c: number): string {
	let s = "";
	let n = c + 1;
	while (n > 0) {
		const m = (n - 1) % 26;
		s = String.fromCharCode(65 + m) + s;
		n = Math.floor((n - 1) / 26);
	}
	return s;
}

function parseRange(ref: string): Range | undefined {
	const [a, b] = ref.split(":");
	const p = a ? parseRef(a) : undefined;
	const q = b ? parseRef(b) : p;
	if (!p || !q) return undefined;
	return {
		r1: Math.min(p.r, q.r),
		c1: Math.min(p.c, q.c),
		r2: Math.max(p.r, q.r),
		c2: Math.max(p.c, q.c),
	};
}

// ---------- colours ----------

/** The legacy palette (indexed colours 0–63). */
const INDEXED = [
	"000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
	"000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
	"800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080",
	"9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF",
	"000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF",
	"00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
	"3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696",
	"003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
]; // biome-ignore format: a table

/** The theme's colours in the order cells refer to them: lt1, dk1, lt2, dk2, accent1–6, hlink, folHlink. */
function themeColors(xml: string | undefined): string[] {
	const defaults = [
		"FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31",
		"A5A5A5", "FFC000", "5B9BD5", "70AD47", "0563C1", "954F72",
	]; // biome-ignore format: a list
	if (!xml) return defaults;
	const scheme = /<(?:\w+:)?clrScheme\b[\s\S]*?<\/(?:\w+:)?clrScheme>/.exec(xml)?.[0];
	if (!scheme) return defaults;
	const get = (name: string) => {
		const block = new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(
			scheme,
		)?.[1];
		return (
			(block &&
				(/srgbClr\s+val="([0-9A-Fa-f]{6})"/.exec(block)?.[1] ??
					/lastClr="([0-9A-Fa-f]{6})"/.exec(block)?.[1])) ||
			undefined
		);
	};
	const order = [
		"lt1",
		"dk1",
		"lt2",
		"dk2",
		"accent1",
		"accent2",
		"accent3",
		"accent4",
		"accent5",
		"accent6",
		"hlink",
		"folHlink",
	];
	return order.map((n, i) => get(n) ?? defaults[i]!);
}

/** A colour element's attributes (rgb, theme, indexed, tint) as CSS, or undefined for "automatic". */
function color(attrs: string | undefined, theme: string[]): string | undefined {
	if (!attrs || on(attr(attrs, "auto"))) return undefined;
	let hex: string | undefined;
	const rgb = attr(attrs, "rgb");
	const th = attr(attrs, "theme");
	const ix = attr(attrs, "indexed");
	if (rgb && /^[0-9A-Fa-f]{6,8}$/.test(rgb)) hex = rgb.slice(-6);
	else if (th !== undefined) hex = theme[Number(th)];
	else if (ix !== undefined) hex = INDEXED[Number(ix)]; // 64: the system's text colour
	if (!hex) return undefined;
	const tint = Number(attr(attrs, "tint") ?? 0);
	return `#${tint ? tinted(hex, tint) : hex.toLowerCase()}`;
}

/** Excel's tint: towards white (> 0) or black (< 0) in HLS lightness. */
function tinted(hex: string, tint: number): string {
	const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
		number,
		number,
		number,
	];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	let l = (max + min) / 2;
	let h = 0;
	let s = 0;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
		h /= 6;
	}
	l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
	const hue = (p: number, q: number, t: number) => {
		const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
		if (u < 1 / 6) return p + (q - p) * 6 * u;
		if (u < 1 / 2) return q;
		if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
		return p;
	};
	let rgb: number[];
	if (s === 0) rgb = [l, l, l];
	else {
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		rgb = [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
	}
	return rgb
		.map((x) =>
			Math.round(Math.min(1, Math.max(0, x)) * 255)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("");
}

// ---------- styles ----------

interface Font {
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	size?: number;
	color?: string;
}

function readStyles(
	xml: string | undefined,
	theme: string[],
	formatOf: (id: number) => string,
): { styles: CellStyle[]; baseSize: number } {
	if (!xml) return { styles: [{ fmt: "General" }], baseSize: 11 };
	const formats = new Map<number, string>();
	for (const m of xml.matchAll(/<(?:\w+:)?numFmt\b([^>]*)\/?>/g)) {
		const id = attr(m[1], "numFmtId");
		const code = attr(m[1], "formatCode");
		if (id !== undefined && code !== undefined) formats.set(Number(id), code);
	}
	const block = (name: string) =>
		new RegExp(`<(?:\\w+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${name}>)`).exec(
			xml,
		)?.[1] ?? "";
	const fonts: Font[] = [];
	for (const m of block("fonts").matchAll(
		/<(?:\w+:)?font\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?font>)/g,
	)) {
		const f = m[1] ?? "";
		const flag = (tag: string) => {
			const t = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*)/?>`).exec(f);
			if (!t) return false;
			const val = attr(t[1], "val");
			return val === undefined || (val !== "0" && val !== "false" && val !== "none");
		};
		const sz = /<(?:\w+:)?sz\b([^>]*)\/?>/.exec(f);
		const col = /<(?:\w+:)?color\b([^>]*)\/?>/.exec(f);
		fonts.push({
			bold: flag("b"),
			italic: flag("i"),
			underline: flag("u"),
			strike: flag("strike"),
			size: sz ? Number(attr(sz[1], "val")) || undefined : undefined,
			color: col ? color(col[1], theme) : undefined,
		});
	}
	const fills: (string | undefined)[] = [];
	for (const m of block("fills").matchAll(
		/<(?:\w+:)?fill\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?fill>)/g,
	)) {
		const f = m[1] ?? "";
		const pattern = /<(?:\w+:)?patternFill\b([^>]*)/.exec(f);
		const type = pattern ? attr(pattern[1], "patternType") : undefined;
		if (pattern && type && type !== "none") {
			const fg = /<(?:\w+:)?fgColor\b([^>]*)\/?>/.exec(f);
			const bg = /<(?:\w+:)?bgColor\b([^>]*)\/?>/.exec(f);
			fills.push(color(fg?.[1], theme) ?? (type !== "solid" ? color(bg?.[1], theme) : undefined));
		} else if (/<(?:\w+:)?gradientFill\b/.test(f)) {
			fills.push(color(/<(?:\w+:)?color\b([^>]*)\/?>/.exec(f)?.[1], theme));
		} else fills.push(undefined);
	}
	const base = fonts[0]?.size ?? 11;
	const styles: CellStyle[] = [];
	for (const m of block("cellXfs").matchAll(
		/<(?:\w+:)?xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?xf>)/g,
	)) {
		const a = m[1];
		const id = Number(attr(a, "numFmtId") ?? 0);
		const font = fonts[Number(attr(a, "fontId") ?? 0)] ?? {};
		const fill = fills[Number(attr(a, "fillId") ?? 0)];
		const al = /<(?:\w+:)?alignment\b([^>]*)\/?>/.exec(m[2] ?? "")?.[1];
		const s: CellStyle = { fmt: formats.get(id) ?? formatOf(id) };
		if (font.bold) s.bold = true;
		if (font.italic) s.italic = true;
		if (font.underline) s.underline = true;
		if (font.strike) s.strike = true;
		if (font.size && font.size !== base) s.size = font.size;
		if (font.color) s.color = font.color;
		if (fill) s.fill = fill;
		if (al) {
			const h = attr(al, "horizontal");
			if (h && h !== "general") s.align = h as CellStyle["align"];
			const v = attr(al, "vertical");
			if (v === "top" || v === "center") s.valign = v;
			if (on(attr(al, "wrapText"))) s.wrap = true;
			const indent = Number(attr(al, "indent") ?? 0);
			if (indent) s.indent = indent;
			const rot = Number(attr(al, "textRotation") ?? 0);
			if (rot) s.rotate = rot;
		}
		styles.push(s);
	}
	if (!styles.length) styles.push({ fmt: "General" });
	return { styles, baseSize: base };
}

// ---------- shared strings ----------

function readStrings(xml: string | undefined): string[] {
	const out: string[] = [];
	if (!xml) return out;
	let cur: string | undefined;
	let inT = 0;
	let rph = 0; // phonetic runs are not part of the value
	for (const t of xmlTokens(xml)) {
		if (t.text !== undefined) {
			if (cur !== undefined && inT && !rph) cur += t.text;
		} else if (t.tag === "si") {
			if (t.close) {
				out.push(unescapeX(cur ?? ""));
				cur = undefined;
			} else if (t.self) out.push("");
			else cur = "";
		} else if (t.tag === "t" && !t.self) inT += t.close ? -1 : 1;
		else if (t.tag === "rPh" && !t.self) rph += t.close ? -1 : 1;
	}
	return out;
}

// ---------- the workbook ----------

/** Column width in characters → pixels (Calibri 11: a digit is 7 px wide). */
const widthPx = (chars: number) => Math.round(chars * 7);
/** Points → pixels. */
const pointsPx = (pt: number) => Math.round((pt * 4) / 3);

/**
 * Reads a workbook's parts list, sheets and styles. Undefined when the bytes are not an xlsx (an
 * old .xls, an encrypted file, a ZIP without a workbook). `formatOf` gives a built-in number
 * format's code.
 */
export async function readWorkbook(
	bytes: Uint8Array,
	formatOf: (id: number) => string,
): Promise<Workbook | undefined> {
	const zip = zipEntries(bytes);
	if (!zip) return undefined;
	const text = (path: string) => readEntry(bytes, zip.get(path));
	// the workbook part: from the package's relationships, usually xl/workbook.xml
	const root = (await text("_rels/.rels")) ?? "";
	const officeDoc = [...root.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)]
		.map((m) => m[1])
		.find((a) => /\/officeDocument$/.test(attr(a, "Type") ?? ""));
	const bookPath = (attr(officeDoc, "Target") ?? "xl/workbook.xml").replace(/^\//, "");
	const book = await text(bookPath);
	if (!book) return undefined;
	const dir = bookPath.includes("/") ? bookPath.slice(0, bookPath.lastIndexOf("/") + 1) : "";
	const relsPath = `${dir}_rels/${bookPath.slice(dir.length)}.rels`;
	const rels = new Map<string, { target: string; type: string }>();
	for (const m of ((await text(relsPath)) ?? "").matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
		const id = attr(m[1], "Id");
		const to = attr(m[1], "Target");
		if (!id || !to) continue;
		rels.set(id, { target: resolve(dir, to), type: attr(m[1], "Type") ?? "" });
	}
	const relOf = (suffix: string) => [...rels.values()].find((r) => r.type.endsWith(suffix))?.target;
	const date1904 = on(attr(/<(?:\w+:)?workbookPr\b([^>]*)/.exec(book)?.[1], "date1904"));
	const theme = themeColors(await text(relOf("/theme") ?? `${dir}theme/theme1.xml`));
	const { styles, baseSize } = readStyles(
		await text(relOf("/styles") ?? `${dir}styles.xml`),
		theme,
		formatOf,
	);
	let strings: string[] | undefined;
	const sharedPath = relOf("/sharedStrings") ?? `${dir}sharedStrings.xml`;
	const sheets: SheetInfo[] = [];
	for (const m of book.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)) {
		const a = m[1];
		const rid = /(?:^|\s)[\w]+:id\s*=\s*"([^"]*)"/.exec(a ?? "")?.[1] ?? attr(a, "id");
		const rel = rid ? rels.get(rid) : undefined;
		const state = attr(a, "state");
		sheets.push({
			name: attr(a, "name") ?? `Sheet${sheets.length + 1}`,
			hidden: state === "hidden" || state === "veryHidden",
			kind: rel && /chartsheet/i.test(rel.type + rel.target) ? "chart" : "cells",
			path: rel?.target,
		});
	}
	const cache = new Map<number, Promise<SheetData>>();
	const empty = (): SheetData => ({
		rows: 0,
		cols: 0,
		cells: [],
		merges: [],
		widths: new Map(),
		defaultWidth: 64,
		heights: new Map(),
		defaultHeight: 20,
		frozen: { rows: 0, cols: 0 },
		cut: false,
	});
	const activeTab = Number(
		attr(/<(?:\w+:)?workbookView\b([^>]*)/.exec(book)?.[1], "activeTab") ?? 0,
	);
	return {
		sheets,
		active: sheets[activeTab] ? activeTab : 0,
		styles,
		date1904,
		sheet(index) {
			let p = cache.get(index);
			if (!p) {
				p = (async () => {
					const info = sheets[index];
					if (!info?.path || info.kind !== "cells") return empty();
					const xml = await text(info.path);
					if (!xml) return empty();
					strings ??= readStrings(await text(sharedPath));
					return readSheet(xml, strings, styles, baseSize);
				})();
				cache.set(index, p);
			}
			return p;
		},
	};
}

/** A relationship's target relative to the folder of the part that names it. */
function resolve(dir: string, target: string): string {
	if (target.startsWith("/")) return target.slice(1);
	const parts = (dir + target).split("/");
	const out: string[] = [];
	for (const p of parts) {
		if (p === "..") out.pop();
		else if (p !== ".") out.push(p);
	}
	return out.join("/");
}

/** One worksheet's cells and layout. */
export function readSheet(
	xml: string,
	strings: string[],
	styles: CellStyle[],
	baseSize = 11,
): SheetData {
	const cells: (Cell | undefined)[][] = [];
	const merges: Range[] = [];
	const widths = new Map<number, number>();
	const heights = new Map<number, number>();
	let defaultWidth = 64;
	let defaultHeight = pointsPx(baseSize * 1.36) || 20;
	let frozen = { rows: 0, cols: 0 };
	let rows = 0;
	let cols = 0;
	let count = 0;
	let cut = false;
	// inside <sheetData>
	let r = -1;
	let nextRow = 0;
	let nextCol = 0;
	let c = 0;
	let type = "";
	let style = 0;
	let value: string | undefined;
	let formula: string | undefined;
	let shared: string | undefined;
	let inV = 0;
	let inF = 0;
	let inIs = 0;
	let inT = 0;
	let inRph = 0;
	let inCell = false;
	const formulas = new Map<string, { f: string; r: number; c: number }>();
	// one token object, refilled: a sheet has millions of tokens
	const re = new RegExp(TOKEN.source, "g");
	const t: Tok = {};
	for (let m = re.exec(xml); m; m = re.exec(xml)) {
		if (m[2]) {
			const name = m[2];
			t.tag = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
			t.close = m[1] === "/";
			t.self = m[4] === "/";
			t.attrs = m[3];
			t.text = undefined;
		} else if (m[5] !== undefined || m[6] !== undefined) {
			t.text = m[5] ?? decode(m[6]!);
		} else continue;
		if (t.text !== undefined) {
			if (inV) value = (value ?? "") + t.text;
			else if (inF) formula = (formula ?? "") + t.text;
			else if (inIs && inT && !inRph) value = (value ?? "") + t.text;
			continue;
		}
		const tag = t.tag!;
		if (tag === "c") {
			if (!t.close) {
				const ref = quick(t.attrs, "r");
				const p = ref ? parseRef(ref) : undefined;
				c = p ? p.c : nextCol;
				if (p && r < 0) r = p.r;
				type = quick(t.attrs, "t") ?? "n";
				style = Number(quick(t.attrs, "s") ?? 0);
				value = undefined;
				formula = undefined;
				shared = undefined;
				inCell = true;
			}
			if (t.close || t.self) {
				inCell = false;
				nextCol = c + 1;
				if (r < 0 || r >= MAX_ROWS || c >= MAX_COLS) continue;
				if (shared !== undefined) {
					if (formula) formulas.set(shared, { f: formula, r, c });
					else {
						const base = formulas.get(shared);
						if (base) formula = shiftFormula(base.f, r - base.r, c - base.c);
					}
				}
				const cell = toCell(type, value, strings);
				const hasStyle = style > 0 && (styles[style]?.fill || styles[style]?.color);
				if (!cell && !formula && !hasStyle) continue;
				if (count >= CELL_MAX) {
					cut = true;
					continue;
				}
				count++;
				const row = cells[r] ?? [];
				cells[r] = row;
				// toCell made a new object: it takes the style and formula itself
				const out = (cell ?? { t: "s", v: "" }) as Cell;
				out.s = style;
				if (formula) out.f = formula;
				row[c] = out;
				if (cell || formula) {
					if (r + 1 > rows) rows = r + 1;
					if (c + 1 > cols) cols = c + 1;
				}
			}
		} else if (tag === "row") {
			if (!t.close) {
				const rr = attr(t.attrs, "r");
				r = rr ? Number(rr) - 1 : nextRow;
				nextRow = r + 1;
				nextCol = 0;
				const hidden = on(attr(t.attrs, "hidden"));
				const ht = attr(t.attrs, "ht");
				if (hidden) heights.set(r, 0);
				else if (ht && (on(attr(t.attrs, "customHeight")) || Number(ht) > 0)) {
					const px = pointsPx(Number(ht));
					if (px !== defaultHeight) heights.set(r, px);
				}
			}
			if (t.close || t.self) r = -1;
		} else if (inCell && tag === "v" && !t.self) inV += t.close ? -1 : 1;
		else if (inCell && tag === "f") {
			if (!t.close && attr(t.attrs, "t") === "shared") shared = attr(t.attrs, "si");
			if (!t.self) inF += t.close ? -1 : 1;
		} else if (inCell && tag === "is" && !t.self) inIs += t.close ? -1 : 1;
		else if (inCell && tag === "t" && !t.self) inT += t.close ? -1 : 1;
		else if (inCell && tag === "rPh" && !t.self) inRph += t.close ? -1 : 1;
		else if (tag === "mergeCell" && !t.close) {
			const range = parseRange(attr(t.attrs, "ref") ?? "");
			if (range && range.r2 < MAX_ROWS && range.c2 < MAX_COLS) merges.push(range);
		} else if (tag === "col" && !t.close) {
			const min = Number(attr(t.attrs, "min") ?? 0) - 1;
			const max = Math.min(Number(attr(t.attrs, "max") ?? 0) - 1, MAX_COLS - 1);
			const hidden = on(attr(t.attrs, "hidden"));
			const w = attr(t.attrs, "width");
			if (min < 0 || max < min) continue;
			const px = hidden ? 0 : w !== undefined ? widthPx(Number(w)) : undefined;
			// a range up to the last column usually only styles the rest of the sheet
			if (px === undefined || max - min > 2000) continue;
			for (let k = min; k <= max; k++) widths.set(k, px);
		} else if (tag === "sheetFormatPr" && !t.close) {
			const dw = attr(t.attrs, "defaultColWidth");
			const bw = attr(t.attrs, "baseColWidth");
			if (dw) defaultWidth = widthPx(Number(dw));
			else if (bw) defaultWidth = widthPx(Number(bw)) + 8;
			const dh = attr(t.attrs, "defaultRowHeight");
			if (dh) defaultHeight = pointsPx(Number(dh));
		} else if (tag === "pane" && !t.close) {
			const state = attr(t.attrs, "state");
			if (state === "frozen" || state === "frozenSplit")
				frozen = {
					rows: Math.max(0, Math.floor(Number(attr(t.attrs, "ySplit") ?? 0))),
					cols: Math.max(0, Math.floor(Number(attr(t.attrs, "xSplit") ?? 0))),
				};
		}
	}
	for (const m of merges) {
		// a merge reaches as far as the data
		const anchor = cells[m.r1]?.[m.c1];
		if (anchor && (anchor.t !== "s" || anchor.v !== "")) {
			if (m.r2 + 1 > rows) rows = Math.min(m.r2 + 1, MAX_ROWS);
			if (m.c2 + 1 > cols) cols = Math.min(m.c2 + 1, MAX_COLS);
		}
	}
	frozen = { rows: Math.min(frozen.rows, 50), cols: Math.min(frozen.cols, 20) };
	return { rows, cols, cells, merges, widths, defaultWidth, heights, defaultHeight, frozen, cut };
}

function toCell(type: string, value: string | undefined, strings: string[]): CellValue | undefined {
	if (type === "inlineStr")
		return value === undefined ? undefined : { t: "s", v: unescapeX(value) };
	if (value === undefined) return undefined;
	switch (type) {
		case "s": {
			const v = strings[Number(value)];
			return v === undefined ? undefined : { t: "s", v };
		}
		case "str":
			return { t: "s", v: unescapeX(value) };
		case "b":
			return { t: "b", v: value === "1" || value === "true" };
		case "e":
			return { t: "e", v: value };
		case "d": {
			// an ISO date: as a serial number, so its format shows it
			const ms = Date.parse(
				value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`,
			);
			if (Number.isNaN(ms)) return { t: "s", v: value };
			return { t: "n", v: ms / 86_400_000 + 25_569 };
		}
		default: {
			const n = Number(value);
			return value.trim() === "" || Number.isNaN(n) ? { t: "s", v: value } : { t: "n", v: n };
		}
	}
}

/**
 * A shared formula moved by rows and columns: relative references shift, `$` ones stay. Strings
 * in quotes and sheet names are left alone.
 */
export function shiftFormula(f: string, dr: number, dc: number): string {
	if (!dr && !dc) return f;
	let out = "";
	let i = 0;
	while (i < f.length) {
		const ch = f[i]!;
		if (ch === '"' || ch === "'") {
			const end = f.indexOf(ch, i + 1);
			const stop = end < 0 ? f.length : end + 1;
			out += f.slice(i, stop);
			i = stop;
			continue;
		}
		const m = /^(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(])/.exec(f.slice(i));
		const prev = out.at(-1) ?? "";
		if (m && !/[\w.]/.test(prev)) {
			const col = m[1] ? m[2]! : colName(Math.max(0, parseRef(`${m[2]}1`)!.c + dc));
			const row = m[3] ? m[4]! : String(Math.max(1, Number(m[4]) + dr));
			out += `${m[1]}${col}${m[3]}${row}`;
			i += m[0].length;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}
