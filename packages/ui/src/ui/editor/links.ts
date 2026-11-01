// As in Notion, links hide their [[ ]] or [ ](…) wherever the cursor is and act as one piece of
// text. Embedded files (![[…]]) show only below their line.
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { ExternalLink, Link2, Pencil, Unlink } from "lucide-react";
import { navigate, openItem } from "../../hooks";
import { repo } from "../../repo";
import { tr } from "../../i18n";
import { askText, showMenu } from "./menu";
import { formatToolbar } from "./toolbar";
import { wikiLinkRe } from "@obtion/core/model";
import { webHref } from "../text";

interface Link {
  from: number;
  to: number;
  text: string;
  /** A page title, optionally with "#Section", or a web address. */
  target: string;
  web: boolean;
  /** Embedded files show below the line, nothing of them in the line. */
  embed?: boolean;
}

function linksIn(state: EditorState, from: number, to: number): Link[] {
  const out: Link[] = [];
  for (let pos = from; pos <= to; ) {
    const line = state.doc.lineAt(pos);
    if (line.text.includes("[[")) {
      for (const m of line.text.matchAll(wikiLinkRe())) {
        const start = line.from + m.index!;
        const [all, open, title, rest] = [m[0], m[1] + "[[", m[2]!, (m[3] ?? "") + (m[4] ?? "")];
        const bar = rest.indexOf("|");
        const target = title + (bar >= 0 ? rest.slice(0, bar) : rest);
        const id = open === "![[" ? repo.resolveTitle(title.trim()) : undefined;
        out.push({ from: start, to: start + all.length, text: bar >= 0 ? rest.slice(bar + 1) : target, target, web: false, embed: !!(id && repo.get(id)?.file) });
      }
    }
    pos = line.to + 1;
  }
  syntaxTree(state).iterate({
    from,
    to,
    enter: (n) => {
      if (n.name !== "Link") return;
      const marks = n.node.getChildren("LinkMark");
      const url = n.node.getChild("URL");
      if (marks.length < 2 || !url) return false;
      out.push({ from: n.from, to: n.to, text: state.sliceDoc(marks[0]!.to, marks[1]!.from), target: state.sliceDoc(url.from, url.to), web: true });
      return false;
    },
  });
  // a wikilink's inner [Page] can be a Markdown link too: the wikilink wins
  return out.filter((l) => !l.web || !out.some((o) => !o.web && o.from <= l.from && o.to >= l.to)).sort((a, b) => a.from - b.from);
}

function linkAt(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  const all = linksIn(state, line.from, line.to);
  return all.find((l) => l.from === pos) ?? all.find((l) => l.from <= pos && l.to >= pos);
}

const pageTitle = (target: string) => target.split("#")[0]!.trim();

function openLink(l: Link) {
  if (l.web) return void window.open(webHref(l.target), "_blank", "noopener");
  const title = pageTitle(l.target);
  const id = repo.resolveTitle(title);
  if (id) openItem(id);
  else navigate(`/create?title=${encodeURIComponent(title)}`);
}

function markdownWithText(l: Link, text: string) {
  if (l.web) return `[${text.replace(/[[\]\n]/g, "")}](${l.target})`;
  const clean = text.replace(/[|\]\n]/g, "").trim();
  return !clean || clean === l.target ? `[[${l.target}]]` : `[[${l.target}|${clean}]]`;
}

function linkMenu(view: EditorView, el: HTMLElement, at: { left: number; top: number }) {
  const l = linkAt(view.state, view.posAtDOM(el));
  if (!l) return;
  const below = () => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.bottom + 6 };
  };
  const readOnly = view.state.readOnly;
  showMenu(at, [
    { entries: [{ label: tr("editor.link.open"), icon: ExternalLink, run: () => openLink(l) }] },
    ...(readOnly
      ? []
      : [
          {
            entries: [
              {
                label: tr("editor.link.editText"),
                icon: Pencil,
                run: async () => {
                  const text = await askText(below(), l.text, tr("editor.link.text"));
                  const now = linkAt(view.state, l.from);
                  if (text !== null && now?.from === l.from && now.to === l.to) view.dispatch({ changes: { from: l.from, to: l.to, insert: markdownWithText(l, text) } });
                  view.focus();
                },
              },
              {
                label: tr("editor.link.editTarget"),
                icon: Link2,
                run: () => {
                  view.dispatch({ selection: EditorSelection.range(l.from, l.to) });
                  view.focus();
                  view.plugin(formatToolbar)?.openLink({ text: l.text, target: l.web ? l.target : pageTitle(l.target) });
                },
              },
              {
                label: tr("editor.link.remove"),
                icon: Unlink,
                run: () => {
                  view.dispatch({ changes: { from: l.from, to: l.to, insert: l.text }, selection: EditorSelection.cursor(l.from + l.text.length) });
                  view.focus();
                },
              },
            ],
          },
        ]),
  ]).focusFirst();
}

class LinkWidget extends WidgetType {
  constructor(readonly text: string, readonly target: string, readonly web: boolean, readonly exists: boolean) {
    super();
  }
  override eq(o: LinkWidget) {
    return o.text === this.text && o.target === this.target && o.web === this.web && o.exists === this.exists;
  }
  toDOM(view: EditorView) {
    const a = document.createElement("span");
    a.className = this.web ? "cm-mdlink" : "cm-wikilink" + (this.exists ? "" : " missing");
    a.textContent = this.text;
    a.title = this.target;
    a.setAttribute("role", "link");
    a.addEventListener("mousedown", (e) => e.button === 0 && e.preventDefault());
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const l = linkAt(view.state, view.posAtDOM(a));
      if (l) openLink(l);
    });
    a.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      linkMenu(view, a, { left: e.clientX, top: e.clientY + 4 });
    });
    return a;
  }
  override ignoreEvent() {
    return true;
  }
}

function build(view: EditorView): DecorationSet {
  const deco: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges)
    for (const l of linksIn(view.state, from, to)) {
      if (l.embed) deco.push(Decoration.replace({}).range(l.from, l.to));
      else deco.push(Decoration.replace({ widget: new LinkWidget(l.text || l.target, l.target, l.web, l.web || !!repo.resolveTitle(pageTitle(l.target))) }).range(l.from, l.to));
    }
  return Decoration.set(deco, true);
}

export const links = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.decorations ?? Decoration.none),
  },
);
