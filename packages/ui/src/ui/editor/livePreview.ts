// The text reads like a page, not like Markdown: bullets and checkboxes instead of "- " and
// "- [ ] ", quotes with a bar, a line for "---", and no "**", "*", "~~", "`" or "[…](…)" around
// text unless the cursor is inside it. Headings, code blocks and quotes get their own line look.
import { syntaxTree } from "@codemirror/language";
import { type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { tr } from "../../i18n";

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
  override eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-line-hint";
    s.textContent = tr("editor.lineHint");
    s.setAttribute("aria-hidden", "true");
    return s;
  }
}

const hide = Decoration.replace({});
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
  const lineActive = (pos: number) => {
    const l = state.doc.lineAt(pos);
    return touches(l.from, l.to);
  };
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
          case "ATXHeading6":
            deco.push(line("cm-h cm-h" + Math.min(3, Number(n.name.slice(-1)))).range(state.doc.lineAt(n.from).from));
            return false;
          case "FencedCode": {
            const info = n.node.getChild("CodeInfo");
            if (info && /^(abfrage|query)$/i.test(state.sliceDoc(info.from, info.to).trim())) return false; // a query block draws itself
            const first = state.doc.lineAt(n.from).number;
            const last = state.doc.lineAt(n.to).number;
            for (let i = first; i <= last; i++) deco.push(line(cx("cm-codeblock", i === first && "first", i === last && "last", (i === first || i === last) && "fence")).range(state.doc.line(i).from));
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
            if (!lineActive(n.from)) deco.push(hide.range(n.from, end));
            return;
          }
          case "HorizontalRule":
            if (!lineActive(n.from)) deco.push(Decoration.replace({ widget: new RuleWidget() }).range(n.from, n.to));
            return;
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
              deco.push(line(cx("cm-listline cm-taskline", checked && "done")).range(listLine.from));
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
          case "Link": {
            // [text](url): only the text, as a link (wikilinks are not Markdown links)
            const marks = n.node.getChildren("LinkMark");
            const url = n.node.getChild("URL");
            if (marks.length < 2 || !url || touches(n.from, n.to)) return;
            const href = state.sliceDoc(url.from, url.to);
            deco.push(hide.range(marks[0]!.from, marks[0]!.to));
            if (marks[0]!.to < marks[1]!.from) deco.push(Decoration.mark({ class: "cm-mdlink", attributes: { "data-href": href, title: href } }).range(marks[0]!.to, marks[1]!.from));
            deco.push(hide.range(marks[1]!.from, n.to));
            return false;
          }
          default: {
            const markName = INLINE[n.name];
            if (!markName || touches(n.from, n.to)) return;
            for (const m of n.node.getChildren(markName)) deco.push(hide.range(m.from, m.to));
          }
        }
      },
    });
  }
  // empty lines between blocks: small gaps
  const cur = state.doc.lineAt(sel.head);
  for (const { from, to } of view.visibleRanges)
    for (let pos = from; pos <= to; ) {
      const l = state.doc.lineAt(pos);
      if (!l.length && l.number !== cur.number && l.number > 1 && l.number < state.doc.lines) deco.push(line("cm-blank").range(l.from));
      pos = l.to + 1;
    }
  // an empty line with the cursor: how to go on
  if (focus && sel.empty && !cur.length && state.doc.length > 0 && !state.readOnly) deco.push(Decoration.widget({ widget: new HintWidget(), side: 1 }).range(cur.from));
  return { deco: Decoration.set(deco, true), atomic: Decoration.set(atomic, true) };
}

function cx(...c: (string | false)[]) {
  return c.filter(Boolean).join(" ");
}

export const livePreview = ViewPlugin.fromClass(
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
    eventHandlers: {
      click(e) {
        const a = (e.target as HTMLElement).closest<HTMLElement>(".cm-mdlink");
        if (!a?.dataset.href) return false;
        e.preventDefault();
        window.open(a.dataset.href, "_blank", "noopener");
        return true;
      },
    },
  },
);
