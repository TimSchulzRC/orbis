// Every line is a block; a fenced block or a table counts as one. A block's kind is its Markdown prefix, so
// changing the kind only rewrites that prefix and the text stays Markdown for sync, search and agents.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type Line, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
	CheckSquare,
	Heading1,
	Heading2,
	Heading3,
	List,
	ListOrdered,
	Quote,
	Type,
} from "lucide-react";
import type { ComponentType } from "react";
import { tr } from "../../i18n";

type BlockKind = "text" | "h1" | "h2" | "h3" | "bullet" | "number" | "todo" | "quote";

export const KINDS: { kind: BlockKind; prefix: string; icon: ComponentType<{ size?: number }> }[] =
	[
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

const PREFIX = /^(\s*)(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?)?/;

const prefixOf = (kind: BlockKind) => KINDS.find((k) => k.kind === kind)!.prefix;

export function kindOf(text: string): BlockKind {
	const prefix = PREFIX.exec(text)?.[2] ?? "";
	if (/^# /.test(prefix)) return "h1";
	if (/^## /.test(prefix)) return "h2";
	if (/^#{3,6} /.test(prefix)) return "h3";
	if (/\[[ xX]\]/.test(prefix)) return "todo";
	if (/^[-*+] /.test(prefix)) return "bullet";
	if (/^\d/.test(prefix)) return "number";
	if (/^>/.test(prefix)) return "quote";
	return "text";
}

/** The cursor keeps its place in the text. */
export function setKind(view: EditorView, pos: number, kind: BlockKind) {
	const line = view.state.doc.lineAt(pos);
	const match = PREFIX.exec(line.text)!;
	const from = line.from + match[1]!.length;
	const old = match[2] ?? "";
	const changes = view.state.changes({ from, to: from + old.length, insert: prefixOf(kind) });
	const head = view.state.selection.main.head;
	const inLine = head >= line.from && head <= line.to;
	view.dispatch({
		changes,
		selection: EditorSelection.cursor(
			changes.mapPos(inLine ? Math.max(head, from + old.length) : line.to, 1),
		),
		scrollIntoView: true,
	});
	view.focus();
}

/** A selection that ends at the start of a line leaves that line out. */
export function linesOf(state: EditorState, from: number, to: number) {
	const first = state.doc.lineAt(from);
	let last = state.doc.lineAt(to);
	if (to > from && to === last.from && last.number > first.number)
		last = state.doc.line(last.number - 1);
	const out: Line[] = [];
	for (let n = first.number; n <= last.number; n++) out.push(state.doc.line(n));
	return out;
}

/** The fenced code block around `pos`, if any. */
function fenceAt(state: EditorState, pos: number) {
	for (
		let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(pos, 1);
		n;
		n = n.parent
	)
		if (n.name === "FencedCode") return n;
	return null;
}

const inFence = (state: EditorState, pos: number) => !!fenceAt(state, pos);

/** Table lines are rows and have no kind of their own. */
const inTable = (state: EditorState, pos: number) => {
	for (
		let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(pos, 1);
		n;
		n = n.parent
	)
		if (n.name === "Table") return true;
	return false;
};

/** Null unless all selected blocks share one kind. Lines in a fenced block or a table do not count. */
export function kindOfRange(state: EditorState, from: number, to: number): BlockKind | null {
	const kinds = new Set(
		linesOf(state, from, to)
			.filter((l) => !inFence(state, l.from) && !inTable(state, l.from))
			.map((l) => kindOf(l.text)),
	);
	return kinds.size === 1 ? [...kinds][0]! : null;
}

/** Fenced blocks and tables stay as they are; the selection stays on the same text. */
export function setKindRange(view: EditorView, from: number, to: number, kind: BlockKind) {
	const { state } = view;
	const prefix = prefixOf(kind);
	const changes = state.changes(
		linesOf(state, from, to)
			.filter((l) => !inFence(state, l.from) && !inTable(state, l.from))
			.map((l) => {
				const match = PREFIX.exec(l.text)!;
				const at = l.from + match[1]!.length;
				return { from: at, to: at + (match[2] ?? "").length, insert: prefix };
			}),
	);
	view.dispatch({ changes, selection: state.selection.map(changes), scrollIntoView: true });
	view.focus();
}

/** The line at `pos`, or the whole fenced block or table it lies in. */
export function blockAt(state: EditorState, pos: number): { from: number; to: number } {
	const line = state.doc.lineAt(pos);
	for (
		let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(
			line.from,
			1,
		);
		n;
		n = n.parent
	)
		if (
			n.name === "FencedCode" ||
			(n.name === "Table" && n.parent?.name === "Document" && line.text.trim())
		)
			return { from: state.doc.lineAt(n.from).from, to: state.doc.lineAt(n.to).to };
	return { from: line.from, to: line.to };
}

/** The block with its line break: the one after it, or before it for the last block. */
function removalRange(doc: Text, block: { from: number; to: number }) {
	return block.to < doc.length
		? { from: block.from, to: block.to + 1 }
		: { from: Math.max(0, block.from - 1), to: block.to };
}

/** `block` spans whole lines. `target` is a line start, or doc.length for the end. */
export function moveBlock(view: EditorView, block: { from: number; to: number }, target: number) {
	const { doc } = view.state;
	if (target >= block.from && target <= block.to + 1) return;
	const text = doc.sliceString(block.from, block.to);
	const remove = removalRange(doc, block);
	const insert =
		target >= doc.length
			? { from: doc.length, insert: "\n" + text }
			: { from: target, insert: text + "\n" };
	const changes = view.state.changes([remove, insert]);
	const start = changes.mapPos(insert.from, -1) + (target >= doc.length ? 1 : 0);
	view.dispatch({
		changes,
		selection: EditorSelection.cursor(start + text.length),
		scrollIntoView: true,
	});
}

export function moveBy(view: EditorView, pos: number, dir: -1 | 1) {
	const { doc } = view.state;
	const block = blockAt(view.state, pos);
	if (dir < 0) {
		if (block.from === 0) return;
		moveBlock(view, block, blockAt(view.state, block.from - 1).from);
	} else {
		if (block.to >= doc.length) return;
		const next = blockAt(view.state, block.to + 1);
		moveBlock(view, block, next.to >= doc.length ? doc.length : next.to + 1);
	}
}

export function duplicateBlock(view: EditorView, pos: number) {
	const block = blockAt(view.state, pos);
	const text = view.state.doc.sliceString(block.from, block.to);
	view.dispatch({
		changes: { from: block.to, insert: "\n" + text },
		selection: EditorSelection.cursor(block.to + 1 + text.length),
	});
	view.focus();
}

export function deleteBlock(view: EditorView, pos: number) {
	const { doc } = view.state;
	const range = removalRange(doc, blockAt(view.state, pos));
	view.dispatch({
		changes: range,
		selection: EditorSelection.cursor(Math.min(range.from, doc.length - (range.to - range.from))),
	});
	view.focus();
}

const MARK_NODE: Record<string, string> = {
	"**": "StrongEmphasis",
	"*": "Emphasis",
	"~~": "Strikethrough",
	"`": "InlineCode",
};
const MARK_NODES = new Set(Object.values(MARK_NODE));
const MARK_PARTS = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark"]);

type Range = { from: number; to: number };
type MarkNode = Range & { name: string; open: Range; close: Range };

/** Per block the selected text after its prefix, trimmed. Fenced blocks are left out. */
function segments(state: EditorState, from: number, to: number) {
	return linesOf(state, from, to).flatMap((l) => {
		const start = Math.max(from, l.from + PREFIX.exec(l.text)![0].length);
		const text = state.sliceDoc(start, Math.min(to, l.to));
		const textStart = start + text.length - text.trimStart().length;
		return text.trim() && !inFence(state, l.from)
			? [{ from: textStart, to: textStart + text.trim().length, line: l }]
			: [];
	});
}

/** The marked spans (bold, italic, …) touching [from, to], and the mark characters among them. */
function marksAt(state: EditorState, from: number, to: number) {
	const tree = ensureSyntaxTree(state, to, 200) ?? syntaxTree(state);
	const nodes: MarkNode[] = [];
	const parts: Range[] = [];
	tree.iterate({
		from,
		to,
		enter: (n) => {
			if (MARK_PARTS.has(n.name)) parts.push({ from: n.from, to: n.to });
			if (!MARK_NODES.has(n.name)) return;
			const first = n.node.firstChild;
			const last = n.node.lastChild;
			if (
				first &&
				last &&
				first !== last &&
				MARK_PARTS.has(first.name) &&
				MARK_PARTS.has(last.name)
			)
				nodes.push({
					name: n.name,
					from: n.from,
					to: n.to,
					open: { from: first.from, to: first.to },
					close: { from: last.from, to: last.to },
				});
		},
	});
	const letter = (p: number) =>
		!/\s/.test(state.sliceDoc(p, p + 1)) && !parts.some((r) => p >= r.from && p < r.to);
	return { nodes, letter };
}

/** Marks are hidden while not edited, so they may lie inside or outside the selection. */
function markOn(state: EditorState, seg: Range, mark: string) {
	const { nodes: all, letter } = marksAt(state, seg.from, seg.to);
	const nodes = all.filter((n) => n.name === MARK_NODE[mark] && n.to > seg.from && n.from < seg.to);
	let letters = 0;
	let marked = 0;
	for (let p = seg.from; p < seg.to; p++) {
		if (!letter(p)) continue;
		letters++;
		if (nodes.some((n) => p >= n.open.to && p < n.close.from)) marked++;
	}
	return { on: letters > 0 && marked === letters, nodes };
}

export function markActive(state: EditorState, mark: string) {
	const { from, to } = state.selection.main;
	const segs = from < to ? segments(state, from, to) : [];
	return segs.length > 0 && segs.every((seg) => markOn(state, seg, mark).on);
}

/**
 * Where to put a mark on [a, b] so it nests with the other marks. Where another marked span begins
 * or ends inside, each piece between that span's marks gets its own pair ("~~ab**c**~~ **y**").
 */
function pieces(state: EditorState, a: number, b: number, mark: string): Range[] {
	const { nodes, letter } = marksAt(state, a, b);
	// another span cuts the range unless it lies within it, or the range within its text
	const crosses = (n: MarkNode) =>
		n.to > a && n.from < b && !(n.from >= a && n.to <= b) && !(n.open.to <= a && n.close.from >= b);
	const cuts = nodes
		.filter((n) => n.name !== MARK_NODE[mark] && crosses(n))
		.flatMap((n) => [n.open, n.close])
		.filter((r) => r.to > a && r.from < b)
		.sort((x, y) => x.from - y.from);
	const hasLetter = (from: number, to: number) => {
		for (let p = from; p < to; p++) if (letter(p)) return true;
		return false;
	};
	const out: Range[] = [];
	let start = a;
	for (const c of [...cuts, { from: b, to: b }]) {
		let from = start;
		let to = Math.max(start, c.from);
		while (from < to && /\s/.test(state.sliceDoc(from, from + 1))) from++;
		while (to > from && /\s/.test(state.sliceDoc(to - 1, to))) to--;
		if (hasLetter(from, to)) out.push({ from, to });
		start = Math.max(start, c.to);
	}
	return out;
}

/**
 * Removes the mark only when all of the selection has it. Each block gets its own pair, since
 * Markdown marks end at a line. Partly marked text gets one pair around the whole.
 */
export function toggleMark(view: EditorView, mark: string) {
	const { state } = view;
	const main = state.selection.main;
	const len = mark.length;
	if (main.empty) {
		// the cursor between an empty pair ("**|**"): ⌘B again takes the pair away
		const empty =
			state.sliceDoc(main.from - len, main.from) === mark &&
			state.sliceDoc(main.from, main.from + len) === mark;
		view.dispatch({
			changes: empty
				? { from: main.from - len, to: main.from + len }
				: { from: main.from, insert: mark + mark },
			selection: EditorSelection.cursor(empty ? main.from - len : main.from + len),
			userEvent: "input.format",
		});
		view.focus();
		return true;
	}
	const segs = segments(state, main.from, main.to).map((seg) => ({
		seg,
		...markOn(state, seg, mark),
	}));
	if (!segs.length) return true;
	const off = segs.every((s) => s.on);
	const specs: { from: number; to?: number; insert?: string }[] = [];
	const seen = new Set<number>();
	const drop = (n: MarkNode) => {
		if (seen.has(n.from)) return;
		seen.add(n.from);
		specs.push(n.open, n.close);
	};
	for (const { seg, on, nodes } of segs) {
		if (off) nodes.forEach(drop);
		// a block that has it stays as it is, unless its span reaches into another line (it is taken apart there)
		if (off || (on && nodes.every((n) => n.from >= seg.line.from && n.to <= seg.line.to))) continue;
		// the pieces already marked merge into one span, within the block's line
		let a = seg.from;
		let b = seg.to;
		for (const n of nodes) {
			a = Math.max(seg.line.from, Math.min(a, n.from));
			b = Math.min(seg.line.to, Math.max(b, n.to));
			drop(n);
		}
		for (const p of pieces(state, a, b, mark))
			specs.push({ from: p.from, insert: mark }, { from: p.to, insert: mark });
	}
	const changes = state.changes(specs);
	view.dispatch({
		changes,
		selection: EditorSelection.range(changes.mapPos(main.from, 1), changes.mapPos(main.to, -1)),
		userEvent: "input.format",
	});
	view.focus();
	return true;
}
