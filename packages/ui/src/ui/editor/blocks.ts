// Blocks of the text as Notion has them: every line is one (a fenced code or query block is one
// as a whole). Their kind is the Markdown at the start of the line, so turning a block into
// another kind only changes that prefix – the text stays Markdown for sync, search and agents.
import type { ComponentType } from "react";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type Line } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { CheckSquare, Heading1, Heading2, Heading3, List, ListOrdered, Quote, Type } from "lucide-react";
import { tr } from "../../i18n";

type BlockKind = "text" | "h1" | "h2" | "h3" | "bullet" | "number" | "todo" | "quote";

export const KINDS: { kind: BlockKind; prefix: string; icon: ComponentType<{ size?: number }> }[] = [
  { kind: "text", prefix: "", icon: Type },
  { kind: "h1", prefix: "# ", icon: Heading1 },
  { kind: "h2", prefix: "## ", icon: Heading2 },
  { kind: "h3", prefix: "### ", icon: Heading3 },
  { kind: "bullet", prefix: "- ", icon: List },
  { kind: "number", prefix: "1. ", icon: ListOrdered },
  { kind: "todo", prefix: "- [ ] ", icon: CheckSquare },
  { kind: "quote", prefix: "> ", icon: Quote },
];

export const kindName = (k: BlockKind) => tr("editor.block." + k);

/** Indentation, then the block's Markdown prefix (heading, task, list, quote). */
const PREFIX = /^(\s*)(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?)?/;

export function kindOf(text: string): BlockKind {
  const p = PREFIX.exec(text)?.[2] ?? "";
  if (/^# /.test(p)) return "h1";
  if (/^## /.test(p)) return "h2";
  if (/^#{3,6} /.test(p)) return "h3";
  if (/\[[ xX]\]/.test(p)) return "todo";
  if (/^[-*+] /.test(p)) return "bullet";
  if (/^\d/.test(p)) return "number";
  if (/^>/.test(p)) return "quote";
  return "text";
}

/** Turn the line at `pos` into another kind of block; the cursor keeps its place in the text. */
export function setKind(view: EditorView, pos: number, kind: BlockKind) {
  const line = view.state.doc.lineAt(pos);
  const m = PREFIX.exec(line.text)!;
  const from = line.from + m[1]!.length;
  const old = m[2] ?? "";
  const prefix = KINDS.find((k) => k.kind === kind)!.prefix;
  const changes = view.state.changes({ from, to: from + old.length, insert: prefix });
  const head = view.state.selection.main.head;
  const inLine = head >= line.from && head <= line.to;
  view.dispatch({ changes, selection: EditorSelection.cursor(changes.mapPos(inLine ? Math.max(head, from + old.length) : line.to, 1)), scrollIntoView: true });
  view.focus();
}

/** The lines a selection covers; a selection that ends at the start of a line leaves that line out. */
export function linesOf(state: EditorState, from: number, to: number) {
  const first = state.doc.lineAt(from);
  let last = state.doc.lineAt(to);
  if (to > from && to === last.from && last.number > first.number) last = state.doc.line(last.number - 1);
  const out: Line[] = [];
  for (let n = first.number; n <= last.number; n++) out.push(state.doc.line(n));
  return out;
}

const inFence = (state: EditorState, pos: number) => {
  for (let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) if (n.name === "FencedCode") return true;
  return false;
};

/** The kind of the selected blocks: theirs when they all have one, else null. Lines in a fenced block do not count. */
export function kindOfRange(state: EditorState, from: number, to: number): BlockKind | null {
  const kinds = new Set(linesOf(state, from, to).filter((l) => !inFence(state, l.from)).map((l) => kindOf(l.text)));
  return kinds.size === 1 ? [...kinds][0]! : null;
}

/** Turn every selected block into another kind (fenced blocks stay as they are); the selection stays on the same text. */
export function setKindRange(view: EditorView, from: number, to: number, kind: BlockKind) {
  const { state } = view;
  const prefix = KINDS.find((k) => k.kind === kind)!.prefix;
  const changes = state.changes(
    linesOf(state, from, to)
      .filter((l) => !inFence(state, l.from))
      .map((l) => {
        const m = PREFIX.exec(l.text)!;
        const at = l.from + m[1]!.length;
        return { from: at, to: at + (m[2] ?? "").length, insert: prefix };
      }),
  );
  view.dispatch({ changes, selection: state.selection.map(changes), scrollIntoView: true });
  view.focus();
}

/** The block at a position: its line, or the whole fenced block it lies in. */
export function blockAt(state: EditorState, pos: number): { from: number; to: number } {
  const line = state.doc.lineAt(pos);
  let node = syntaxTree(state).resolveInner(line.from, 1);
  for (let n: typeof node | null = node; n; n = n.parent) if (n.name === "FencedCode") return { from: state.doc.lineAt(n.from).from, to: state.doc.lineAt(n.to).to };
  return { from: line.from, to: line.to };
}

/** Move the block [from, to] (whole lines) so it starts where line `target` started (doc.length: at the end). */
export function moveBlock(view: EditorView, b: { from: number; to: number }, target: number) {
  const { doc } = view.state;
  if (target >= b.from && target <= b.to + 1) return;
  const text = doc.sliceString(b.from, b.to);
  const remove = b.to < doc.length ? { from: b.from, to: b.to + 1 } : { from: Math.max(0, b.from - 1), to: b.to };
  const insert = target >= doc.length ? { from: doc.length, insert: "\n" + text } : { from: target, insert: text + "\n" };
  const changes = view.state.changes([remove, insert]);
  const start = changes.mapPos(insert.from, -1) + (target >= doc.length ? 1 : 0);
  view.dispatch({ changes, selection: EditorSelection.cursor(start + text.length), scrollIntoView: true });
}

export function moveBy(view: EditorView, pos: number, dir: -1 | 1) {
  const { doc } = view.state;
  const b = blockAt(view.state, pos);
  if (dir < 0) {
    if (b.from === 0) return;
    moveBlock(view, b, blockAt(view.state, b.from - 1).from);
  } else {
    if (b.to >= doc.length) return;
    const next = blockAt(view.state, b.to + 1);
    moveBlock(view, b, next.to >= doc.length ? doc.length : next.to + 1);
  }
}

export function duplicateBlock(view: EditorView, pos: number) {
  const b = blockAt(view.state, pos);
  const text = view.state.doc.sliceString(b.from, b.to);
  view.dispatch({ changes: { from: b.to, insert: "\n" + text }, selection: EditorSelection.cursor(b.to + 1 + text.length) });
  view.focus();
}

export function deleteBlock(view: EditorView, pos: number) {
  const { doc } = view.state;
  const b = blockAt(view.state, pos);
  const range = b.to < doc.length ? { from: b.from, to: b.to + 1 } : { from: Math.max(0, b.from - 1), to: b.to };
  view.dispatch({ changes: range, selection: EditorSelection.cursor(Math.min(range.from, doc.length - (range.to - range.from))) });
  view.focus();
}

/**
 * The mark characters touching a position on both sides, as runs of one character: around
 * "~~**Text**~~" the start of "Text" has "~~" and "**". Marks are often hidden while the text is
 * not edited, so they may lie inside or outside a selection; the search stays in [lo, hi].
 */
function markRuns(state: EditorState, pos: number, lo: number, hi: number) {
  const isMark = (i: number) => /[*~`]/.test(state.sliceDoc(i, i + 1));
  let a = pos;
  let b = pos;
  while (a > lo && isMark(a - 1)) a--;
  while (b < hi && isMark(b)) b++;
  const runs: { ch: string; from: number; n: number }[] = [];
  for (let i = a; i < b; i++) {
    const ch = state.sliceDoc(i, i + 1);
    const last = runs.at(-1);
    if (last && last.ch === ch && last.from + last.n === i) last.n++;
    else runs.push({ ch, from: i, n: 1 });
  }
  return runs;
}

/** Where `mark` sits in the runs: "**" in two or more stars, "*" in one or three, "~~" in two tildes. */
function markIn(runs: ReturnType<typeof markRuns>, mark: string) {
  return runs.find((r) => r.ch === mark[0] && (mark === "*" ? r.n % 2 === 1 : r.n >= mark.length));
}

/** The changes that toggle `mark` on [from, to] (text within one line): its pair taken away, or put around. */
function markChanges(state: EditorState, from: number, to: number, mark: string): { on: boolean; changes: { from: number; to?: number; insert?: string }[] } {
  const line = state.doc.lineAt(from);
  const open = markIn(markRuns(state, from, line.from, line.to), mark);
  const close = markIn(markRuns(state, to, line.from, line.to), mark);
  // two runs, the opening one before the closing one (not one run of only marks)
  if (open && close && open.from + open.n <= close.from) return { on: true, changes: [{ from: open.from, to: open.from + mark.length }, { from: close.from, to: close.from + mark.length }] };
  return { on: false, changes: [{ from, insert: mark }, { from: to, insert: mark }] };
}

/** Wrap the selection in a mark ("**", "*", "~~", "`"), or take it away when it is there already – also among other marks. */
export function toggleMark(view: EditorView, mark: string) {
  const { state } = view;
  const main = state.selection.main;
  if (state.selection.ranges.length === 1 && state.doc.lineAt(main.from).number !== state.doc.lineAt(main.to).number) return toggleMarkLines(view, mark);
  const tx = state.changeByRange((r) => {
    if (r.empty) {
      // the cursor between an empty pair ("**|**"): ⌘B again takes the pair away
      const L = mark.length;
      if (state.sliceDoc(r.from - L, r.from) === mark && state.sliceDoc(r.from, r.from + L) === mark)
        return { changes: { from: r.from - L, to: r.from + L }, range: EditorSelection.cursor(r.from - L) };
      return { changes: { from: r.from, insert: mark + mark }, range: EditorSelection.cursor(r.from + L) };
    }
    const set = state.changes(markChanges(state, r.from, r.to, mark).changes);
    return { changes: set, range: EditorSelection.range(set.mapPos(r.from, 1), set.mapPos(r.to, -1)) };
  });
  view.dispatch(state.update(tx, { userEvent: "input.format" }));
  view.focus();
  return true;
}

/** A mark over several blocks: Markdown marks end at a line, so each block's selected text gets its own pair. */
function toggleMarkLines(view: EditorView, mark: string) {
  const { state } = view;
  const { from, to } = state.selection.main;
  const parts = linesOf(state, from, to).flatMap((l) => {
    const start = Math.max(from, l.from + PREFIX.exec(l.text)![0].length);
    const text = state.sliceDoc(start, Math.min(to, l.to));
    const lead = text.length - text.trimStart().length;
    const inner = text.trim();
    return inner && !inFence(state, l.from) ? [markChanges(state, start + lead, start + lead + inner.length, mark)] : [];
  });
  if (!parts.length) return true;
  // all marked: take it away everywhere; else add it where it is missing
  const off = parts.every((p) => p.on);
  const changes = state.changes(parts.filter((p) => p.on === off).flatMap((p) => p.changes));
  view.dispatch({ changes, selection: EditorSelection.range(changes.mapPos(from, 1), changes.mapPos(to, -1)), userEvent: "input.format" });
  view.focus();
  return true;
}
