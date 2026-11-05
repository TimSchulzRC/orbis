// Markdown editor bound directly to the node's Y.Text, so edits merge with
// other devices and agents character by character.
import { useEffect, useRef } from "react";
import * as Y from "yjs";
import { Compartment, EditorState, Prec, RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  keymap,
  placeholder as placeholderExt,
  drawSelection,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { parseWikiLinks, titleKey, touchOnTextEdit } from "@obtion/core/model";
import { embedHTML, hydrateFiles } from "./Markdown";
import { drawingEmbedHTML, hydrateDrawings } from "../drawing/Drawing";
import { openLightbox } from "./Lightbox";
import { notify } from "./feedback";
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { FilePlus } from "lucide-react";
import { livePreview } from "./editor/livePreview";
import { tables } from "./editor/tables";
import { links, refreshEmbeds } from "./editor/links";
import { editorNode, mentionCompletion, onSlashFiles, pageOption, slashCompletion, slashRender } from "./editor/slash";
import { blockHandles } from "./editor/handles";
import { formatKeymap, formatToolbar } from "./editor/toolbar";
import { moveBy } from "./editor/blocks";
import { searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { repo } from "../repo";
import { files } from "../files";
import { tr } from "../i18n";
import { kindHint, linkInner, placeHint } from "./text";

const highlight = HighlightStyle.define([
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

/** Must render like embeds in read-only Markdown. */
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
    hydrateDrawings(wrap);
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

/** In text order, so the full view can page through them. */
function embeddedImages(state: EditorState): string[] {
  const out: string[] = [];
  for (const link of parseWikiLinks(state.doc.toString())) {
    const id = link.embed ? repo.resolveTitle(link.target) : undefined;
    if (id && repo.get(id)?.file?.filetype === "bild") out.push(id);
  }
  return out;
}

function imageDecos(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = state.doc;
  for (let i = 1; i <= text.lines; i++) {
    const line = text.line(i);
    if (!line.text.includes("![[")) continue;
    for (const link of parseWikiLinks(line.text)) {
      const id = link.embed ? repo.resolveTitle(link.target) : undefined;
      const item = id ? repo.get(id) : undefined;
      if (!item || item.deleted) continue;
      const html = item.file ? embedHTML(item, link.size) : item.kind === "zeichnung" ? drawingEmbedHTML(item, link.size) : undefined;
      if (html) builder.add(line.to, line.to, Decoration.widget({ widget: new EmbedWidget(html), block: true, side: 1 }));
    }
  }
  return builder.finish();
}


const images = StateField.define<DecorationSet>({
  create: imageDecos,
  update: (deco, tr) => (tr.docChanged || tr.effects.some((e) => e.is(refreshEmbeds)) ? imageDecos(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

/** What the embeds of the text show, so a change to one of them redraws it. */
function embedsKey(state: EditorState): string {
  const text = state.doc.toString();
  if (!text.includes("![[")) return "";
  return parseWikiLinks(text)
    .filter((l) => l.embed)
    .map((l) => {
      const item = repo.get(repo.resolveTitle(l.target));
      return item ? `${item.id}:${item.updated}:${item.deleted}` : "";
    })
    .join("|");
}

const LINK_HITS = 40;

const linkCompletion = (selfId?: string) => (ctx: CompletionContext): CompletionResult | null => {
  const match = ctx.matchBefore(/\[\[[^\]\n]*$/);
  if (!match) return null;
  const query = match.text.slice(2);
  const close = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2) === "]]" ? "" : "]]";
  const hits = (query.trim() ? repo.search(query, LINK_HITS) : [...repo.live()].sort((a, b) => b.updated - a.updated).slice(0, LINK_HITS)).filter((hit) => hit.id !== selfId);
  const ix = repo.index();
  const options: Completion[] = hits.map((hit) => pageOption({
    label: hit.title,
    hint: kindHint(hit, ix),
    place: placeHint(hit, ix),
    apply: linkInner(hit, ix) + close,
    boost: hit.title.toLowerCase().startsWith(query.toLowerCase()) ? 10 : 0,
  }));
  if (query.trim() && !hits.some((h) => h.title.toLowerCase() === titleKey(query)))
    options.push(pageOption({ label: query.trim(), hint: tr("editor.newLink"), apply: query.trim() + close, boost: -10, icon: FilePlus }));
  return { from: match.from + 2, options, filter: false };
};

function localStamp(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** Pasted screenshots all arrive as "image.png", so they get a dated name instead. */
function uploadName(f: File): string {
  if (f.name && f.name !== "image.png") return f.name;
  const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
  return `${tr("editor.pastedImage")} ${localStamp()}.${ext}`;
}

async function insertFiles(view: EditorView, list: File[], pos: number) {
  let at = pos;
  for (const f of list) {
    const name = uploadName(f);
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
    insertFiles(view, list, view.state.doc.lineAt(pos).to);
    return true;
  },
});

export function insertFilesAtCursor(view: EditorView, list: File[]) {
  return insertFiles(view, list, view.state.selection.main.head);
}
onSlashFiles(insertFilesAtCursor);

function endQuote(view: EditorView) {
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  const atEndOfEmptyQuote = sel.empty && /^\s*>\s*$/.test(line.text) && sel.head === line.to;
  if (!atEndOfEmptyQuote) return false;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: "" } });
  return true;
}

/** "[] " starts a to-do, a shortcut Markdown itself lacks. */
const shortcuts = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== " " || view.state.readOnly) return false;
  const line = view.state.doc.lineAt(from);
  const before = view.state.sliceDoc(line.from, from);
  if (!/^\s*\[\]$/.test(before)) return false;
  const start = line.from + before.indexOf("[");
  view.dispatch({ changes: { from: start, to, insert: "- [ ] " } });
  return true;
});

const editableState = (readOnly: boolean) => [EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)];

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
    viewRef.current?.dispatch({ effects: editable.current.reconfigure(editableState(readOnly)) });
  }, [readOnly]);
  useEffect(() => {
    const ytext = doc.getText("body");
    const undoManager = new Y.UndoManager(ytext);
    const stopTouch = touchOnTextEdit(doc); // typing moves "geändert"
    const extensions: Extension[] = [
      yCollab(ytext, null, { undoManager }),
      formatKeymap,
      // Markdown would continue the quote, an empty quote line ends it instead
      Prec.highest(keymap.of([{ key: "Enter", run: endQuote }])),
      keymap.of([
        ...yUndoManagerKeymap,
        // ⌘⇧↑/↓ move the block as in Notion, ⌥↑/↓ (default keymap) the line
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
      links,
      livePreview,
      tables,
      images,
      autocompletion({ override: [linkCompletion(nodeId), slashCompletion, mentionCompletion(nodeId)], icons: false, addToOptions: [slashRender], maxRenderedOptions: 40 }),
      editorNode.of(nodeId),
      blockHandles,
      formatToolbar,
      shortcuts,
      fileHandlers,
      placeholderExt(placeholder ?? tr("editor.placeholder")),
      EditorView.contentAttributes.of({ spellcheck: "true", autocapitalize: "sentences", "aria-label": tr("editor.label") }),
      editable.current.of(editableState(readOnly)),
      ...extra,
    ];
    const view = new EditorView({ state: EditorState.create({ doc: ytext.toString(), extensions }), parent: host.current! });
    viewRef.current = view;
    let embeds = embedsKey(view.state);
    const stopEmbeds = repo.subscribe(() => {
      const next = embedsKey(view.state);
      if (next === embeds) return;
      embeds = next;
      view.dispatch({ effects: refreshEmbeds.of(null) });
    });
    if (autoFocus) view.focus();
    onView?.(view);
    return () => {
      onView?.(null);
      viewRef.current = null;
      view.destroy();
      undoManager.destroy();
      stopTouch();
      stopEmbeds();
    };
  }, [doc]);
  return <div ref={host} className={minHeight} />;
}
