// Left of the block under the pointer, as in Notion: "+" adds a block below and opens the "/"
// menu, "⠿" drags the block somewhere else or, clicked, opens its menu (turn into, duplicate,
// move, delete). Not on touch screens and not in read-only text.
import { startCompletion } from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";
import { ArrowDown, ArrowUp, Copy, GripVertical, Plus, Trash2 } from "lucide-react";
import { tr } from "../../i18n";
import { KINDS, blockAt, deleteBlock, duplicateBlock, kindName, kindOf, moveBlock, moveBy, setKind } from "./blocks";
import { iconButton } from "./icons";
import { showMenu } from "./menu";
import { MOD } from "../bits";

/** ⌥ on Apple devices, Alt elsewhere (the keys that move a line). */
const ALT = MOD === "⌘" ? "⌥" : "Alt ";

const coarse = () => matchMedia("(pointer: coarse)").matches;

/** The block under a height of the screen, and the place where it starts on the screen. */
function blockAtY(view: EditorView, y: number) {
  const lb = view.lineBlockAtHeight(y - view.documentTop);
  const b = blockAt(view.state, lb.from);
  const first = view.lineBlockAt(b.from);
  const last = view.lineBlockAt(b.to);
  return { ...b, top: view.documentTop + first.top, bottom: view.documentTop + last.bottom };
}

/** The menu of a block, at a point of the screen. */
export function blockMenu(view: EditorView, pos: number, at: { left: number; top: number }) {
  const line = view.state.doc.lineAt(pos);
  const current = kindOf(line.text);
  const fenced = blockAt(view.state, pos).to !== line.to || line.text.startsWith("```");
  return showMenu(at, [
    ...(fenced ? [] : [{ title: tr("editor.turnInto"), entries: KINDS.map((k) => ({ label: kindName(k.kind), icon: k.icon, active: k.kind === current, run: () => setKind(view, pos, k.kind) })) }]),
    {
      entries: [
        { label: tr("editor.duplicate"), icon: Copy, run: () => duplicateBlock(view, pos) },
        { label: tr("editor.moveUp"), icon: ArrowUp, hint: ALT + "↑", run: () => (moveBy(view, pos, -1), view.focus()) },
        { label: tr("editor.moveDown"), icon: ArrowDown, hint: ALT + "↓", run: () => (moveBy(view, pos, 1), view.focus()) },
        { label: tr("editor.deleteBlock"), icon: Trash2, danger: true, run: () => deleteBlock(view, pos) },
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
      this.frame = requestAnimationFrame(() => this.hover(e.clientX, e.clientY));
    };
    hover(x: number, y: number) {
      const { view } = this;
      const r = view.contentDOM.getBoundingClientRect();
      const inside = !view.state.readOnly && !coarse() && y >= r.top && y <= r.bottom && x >= r.left - 72 && x <= r.right + 24 && !document.querySelector(".cm-menu");
      if (!inside) return this.hide();
      const b = blockAtY(view, y);
      this.current = b;
      const dom = view.dom.getBoundingClientRect();
      // centred on the first line of the block
      const c = view.coordsAtPos(b.from, 1);
      const mid = c ? (c.top + c.bottom) / 2 : b.top + 13;
      this.box.style.top = mid - 12 - dom.top + "px";
      this.box.classList.add("shown");
    }
    hide() {
      if (!document.querySelector(".cm-menu")) this.box.classList.remove("shown");
    }
    add() {
      const { view } = this;
      if (!this.current) return;
      const line = view.state.doc.lineAt(this.current.to);
      if (!line.length && this.current.from === this.current.to) view.dispatch({ changes: { from: line.from, insert: "/" }, selection: EditorSelection.cursor(line.from + 1) });
      else view.dispatch({ changes: { from: this.current.to, insert: "\n/" }, selection: EditorSelection.cursor(this.current.to + 2), scrollIntoView: true });
      view.focus();
      startCompletion(view);
    }
    grab(e: MouseEvent) {
      e.preventDefault();
      const { view } = this;
      const b = this.current;
      if (!b) return;
      const sx = e.clientX;
      const sy = e.clientY;
      let target: number | null = null;
      const dom = view.dom.getBoundingClientRect();
      const move = (m: MouseEvent) => {
        if (!this.dragging && Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return;
        this.dragging = true;
        document.body.classList.add("cm-dragging");
        const r = view.contentDOM.getBoundingClientRect();
        const y = Math.max(r.top + 1, Math.min(r.bottom - 1, m.clientY));
        const over = blockAtY(view, y);
        let before = y < (over.top + over.bottom) / 2;
        // as in Notion, the gap right below the block is no place of its own (it is where the
        // block is already): over the block that is the line above it, over the next one below that
        if (over.from === b.from) before = true;
        else if (before && over.from === b.to + 1) before = false;
        target = before ? over.from : over.to >= view.state.doc.length ? view.state.doc.length : over.to + 1;
        this.drop.style.top = (before ? over.top : over.bottom) - dom.top - 1 + "px";
        this.drop.classList.add("shown");
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.classList.remove("cm-dragging");
        this.drop.classList.remove("shown");
        if (this.dragging) {
          this.dragging = false;
          if (target !== null) moveBlock(view, b, target);
          view.focus();
        } else {
          const r = (e.target as HTMLElement).closest("button")!.getBoundingClientRect();
          view.dispatch({ selection: EditorSelection.cursor(view.state.doc.lineAt(b.from).to) });
          blockMenu(view, b.from, { left: r.left, top: r.bottom + 4 }).focusFirst();
        }
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    }
    /** Any key in the text (typing, arrows) hides the handles until the pointer moves again, as the mouse pointer hides. */
    keydown = () => {
      if (this.dragging) return;
      cancelAnimationFrame(this.frame);
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
