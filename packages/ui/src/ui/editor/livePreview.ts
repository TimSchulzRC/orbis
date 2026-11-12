// Makes the Markdown read like a page. Inline marks stay hidden unless the cursor is inside them.
import { syntaxTree } from "@codemirror/language";
import {
	EditorSelection,
	EditorState,
	type Extension,
	type Line,
	Prec,
	type Range,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	keymap,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { isQueryInfo } from "@obtion/core/query";
import { tr } from "../../i18n";
import { cn } from "../../lib/utils";
import { blockAt, kindName } from "./blocks";

class BulletWidget extends WidgetType {
	constructor(readonly depth: number) {
		super();
	}
	override eq(o: BulletWidget) {
		return o.depth === this.depth;
	}
	toDOM() {
		const span = document.createElement("span");
		span.className = "cm-bullet";
		span.textContent = ["•", "◦", "▪"][this.depth % 3]!;
		return span;
	}
}

class CheckWidget extends WidgetType {
	constructor(
		readonly checked: boolean,
		readonly pos: number,
	) {
		super();
	}
	override eq(o: CheckWidget) {
		return o.checked === this.checked && o.pos === this.pos;
	}
	toDOM(view: EditorView) {
		const box = document.createElement("span");
		box.className = "cm-check" + (this.checked ? " checked" : "");
		box.setAttribute("role", "checkbox");
		box.setAttribute("aria-checked", String(this.checked));
		box.setAttribute("aria-label", tr("editor.block.todo"));
		box.addEventListener("mousedown", (e) => {
			e.preventDefault();
			if (view.state.readOnly) return;
			// flip the middle character of "[ ]" / "[x]"
			const at = view.posAtDOM(box);
			const text = view.state.doc.sliceString(at, at + 8);
			const i = text.indexOf("[");
			if (i < 0) return;
			view.dispatch({
				changes: { from: at + i + 1, to: at + i + 2, insert: this.checked ? " " : "x" },
			});
		});
		return box;
	}
	override ignoreEvent() {
		return true;
	}
}

class RuleWidget extends WidgetType {
	override eq() {
		return true;
	}
	toDOM() {
		const hr = document.createElement("span");
		hr.className = "cm-rule";
		return hr;
	}
}

class HintWidget extends WidgetType {
	constructor(readonly text: string) {
		super();
	}
	override eq(o: HintWidget) {
		return o.text === this.text;
	}
	toDOM() {
		const span = document.createElement("span");
		span.className = "cm-line-hint";
		span.textContent = this.text;
		span.setAttribute("aria-hidden", "true");
		return span;
	}
}

const hide = Decoration.replace({});
/** Only with its space is "#" a heading. */
const HEADING = /^(#{1,6}) /;
const line = (cls: string) => Decoration.line({ class: cls });
const INLINE: Record<string, string> = {
	Emphasis: "EmphasisMark",
	StrongEmphasis: "EmphasisMark",
	Strikethrough: "StrikethroughMark",
	InlineCode: "CodeMark",
};
/** Levels 4 to 6 look like level 3. */
const HEADING_KINDS = ["h1", "h2", "h3"] as const;

/** `pos`, or one further when a space follows it. */
const pastSpace = (state: EditorState, pos: number) =>
	state.sliceDoc(pos, pos + 1) === " " ? pos + 1 : pos;

/** `atomic` holds the widgets the cursor steps over as one. */
function build(view: EditorView): { deco: DecorationSet; atomic: DecorationSet } {
	const { state } = view;
	const sel = state.selection.main;
	const focus = view.hasFocus;
	const deco: Range<Decoration>[] = [];
	const atomic: Range<Decoration>[] = [];
	const touches = (from: number, to: number) => focus && sel.from <= to && sel.to >= from;
	for (const { from, to } of view.visibleRanges) {
		syntaxTree(state).iterate({
			from,
			to,
			enter: (n) => {
				switch (n.name) {
					case "ATXHeading1":
					case "ATXHeading2":
					case "ATXHeading3":
					case "ATXHeading4":
					case "ATXHeading5":
					case "ATXHeading6": {
						// the "#" show only while the cursor is at the start of the text, to change levels there (as in Obsidian)
						const headLine = state.doc.lineAt(n.from);
						const heading = HEADING.exec(headLine.text);
						if (!heading) return false;
						const level = heading[1]!.length;
						const prefixEnd = headLine.from + heading[0].length;
						deco.push(line("cm-h cm-h" + level).range(headLine.from));
						const cursorInPrefix =
							focus && sel.empty && sel.head >= headLine.from && sel.head <= prefixEnd;
						if (!cursorInPrefix) deco.push(hide.range(headLine.from, prefixEnd));
						if (headLine.length === heading[0].length && !state.readOnly)
							deco.push(
								Decoration.widget({
									widget: new HintWidget(kindName(HEADING_KINDS[Math.min(level, 3) - 1]!)),
									side: 1,
								}).range(headLine.to),
							);
						return false;
					}
					case "FencedCode": {
						const info = n.node.getChild("CodeInfo");
						if (info && isQueryInfo(state.sliceDoc(info.from, info.to).trim())) return false; // a query block draws itself
						const first = state.doc.lineAt(n.from).number;
						const last = state.doc.lineAt(n.to).number;
						for (let i = first; i <= last; i++)
							deco.push(
								line(
									cn(
										"cm-codeblock",
										i === first && "first",
										i === last && "last",
										(i === first || i === last) && "fence",
									),
								).range(state.doc.line(i).from),
							);
						return false;
					}
					case "Blockquote": {
						const first = state.doc.lineAt(n.from).number;
						const last = state.doc.lineAt(n.to).number;
						for (let i = first; i <= last; i++)
							deco.push(line("cm-quote").range(state.doc.line(i).from));
						return;
					}
					case "QuoteMark": {
						const mark = hide.range(n.from, pastSpace(state, n.to));
						deco.push(mark);
						atomic.push(mark);
						return;
					}
					case "HorizontalRule": {
						const rule = Decoration.replace({ widget: new RuleWidget() }).range(n.from, n.to);
						deco.push(rule);
						atomic.push(rule);
						return;
					}
					case "ListItem": {
						const mark = n.node.getChild("ListMark");
						if (!mark) return;
						const listLine = state.doc.lineAt(n.from);
						const task = n.node.getChild("Task")?.getChild("TaskMarker");
						if (task) {
							const checked = /x/i.test(state.sliceDoc(task.from, task.to));
							const box = Decoration.replace({ widget: new CheckWidget(checked, mark.from) }).range(
								mark.from,
								pastSpace(state, task.to),
							);
							deco.push(box);
							atomic.push(box);
							deco.push(
								line(cn("cm-listline cm-taskline", checked && "done")).range(listLine.from),
							);
						} else if (n.node.parent?.name === "BulletList") {
							let depth = 0;
							for (let p: typeof n.node | null = n.node.parent; p; p = p.parent)
								if (p.name === "BulletList" || p.name === "OrderedList") depth++;
							const bullet = Decoration.replace({ widget: new BulletWidget(depth - 1) }).range(
								mark.from,
								pastSpace(state, mark.to),
							);
							deco.push(bullet);
							atomic.push(bullet);
							deco.push(line("cm-listline").range(listLine.from));
						} else {
							deco.push(Decoration.mark({ class: "cm-ordered" }).range(mark.from, mark.to));
							deco.push(line("cm-listline").range(listLine.from));
						}
						return;
					}
					case "Link":
						return false; // drawn as a whole by links.ts
					default: {
						const markName = INLINE[n.name];
						if (!markName || touches(n.from, n.to)) return;
						for (const m of n.node.getChildren(markName)) deco.push(hide.range(m.from, m.to));
					}
				}
			},
		});
	}
	const cur = state.doc.lineAt(sel.head);
	if (focus && sel.empty && !cur.length && state.doc.length > 0 && !state.readOnly)
		deco.push(
			Decoration.widget({ widget: new HintWidget(tr("editor.lineHint")), side: 1 }).range(cur.from),
		);
	return { deco: Decoration.set(deco, true), atomic: Decoration.set(atomic, true) };
}

const preview = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		atomic: DecorationSet;
		constructor(view: EditorView) {
			({ deco: this.decorations, atomic: this.atomic } = build(view));
		}
		update(u: ViewUpdate) {
			if (
				u.docChanged ||
				u.selectionSet ||
				u.viewportChanged ||
				u.focusChanged ||
				syntaxTree(u.startState) !== syntaxTree(u.state)
			)
				({ deco: this.decorations, atomic: this.atomic } = build(u.view));
		}
	},
	{
		decorations: (v) => v.decorations,
		provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.atomic ?? Decoration.none),
	},
);

/** Line prefixes the preview hides. */
const HIDDEN = /^(\s*)(#{1,6} |[-*+] \[[ xX]\] |[-*+] |> ?)/;

function textStart(
	state: EditorState,
	pos: number,
): { line: Line; start: number; end: number } | null {
	const docLine = state.doc.lineAt(pos);
	const match = HIDDEN.exec(docLine.text);
	if (!match) return null;
	const block = blockAt(state, docLine.from);
	if (block.from !== docLine.from || block.to !== docLine.to) return null; // in a code block it is text
	return {
		line: docLine,
		start: docLine.from + match[1]!.length,
		end: docLine.from + match[0].length,
	};
}

/** The cursor never stands in front of a hidden prefix, where typing would undo the block's kind. */
const keepOutOfPrefix = EditorState.transactionFilter.of((transaction) => {
	if (!transaction.selection) return transaction;
	const { state } = transaction;
	const before =
		transaction.docChanged || transaction.isUserEvent("select.pointer")
			? null
			: transaction.startState.selection;
	let moved = false;
	const fix = (pos: number, was?: number) => {
		const prefix = textStart(state, pos);
		if (!prefix || pos < prefix.start || pos >= prefix.end || HEADING.test(prefix.line.text))
			return pos; // a heading's "#" show there
		moved = true;
		// stepping left from the text's start goes on to the line above instead of getting stuck
		if (was === prefix.end && prefix.start > 0) return prefix.start - 1;
		return prefix.end;
	};
	// non-empty selections keep their ends
	const ranges = transaction.selection.ranges.map((r, i) =>
		r.empty ? EditorSelection.cursor(fix(r.head, before?.ranges[i]?.head)) : r,
	);
	return moved
		? [
				transaction,
				{
					selection: EditorSelection.create(ranges, transaction.selection.mainIndex),
					sequential: true,
				},
			]
		: transaction;
});

/** Enter in front of a heading's text adds a line above it, and the heading stays one (as in Notion). */
function newlineAbove(view: EditorView) {
	const sel = view.state.selection.main;
	const prefix = sel.empty ? textStart(view.state, sel.head) : null;
	if (
		!prefix ||
		sel.head !== prefix.end ||
		prefix.line.to === prefix.end ||
		!HEADING.test(prefix.line.text)
	)
		return false;
	view.dispatch({
		changes: { from: prefix.line.from, insert: "\n" },
		selection: EditorSelection.cursor(sel.head + 1),
		scrollIntoView: true,
		userEvent: "input",
	});
	return true;
}

/** Backspace at the start of a heading's text takes one level away; after "# " it is text. */
function fewerLevels(view: EditorView) {
	const sel = view.state.selection.main;
	const prefix = sel.empty ? textStart(view.state, sel.head) : null;
	const heading = prefix && HEADING.exec(prefix.line.text);
	if (!prefix || !heading || sel.head !== prefix.end) return false;
	const from = prefix.line.from;
	const changes = heading[1]!.length > 1 ? { from, to: from + 1 } : { from, to: prefix.end };
	view.dispatch({
		changes,
		selection: EditorSelection.cursor(prefix.end - (changes.to - changes.from)),
		userEvent: "delete",
	});
	return true;
}

export const livePreview: Extension = [
	preview,
	keepOutOfPrefix,
	Prec.highest(
		keymap.of([
			{ key: "Enter", run: newlineAbove },
			{ key: "Backspace", run: fewerLevels },
		]),
	),
];
