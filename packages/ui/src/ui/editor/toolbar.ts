// Formatting toolbar above selected text, as in Notion.
import { EditorSelection, Facet, Prec } from "@codemirror/state";
import { type EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { titleKey } from "@obtion/core/model";
import {
	Bold,
	ChevronDown,
	Code,
	FileText,
	Globe,
	Italic,
	Link2,
	Scissors,
	Strikethrough,
} from "lucide-react";
import { getLang, tr } from "../../i18n";
import { shortcut } from "../../lib/platform";
import { repo } from "../../repo";
import { extractAs } from "../extract";
import { ICON } from "../icons";
import { pal } from "../item-look";
import { kindHint, placeHint, webHref } from "../text";
import { KINDS, kindName, kindOfRange, markActive, setKindRange, toggleMark } from "./blocks";
import { iconButton, iconHTML } from "./icons";
import { showMenu } from "./menu";

const EXTRACT_MENU_ROWS = 10;
const LINK_HITS = 6;
/** The bar keeps this many px away from the window's edges and from the selection. */
const GAP = 8;

const key = (k: string) => ` (${shortcut(k, getLang())})`;

/** Set for the page's own text, where the toolbar offers to extract the selection. */
export const toolbarExtract = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) });

const isURL = (s: string) => /^(https?:\/\/|mailto:|www\.)\S+$/i.test(s.trim());

/** Writes [[Page]] when the text equals the page title. */
function link(
	view: EditorView,
	target: { page?: string; url?: string },
	text = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
) {
	const { from, to } = view.state.selection.main;
	const insert = target.page ? pageLink(target.page, text) : `[${text}](${webHref(target.url!)})`;
	view.dispatch({
		changes: { from, to, insert },
		selection: EditorSelection.cursor(from + insert.length),
	});
	view.focus();
}

/** `page` is a title or, for a page its title can't name exactly, its id. */
function pageLink(page: string, text: string) {
	if (titleKey(text) === page.toLowerCase() && !repo.get(page)) return `[[${page}]]`;
	return `[[${page}|${text.replace(/[|\]\n]/g, "").trim()}]]`; // a | or ] would end the link
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
	hits: { title: string; target: string; type: string; place: string }[] = [];
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
			const entries = KINDS.map((k) => ({
				label: kindName(k.kind),
				icon: k.icon,
				active: k.kind === current,
				run: () => setKindRange(view, from, to, k.kind),
			}));
			this.openMenu(this.kindBtn, tr("editor.turnInto"), entries);
		});
		const sep = () => Object.assign(document.createElement("span"), { className: "cm-tb-sep" });
		const mark = (icon: typeof Bold, label: string, chars: string) => {
			const button = iconButton(icon, label, "cm-tb", 16);
			button.setAttribute("aria-pressed", "false");
			button.addEventListener("click", () => toggleMark(view, chars));
			this.marks.push({ button, mark: chars });
			return button;
		};
		const linkBtn = (this.linkBtn = iconButton(
			Link2,
			tr("editor.fmt.link") + key("K"),
			"cm-tb wide",
			16,
		));
		linkBtn.insertAdjacentHTML("beforeend", `<span>${tr("editor.fmt.linkShort")}</span>`);
		linkBtn.addEventListener("click", () => this.openLink());
		this.extractBtn = iconButton(Scissors, tr("editor.fmt.extract"), "cm-tb wide extract", 16);
		this.extractBtn.insertAdjacentHTML(
			"beforeend",
			`<span>${tr("editor.fmt.extract")}</span>${iconHTML(ChevronDown, 14)}`,
		);
		this.extractBtn.addEventListener("click", () => {
			const entries = repo
				.index()
				.typesInOrder()
				.map((t) => ({
					label: t.schema.name,
					icon: ICON[t.schema.icon] ?? ICON.circle,
					color: pal(t.schema.color),
					run: () => extractAs(view, t.id),
				}));
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
		this.input.addEventListener("blur", () =>
			setTimeout(
				() => this.linking && !this.dom.contains(document.activeElement) && this.closeLink(false),
				0,
			),
		);
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
		const sel = this.view.state.selection.main;
		const textSelected =
			!sel.empty &&
			this.view.hasFocus &&
			!this.pointerDown &&
			!!this.view.state.sliceDoc(sel.from, sel.to).trim();
		return !this.view.state.readOnly && (this.linking || this.menuOpen || textSelected);
	}
	place() {
		if (!this.wanted) {
			this.dom.classList.remove("shown");
			return;
		}
		const { view } = this;
		const sel = view.state.selection.main;
		const kind = kindOfRange(view.state, sel.from, sel.to);
		this.kindBtn.innerHTML = `<span>${kind ? kindName(kind) : tr("editor.block.mixed")}</span>${iconHTML(ChevronDown, 14)}`;
		// a link is inline: one block only
		const multi = view.state.doc.lineAt(sel.from).number !== view.state.doc.lineAt(sel.to).number;
		this.linkBtn.hidden = this.linkSep.hidden = multi;
		for (const { button, mark } of this.marks)
			button.setAttribute("aria-pressed", String(markActive(view.state, mark)));
		this.extractBtn.hidden = this.extractSep.hidden =
			!view.state.facet(toolbarExtract) || !repo.index().typesInOrder().length;
		view.requestMeasure({
			read: () => {
				// read the selection at measure time, a change may land first (extracting shortens the text)
				const sel = view.state.selection.main;
				const start = view.coordsAtPos(sel.from, 1);
				const end = view.coordsAtPos(sel.to, -1);
				return { start, end, dom: view.dom.getBoundingClientRect() };
			},
			write: ({ start, end, dom }) => {
				if (!start || !end) return;
				this.dom.classList.add("shown");
				const width = this.dom.offsetWidth;
				// centred over a one-line selection, else at its start
				const preferred =
					start.top === end.top ? (start.left + end.right) / 2 - width / 2 : start.left;
				const left = Math.max(
					-dom.left + GAP,
					Math.min(preferred - dom.left, innerWidth - dom.left - width - GAP),
				);
				this.dom.style.left = left + "px";
				this.dom.style.top = start.top - dom.top - this.dom.offsetHeight - GAP + "px";
			},
		});
	}
	openMenu(
		btn: HTMLElement,
		title: string,
		entries: Parameters<typeof showMenu>[1][number]["entries"],
		maxRows?: number,
	) {
		const { view } = this;
		this.menuOpen = true;
		const onClose = () => {
			this.menuOpen = false;
			// closed by Escape: refocus the text so the selection and the bar stay
			if (!document.activeElement || document.activeElement === document.body) view.focus();
			this.place();
		};
		showMenu(
			{ left: btn.getBoundingClientRect().left, top: this.dom.getBoundingClientRect().bottom + 4 },
			[{ title, entries }],
			onClose,
			maxRows,
		).focusFirst();
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
		const query = this.input.value;
		const sel = this.view.state.selection.main;
		const text = this.relinkText ?? this.view.state.sliceDoc(sel.from, sel.to);
		const ix = repo.index();
		const found = repo.search(query.trim() ? query : text, LINK_HITS).filter((hit) => hit.title);
		this.hits = found.map((hit) => ({
			title: hit.title,
			target: ix.linkTarget(hit),
			type: kindHint(hit, ix),
			place: placeHint(hit, ix),
		}));
		this.picked = 0;
		this.results.textContent = "";
		const isWeb = isURL(query);
		const rows: {
			icon: typeof Globe;
			label: string;
			hint: string;
			place?: string;
			run: () => void;
		}[] = [];
		if (isWeb)
			rows.push({
				icon: Globe,
				label: query.trim(),
				hint: tr("editor.fmt.linkWeb"),
				run: () => this.choose({ url: query.trim() }),
			});
		if (this.hits.length)
			for (const hit of this.hits)
				rows.push({
					icon: FileText,
					label: hit.title,
					hint: hit.type,
					place: hit.place,
					run: () => this.choose({ page: hit.target }),
				});
		else if (!isWeb) {
			const hint = Object.assign(document.createElement("div"), {
				className: "cm-toolbar-empty",
				textContent: tr("editor.fmt.linkNone"),
			});
			this.results.append(hint);
		}
		rows.forEach((row, i) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "cm-menu-row" + (i === 0 ? " active" : "");
			button.innerHTML = `<span class="cm-menu-icon">${iconHTML(row.icon, 15)}</span><span class="cm-menu-label"></span><span class="cm-menu-hint"></span>`;
			const label = button.querySelector(".cm-menu-label")!;
			label.textContent = row.label;
			button.querySelector(".cm-menu-hint")!.textContent = row.hint;
			if (row.place) {
				// The path goes below the title: two entries with one title differ there.
				const lines = Object.assign(document.createElement("span"), { className: "cm-menu-lines" });
				label.replaceWith(lines);
				lines.append(
					label,
					Object.assign(document.createElement("span"), {
						className: "cm-menu-place",
						textContent: row.place,
					}),
				);
			}
			button.addEventListener("click", row.run);
			this.results.append(button);
		});
	}
	key(e: KeyboardEvent) {
		const rows = [...this.results.querySelectorAll<HTMLButtonElement>("button")];
		if (e.key === "Escape") e.preventDefault(), this.closeLink();
		else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (!rows.length) return;
			this.picked = (this.picked + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
			rows.forEach((row, i) => row.classList.toggle("active", i === this.picked));
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
