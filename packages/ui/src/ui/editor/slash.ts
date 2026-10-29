// "/" opens the block menu as in Notion: kinds of text, a link to a page, images and files,
// a divider, code and query blocks – filtered while typing. "@" links a page right where you are.
import type { ComponentType } from "react";
import { type Completion, type CompletionContext, type CompletionResult, startCompletion } from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Code, FileText, ImagePlus, Lightbulb, Link2, ListFilter, Minus, Paperclip } from "lucide-react";
import { repo } from "../../repo";
import { tr } from "../../i18n";
import { insertQueryBlock } from "../QueryBlock";
import { KINDS, kindName, setKind } from "./blocks";
import { iconHTML } from "./icons";

/** A menu entry with an icon, a description and more words it is found by. */
interface SlashItem {
  id: string;
  icon: ComponentType<{ size?: number }>;
  section: "basic" | "insert";
  run: (view: EditorView, pos: number) => void;
}

type Option = Completion & { icon?: ComponentType<{ size?: number }>; hint?: string; page?: boolean };

let filesHandler: (view: EditorView, files: File[]) => void = () => {};
/** The editor tells how chosen files are inserted (Editor.tsx). */
export function onSlashFiles(f: typeof filesHandler) {
  filesHandler = f;
}

function chooseFiles(view: EditorView, accept: string) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = true;
  input.onchange = () => input.files && filesHandler(view, [...input.files]);
  input.click();
}

/** Put a block of its own on the line (the line itself if it is empty, else one below). */
function insertBlock(view: EditorView, pos: number, text: string, cursor: number) {
  const line = view.state.doc.lineAt(pos);
  const at = line.length ? line.to : line.from;
  const lead = line.length ? "\n" : "";
  const next = view.state.doc.length > line.to ? "" : "\n";
  view.dispatch({ changes: { from: at, to: line.length ? at : line.to, insert: lead + text + next }, selection: EditorSelection.cursor(at + lead.length + cursor), scrollIntoView: true });
}

const ITEMS: SlashItem[] = [
  ...KINDS.map((k) => ({ id: k.kind, icon: k.icon, section: "basic" as const, run: (view: EditorView, pos: number) => setKind(view, pos, k.kind) })),
  {
    id: "callout",
    icon: Lightbulb,
    section: "basic",
    run: (view, pos) => {
      setKind(view, pos, "quote");
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      view.dispatch({ changes: { from: line.from + 2, insert: "💡 " }, selection: EditorSelection.cursor(line.to + 3) });
    },
  },
  {
    id: "link",
    icon: Link2,
    section: "insert",
    run: (view, pos) => {
      view.dispatch({ changes: { from: pos, insert: "[[" }, selection: EditorSelection.cursor(pos + 2) });
      startCompletion(view);
    },
  },
  { id: "image", icon: ImagePlus, section: "insert", run: (view) => chooseFiles(view, "image/*") },
  { id: "file", icon: Paperclip, section: "insert", run: (view) => chooseFiles(view, "") },
  { id: "divider", icon: Minus, section: "insert", run: (view, pos) => insertBlock(view, pos, "---\n", 4) },
  { id: "code", icon: Code, section: "insert", run: (view, pos) => insertBlock(view, pos, "```\n\n```", 4) },
  { id: "query", icon: ListFilter, section: "insert", run: (view) => insertQueryBlock(view) },
];

const SECTIONS = { basic: { name: "editor.section.basic", rank: 0 }, insert: { name: "editor.section.insert", rank: 1 } };

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** "/" at the start of a line or after a space. */
export function slashCompletion(ctx: CompletionContext): CompletionResult | null {
  if (ctx.state.readOnly) return null;
  const m = ctx.matchBefore(/(?:^|\s)\/[\p{L}\p{N}]*$/u);
  if (!m) return null;
  const from = m.from + m.text.indexOf("/");
  const q = norm(ctx.state.sliceDoc(from + 1, ctx.pos));
  const options: Option[] = [];
  for (const it of ITEMS) {
    const kind = KINDS.find((k) => k.kind === it.id)?.kind;
    const label = kind ? kindName(kind) : tr("editor.slash." + it.id);
    const words = norm(label + " " + tr("editor.slash." + it.id + ".keys"));
    if (q && !words.split(/[\s,]+/).some((w) => w.startsWith(q)) && !words.includes(q)) continue;
    options.push({
      label,
      icon: it.icon,
      hint: tr("editor.slash." + it.id + ".hint"),
      section: { name: tr(SECTIONS[it.section].name), rank: SECTIONS[it.section].rank },
      boost: -ITEMS.indexOf(it),
      apply: (view) => {
        // the typed "/…" goes, then the block changes
        view.dispatch({ changes: { from, to: ctx.pos, insert: "" } });
        it.run(view, from);
      },
    });
  }
  return { from, options, filter: false };
}

/** A page among the options (links and mentions): drawn with a page icon and its type. */
export function pageOption(o: Option): Completion {
  return { icon: FileText, page: true, ...o } as Option;
}

/** "@" and a few letters of a title: a link to that page. */
export function mentionCompletion(selfId?: string) {
  return (ctx: CompletionContext): CompletionResult | null => {
    if (ctx.state.readOnly) return null;
    const m = ctx.matchBefore(/(?:^|[\s(])@[^@\n[\]]{0,40}$/);
    if (!m) return null;
    const from = m.from + m.text.indexOf("@");
    const q = ctx.state.sliceDoc(from + 1, ctx.pos);
    if (!q && !ctx.explicit && ctx.state.sliceDoc(from - 1, from).trim()) return null;
    const hits = (q.trim() ? repo.search(q, 20) : repo.live().sort((a, b) => b.updated - a.updated).slice(0, 12)).filter((r) => r.id !== selfId && r.title);
    // a space after a word that finds nothing: it was no mention
    if (!hits.length && /\s/.test(q)) return null;
    return {
      from,
      filter: false,
      options: hits.map((r, i) =>
        pageOption({
        label: r.title,
        hint: r.kind === "datei" ? tr("kind.file") : (repo.index().typeName(r.type) ?? ""),
        boost: -i,
        apply: (view, _c, a, b) => view.dispatch({ changes: { from: a, to: b, insert: `[[${r.title}]]` }, selection: EditorSelection.cursor(a + r.title.length + 4) }),
        }),
      ),
    };
  };
}

/** Each entry with its icon and a line on what it does (pages: their type). */
export const slashRender = {
  position: 20,
  render(c: Completion): Node | null {
    const o = c as Option;
    if (!o.icon) return null;
    const row = document.createElement("div");
    row.className = "cm-slash" + (o.page ? " page" : "");
    const tile = document.createElement("span");
    tile.className = "cm-slash-icon";
    tile.innerHTML = iconHTML(o.icon, o.page ? 15 : 18);
    const text = document.createElement("span");
    text.className = "cm-slash-text";
    const name = document.createElement("span");
    name.className = "cm-slash-name";
    name.textContent = o.label;
    text.append(name);
    if (o.hint) {
      const hint = document.createElement("span");
      hint.className = "cm-slash-hint";
      hint.textContent = o.hint;
      text.append(hint);
    }
    row.append(tile, text);
    return row;
  },
};
