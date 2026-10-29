// Markdown editor bound directly to the node's Y.Text, so edits merge with
// other devices and agents character by character.
import { useEffect, useRef } from "react";
import * as Y from "yjs";
import { Compartment, EditorState, Prec, RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  keymap,
  placeholder as placeholderExt,
  drawSelection,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { touchOnTextEdit } from "@obtion/core/model";
import { embedHTML, hydrateFiles } from "./Markdown";
import { openLightbox } from "./Lightbox";
import { notify } from "./feedback";
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { FilePlus } from "lucide-react";
import { livePreview } from "./editor/livePreview";
import { mentionCompletion, onSlashFiles, pageOption, slashCompletion, slashRender } from "./editor/slash";
import { blockHandles } from "./editor/handles";
import { formatKeymap, formatToolbar } from "./editor/toolbar";
import { moveBy } from "./editor/blocks";
import { searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { repo } from "../repo";
import { go, itemHref } from "../hooks";
import { files } from "../files";
import { tr } from "../i18n";

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.75em", fontWeight: "650", lineHeight: "1.3", letterSpacing: "-0.01em" },
  { tag: t.heading2, fontSize: "1.4em", fontWeight: "650", lineHeight: "1.35" },
  { tag: t.heading3, fontSize: "1.18em", fontWeight: "650" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650" },
  { tag: t.strong, fontWeight: "650" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.86em", color: "var(--code-text)", background: "color-mix(in srgb, var(--muted-foreground) 14%, transparent)", borderRadius: "4px", padding: "0.15em 0.3em" },
  { tag: [t.processingInstruction, t.meta], color: "var(--faint)" },
  { tag: t.link, color: "var(--focus)" },
  { tag: t.url, color: "var(--muted-foreground)" },
  { tag: t.quote, color: "inherit" },
  { tag: t.list, color: "inherit" },
  { tag: t.contentSeparator, color: "var(--faint)" },
]);

// ---------- wikilinks ----------

const linkRe = /(!?\[\[)([^\]|#\n]+)((?:#[^\]|\n]*)?(?:\|[^\]\n]*)?)(\]\])/g;

const linkDecorator = new MatchDecorator({
  regexp: linkRe,
  decorate(add, from, _to, m) {
    const target = m[2]!.trim();
    const id = repo.resolveTitle(target);
    if (m[1] === "![[" && id && repo.get(id)?.file?.filetype === "bild") return;
    const exists = !!id;
    const open = m[1]!.length;
    add(from, from + open, Decoration.mark({ class: "cm-bracket-dim" }));
    add(from + open, from + open + m[2]!.length + m[3]!.length, Decoration.mark({ class: exists ? "cm-wikilink" : "cm-wikilink missing", attributes: { "data-target": target } }));
    add(from + open + m[2]!.length + m[3]!.length, from + m[0].length, Decoration.mark({ class: "cm-bracket-dim" }));
  },
});

const wikilinks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = linkDecorator.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = linkDecorator.updateDeco(u, this.decorations);
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      click(e) {
        const el = (e.target as HTMLElement).closest("[data-target]") as HTMLElement | null;
        if (!el) return false;
        const target = el.dataset.target!;
        const id = repo.resolveTitle(target);
        e.preventDefault();
        if (id) go(itemHref(id).slice(1));
        else go(`/create?title=${encodeURIComponent(target)}`);
        return true;
      },
    },
  },
);

// ---------- quiet markup: the syntax only shows on the line being edited ----------
// Elsewhere the text reads like text: no "# " before headings, no [[ ]] around links, no target
// before an |alias, and no ![[file]] source where the file is shown below it.

function quietRanges(line: { from: number; text: string }): [number, number][] {
  const out: [number, number][] = [];
  const h = /^(#{1,6} )/.exec(line.text);
  if (h) out.push([line.from, line.from + h[1]!.length]);
  for (const m of line.text.matchAll(linkRe)) {
    const start = line.from + m.index!;
    const [all, open, target, rest] = [m[0], m[1]!, m[2]!, m[3]!];
    if (open === "![[") {
      const id = repo.resolveTitle(target.trim());
      if (id && repo.get(id)?.file) out.push([start, start + all.length]); // the embed shows it
      continue;
    }
    out.push([start, start + open.length]);
    const bar = rest.indexOf("|");
    if (bar >= 0) out.push([start + open.length, start + open.length + target.length + bar + 1]);
    out.push([start + all.length - 2, start + all.length]);
  }
  return out;
}

function headingDecos(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const sel = view.state.selection.main;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const active = view.hasFocus && sel.from <= line.to && sel.to >= line.from;
      if (!active) for (const [a, z] of quietRanges(line)) b.add(a, z, Decoration.replace({}));
      pos = line.to + 1;
    }
  }
  return b.finish();
}

const quietHeadings = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = headingDecos(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) this.decorations = headingDecos(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------- file embeds ----------

/** An embedded file below its line, drawn like in read-only text (Markdown.tsx). */
class EmbedWidget extends WidgetType {
  constructor(readonly html: string) {
    super();
  }
  override eq(o: EmbedWidget) {
    return o.html === this.html;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-embed";
    wrap.innerHTML = this.html;
    hydrateFiles(wrap);
    wrap.addEventListener("click", (e) => {
      const img = (e.target as HTMLElement).closest<HTMLImageElement>(".embed-img img");
      if (!img) return;
      e.preventDefault();
      const ids = embeddedImages(view.state);
      openLightbox(ids, ids.indexOf(img.dataset.id!));
    });
    return wrap;
  }
  override ignoreEvent() {
    return true;
  }
}

const EMBED = /!\[\[([^\]|#\n]+)(?:\|(\d+))?[^\]]*\]\]/g;

/** Ids of the images embedded in the text, in order (the full view pages through them). */
function embeddedImages(state: EditorState): string[] {
  const out: string[] = [];
  for (const m of state.doc.toString().matchAll(EMBED)) {
    const id = repo.resolveTitle(m[1]!.trim());
    if (id && repo.get(id)?.file?.filetype === "bild") out.push(id);
  }
  return out;
}

function imageDecos(state: EditorState): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const text = state.doc;
  for (let i = 1; i <= text.lines; i++) {
    const line = text.line(i);
    if (!line.text.includes("![[")) continue;
    for (const m of line.text.matchAll(EMBED)) {
      const id = repo.resolveTitle(m[1]!.trim());
      const item = id ? repo.get(id) : undefined;
      if (item?.file && !item.deleted) b.add(line.to, line.to, Decoration.widget({ widget: new EmbedWidget(embedHTML(item, m[2] ? Number(m[2]) : undefined)), block: true, side: 1 }));
    }
  }
  return b.finish();
}

const images = StateField.define<DecorationSet>({
  create: imageDecos,
  update: (deco, tr) => (tr.docChanged ? imageDecos(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- [[ autocomplete ----------

const linkCompletion = (selfId?: string) => (ctx: CompletionContext): CompletionResult | null => {
  const m = ctx.matchBefore(/\[\[[^\]\n]*$/);
  if (!m) return null;
  const q = m.text.slice(2);
  const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
  const hits = (q.trim() ? repo.search(q, 40) : repo.live().sort((a, b) => b.updated - a.updated).slice(0, 40)).filter((r) => r.id !== selfId);
  const options: Completion[] = hits.map((r) => pageOption({
    label: r.title,
    hint: r.kind === "datei" ? tr("kind.file") : (repo.index().typeName(r.type) ?? ""),
    apply: r.title + (after === "]]" ? "" : "]]"),
    boost: r.title.toLowerCase().startsWith(q.toLowerCase()) ? 10 : 0,
  }));
  if (q.trim() && !hits.some((h) => h.title.toLowerCase() === q.trim().toLowerCase()))
    options.push(pageOption({ label: q.trim(), hint: tr("editor.newLink"), apply: q.trim() + (after === "]]" ? "" : "]]"), boost: -10, icon: FilePlus }));
  return { from: m.from + 2, options, filter: false };
};

// ---------- paste and drop files ----------

/** 2026-10-25-23-03-27 in local time (names of pasted images). */
function localStamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Insert files at a position: stored on this device at once, uploaded when the server is reachable. */
async function insertFiles(view: EditorView, list: File[], pos: number, parent?: string) {
  let at = pos;
  for (const f of list) {
    const name = f.name && f.name !== "image.png" ? f.name : `${tr("editor.pastedImage")} ${localStamp()}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`;
    try {
      const res = await files.add(f, name, { parent: undefined });
      const isImg = f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(res.name);
      const isMedia = isImg || /^(audio|video)\//.test(f.type) || /\.pdf$/i.test(res.name);
      const insert = `${isMedia ? "!" : ""}[[${res.name}]]\n`;
      view.dispatch({ changes: { from: at, insert } });
      at += insert.length;
    } catch (e) {
      console.error(e);
      notify.error(tr("editor.fileFailed"));
    }
  }
  void parent;
}

const fileHandlers = EditorView.domEventHandlers({
  paste(e, view) {
    const list = [...(e.clipboardData?.files ?? [])];
    if (!list.length) return false;
    e.preventDefault();
    insertFiles(view, list, view.state.selection.main.head);
    return true;
  },
  drop(e, view) {
    const list = [...(e.dataTransfer?.files ?? [])];
    if (!list.length) return false;
    e.preventDefault();
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
    insertFiles(view, list, view.state.doc.lineAt(pos).to + (view.state.doc.lineAt(pos).length ? 0 : 0));
    return true;
  },
});

/** For the toolbar / camera button: insert chosen files at the cursor. */
export function insertFilesAtCursor(view: EditorView, list: File[]) {
  return insertFiles(view, list, view.state.selection.main.head);
}
onSlashFiles(insertFilesAtCursor);

function endQuote(view: EditorView) {
  const { state } = view;
  const s = state.selection.main;
  const line = state.doc.lineAt(s.head);
  if (!s.empty || !/^\s*>\s*$/.test(line.text) || s.head !== line.to) return false;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: "" } });
  return true;
}

/** Markdown shortcuts Markdown itself does not have: "[] " starts a to-do. */
const shortcuts = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== " " || view.state.readOnly) return false;
  const line = view.state.doc.lineAt(from);
  const before = view.state.sliceDoc(line.from, from);
  if (!/^\s*\[\]$/.test(before)) return false;
  const start = line.from + before.indexOf("[");
  view.dispatch({ changes: { from: start, to, insert: "- [ ] " } });
  return true;
});

// ---------- component ----------

export function Editor({
  doc,
  nodeId,
  placeholder,
  autoFocus,
  onView,
  extra = [],
  minHeight = "min-h-[30vh]",
  readOnly = false,
}: {
  minHeight?: string;
  /** Shown, not edited. */
  readOnly?: boolean;
  doc: Y.Doc;
  nodeId?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onView?: (v: EditorView | null) => void;
  extra?: Extension[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  useEffect(() => {
    viewRef.current?.dispatch({ effects: editable.current.reconfigure([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]) });
  }, [readOnly]);
  useEffect(() => {
    const ytext = doc.getText("body");
    const undoManager = new Y.UndoManager(ytext);
    const stopTouch = touchOnTextEdit(doc); // typing moves "geändert"
    const extensions: Extension[] = [
      yCollab(ytext, null, { undoManager }),
      formatKeymap,
      // Enter on an empty quote line ends the quote (Markdown would keep it going)
      Prec.highest(keymap.of([{ key: "Enter", run: endQuote }])),
      keymap.of([
        ...yUndoManagerKeymap,
        // ⌘⇧↑ / ⌘⇧↓ move the block (as in Notion), ⌥↑ / ⌥↓ the line
        { key: "Mod-Shift-ArrowUp", run: (v) => (moveBy(v, v.state.selection.main.head, -1), true) },
        { key: "Mod-Shift-ArrowDown", run: (v) => (moveBy(v, v.state.selection.main.head, 1), true) },
        ...defaultKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      drawSelection(),
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      wikilinks,
      quietHeadings,
      livePreview,
      images,
      autocompletion({ override: [linkCompletion(nodeId), slashCompletion, mentionCompletion(nodeId)], icons: false, addToOptions: [slashRender], maxRenderedOptions: 40 }),
      blockHandles,
      formatToolbar,
      shortcuts,
      fileHandlers,
      placeholderExt(placeholder ?? tr("editor.placeholder")),
      EditorView.contentAttributes.of({ spellcheck: "true", autocapitalize: "sentences", "aria-label": tr("editor.label") }),
      editable.current.of([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
      ...extra,
    ];
    const view = new EditorView({ state: EditorState.create({ doc: ytext.toString(), extensions }), parent: host.current! });
    viewRef.current = view;
    if (autoFocus) view.focus();
    onView?.(view);
    return () => {
      onView?.(null);
      viewRef.current = null;
      view.destroy();
      undoManager.destroy();
      stopTouch();
    };
  }, [doc]);
  return <div ref={host} className={minHeight} />;
}
