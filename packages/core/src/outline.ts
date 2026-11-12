// Long texts in parts: the headings of a Markdown text (its outline), one section by its heading
// or path ("Status > Offene Punkte"), and pages of a text by character offset. Agents read long
// bodies and file texts this way instead of all at once; the search names the heading of a hit.
import { foldUmlauts } from "./text";

export interface Heading {
	/** 1–6, the number of #. */
	level: number;
	/** The heading as written, without the #. */
	text: string;
	/** The headings above it and itself, joined with " > ". */
	path: string;
	/** Where its line starts in the text. */
	offset: number;
	/** Characters up to the next heading of the same or a higher level (or the end): its section. */
	size: number;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The ATX headings of a Markdown text (# …), not those in code blocks. */
export function outline(text: string): Heading[] {
	const out: Heading[] = [];
	const stack: Heading[] = [];
	let fence: string | null = null;
	let at = 0;
	for (const line of text.split("\n")) {
		const start = at;
		at += line.length + 1;
		const l = line.replace(/\r$/, "");
		const f = l.match(FENCE);
		if (f) {
			if (!fence) fence = f[1]![0]!.repeat(3);
			else if (f[1]!.startsWith(fence)) fence = null;
			continue;
		}
		if (fence) continue;
		const m = l.match(HEADING);
		if (!m || !m[2]!.trim()) continue;
		const level = m[1]!.length;
		while (stack.length && stack.at(-1)!.level >= level) stack.pop();
		const h: Heading = { level, text: m[2]!.trim(), path: "", offset: start, size: 0 };
		h.path = [...stack, h].map((x) => x.text).join(" > ");
		stack.push(h);
		out.push(h);
	}
	for (let n = 0; n < out.length; n++) {
		const h = out[n]!;
		const next = out.slice(n + 1).find((x) => x.level <= h.level);
		h.size = (next ? next.offset : text.length) - h.offset;
	}
	return out;
}

/** A heading or a path segment as compared: no marks, folded, single spaces. */
const norm = (s: string) =>
	foldUmlauts(
		s
			.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
			.replace(/[*`]/g, "")
			.replace(/\s+/g, " ")
			.trim(),
	);

/** Its ancestors (outermost first) and itself, as they match path segments. */
function chain(all: Heading[], h: Heading): Heading[] {
	const out = [h];
	for (let n = all.indexOf(h) - 1; n >= 0; n--)
		if (all[n]!.level < out[0]!.level) out.unshift(all[n]!);
	return out;
}

/** The segments in order, the last one the heading itself; those before match its ancestors. */
function matchesPath(
	all: Heading[],
	h: Heading,
	segs: string[],
	same: (a: string, b: string) => boolean,
): boolean {
	if (!same(norm(h.text), segs.at(-1)!)) return false;
	const up = chain(all, h).slice(0, -1);
	let k = 0;
	for (const s of segs.slice(0, -1)) {
		while (k < up.length && !same(norm(up[k]!.text), s)) k++;
		if (k++ >= up.length) return false;
	}
	return true;
}

export type SectionFind = { heading: Heading } | { candidates: Heading[] };

/**
 * The section a heading text or a path ("Status > Offene Punkte", also with / or ›) names,
 * case-insensitive: exact headings first, then headings that contain the words. Several:
 * the candidates. None: no candidates.
 */
export function findSection(all: Heading[], ref: string): SectionFind {
	const segs = ref
		.split(/\s+(?:>|›|\/)\s+|\s*(?:>|›)\s*/)
		.map(norm)
		.filter(Boolean);
	if (!segs.length) return { candidates: [] };
	for (const same of [(a: string, b: string) => a === b, (a: string, b: string) => a.includes(b)]) {
		const hits = all.filter((h) => matchesPath(all, h, segs, same));
		if (hits.length === 1) return { heading: hits[0]! };
		if (hits.length > 1) return { candidates: hits };
	}
	return { candidates: [] };
}

/** The heading a position is in (the last one starting at or before it). */
export function headingAt(all: Heading[], pos: number): Heading | undefined {
	let found: Heading | undefined;
	for (const h of all) {
		if (h.offset > pos) break;
		found = h;
	}
	return found;
}

export interface Page {
	text: string;
	/** Where the page starts and ends in the whole text. */
	from: number;
	to: number;
	total: number;
	/** Where the next page starts; undefined at the end. */
	next?: number;
}

/**
 * The characters from `offset`, at most `max`. A page that would end inside a line ends after the
 * last line break in its last fifth instead, so the next one starts on a new line.
 */
export function page(text: string, offset: number, max: number): Page {
	const from = Math.min(Math.max(0, Math.floor(offset)), text.length);
	let to = Math.min(text.length, from + Math.max(1, Math.floor(max)));
	if (to < text.length) {
		const nl = text.lastIndexOf("\n", to - 1);
		if (nl >= from + Math.floor(max * 0.8)) to = nl + 1;
	}
	return {
		text: text.slice(from, to),
		from,
		to,
		total: text.length,
		next: to < text.length ? to : undefined,
	};
}
