// Formatting toolbar above selected text, as in Notion.
import { EditorSelection, Facet, Prec } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate, keymap } from "@codemirror/view";
import { Bold, ChevronDown, Code, FileText, Globe, Italic, Link2, Scissors, Strikethrough } from "lucide-react";
import { repo } from "../../repo";
import { getLang, tr } from "../../i18n";
import { shortcut } from "../../lib/platform";
import { KINDS, kindName, kindOfRange, markActive, setKindRange, toggleMark } from "./blocks";
import { extractAs } from "../extract";
import { ICON } from "../icons";
import { pal } from "../item-look";
import { iconButton, iconHTML } from "./icons";
import { showMenu } from "./menu";
import { titleKey } from "@obtion/core/model";
import { kindHint, webHref } from "../text";

const EXTRACT_MENU_ROWS = 10;

const key = (k: string) => ` (${shortcut(k, getLang())})`;

/** Set for the page's own text, where the toolbar offers to extract the selection. */
export const toolbarExtract = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) });

const isURL = (s: string) => /^(https?:\/\/|mailto:|www\.)\S+$/i.test(s.trim());

/** Writes [[Page]] when the text equals the page title. */
function link(view: EditorView, target: { page?: string; url?: string }, text = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)) {
  const { from, to } = view.state.selection.main;
  const insert = target.page
    ? titleKey(text) === target.page.toLowerCase()
      ? `[[${target.page}]]`
      : `[[${target.page}|${text}]]`
    : `[${text}](${webHref(target.url!)})`;
  view.dispatch({ changes: { from, to, insert }, selection: EditorSelection.cursor(from + insert.length) });
  view.focus();
}

class Toolbar {
  dom: HTMLDivElement;
  bar: HTMLDivElement;
  linkBox: HTMLDivElement;
  input: HTMLInputElement;
  results: HTMLDivElement;
  kindBtn: HTMLButtonElement;
  linkBtn: HTMLButtonElement;
  extractBtn: HTMLButtonElement;
  extractSep: HTMLSpanElement;
  linkSep: HTMLSpanElement;
  pointerDown = false;
  marks: { button: HTMLButtonElement; mark: string }[] = [];
  /** Keeps the bar shown while a menu below it has the focus. */
  menuOpen = false;
  linking = false;
  picked = 0;
  /** Set while relinking; the selection is then the whole link. */
  relinkText: string | null = null;
  hits: { title: string; type: string }[] = [];
  constructor(readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-toolbar";
    this.dom.addEventListener("mousedown", (e) => {
      if (!(e.target as HTMLElement).closest("input")) e.preventDefault();
    });
    this.bar = document.createElement("div");
    this.bar.className = "cm-toolbar-bar";
    this.kindBtn = document.createElement("button");
    this.kindBtn.type = "button";
    this.kindBtn.className = "cm-tb kind";
    this.kindBtn.addEventListener("click", () => {
      const { from, to } = view.state.selection.main;
      const current = kindOfRange(view.state, from, to);
      const entries = KINDS.map((k) => ({ label: kindName(k.kind), icon: k.icon, active: k.kind === current, run: () => setKindRange(view, from, to, k.kind) }));
      this.openMenu(this.kindBtn, tr("editor.turnInto"), entries);
    });
    const sep = () => Object.assign(document.createElement("span"), { className: "cm-tb-sep" });
    const mark = (icon: typeof Bold, label: string, m: string) => {
      const b = iconButton(icon, label, "cm-tb", 16);
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => toggleMark(view, m));
      this.marks.push({ button: b, mark: m });
      return b;
    };
    const linkBtn = (this.linkBtn = iconButton(Link2, tr("editor.fmt.link") + key("K"), "cm-tb wide", 16));
    linkBtn.insertAdjacentHTML("beforeend", `<span>${tr("editor.fmt.linkShort")}</span>`);
    linkBtn.addEventListener("click", () => this.openLink());
    this.extractBtn = iconButton(Scissors, tr("editor.fmt.extract"), "cm-tb wide extract", 16);
    this.extractBtn.insertAdjacentHTML("beforeend", `<span>${tr("editor.fmt.extract")}</span>${iconHTML(ChevronDown, 14)}`);
    this.extractBtn.addEventListener("click", () => {
      const entries = repo.index().typesInOrder().map((t) => ({ label: t.schema.name, icon: ICON[t.schema.icon] ?? ICON.circle, color: pal(t.schema.color), run: () => extractAs(view, t.id) }));
      this.openMenu(this.extractBtn, tr("editor.extractAs"), entries, EXTRACT_MENU_ROWS);
    });
    this.extractSep = sep();
    this.linkSep = sep();
    this.bar.append(
      this.kindBtn,
      sep(),
      linkBtn,
      this.linkSep,
      mark(Bold, tr("editor.fmt.bold") + key("B"), "**"),
      mark(Italic, tr("editor.fmt.italic") + key("I"), "*"),
      mark(Strikethrough, tr("editor.fmt.strike") + key("⇧S"), "~~"),
      mark(Code, tr("editor.fmt.code") + key("E"), "`"),
      this.extractSep,
      this.extractBtn,
    );
    this.linkBox = document.createElement("div");
    this.linkBox.className = "cm-toolbar-link";
    this.input = document.createElement("input");
    this.input.placeholder = tr("editor.fmt.linkPlaceholder");
    this.input.setAttribute("aria-label", tr("editor.fmt.link"));
    this.input.addEventListener("input", () => this.search());
    this.input.addEventListener("keydown", (e) => this.key(e));
    this.input.addEventListener("blur", () => setTimeout(() => this.linking && !this.dom.contains(document.activeElement) && this.closeLink(false), 0));
    this.results = document.createElement("div");
    this.results.className = "cm-toolbar-results";
    this.linkBox.append(this.input, this.results);
    this.dom.append(this.bar, this.linkBox);
    view.dom.append(this.dom);
    view.contentDOM.addEventListener("mousedown", this.down);
    window.addEventListener("mouseup", this.up);
    this.place();
  }
  down = () => {
    this.pointerDown = true;
    this.place();
  };
  up = () => {
    if (!this.pointerDown) return;
    this.pointerDown = false;
    setTimeout(() => this.place());
  };
  get wanted() {
    const s = this.view.state.selection.main;
    return !this.view.state.readOnly && (this.linking || this.menuOpen || (!s.empty && this.view.hasFocus && !this.pointerDown && !!this.view.state.sliceDoc(s.from, s.to).trim()));
  }
  place() {
    if (!this.wanted) {
      this.dom.classList.remove("shown");
      return;
    }
    const { view } = this;
    const s = view.state.selection.main;
    const k = kindOfRange(view.state, s.from, s.to);
    this.kindBtn.innerHTML = `<span>${k ? kindName(k) : tr("editor.block.mixed")}</span>${iconHTML(ChevronDown, 14)}`;
    // a link is inline: one block only
    const multi = view.state.doc.lineAt(s.from).number !== view.state.doc.lineAt(s.to).number;
    this.linkBtn.hidden = this.linkSep.hidden = multi;
    for (const { button, mark } of this.marks) button.setAttribute("aria-pressed", String(markActive(view.state, mark)));
    this.extractBtn.hidden = this.extractSep.hidden = !view.state.facet(toolbarExtract) || !repo.index().typesInOrder().length;
    view.requestMeasure({
      read: () => {
        // read the selection at measure time, a change may land first (extracting shortens the text)
        const s = view.state.selection.main;
        const a = view.coordsAtPos(s.from, 1);
        const b = view.coordsAtPos(s.to, -1);
        return { a, b, dom: view.dom.getBoundingClientRect() };
      },
      write: ({ a, b, dom }) => {
        if (!a || !b) return;
        this.dom.classList.add("shown");
        const w = this.dom.offsetWidth;
        const left = Math.max(-dom.left + 8, Math.min((a.top === b.top ? (a.left + b.right) / 2 - w / 2 : a.left) - dom.left, innerWidth - dom.left - w - 8));
        this.dom.style.left = left + "px";
        this.dom.style.top = a.top - dom.top - this.dom.offsetHeight - 8 + "px";
      },
    });
  }
  openMenu(btn: HTMLElement, title: string, entries: Parameters<typeof showMenu>[1][number]["entries"], maxRows?: number) {
    const { view } = this;
    this.menuOpen = true;
    const onClose = () => {
      this.menuOpen = false;
      // closed by Escape: refocus the text so the selection and the bar stay
      if (!document.activeElement || document.activeElement === document.body) view.focus();
      this.place();
    };
    showMenu({ left: btn.getBoundingClientRect().left, top: this.dom.getBoundingClientRect().bottom + 4 }, [{ title, entries }], onClose, maxRows).focusFirst();
  }
  /** With `relink`, picks a new target for the selected link. */
  openLink(relink?: { text: string; target: string }) {
    if (this.view.state.selection.main.empty) return;
    this.linking = true;
    this.relinkText = relink?.text ?? null;
    this.dom.classList.add("linking");
    this.input.value = relink?.target ?? "";
    this.search();
    this.place();
    setTimeout(() => (this.input.focus(), this.input.select()));
  }
  choose(target: { page?: string; url?: string }) {
    const text = this.relinkText ?? undefined;
    this.closeLink(false);
    link(this.view, target, text);
  }
  closeLink(refocus = true) {
    this.linking = false;
    this.relinkText = null;
    this.dom.classList.remove("linking");
    if (refocus) this.view.focus();
    this.place();
  }
  search() {
    const q = this.input.value;
    const s = this.view.state.selection.main;
    const text = this.relinkText ?? this.view.state.sliceDoc(s.from, s.to);
    const ix = repo.index();
    const found = (q.trim() ? repo.search(q, 6) : repo.search(text, 6)).filter((r) => r.title);
    this.hits = found.map((r) => ({ title: r.title, type: kindHint(r, ix) }));
    this.picked = 0;
    this.results.textContent = "";
    const rows: { icon: typeof Globe; label: string; hint: string; run: () => void }[] = [];
    if (isURL(q)) rows.push({ icon: Globe, label: q.trim(), hint: tr("editor.fmt.linkWeb"), run: () => this.choose({ url: q.trim() }) });
    if (this.hits.length) for (const h of this.hits) rows.push({ icon: FileText, label: h.title, hint: h.type, run: () => this.choose({ page: h.title }) });
    else if (!isURL(q)) {
      const hint = Object.assign(document.createElement("div"), { className: "cm-toolbar-empty", textContent: tr("editor.fmt.linkNone") });
      this.results.append(hint);
    }
    rows.forEach((r, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cm-menu-row" + (i === 0 ? " active" : "");
      b.innerHTML = `<span class="cm-menu-icon">${iconHTML(r.icon, 15)}</span><span class="cm-menu-label"></span><span class="cm-menu-hint"></span>`;
      b.querySelector(".cm-menu-label")!.textContent = r.label;
      b.querySelector(".cm-menu-hint")!.textContent = r.hint;
      b.addEventListener("click", r.run);
      this.results.append(b);
    });
  }
  key(e: KeyboardEvent) {
    const rows = [...this.results.querySelectorAll<HTMLButtonElement>("button")];
    if (e.key === "Escape") (e.preventDefault(), this.closeLink());
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      this.picked = (this.picked + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      rows.forEach((r, i) => r.classList.toggle("active", i === this.picked));
    } else if (e.key === "Enter") {
      e.preventDefault();
      rows[this.picked]?.click();
    }
  }
  update(u: ViewUpdate) {
    if (u.selectionSet || u.focusChanged || u.docChanged || u.geometryChanged) {
      if (this.linking && u.selectionSet && u.view.hasFocus) this.closeLink(false);
      this.place();
    }
  }
  destroy() {
    this.view.contentDOM.removeEventListener("mousedown", this.down);
    window.removeEventListener("mouseup", this.up);
    this.dom.remove();
  }
}

export const formatToolbar = ViewPlugin.fromClass(Toolbar);

/** Without a selection ⌘K stays the search. */
function linkKey(view: EditorView) {
  if (view.state.readOnly || view.state.selection.main.empty) return false;
  view.plugin(formatToolbar)?.openLink();
  return true;
}

export const formatKeymap = Prec.high(
  keymap.of([
    { key: "Mod-b", run: (v) => toggleMark(v, "**") },
    { key: "Mod-i", run: (v) => toggleMark(v, "*") },
    { key: "Mod-Shift-s", run: (v) => toggleMark(v, "~~") },
    { key: "Mod-e", run: (v) => toggleMark(v, "`") },
    { key: "Mod-k", run: linkKey },
  ]),
);
