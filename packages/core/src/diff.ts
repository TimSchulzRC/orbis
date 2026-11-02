// Line diffs between two versions of a text, for the history of an item's body: hunks for the
// app (lines marked as kept, added or removed) and a compact unified diff for agents. The diff
// itself comes from jsdiff (Myers); here only the shape the app and the tools need.
import { structuredPatch } from "diff";

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
  const nl = (s: string) => (s === "" || s.endsWith("\n") ? s : s + "\n");
  const patch = structuredPatch("", "", nl(a), nl(b), undefined, undefined, { context, maxEditLength: MAX_EDITS, timeout: MAX_MS });
  const hunks: Hunk[] = patch
    ? patch.hunks.map((h) => ({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines: h.lines.filter((l) => l[0] !== "\\").map((l) => ({ op: l[0] as DiffLine["op"], text: l.slice(1) })),
      }))
    : [replacedAll(a, b)];
  let added = 0;
  let removed = 0;
  for (const h of hunks) for (const l of h.lines) l.op === "+" ? added++ : l.op === "-" && removed++;
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
    lines: [...old.map((text) => ({ op: "-" as const, text })), ...now.map((text) => ({ op: "+" as const, text }))],
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
export function unifiedDiff(d: TextDiff, opts: { maxLines?: number; maxWidth?: number } = {}): Unified {
  const max = opts.maxLines ?? Infinity;
  const width = opts.maxWidth ?? Infinity;
  const out: string[] = [];
  let total = 0;
  const push = (s: string) => {
    total++;
    if (out.length < max) out.push(s.length > width ? s.slice(0, width - 1) + "…" : s);
  };
  for (const h of d.hunks) {
    push(`@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`);
    for (const l of h.lines) push(l.op + l.text);
  }
  return { text: out.join("\n"), total, shown: out.length };
}

const range = (start: number, lines: number) => (lines === 1 ? `${start}` : `${start},${lines}`);
