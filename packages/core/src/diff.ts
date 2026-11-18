// Line diffs between two versions of a text, for the history of an item's body: hunks for the
// app (lines marked as kept, added or removed) and a compact unified diff for agents. The diff
// itself comes from jsdiff (Myers); here only the shape the app and the tools need.
import { diffArrays, diffWordsWithSpace, structuredPatch } from "diff";

export interface DiffLine {
	op: " " | "+" | "-";
	text: string;
}

export interface Hunk {
	/** first line of the hunk in the old and in the new text, counted from 1 */
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: DiffLine[];
}

export interface TextDiff {
	hunks: Hunk[];
	added: number;
	removed: number;
}

/**
 * Above this many edits, or after this long, the diff gives up and shows the whole text as
 * replaced: a big rewrite of a long text stays cheap (the server diffs while answering a tool call).
 */
const MAX_EDITS = 1000;
const MAX_MS = 250;

/** The changed lines between `a` and `b`, with `context` unchanged lines around each change. */
export function textDiff(a: string, b: string, context = 3): TextDiff {
	if (a === b) return { hunks: [], added: 0, removed: 0 };
	// jsdiff marks a missing final newline with an extra line; both sides end with one, so it never does
	const nl = (s: string) => (s === "" || s.endsWith("\n") ? s : `${s}\n`);
	const patch = structuredPatch("", "", nl(a), nl(b), undefined, undefined, {
		context,
		maxEditLength: MAX_EDITS,
		timeout: MAX_MS,
	});
	const hunks: Hunk[] = patch
		? patch.hunks.map((h) => ({
				oldStart: h.oldStart,
				oldLines: h.oldLines,
				newStart: h.newStart,
				newLines: h.newLines,
				lines: h.lines
					.filter((l) => l[0] !== "\\")
					.map((l) => ({ op: l[0] as DiffLine["op"], text: l.slice(1) })),
			}))
		: [replacedAll(a, b)];
	let added = 0;
	let removed = 0;
	for (const h of hunks)
		for (const l of h.lines) l.op === "+" ? added++ : l.op === "-" && removed++;
	return { hunks, added, removed };
}

function replacedAll(a: string, b: string): Hunk {
	const lines = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));
	const old = lines(a);
	const now = lines(b);
	return {
		oldStart: old.length ? 1 : 0,
		oldLines: old.length,
		newStart: now.length ? 1 : 0,
		newLines: now.length,
		lines: [
			...old.map((text) => ({ op: "-" as const, text })),
			...now.map((text) => ({ op: "+" as const, text })),
		],
	};
}

export interface Unified {
	text: string;
	/** lines of the full diff (hunk headers included) and how many of them are in `text` */
	total: number;
	shown: number;
}

/**
 * The diff as unified text ("@@ -3,2 +3,4 @@", then " ", "+", "-" lines), at most `maxLines`
 * lines. Lines longer than `maxWidth` are cut with "…". Whoever shows it says how to get the rest.
 */
export function unifiedDiff(
	d: TextDiff,
	opts: { maxLines?: number; maxWidth?: number } = {},
): Unified {
	const max = opts.maxLines ?? Number.POSITIVE_INFINITY;
	const width = opts.maxWidth ?? Number.POSITIVE_INFINITY;
	const out: string[] = [];
	let total = 0;
	const push = (s: string) => {
		total++;
		if (out.length < max) out.push(s.length > width ? `${s.slice(0, width - 1)}…` : s);
	};
	for (const h of d.hunks) {
		push(`@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`);
		for (const l of h.lines) push(l.op + l.text);
	}
	return { text: out.join("\n"), total, shown: out.length };
}

const range = (start: number, lines: number) => (lines === 1 ? `${start}` : `${start},${lines}`);

/** A part of a changed line: kept, or only in the old (`-`) or the new (`+`) one. */
export type WordPart = { op: DiffLine["op"]; text: string };

/** Which words of a line changed: the old line's parts (kept and removed) and the new one's (kept and added). */
export function wordDiff(a: string, b: string): { old: WordPart[]; now: WordPart[] } {
	const old: WordPart[] = [];
	const now: WordPart[] = [];
	for (const p of diffWordsWithSpace(a, b)) {
		if (!p.added) old.push({ op: p.removed ? "-" : " ", text: p.value });
		if (!p.removed) now.push({ op: p.added ? "+" : " ", text: p.value });
	}
	return { old, now };
}

/** One change against the base text: its lines [start, end) become `lines` (start = end: inserted). */
interface Edit {
	start: number;
	end: number;
	lines: string[];
}

/** How long a merge may diff: past that (huge rewrites) the draft is kept as it is. */
const MERGE_MS = 250;

/**
 * The changes that turn `base` into `other`, each on its own range of base lines. A block of lines
 * changed one for one is one change per line, so a clash on one of them leaves the others. undefined
 * when the diff takes too long.
 */
function editsOf(base: string[], other: string[]): Edit[] | undefined {
	const parts = diffArrays(base, other, { timeout: MERGE_MS });
	if (!parts) return undefined;
	const out: Edit[] = [];
	let at = 0;
	let open: Edit | undefined; // the edit a removal and an addition next to each other share
	for (const part of parts) {
		if (!part.added && !part.removed) {
			at += part.count;
			open = undefined;
			continue;
		}
		if (!open) {
			open = { start: at, end: at, lines: [] };
			out.push(open);
		}
		if (part.added) open.lines.push(...part.value);
		else {
			at += part.count;
			open.end = at;
		}
	}
	return out.flatMap((e) =>
		e.end - e.start > 1 && e.end - e.start === e.lines.length
			? e.lines.map((line, i) => ({ start: e.start + i, end: e.start + i + 1, lines: [line] }))
			: [e],
	);
}

/** Two edits that touch the same base lines, or insert at the same place. */
const clash = (a: Edit, b: Edit) =>
	(a.start < b.end && b.start < a.end) ||
	(a.start === a.end && b.start === b.end && a.start === b.start);

/**
 * The edits made from `base` to `draft`, applied to `current`, which someone else changed from
 * `base` meanwhile: a three-way merge by lines on the base's line ranges. Where both changed the
 * same lines, theirs stays and that edit of the draft gives way; every other edit of both goes in.
 */
export function mergeText(base: string, draft: string, current: string): string {
	if (current === base || draft === current) return draft;
	if (draft === base) return current;
	const lines = base.split("\n");
	const theirs = editsOf(lines, current.split("\n"));
	const drafted = editsOf(lines, draft.split("\n"));
	if (!theirs || !drafted) return draft; // too big to merge in time: the text on screen stays
	const mine = drafted.filter((m) => !theirs.some((t) => clash(m, t)));
	// in base order; an insertion before a change that starts at the same line
	const all = [...theirs, ...mine].sort(
		(a, b) => a.start - b.start || a.end - a.start - (b.end - b.start),
	);
	const out: string[] = [];
	let at = 0;
	for (const e of all) {
		out.push(...lines.slice(at, e.start), ...e.lines);
		at = Math.max(at, e.end);
	}
	out.push(...lines.slice(at));
	return out.join("\n");
}
