// Block handles beside the pointer, as in Notion. Not on touch screens and not in read-only text.
import { startCompletion } from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";
import { ArrowDown, ArrowUp, Copy, GripVertical, Plus, Trash2 } from "lucide-react";
import { tr } from "../../i18n";
import { isCoarse as coarse, MOD } from "../../lib/platform";
import {
	blockAt,
	deleteBlock,
	duplicateBlock,
	KINDS,
	kindName,
	kindOf,
	moveBlock,
	moveBy,
	setKind,
} from "./blocks";
import { iconButton } from "./icons";
import { drawingOnLine } from "./links";
import { showMenu } from "./menu";
import { menuCell, tableAt, tableEntries } from "./tables";

const ALT = MOD === "⌘" ? "⌥" : "Alt ";
/** How far left and right of the text the pointer still shows the handles, in px. */
const REACH_LEFT = 72;
const REACH_RIGHT = 24;
/** The pointer must move this far, in px, before a press on the grip becomes a drag. */
const DRAG_THRESHOLD = 4;

function blockAtY(view: EditorView, y: number) {
	const lineBlock = view.lineBlockAtHeight(y - view.documentTop);
	const block = blockAt(view.state, lineBlock.from);
	const first = view.lineBlockAt(block.from);
	const last = view.lineBlockAt(block.to);
	return { ...block, top: view.documentTop + first.top, bottom: view.documentTop + last.bottom };
}

function blockMenu(view: EditorView, pos: number, at: { left: number; top: number }) {
	const line = view.state.doc.lineAt(pos);
	const current = kindOf(line.text);
	const fenced = blockAt(view.state, pos).to !== line.to || line.text.startsWith("```");
	// a diagram is no text: nothing to turn it into, and a copy would show the same diagram twice
	const diagram = !!drawingOnLine(line.text);
	const table = tableAt(view.state, pos);
	const cell = table && menuCell(view.state, table);
	return showMenu(at, [
		...(fenced || diagram
			? []
			: [
					{
						title: tr("editor.turnInto"),
						entries: KINDS.map((k) => ({
							label: kindName(k.kind),
							icon: k.icon,
							active: k.kind === current,
							run: () => setKind(view, pos, k.kind),
						})),
					},
				]),
		...(table && cell
			? [{ title: tr("editor.table.title"), entries: tableEntries(view, table, cell.n, cell.col) }]
			: []),
		{
			entries: [
				...(diagram
					? []
					: [{ label: tr("editor.duplicate"), icon: Copy, run: () => duplicateBlock(view, pos) }]),
				{
					label: tr("editor.moveUp"),
					icon: ArrowUp,
					hint: `${ALT}↑`,
					run: () => (moveBy(view, pos, -1), view.focus()),
				},
				{
					label: tr("editor.moveDown"),
					icon: ArrowDown,
					hint: `${ALT}↓`,
					run: () => (moveBy(view, pos, 1), view.focus()),
				},
				{
					label: tr("editor.deleteBlock"),
					icon: Trash2,
					danger: true,
					run: () => deleteBlock(view, pos),
				},
			],
		},
	]);
}

export const blockHandles = ViewPlugin.fromClass(
	class {
		box: HTMLDivElement;
		drop: HTMLDivElement;
		current: { from: number; to: number } | null = null;
		dragging = false;
		frame = 0;
		constructor(readonly view: EditorView) {
			this.box = document.createElement("div");
			this.box.className = "cm-handles";
			this.box.setAttribute("aria-hidden", "true");
			const add = iconButton(Plus, tr("editor.addBlock"), "cm-handle", 16);
			const grip = iconButton(GripVertical, tr("editor.dragBlock"), "cm-handle grip", 16);
			add.tabIndex = grip.tabIndex = -1;
			add.addEventListener("mousedown", (e) => e.preventDefault());
			add.addEventListener("click", () => this.add());
			grip.addEventListener("mousedown", (e) => this.grab(e));
			this.box.append(add, grip);
			this.drop = document.createElement("div");
			this.drop.className = "cm-drop";
			view.dom.append(this.box, this.drop);
			window.addEventListener("mousemove", this.move);
			view.contentDOM.addEventListener("keydown", this.keydown);
		}
		move = (e: MouseEvent) => {
			if (this.dragging) return;
			cancelAnimationFrame(this.frame);
			// a dialog over the text (a diagram on full screen): no handles, and no measuring of the text
			// behind it on every move
			if ((e.target as Element | null)?.closest?.("[aria-modal]"))
				return void (this.box.classList.contains("shown") && this.hide());
			this.frame = requestAnimationFrame(() => this.hover(e.clientX, e.clientY));
		};
		hover(x: number, y: number) {
			const { view } = this;
			const content = view.contentDOM.getBoundingClientRect();
			const nearText =
				y >= content.top &&
				y <= content.bottom &&
				x >= content.left - REACH_LEFT &&
				x <= content.right + REACH_RIGHT;
			const inside =
				!view.state.readOnly && !coarse() && nearText && !document.querySelector(".cm-menu");
			if (!inside) return this.hide();
			const block = blockAtY(view, y);
			this.current = block;
			const dom = view.dom.getBoundingClientRect();
			// centred on the first line of the block. A block drawn as a whole (a query, a table) is
			// taller than a line: its handles go to its top, beside its heading or first row
			const coords = view.coordsAtPos(block.from, 1);
			let mid = coords ? (coords.top + coords.bottom) / 2 : block.top + 13;
			if (coords && coords.bottom - coords.top > view.defaultLineHeight * 1.5) {
				const anchor = [...view.contentDOM.querySelectorAll("[data-handle-anchor]")]
					.map((x) => x.getBoundingClientRect())
					.find((r) => r.top >= coords.top - 1 && r.top < coords.bottom);
				mid = anchor
					? anchor.top + Math.min(anchor.height, 36) / 2
					: coords.top + view.defaultLineHeight / 2;
			}
			this.box.style.top = `${mid - 12 - dom.top}px`;
			this.box.classList.remove("instant");
			this.box.classList.add("shown");
		}
		hide() {
			if (!document.querySelector(".cm-menu")) this.box.classList.remove("shown");
		}
		add() {
			const { view } = this;
			if (!this.current) return;
			const line = view.state.doc.lineAt(this.current.to);
			if (!line.length && this.current.from === this.current.to)
				view.dispatch({
					changes: { from: line.from, insert: "/" },
					selection: EditorSelection.cursor(line.from + 1),
				});
			else
				view.dispatch({
					changes: { from: this.current.to, insert: "\n/" },
					selection: EditorSelection.cursor(this.current.to + 2),
					scrollIntoView: true,
				});
			view.focus();
			startCompletion(view);
		}
		grab(e: MouseEvent) {
			e.preventDefault();
			const { view } = this;
			const block = this.current;
			if (!block) return;
			const startX = e.clientX;
			const startY = e.clientY;
			let target: number | null = null;
			const dom = view.dom.getBoundingClientRect();
			const move = (m: MouseEvent) => {
				if (!this.dragging && Math.hypot(m.clientX - startX, m.clientY - startY) < DRAG_THRESHOLD)
					return;
				this.dragging = true;
				document.body.classList.add("cm-dragging");
				const content = view.contentDOM.getBoundingClientRect();
				const y = Math.max(content.top + 1, Math.min(content.bottom - 1, m.clientY));
				const over = blockAtY(view, y);
				let before = y < (over.top + over.bottom) / 2;
				// as in Notion, the gap right below the dragged block is where it already is, so it is no
				// drop target of its own
				if (over.from === block.from) before = true;
				else if (before && over.from === block.to + 1) before = false;
				const { length } = view.state.doc;
				const afterOver = over.to >= length ? length : over.to + 1;
				target = before ? over.from : afterOver;
				this.drop.style.top = `${(before ? over.top : over.bottom) - dom.top - 1}px`;
				this.drop.classList.add("shown");
			};
			const up = () => {
				window.removeEventListener("mousemove", move);
				window.removeEventListener("mouseup", up);
				document.body.classList.remove("cm-dragging");
				this.drop.classList.remove("shown");
				if (this.dragging) {
					this.dragging = false;
					if (target !== null) moveBlock(view, block, target);
					view.focus();
				} else {
					const button = (e.target as HTMLElement).closest("button")!.getBoundingClientRect();
					// a table keeps its rendering: its menu acts on the cell with the cursor, or its last row
					if (!tableAt(view.state, block.from))
						view.dispatch({
							selection: EditorSelection.cursor(view.state.doc.lineAt(block.from).to),
						});
					blockMenu(view, block.from, { left: button.left, top: button.bottom + 4 }).focusFirst();
				}
			};
			window.addEventListener("mousemove", move);
			window.addEventListener("mouseup", up);
		}
		/** Any key hides the handles until the pointer moves again, like the mouse pointer hides. */
		keydown = () => {
			if (this.dragging) return;
			cancelAnimationFrame(this.frame);
			this.box.classList.add("instant"); // skip the fade
			this.hide();
		};
		destroy() {
			window.removeEventListener("mousemove", this.move);
			this.view.contentDOM.removeEventListener("keydown", this.keydown);
			cancelAnimationFrame(this.frame);
			this.box.remove();
			this.drop.remove();
		}
	},
);
