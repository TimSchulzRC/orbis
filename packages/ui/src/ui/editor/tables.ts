// GFM tables read as tables: while the cursor is elsewhere a table shows as one, drawn like in
// read-only text (Markdown.tsx), its cells formatted, its links working. A click into a cell
// shows its Markdown, the cursor where the click was. There Tab and Shift-Tab go from cell to
// cell, Enter adds a row, and the block menu (or a right click on the table) adds and removes
// rows and columns. The Markdown stays the table: only the lines and cells an edit is about change.
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type Extension, Prec, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType, keymap } from "@codemirror/view";
import { BetweenHorizontalEnd, BetweenHorizontalStart, BetweenVerticalEnd, BetweenVerticalStart, Trash2 } from "lucide-react";
import { tr } from "../../i18n";
import { hydrateFiles, renderMarkdown } from "../Markdown";
import { type MenuEntry, showMenu } from "./menu";
import { type Change, cellAt, deleteCell, emptyRow, insertCell, newTable, parseRow, sourceOffset } from "./tableText";

/** A table of the text: from the start of its first line to the end of its last; line numbers. */
export interface TableBlock {
  from: number;
  to: number;
  first: number;
  last: number;
}

const block = (state: EditorState, from: number, to: number): TableBlock => {
  const a = state.doc.lineAt(from);
  const b = state.doc.lineAt(to);
  return { from: a.from, to: b.to, first: a.number, last: b.number };
};

/** The tables of the text, those on their own (one in a list or a quote stays text). */
function tablesOf(state: EditorState): TableBlock[] {
  const out: TableBlock[] = [];
  for (let n = syntaxTree(state).topNode.firstChild; n; n = n.nextSibling) if (n.name === "Table") out.push(block(state, n.from, n.to));
  return out;
}

/** The table the line at `pos` belongs to. */
export function tableAt(state: EditorState, pos: number): TableBlock | null {
  const line = state.doc.lineAt(pos);
  if (!line.text.trim()) return null;
  for (let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(line.from, 1); n; n = n.parent)
    if (n.name === "Table") return n.parent?.name === "Document" ? block(state, n.from, n.to) : null;
  return null;
}

// ---------- edits ----------

/** The rows of a table that hold cells: the header and the rows below the delimiter. */
const cellLines = (t: TableBlock) => Array.from({ length: t.last - t.first + 1 }, (_, i) => t.first + i).filter((n) => n !== t.first + 1);

/** The cursor in a table's cell: its table, line and column. */
function cellOf(state: EditorState, pos: number) {
  const t = tableAt(state, pos);
  if (!t) return null;
  const line = state.doc.lineAt(pos);
  return { t, line: line.number, col: cellAt(parseRow(line.text), pos - line.from) };
}

/** The end of the text of cell `col` in line `n`: where the cursor goes. */
function cellEnd(state: EditorState, n: number, col: number) {
  const line = state.doc.line(n);
  const cells = parseRow(line.text).cells;
  const c = cells[Math.min(col, cells.length - 1)];
  return line.from + (c ? c.to : line.length);
}

const width = (state: EditorState, t: TableBlock) => parseRow(state.doc.line(t.first).text).cells.length;
const outer = (state: EditorState, t: TableBlock) => parseRow(state.doc.line(t.first).text).lead;

/** An empty row below line `n` (below the delimiter when that is the header); the cursor in its first cell. */
export function addRow(view: EditorView, t: TableBlock, n: number) {
  const { state } = view;
  const at = state.doc.line(Math.max(n, t.first + 1));
  const row = emptyRow(width(state, t), outer(state, t));
  const first = parseRow(row).cells[0]!;
  view.dispatch({ changes: { from: at.to, insert: "\n" + row }, selection: EditorSelection.cursor(at.to + 1 + first.from), scrollIntoView: true, userEvent: "input" });
}

/** Take row `n` away (not the header, not the delimiter). */
export function deleteRow(view: EditorView, t: TableBlock, n: number) {
  if (n < t.first + 2) return;
  const { doc } = view.state;
  const line = doc.line(n);
  const next = n < t.last ? n : n - 1;
  view.dispatch({ changes: { from: line.from - 1, to: line.to }, selection: EditorSelection.cursor(Math.min(line.from - 1, doc.line(next).to)), userEvent: "delete" });
}

/** Lines' cell edits as one change set: each line's offsets moved to the line. */
function perLine(view: EditorView, t: TableBlock, edit: (text: string, n: number) => Change | null) {
  const { doc } = view.state;
  const specs: Change[] = [];
  for (let n = t.first; n <= t.last; n++) {
    const line = doc.line(n);
    const c = edit(line.text, n);
    if (c) specs.push({ from: line.from + c.from, to: line.from + c.to, insert: c.insert });
  }
  return view.state.changes(specs);
}

/** A new column at index `at`; the cursor in its header cell. */
export function addColumn(view: EditorView, t: TableBlock, at: number) {
  const changes = perLine(view, t, (text, n) => insertCell(text, at, n === t.first + 1 ? "---" : ""));
  const head = changes.mapPos(view.state.doc.line(t.first).from);
  view.dispatch({ changes, userEvent: "input" });
  const line = view.state.doc.lineAt(head);
  const c = parseRow(line.text).cells[at];
  if (c) view.dispatch({ selection: EditorSelection.cursor(line.from + c.from) });
}

/** Take column `col` away, in every row that has it (never the last column). */
export function deleteColumn(view: EditorView, t: TableBlock, col: number) {
  if (width(view.state, t) < 2) return;
  const head = view.state.selection.main.head;
  const changes = perLine(view, t, (text) => deleteCell(text, col));
  view.dispatch({ changes, selection: EditorSelection.cursor(changes.mapPos(head)), userEvent: "delete" });
}

/** The table's entries for a menu: rows and columns around the cell in line `n`, column `col`. */
export function tableEntries(view: EditorView, t: TableBlock, n: number, col: number): MenuEntry[] {
  const body = n >= t.first + 2;
  const run = (f: () => void) => () => (f(), view.focus());
  // what to do is said of the table as it is when chosen, not when the menu opened
  const now = () => tableAt(view.state, t.from) ?? t;
  return [
    ...(body ? [{ label: tr("editor.table.rowAbove"), icon: BetweenHorizontalStart, run: run(() => addRow(view, now(), n - 1)) }] : []),
    { label: tr("editor.table.rowBelow"), icon: BetweenHorizontalEnd, run: run(() => addRow(view, now(), n)) },
    { label: tr("editor.table.colLeft"), icon: BetweenVerticalStart, run: run(() => addColumn(view, now(), col)) },
    { label: tr("editor.table.colRight"), icon: BetweenVerticalEnd, run: run(() => addColumn(view, now(), col + 1)) },
    ...(body ? [{ label: tr("editor.table.deleteRow"), icon: Trash2, danger: true, run: run(() => deleteRow(view, now(), n)) }] : []),
    ...(width(view.state, t) > 1 ? [{ label: tr("editor.table.deleteColumn"), icon: Trash2, danger: true, run: run(() => deleteColumn(view, now(), col)) }] : []),
  ];
}

/** The cell the block menu is about: the cursor's when it is in the table, else the last row's first. */
export function menuCell(state: EditorState, t: TableBlock) {
  const c = cellOf(state, state.selection.main.head);
  return c && c.t.from === t.from ? { n: c.line === t.first + 1 ? t.first : c.line, col: c.col } : { n: t.last, col: 0 };
}

/** A new table on the line (the line itself if it is empty), apart from the text around it; its first header cell selected. */
export function insertTable(view: EditorView, pos: number) {
  const { state } = view;
  const line = state.doc.lineAt(pos);
  const text = newTable([1, 2, 3].map((n) => tr("editor.table.column", { n })), 2);
  const before = line.length ? "\n\n" : line.number > 1 && state.doc.line(line.number - 1).text.trim() ? "\n" : "";
  const nextLine = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const after = nextLine?.text.trim() ? "\n" : nextLine ? "" : "\n";
  const from = line.length ? line.to : line.from;
  const start = from + before.length;
  const first = parseRow(text.split("\n")[0]!).cells[0]!;
  view.dispatch({ changes: { from, to: line.length ? from : line.to, insert: before + text + after }, selection: EditorSelection.range(start + first.from, start + first.to), scrollIntoView: true, userEvent: "input" });
  view.focus();
}

// ---------- keys in a table's Markdown ----------

/** Tab and Shift-Tab: the next or the previous cell; Tab in the last one adds a row. */
function moveCell(dir: 1 | -1) {
  return (view: EditorView) => {
    const s = view.state.selection.main;
    const c = cellOf(view.state, s.head);
    if (!c || view.state.readOnly) return false;
    const rows = cellLines(c.t);
    const n = c.line === c.t.first + 1 ? c.t.first : c.line;
    const cols = parseRow(view.state.doc.line(n).text).cells.length;
    const i = rows.indexOf(n);
    let target: { n: number; col: number } | null = null;
    if (dir > 0) target = c.col + 1 < cols ? { n, col: c.col + 1 } : rows[i + 1] ? { n: rows[i + 1]!, col: 0 } : null;
    else target = c.col > 0 ? { n, col: c.col - 1 } : rows[i - 1] ? { n: rows[i - 1]!, col: parseRow(view.state.doc.line(rows[i - 1]!).text).cells.length - 1 } : null;
    if (target) view.dispatch({ selection: EditorSelection.cursor(cellEnd(view.state, target.n, target.col)), scrollIntoView: true });
    else if (dir > 0) addRow(view, c.t, c.t.last);
    return true;
  };
}

/** Enter: a new row below this one. In an empty last row it ends the table, a line of text after it. */
function enterRow(view: EditorView) {
  const s = view.state.selection.main;
  const c = s.empty ? cellOf(view.state, s.head) : null;
  if (!c || view.state.readOnly) return false;
  const { doc } = view.state;
  const line = doc.line(c.line);
  const empty = c.line >= c.t.first + 2 && parseRow(line.text).cells.every((x) => x.from === x.to);
  if (empty && c.line === c.t.last) {
    view.dispatch({ changes: { from: line.from - 1, to: line.to, insert: "\n\n" }, selection: EditorSelection.cursor(line.from + 1), scrollIntoView: true, userEvent: "input" });
    return true;
  }
  addRow(view, c.t, c.line);
  return true;
}

/** Shift-Enter: a line break within the cell (a table row is one line of Markdown). */
function breakInCell(view: EditorView) {
  const s = view.state.selection.main;
  if (view.state.readOnly || !cellOf(view.state, s.head) || view.state.doc.lineAt(s.from).number !== view.state.doc.lineAt(s.to).number) return false;
  view.dispatch(view.state.replaceSelection("<br>"), { userEvent: "input" });
  return true;
}

// ---------- the table as a table ----------

/** Where a click in a cell lies in the Markdown; null outside the cells. */
function clickPos(view: EditorView, wrap: HTMLElement, e: MouseEvent): number | null {
  const cell = (e.target as HTMLElement).closest<HTMLTableCellElement>("th, td");
  const t = tableAt(view.state, view.posAtDOM(wrap));
  if (!t) return null;
  if (!cell) return cellEnd(view.state, t.first, 0);
  const row = cell.parentElement as HTMLTableRowElement;
  const head = row.parentElement?.tagName === "THEAD";
  const n = head ? t.first : t.first + 2 + [...row.parentElement!.children].indexOf(row);
  if (n > t.last) return null;
  const line = view.state.doc.line(n);
  const cells = parseRow(line.text).cells;
  const c = cells[cell.cellIndex];
  if (!c) return line.from + (cells.at(-1)?.to ?? line.length);
  // how far into the cell's shown text the click was
  let k = cell.textContent?.length ?? 0;
  const caret = document.caretPositionFromPoint?.(e.clientX, e.clientY);
  const node = caret?.offsetNode;
  if (node && cell.contains(node)) {
    const r = document.createRange();
    r.setStart(cell, 0);
    r.setEnd(node, caret.offset);
    k = r.toString().length;
  }
  return line.from + c.from + sourceOffset(line.text.slice(c.from, c.to), cell.textContent ?? "", k);
}

class TableWidget extends WidgetType {
  constructor(readonly src: string, readonly rows: number) {
    super();
  }
  override eq(o: TableWidget) {
    return o.src === this.src;
  }
  override get estimatedHeight() {
    return this.rows * 34 + 12;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-table md";
    wrap.innerHTML = renderMarkdown(this.src);
    hydrateFiles(wrap);
    wrap.addEventListener("mousedown", (e) => {
      // links open (their own click), and text can be selected while not editable
      if (e.button !== 0 || view.state.readOnly || (e.target as HTMLElement).closest("a")) return;
      const pos = clickPos(view, wrap, e);
      if (pos === null) return;
      e.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true, userEvent: "select.pointer" });
      view.focus();
    });
    wrap.addEventListener("contextmenu", (e) => {
      if (view.state.readOnly || (e.target as HTMLElement).closest("a")) return;
      const t = tableAt(view.state, view.posAtDOM(wrap));
      const pos = clickPos(view, wrap, e);
      if (!t || pos === null) return;
      e.preventDefault();
      const n = view.state.doc.lineAt(pos).number;
      showMenu({ left: e.clientX, top: e.clientY + 4 }, [{ entries: tableEntries(view, t, n, cellAt(parseRow(view.state.doc.line(n).text), pos - view.state.doc.line(n).from)) }]).focusFirst();
    });
    return wrap;
  }
  override ignoreEvent() {
    return true;
  }
}

const focused = StateEffect.define<boolean>();
const source = Decoration.line({ class: "cm-tablesrc" });

/** Each table as a table, or as its Markdown while the cursor (or a selection) is in it. */
function decos(state: EditorState, focus: boolean): DecorationSet {
  const out: Range<Decoration>[] = [];
  for (const t of tablesOf(state)) {
    const editing = focus && !state.readOnly && state.selection.ranges.some((r) => r.from <= t.to && r.to >= t.from);
    if (!editing) out.push(Decoration.replace({ widget: new TableWidget(state.sliceDoc(t.from, t.to), t.last - t.first + 1), block: true }).range(t.from, t.to));
    else for (let n = t.first; n <= t.last; n++) out.push(source.range(state.doc.line(n).from));
  }
  return Decoration.set(out, true);
}

// a field, not a view plugin: a table drawn as a block takes several lines' place
const field = StateField.define<{ focus: boolean; deco: DecorationSet }>({
  create: (state) => ({ focus: false, deco: decos(state, false) }),
  update(v, t) {
    let focus = v.focus;
    for (const e of t.effects) if (e.is(focused)) focus = e.value;
    const changed = t.docChanged || !!t.selection || focus !== v.focus || t.startState.readOnly !== t.state.readOnly || syntaxTree(t.startState) !== syntaxTree(t.state);
    return changed ? { focus, deco: decos(t.state, focus) } : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export const tables: Extension = [
  field,
  EditorView.focusChangeEffect.of((_s, focusing) => focused.of(focusing)),
  Prec.high(
    keymap.of([
      { key: "Tab", run: moveCell(1) },
      { key: "Shift-Tab", run: moveCell(-1) },
      { key: "Enter", run: enterRow },
      { key: "Shift-Enter", run: breakInCell },
    ]),
  ),
];
