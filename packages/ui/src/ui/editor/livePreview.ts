// The text reads like a page, not like Markdown: bullets and checkboxes instead of "- " and
// "- [ ] ", quotes with a bar, a line for "---", and no "**", "*", "~~" or "`" around text unless
// the cursor is inside it. A heading shows its "#" only while the cursor is at the start of its
// text. Headings, code blocks and quotes get their own line look.
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension, type Line, Prec, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType, keymap } from "@codemirror/view";
import { tr } from "../../i18n";
import { blockAt, kindName } from "./blocks";
import { isQueryInfo } from "@obtion/core/query";
import { cn } from "../../lib/utils";

class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }
  override eq(o: BulletWidget) {
    return o.depth === this.depth;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-bullet";
    s.textContent = ["•", "◦", "▪"][this.depth % 3]!;
    return s;
  }
}

class CheckWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
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
      // the marker "[ ]" / "[x]": its middle character
      const at = view.posAtDOM(box);
      const text = view.state.doc.sliceString(at, at + 8);
      const i = text.indexOf("[");
      if (i < 0) return;
      view.dispatch({ changes: { from: at + i + 1, to: at + i + 2, insert: this.checked ? " " : "x" } });
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
    const s = document.createElement("span");
    s.className = "cm-line-hint";
    s.textContent = this.text;
    s.setAttribute("aria-hidden", "true");
    return s;
  }
}

const hide = Decoration.replace({});
/** A heading's "# ", with the space that makes it one. */
const HEADING = /^(#{1,6}) /;
const line = (cls: string) => Decoration.line({ class: cls });
const INLINE: Record<string, string> = { Emphasis: "EmphasisMark", StrongEmphasis: "EmphasisMark", Strikethrough: "StrikethroughMark", InlineCode: "CodeMark" };

/** The decorations, and the widgets among them the cursor steps over as one (bullets, checkboxes). */
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
            // only "# " with its space is a heading (as in Notion); its "#" show only while the
            // cursor stands at the start of the text, to add or take away levels there (as in Obsidian)
            const l = state.doc.lineAt(n.from);
            const h = HEADING.exec(l.text);
            if (!h) return false;
            const level = h[1]!.length;
            deco.push(line("cm-h cm-h" + level).range(l.from));
            if (!(focus && sel.empty && sel.head >= l.from && sel.head <= l.from + h[0].length)) deco.push(hide.range(l.from, l.from + h[0].length));
            if (l.length === h[0].length && !state.readOnly) deco.push(Decoration.widget({ widget: new HintWidget(kindName(level === 1 ? "h1" : level === 2 ? "h2" : "h3")), side: 1 }).range(l.to));
            return false;
          }
          case "FencedCode": {
            const info = n.node.getChild("CodeInfo");
            if (info && isQueryInfo(state.sliceDoc(info.from, info.to).trim())) return false; // a query block draws itself
            const first = state.doc.lineAt(n.from).number;
            const last = state.doc.lineAt(n.to).number;
            for (let i = first; i <= last; i++) deco.push(line(cn("cm-codeblock", i === first && "first", i === last && "last", (i === first || i === last) && "fence")).range(state.doc.line(i).from));
            return false;
          }
          case "Blockquote": {
            const first = state.doc.lineAt(n.from).number;
            const last = state.doc.lineAt(n.to).number;
            for (let i = first; i <= last; i++) deco.push(line("cm-quote").range(state.doc.line(i).from));
            return;
          }
          case "QuoteMark": {
            const end = state.sliceDoc(n.to, n.to + 1) === " " ? n.to + 1 : n.to;
            const mark = hide.range(n.from, end);
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
              const end = state.sliceDoc(task.to, task.to + 1) === " " ? task.to + 1 : task.to;
              const box = Decoration.replace({ widget: new CheckWidget(checked, mark.from) }).range(mark.from, end);
              deco.push(box);
              atomic.push(box);
              deco.push(line(cn("cm-listline cm-taskline", checked && "done")).range(listLine.from));
            } else if (n.node.parent?.name === "BulletList") {
              let depth = 0;
              for (let p: typeof n.node | null = n.node.parent; p; p = p.parent) if (p.name === "BulletList" || p.name === "OrderedList") depth++;
              const end = state.sliceDoc(mark.to, mark.to + 1) === " " ? mark.to + 1 : mark.to;
              const bullet = Decoration.replace({ widget: new BulletWidget(depth - 1) }).range(mark.from, end);
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
  // an empty line with the cursor: how to go on
  const cur = state.doc.lineAt(sel.head);
  if (focus && sel.empty && !cur.length && state.doc.length > 0 && !state.readOnly) deco.push(Decoration.widget({ widget: new HintWidget(tr("editor.lineHint")), side: 1 }).range(cur.from));
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
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) ({ deco: this.decorations, atomic: this.atomic } = build(u.view));
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.atomic ?? Decoration.none),
  },
);

/** The hidden Markdown at the start of a line ("# ", "> ", "- ", "- [ ] "): where the text starts. */
const HIDDEN = /^(\s*)(#{1,6} |[-*+] \[[ xX]\] |[-*+] |> ?)/;

function textStart(state: EditorState, pos: number): { line: Line; start: number; end: number } | null {
  const l = state.doc.lineAt(pos);
  const m = HIDDEN.exec(l.text);
  if (!m) return null;
  const b = blockAt(state, l.from);
  if (b.from !== l.from || b.to !== l.to) return null; // in a code block it is text
  return { line: l, start: l.from + m[1]!.length, end: l.from + m[0].length };
}

/** The cursor never stands in front of a hidden prefix, where typing would undo the block's kind. */
const keepOutOfPrefix = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection) return tr;
  const { state } = tr;
  const before = tr.docChanged || tr.isUserEvent("select.pointer") ? null : tr.startState.selection;
  let moved = false;
  const fix = (pos: number, was?: number) => {
    const p = textStart(state, pos);
    if (!p || pos < p.start || pos >= p.end || HEADING.test(p.line.text)) return pos; // a heading's "#" show there
    moved = true;
    // stepping left from the text's start goes on to the line above instead of getting stuck
    if (was === p.end && p.start > 0) return p.start - 1;
    return p.end;
  };
  // a selection (all of the text, say) keeps its ends
  const ranges = tr.selection.ranges.map((r, i) => (r.empty ? EditorSelection.cursor(fix(r.head, before?.ranges[i]?.head)) : r));
  return moved ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex), sequential: true }] : tr;
});

/** Enter in front of a heading's text adds a line above it, and the heading stays one (as in Notion). */
function newlineAbove(view: EditorView) {
  const s = view.state.selection.main;
  const p = s.empty ? textStart(view.state, s.head) : null;
  if (!p || s.head !== p.end || p.line.to === p.end || !HEADING.test(p.line.text)) return false;
  view.dispatch({ changes: { from: p.line.from, insert: "\n" }, selection: EditorSelection.cursor(s.head + 1), scrollIntoView: true, userEvent: "input" });
  return true;
}

/** Backspace at the start of a heading's text takes one level away; after "# " it is text. */
function fewerLevels(view: EditorView) {
  const s = view.state.selection.main;
  const p = s.empty ? textStart(view.state, s.head) : null;
  const h = p && HEADING.exec(p.line.text);
  if (!p || !h || s.head !== p.end) return false;
  const from = p.line.from;
  const changes = h[1]!.length > 1 ? { from, to: from + 1 } : { from, to: p.end };
  view.dispatch({ changes, selection: EditorSelection.cursor(p.end - (changes.to - changes.from)), userEvent: "delete" });
  return true;
}

export const livePreview: Extension = [
  preview,
  keepOutOfPrefix,
  Prec.highest(keymap.of([{ key: "Enter", run: newlineAbove }, { key: "Backspace", run: fewerLevels }])),
];
