// GFM tables as text: the cells of a row line, and the small edits the editor makes to a table
// (a row, a column, a new table). Every edit touches only the lines and cells it has to, and
// leaves the spacing of the others as it is: agents diff these texts.
// Pure, without CodeMirror: positions are offsets in a line's text.

/** A cell of a row: `from`–`to` its text without the spaces around it, `start`–`end` all between its pipes. */
export interface Cell {
  from: number;
  to: number;
  start: number;
  end: number;
}

export interface Row {
  cells: Cell[];
  /** The row starts with a pipe ("| a | b"). */
  lead: boolean;
  /** Where the unescaped pipes are. */
  pipes: number[];
}

export type Align = "left" | "center" | "right" | null;

/** The delimiter row under the header: "| --- | :-: |", one or more dashes per cell. */
export const DELIMITER = /^[\s>]*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;

/** The cells of a table row; a "\|" is a pipe within a cell. */
export function parseRow(text: string): Row {
  const pipes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "|") pipes.push(i);
  }
  const first = text.search(/\S/);
  const last = text.trimEnd().length - 1;
  const lead = first >= 0 && pipes[0] === first;
  // a pipe at the end closes the last cell (unless it is the only pipe and opens the row)
  const trail = pipes.length > (lead ? 1 : 0) && pipes.at(-1) === last;
  const spans: [number, number][] = [];
  let s = lead ? pipes[0]! + 1 : Math.max(0, first);
  for (const p of pipes.slice(lead ? 1 : 0)) {
    spans.push([s, p]);
    s = p + 1;
  }
  if (!trail) spans.push([s, text.length]);
  const cells: Cell[] = spans.map(([start, end]) => {
    const raw = text.slice(start, end);
    const body = raw.trim();
    if (!body) {
      const at = Math.min(end, start + (raw.length > 0 ? 1 : 0));
      return { start, end, from: at, to: at };
    }
    const from = start + raw.length - raw.trimStart().length;
    return { start, end, from, to: from + body.length };
  });
  return { cells, lead, pipes };
}

/** The column the offset lies in (between two pipes), within the row's cells. */
export function cellAt(row: Row, offset: number): number {
  let i = row.cells.findIndex((c) => offset >= c.start && offset <= c.end);
  if (i < 0) i = offset < (row.cells[0]?.start ?? 0) ? 0 : row.cells.length - 1;
  return Math.max(0, i);
}

/** How the columns are aligned, from the delimiter row (":--", ":-:", "--:"). */
export function alignments(delimiter: string): Align[] {
  const row = parseRow(delimiter);
  return row.cells.map((c) => {
    const d = delimiter.slice(c.from, c.to);
    const l = d.startsWith(":");
    const r = d.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : null;
  });
}

/** An empty row of `n` cells, with pipes at its ends (without them empty cells would not count). */
export function emptyRow(n: number): string {
  return `| ${Array.from({ length: n }, () => "").join(" | ")} |`;
}

/** A new table: a header with these names, the delimiter row and `rows` empty rows. */
export function newTable(header: string[], rows = 1): string {
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...Array.from({ length: rows }, () => emptyRow(header.length))].join("\n");
}

export interface Change {
  from: number;
  to: number;
  insert: string;
}

/**
 * A new cell at index `at` (0: before the first) in one row line, with `fill` in it ("---" in the
 * delimiter row). A row shorter than that stays as it is (its missing cells are empty anyway).
 * Offsets relative to the line.
 */
export function insertCell(text: string, at: number, fill = ""): Change | null {
  const row = parseRow(text);
  if (at > row.cells.length || !row.cells.length) return null;
  if (at === 0) {
    const c = row.cells[0]!;
    if (row.lead) return { from: c.start, to: c.start, insert: ` ${fill} |` };
    // without a pipe in front an empty first cell would not count: the row gets one
    return { from: c.start, to: c.start, insert: `| ${fill} | ` };
  }
  const prev = row.cells[at - 1]!;
  // the pipe after the previous cell: the new cell goes in front of it
  if (prev.end < text.length && text[prev.end] === "|") return { from: prev.end, to: prev.end, insert: `| ${fill} ` };
  // the last cell, no pipe after it (an empty cell there needs a closing one)
  const end = text.trimEnd().length;
  return { from: end, to: end, insert: fill ? ` | ${fill}` : " |  |" };
}

/**
 * Take the cell at index `col` out of one row line; null when the row has no such cell. A row
 * that has only this cell keeps an empty one; one left with a single cell gets pipes at its
 * ends (without them it would be no row of a table).
 */
export function deleteCell(text: string, col: number): Change | null {
  const row = parseRow(text);
  if (col >= row.cells.length) return null;
  const c = row.cells[col]!;
  if (row.cells.length < 2) return row.pipes.length ? { from: c.from, to: c.to, insert: "" } : { from: 0, to: text.length, insert: "|  |" };
  if (row.cells.length === 2 && !row.lead) {
    const keep = row.cells[1 - col]!;
    return { from: 0, to: text.length, insert: `| ${text.slice(keep.from, keep.to)} |` };
  }
  const pipeAfter = c.end < text.length && text[c.end] === "|";
  if (pipeAfter) {
    // "| a | b | c |" without b: from after the pipe before it up to and with the pipe after it
    if (col === 0 && !row.lead) {
      let to = c.end + 1;
      while (to < text.length && text[to] === " ") to++;
      return { from: c.start, to, insert: "" };
    }
    return { from: c.start, to: c.end + 1, insert: "" };
  }
  // the last cell without a pipe after it: from the end of the cell before
  const before = row.cells[col - 1]!;
  return { from: before.to, to: text.trimEnd().length, insert: "" };
}

/**
 * Where a place in a cell's shown text lies in its Markdown: walk both and skip what only the
 * Markdown has ("**", "`", "[[", the address of a link …). Good enough to put the cursor where
 * a click was.
 */
export function sourceOffset(src: string, shown: string, k: number): number {
  let i = 0;
  let j = 0;
  while (j < k && i < src.length) {
    // a "<br>" shows no letter
    const br = /^<br\s*\/?>/i.exec(src.slice(i, i + 6));
    if (br) {
      i += br[0].length;
      continue;
    }
    if (src[i] === shown[j]) j++;
    i++;
  }
  // past marks that close right here ("**word**|"), not those that open the next word
  return Math.min(i, src.length);
}
