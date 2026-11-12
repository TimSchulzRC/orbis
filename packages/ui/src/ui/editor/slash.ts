// As in Notion, "/" opens the block menu (also for tables) and "@" links a page right where you are.

import {
	type Completion,
	type CompletionContext,
	type CompletionResult,
	startCompletion,
} from "@codemirror/autocomplete";
import { EditorSelection, Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { foldUmlauts, plainVowels } from "@obtion/core/text";
import {
	Code,
	FileText,
	ImagePlus,
	Lightbulb,
	Link2,
	ListFilter,
	Minus,
	Paperclip,
	Table,
} from "lucide-react";
import type { ComponentType } from "react";
import { tr } from "../../i18n";
import { repo } from "../../repo";
import { DRAWING_ICON } from "../icons";
import { insertQueryBlock } from "../QueryBlock";
import { kindHint, linkInner, placeHint } from "../text";
import { KINDS, kindName, setKind } from "./blocks";
import { iconHTML } from "./icons";
import { insertTable } from "./tables";

/** The item whose text the editor shows; a drawing made with "/" goes below it. */
export const editorNode = Facet.define<string | undefined, string | undefined>({
	combine: (v) => v[0],
});

interface SlashItem {
	id: string;
	icon: ComponentType<{ size?: number }>;
	section: "basic" | "insert";
	run: (view: EditorView, pos: number) => void;
}

type Option = Completion & {
	icon?: ComponentType<{ size?: number }>;
	hint?: string;
	page?: boolean /** A page's path, on a line below. */;
	place?: string;
};

let filesHandler: (view: EditorView, files: File[]) => void = () => {};
/** Set by Editor.tsx, which does the actual file insertion. */
export function onSlashFiles(handler: typeof filesHandler) {
	filesHandler = handler;
}

function chooseFiles(view: EditorView, accept: string) {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = accept;
	input.multiple = true;
	input.onchange = () => input.files && filesHandler(view, [...input.files]);
	input.click();
}

/** Uses the line itself if it is empty, else a new line below. */
function insertBlock(view: EditorView, pos: number, text: string, cursor: number) {
	const line = view.state.doc.lineAt(pos);
	const at = line.length ? line.to : line.from;
	const lead = line.length ? "\n" : "";
	const next = view.state.doc.length > line.to ? "" : "\n";
	view.dispatch({
		changes: { from: at, to: line.length ? at : line.to, insert: lead + text + next },
		selection: EditorSelection.cursor(at + lead.length + cursor),
		scrollIntoView: true,
	});
}

const ITEMS: SlashItem[] = [
	...KINDS.map((k) => ({
		id: k.kind,
		icon: k.icon,
		section: "basic" as const,
		run: (view: EditorView, pos: number) => setKind(view, pos, k.kind),
	})),
	{
		id: "callout",
		icon: Lightbulb,
		section: "basic",
		run: (view, pos) => {
			setKind(view, pos, "quote");
			const line = view.state.doc.lineAt(view.state.selection.main.head);
			view.dispatch({
				changes: { from: line.from + 2, insert: "💡 " },
				selection: EditorSelection.cursor(line.to + 3),
			});
		},
	},
	{
		id: "link",
		icon: Link2,
		section: "insert",
		run: (view, pos) => {
			// the "@" search: no brackets to see while choosing the page
			view.dispatch({
				changes: { from: pos, insert: "@" },
				selection: EditorSelection.cursor(pos + 1),
			});
			startCompletion(view);
		},
	},
	{ id: "image", icon: ImagePlus, section: "insert", run: (view) => chooseFiles(view, "image/*") },
	{ id: "file", icon: Paperclip, section: "insert", run: (view) => chooseFiles(view, "") },
	// "***", not "---": "---" right under a line of text turns that line into a heading (Setext)
	{
		id: "divider",
		icon: Minus,
		section: "insert",
		run: (view, pos) => insertBlock(view, pos, "***\n", 4),
	},
	{
		id: "code",
		icon: Code,
		section: "insert",
		run: (view, pos) => insertBlock(view, pos, "```\n\n```", 4),
	},
	{ id: "table", icon: Table, section: "insert", run: (view, pos) => insertTable(view, pos) },
	{
		id: "drawing",
		icon: DRAWING_ICON,
		section: "insert",
		run: (view, pos) => insertDrawing(view, pos),
	},
	{ id: "query", icon: ListFilter, section: "insert", run: (view) => insertQueryBlock(view) },
];

/**
 * A drawing as a block of this text: kept as a document of its own below the note (so it syncs per
 * element and its images are files), embedded by id. A click on the block opens it to draw.
 */
export function insertDrawing(view: EditorView, pos = view.state.selection.main.head) {
	const parent = view.state.facet(editorNode);
	const id = repo.create({ kind: "drawing", title: "", parents: parent ? [parent] : [] });
	const embed = `![[${id}]]`;
	// after the index has the new drawing (next microtask), so the embed shows at once
	queueMicrotask(() => insertBlock(view, pos, `${embed}\n`, embed.length + 1));
}

const SECTIONS = {
	basic: { name: "editor.section.basic", rank: 0 },
	insert: { name: "editor.section.insert", rank: 1 },
};

/** Umlauts match typed either way: "ueber", "über" and "uber" all find the German "Überschrift". */
const hasWord = (words: string, query: string) =>
	[foldUmlauts, plainVowels].some((f) => f(words).includes(f(query)));

export function slashCompletion(ctx: CompletionContext): CompletionResult | null {
	if (ctx.state.readOnly) return null;
	const match = ctx.matchBefore(/(?:^|\s)\/[\p{L}\p{N}]*$/u);
	if (!match) return null;
	const from = match.from + match.text.indexOf("/");
	const query = ctx.state.sliceDoc(from + 1, ctx.pos);
	const options: Option[] = [];
	for (const item of ITEMS) {
		const kind = KINDS.find((k) => k.kind === item.id)?.kind;
		const label = kind ? kindName(kind) : tr(`editor.slash.${item.id}`);
		if (query && !hasWord(`${label} ${tr(`editor.slash.${item.id}.keys`)}`, query)) continue;
		const section = SECTIONS[item.section];
		options.push({
			label,
			icon: item.icon,
			hint: tr(`editor.slash.${item.id}.hint`),
			section: { name: tr(section.name), rank: section.rank },
			boost: -ITEMS.indexOf(item),
			apply: (view) => {
				// remove the typed "/…" before the block changes
				view.dispatch({ changes: { from, to: ctx.pos, insert: "" } });
				item.run(view, from);
			},
		});
	}
	return { from, options, filter: false };
}

export function pageOption(option: Option): Completion {
	return { icon: FileText, page: true, ...option } as Option;
}

const MENTION_HITS = 20;
const RECENT_MENTIONS = 12;

export function mentionCompletion(selfId?: string) {
	return (ctx: CompletionContext): CompletionResult | null => {
		if (ctx.state.readOnly) return null;
		const match = ctx.matchBefore(/(?:^|[\s(])@[^@\n[\]]{0,40}$/);
		if (!match) return null;
		const from = match.from + match.text.indexOf("@");
		const query = ctx.state.sliceDoc(from + 1, ctx.pos);
		if (!query && !ctx.explicit && ctx.state.sliceDoc(from - 1, from).trim()) return null;
		const hits = (
			query.trim()
				? repo.search(query, MENTION_HITS)
				: [...repo.live()].sort((a, b) => b.updated - a.updated).slice(0, RECENT_MENTIONS)
		).filter((hit) => hit.id !== selfId && hit.title);
		// a space after a word that finds nothing: it was no mention
		if (!hits.length && /\s/.test(query)) return null;
		return {
			from,
			filter: false,
			options: hits.map((hit, i) => {
				const ix = repo.index();
				const insert = `[[${linkInner(hit, ix)}]]`;
				return pageOption({
					label: hit.title,
					hint: kindHint(hit, ix),
					place: placeHint(hit, ix),
					boost: -i,
					apply: (view, _c, a, b) =>
						view.dispatch({
							changes: { from: a, to: b, insert },
							selection: EditorSelection.cursor(a + insert.length),
						}),
				});
			}),
		};
	};
}

export const slashRender = {
	position: 20,
	render(c: Completion): Node | null {
		const option = c as Option;
		if (!option.icon) return null;
		const row = document.createElement("div");
		row.className = `cm-slash${option.page ? " page" : ""}`;
		const tile = document.createElement("span");
		tile.className = "cm-slash-icon";
		tile.innerHTML = iconHTML(option.icon, option.page ? 15 : 18);
		const text = document.createElement("span");
		text.className = "cm-slash-text";
		const name = document.createElement("span");
		name.className = "cm-slash-name";
		name.textContent = option.label;
		text.append(name);
		if (option.hint) {
			const hint = document.createElement("span");
			hint.className = "cm-slash-hint";
			hint.textContent = option.hint;
			text.append(hint);
		}
		if (option.place) {
			// the path goes below the name and the type: two entries with one title differ there
			const place = document.createElement("span");
			place.className = "cm-slash-place";
			place.textContent = option.place;
			const lines = document.createElement("span");
			lines.className = "cm-slash-lines";
			lines.append(text, place);
			row.append(tile, lines);
			return row;
		}
		row.append(tile, text);
		return row;
	},
};
