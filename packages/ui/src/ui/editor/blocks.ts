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

/** Wrap the selection in a mark ("**", "*", "~~", "`"), or take it away when it is there already. */
export function toggleMark(view: EditorView, mark: string) {
  const { state } = view;
  const main = state.selection.main;
  if (state.selection.ranges.length === 1 && state.doc.lineAt(main.from).number !== state.doc.lineAt(main.to).number) return toggleMarkLines(view, mark);
  const tx = state.changeByRange((r) => {
    const before = state.sliceDoc(r.from - mark.length, r.from);
    const after = state.sliceDoc(r.to, r.to + mark.length);
    // "*" must not take one star of "**"
    const single = mark.length === 1 && (state.sliceDoc(r.from - 2, r.from) === "**" ? state.sliceDoc(r.to, r.to + 2) !== "**" : true);
    if (before === mark && after === mark && single)
      return { changes: [{ from: r.from - mark.length, to: r.from }, { from: r.to, to: r.to + mark.length }], range: EditorSelection.range(r.from - mark.length, r.to - mark.length) };
    const inner = state.sliceDoc(r.from, r.to);
    if (inner.length > 2 * mark.length && inner.startsWith(mark) && inner.endsWith(mark))
      return { changes: { from: r.from, to: r.to, insert: inner.slice(mark.length, -mark.length) }, range: EditorSelection.range(r.from, r.to - 2 * mark.length) };
    return { changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }], range: EditorSelection.range(r.from + mark.length, r.to + mark.length) };
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
    return inner && !inFence(state, l.from) ? [{ from: start + lead, to: start + lead + inner.length, text: inner }] : [];
  });
  if (!parts.length) return true;
  const L = mark.length;
  const at = (pos: number) => {
    if (state.sliceDoc(pos, pos + L) !== mark) return false;
    if (L > 1) return true;
    // "*" is no star of "**" (but one of "***")
    let run = 1;
    for (let i = pos - 1; state.sliceDoc(i, i + 1) === "*"; i--) run++;
    for (let i = pos + 1; state.sliceDoc(i, i + 1) === "*"; i++) run++;
    return run !== 2;
  };
  // where a part's two marks start: each just outside it (hidden while not edited) or as its own end
  const marksOf = (p: (typeof parts)[number]): [number, number] | null => {
    const open = at(p.from - L) ? p.from - L : at(p.from) ? p.from : -1;
    const close = at(p.to) ? p.to : at(p.to - L) ? p.to - L : -1;
    return open >= 0 && close >= open + L ? [open, close] : null;
  };
  const off = parts.every((p) => marksOf(p));
  const changes = state.changes(
    parts.flatMap((p): { from: number; to?: number; insert?: string }[] => {
      const m = marksOf(p);
      if (off) return [{ from: m![0], to: m![0] + L }, { from: m![1], to: m![1] + L }];
      return m ? [] : [{ from: p.from, insert: mark }, { from: p.to, insert: mark }];
    }),
  );
  view.dispatch({ changes, selection: EditorSelection.range(changes.mapPos(from, -1), changes.mapPos(to, 1)), userEvent: "input.format" });
  view.focus();
  return true;
}
