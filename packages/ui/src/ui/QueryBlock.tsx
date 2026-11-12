// Live query blocks inside a text: ```query … ``` is stored as JSON with ids and shown
// as its results. Text-form blocks (typed by hand or by an agent) are normalised to JSON.

import {
	type EditorState,
	type Extension,
	RangeSetBuilder,
	StateEffect,
	StateField,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	WidgetType,
} from "@codemirror/view";
import { sameValue } from "@obtion/core/equal";
import { MAIN_TAB, shortId, singleTab, type ViewTab } from "@obtion/core/model";
import {
	andWhere,
	blockSource,
	findBlocks,
	type QueryDef,
	queryFence,
	readBlock,
	runQuery,
} from "@obtion/core/query";
import { cmpKey, keyBetween } from "@obtion/core/sortkey";
import { ArrowUpDown, EyeOff, Funnel, Heading, MoreHorizontal, Rows3, Trash2 } from "lucide-react";
import { StrictMode, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useIndex } from "../hooks";
import { useT } from "../i18n";
import { cn } from "../lib/utils";
import { repo } from "../repo";
import { InlineText } from "./fields";
import { viewGroups } from "./groups";
import { DraftBar, IconButton, InCard, MenuItem, Popover } from "./primitives";
import { QueryEditor } from "./QueryEditor";
import { defaultColumns, Results, useQuery } from "./Results";
import {
	type TabEdit,
	tabName,
	useTabChoice,
	useViewFields,
	ViewSettings,
	ViewTabs,
} from "./Views";

/** A block's views: its tabs, or its one look as the only tab. */
function blockTabs(def: QueryDef): ViewTab[] {
	if (def.tabs && def.tabs.length > 1) return def.tabs;
	return [
		{
			...singleTab({ display: def.view, sort: def.sort, group: def.group, columns: def.columns }),
			...(def.tabs?.[0]
				? { widths: def.tabs[0].widths, name: def.tabs[0].name, order: def.tabs[0].order }
				: {}),
		},
	];
}

/** The block's own look ("main") turns into a tab with an id of its own once there are several. */
function promoteMainTab(tabs: ViewTab[]): ViewTab[] {
	return tabs.map((x, i) => (i === 0 && x.id === MAIN_TAB ? { ...x, id: shortId("v") } : x));
}

function QueryBlockView({
	src,
	thisId,
	n = 0,
	onChange,
	onDelete,
	readOnly,
}: {
	src: string;
	thisId?: string;
	n?: number;
	onChange?: (def: QueryDef) => void;
	onDelete?: () => void;
	readOnly?: boolean;
}) {
	const ix = useIndex();
	const { t } = useT();
	const { def: stored } = readBlock(src, ix);
	// the tools beside the tabs open one popover at a time; a new block starts with its filter
	const [panel, setPanel] = useState<"filter" | "sort" | "group" | "more" | null>(
		!stored.where && !readOnly ? "filter" : null,
	);
	const [addingTitle, setAddingTitle] = useState(false);
	// the conditions are a draft until "Save" or until the filter closes: trying a filter
	// changes nothing. Title, view and "hide when empty" apply at once, like everywhere.
	type Draft = { scope: string; where: QueryDef["where"] } | null; // scope: "base" or a tab id
	const [draft, setDraftState] = useState<Draft>(null);
	// the latest draft at once: closing the filter commits typed text and saves in one go
	const draftRef = useRef<Draft>(null);
	const setDraft = (d: Draft) => {
		draftRef.current = d;
		setDraftState(d);
	};
	const tabs = blockTabs(stored);
	const [tab, pickTab] = useTabChoice(`block:${thisId}:${n}`, tabs);
	const baseWhere = draft?.scope === "base" ? draft.where : stored.where;
	const tabWhere = draft?.scope === tab.id ? draft.where : tab.where;
	const def: QueryDef = { ...stored, where: baseWhere };
	const savedWhere = draft
		? draft.scope === "base"
			? stored.where
			: tabs.find((x) => x.id === draft.scope)?.where
		: undefined;
	const dirty = !!draft && !sameValue(draft.where, savedWhere);
	/** Write the views: several as tabs, a single one as the block's own look (its filter joins the query). */
	const writeTabs = (next: ViewTab[], base: QueryDef = stored) => {
		const first = next[0]!;
		const { tabs: _, ...rest } = base;
		const one = next.length === 1;
		onChange?.({
			...rest,
			where: one ? andWhere(base.where, first.where) : base.where,
			view: first.kind,
			sort: first.sort,
			group: first.group,
			columns: first.columns,
			tabs: one
				? first.widths || first.name || first.order
					? [{ ...first, where: undefined }]
					: undefined
				: next,
		});
	};
	const clean = (x: ViewTab) =>
		Object.fromEntries(
			Object.entries(x).filter(
				([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length),
			),
		) as unknown as ViewTab;
	const patchTab = (id: string, patch: Partial<ViewTab>) =>
		writeTabs(tabs.map((x) => (x.id === id ? clean({ ...x, ...patch }) : x)));
	const edit = (d: QueryDef) => {
		const { where: _w, ...look } = d;
		const { where: _s, ...was } = stored;
		if (!sameValue(look, was)) onChange?.({ ...look, where: stored.where });
	};
	const save = () => {
		const d = draftRef.current;
		const saved =
			d && (d.scope === "base" ? stored.where : tabs.find((x) => x.id === d.scope)?.where);
		if (d && onChange && !sameValue(d.where, saved)) {
			if (d.scope === "base") onChange({ ...stored, where: d.where });
			else patchTab(d.scope, { where: d.where });
		}
		setDraft(null);
	};
	const tabEdit: TabEdit = {
		add: (kind) => {
			const id = shortId("v");
			// the first time: the block's own look becomes the first tab
			const base = promoteMainTab(tabs);
			writeTabs([
				...base,
				{
					id,
					pos: keyBetween(base.at(-1)?.pos ?? null, null),
					kind,
					...(kind === "board" ? { group: "status" } : {}),
				},
			]);
			pickTab(id);
		},
		rename: (id, name) => patchTab(id, { name: name || undefined }),
		duplicate: (id) => {
			const original = tabs.find((x) => x.id === id)!;
			const i = tabs.indexOf(original);
			const copyId = shortId("v");
			const copy = {
				...original,
				id: copyId,
				name: t("view.copyName", { name: tabName(original, t) }),
				pos: keyBetween(original.pos, tabs[i + 1]?.pos ?? null),
			};
			writeTabs(promoteMainTab([...tabs.slice(0, i + 1), copy, ...tabs.slice(i + 1)]));
			pickTab(copyId);
		},
		remove: (id) => writeTabs(tabs.filter((x) => x.id !== id)),
		move: (id, pos) =>
			writeTabs(
				tabs.map((x) => (x.id === id ? { ...x, pos } : x)).sort((a, b) => cmpKey(a.pos, b.pos)),
			),
		settings: () => setPanel("more"),
	};
	const eff: QueryDef = {
		...def,
		where: andWhere(def.where, tabWhere),
		view: tab.kind,
		sort: tab.sort,
		order: tab.order,
		group: tab.group,
		columns: tab.columns,
	};
	const { items, ctx } = useQuery(eff, thisId);
	const fields = useViewFields(def.where, items);
	if (def.hideEmpty && !items.length && !panel) return <div className="h-0" />;
	const editable = !!onChange && !readOnly;
	/** Opening one tool closes the others; closing the filter keeps what was typed. */
	const openPanel = (next: typeof panel) => {
		if (panel === "filter" && next !== "filter") {
			// the text form commits on blur, which would come after the popover is gone
			const focused = document.activeElement;
			if (focused instanceof HTMLElement && focused.closest("[data-popover]")) focused.blur();
			save();
		}
		setPanel(next);
	};
	const settingsFor = (part: "sort" | "group" | "more") => (
		<ViewSettings
			columns={tab.kind === "table" ? defaultColumns(items, ctx) : undefined}
			fields={fields}
			groups={viewGroups(items, eff, ctx)}
			onLook={(p) => patchTab(tab.id, p)}
			part={part}
			tab={{ ...tab, where: tabWhere }}
		/>
	);
	const hasMore =
		tab.kind === "table" ||
		tab.kind === "board" ||
		tab.kind === "calendar" ||
		tab.kind === "timeline";
	const tool = (
		key: "filter" | "sort" | "group",
		icon: typeof Funnel,
		label: string,
		active: boolean,
		body: React.ReactNode,
		wide?: boolean,
	) => (
		<Popover
			align="right"
			onOpenChange={(o) => openPanel(o ? key : null)}
			open={panel === key}
			trigger={(p) => (
				<IconButton
					{...p}
					className={cn(active && "text-fg")}
					icon={icon}
					iconSize={15}
					label={label}
					size="sm"
				/>
			)}
		>
			{wide ? <div className="w-[min(26rem,85vw)] p-2 text-sm">{body}</div> : body}
		</Popover>
	);
	const toolbar = editable && (
		<div className="flex items-center gap-0.5">
			{tool(
				"filter",
				Funnel,
				t("block.filter"),
				!!stored.where,
				<div className="space-y-3">
					<QueryEditor
						autoFocus={!stored.where}
						context
						def={{ where: baseWhere }}
						fields={fields}
						onChange={(d) =>
							!sameValue(d.where, baseWhere) && setDraft({ scope: "base", where: d.where })
						}
					/>
					{tabs.length > 1 && (
						<div>
							<p className="mb-1 text-xs text-muted-foreground">{t("block.filterTab")}</p>
							<QueryEditor
								def={{ where: tabWhere }}
								fields={fields}
								onChange={(d) =>
									!sameValue(d.where, tabWhere) && setDraft({ scope: tab.id, where: d.where })
								}
							/>
						</div>
					)}
					{dirty && <DraftBar onDiscard={() => setDraft(null)} onSave={save} />}
				</div>,
				true,
			)}
			{tab.kind !== "triage" &&
				tool("sort", ArrowUpDown, t("view.sort"), !!tab.sort?.length, settingsFor("sort"))}
			{tab.kind !== "triage" &&
				tab.kind !== "calendar" &&
				tool("group", Rows3, t("view.groupBy"), !!tab.group, settingsFor("group"))}
			<Popover
				align="right"
				onOpenChange={(o) => openPanel(o ? "more" : null)}
				open={panel === "more"}
				trigger={(p) => (
					<IconButton {...p} icon={MoreHorizontal} iconSize={15} label={t("more")} size="sm" />
				)}
			>
				{(close) => (
					<div className="min-w-56">
						{hasMore && <div className="mb-1 border-b border-line pb-1">{settingsFor("more")}</div>}
						{!def.title && (
							<MenuItem
								icon={<Heading size={14} />}
								onClick={() => {
									close();
									setAddingTitle(true);
								}}
							>
								{t("block.addTitle")}
							</MenuItem>
						)}
						<MenuItem
							active={!!def.hideEmpty}
							icon={<EyeOff size={14} />}
							onClick={() => edit({ ...stored, hideEmpty: !def.hideEmpty || undefined })}
						>
							{t("block.hideEmpty")}
						</MenuItem>
						<MenuItem
							danger
							icon={<Trash2 size={14} />}
							onClick={() => {
								close();
								onDelete?.();
							}}
						>
							{t("block.delete")}
						</MenuItem>
					</div>
				)}
			</Popover>
		</div>
	);
	const setTitle = (v: string) => {
		setAddingTitle(false);
		if ((v.trim() || undefined) !== def.title) edit({ ...stored, title: v.trim() || undefined });
	};
	const showTitle = !!def.title || addingTitle;
	const title = (
		<>
			{editable ? (
				<InlineText
					autoFocus={addingTitle}
					className="w-auto min-w-0 max-w-full truncate text-[16px] font-semibold leading-[22px] [field-sizing:content]"
					label={t("block.heading")}
					onCommit={setTitle}
					placeholder={t("block.title")}
					value={def.title ?? ""}
				/>
			) : (
				<h2 className="min-w-0 truncate text-[16px] font-semibold leading-[22px] text-fg">
					{def.title}
				</h2>
			)}
			{!!items.length && (
				<span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">
					{items.length}
				</span>
			)}
		</>
	);
	return (
		// a card of its own in the text: what it shows comes from elsewhere. Padding, not margin,
		// around it: CodeMirror leaves a block widget's margins out of its heights
		<div className="py-3" contentEditable={false}>
			<div className="relative rounded-xl border border-line bg-surface">
				<div className="px-4 pb-3 pt-1 max-sm:px-3">
					<InCard.Provider value>
						{/* the title shares the tabs' line and stays put while they scroll */}
						<div data-handle-anchor="">
							<ViewTabs
								active={tab.id}
								edit={editable ? tabEdit : undefined}
								left={showTitle && title}
								onPick={pickTab}
								right={toolbar}
								tabs={tabs}
							/>
						</div>
						{/* a new block shows nothing until it has a condition (not "everything") */}
						{!def.where ? (
							<p className="py-1 text-sm text-muted-foreground">{t("query.start")}</p>
						) : (
							<Results
								def={eff}
								empty={
									<p className="px-0 py-1 text-sm text-muted-foreground">
										{def.where && "inbox" in def.where ? t("inbox.emptyShort") : t("query.empty")}
									</p>
								}
								keyPrefix={`block:${thisId}`}
								look={{
									key: `block:${thisId}:${n}:${tab.id}`,
									tab,
									onLook: editable ? (p) => patchTab(tab.id, p) : undefined,
								}}
								thisId={thisId}
							/>
						)}
					</InCard.Provider>
				</div>
			</div>
		</div>
	);
}

/** The `n`th query block in the editor's current text. */
const blockAt = (view: EditorView, n: number) => findBlocks(view.state.doc.toString())[n];

/** Kept per element so a changed block keeps its React root in updateDOM. */
const roots = new WeakMap<HTMLElement, Root>();

class BlockWidget extends WidgetType {
	root?: Root;
	constructor(
		readonly src: string,
		readonly n: number,
		readonly thisId?: string,
	) {
		super();
	}
	override eq(o: BlockWidget) {
		return o.src === this.src && o.n === this.n;
	}
	toDOM(view: EditorView) {
		const el = document.createElement("div");
		el.className = "cm-queryblock";
		this.root = createRoot(el);
		roots.set(el, this.root);
		this.mount(view);
		return el;
	}
	/** A changed block keeps its element and React state (editing, chosen tab): only new props. */
	override updateDOM(dom: HTMLElement, view: EditorView) {
		const root = roots.get(dom);
		if (!root) return false;
		this.root = root;
		this.mount(view);
		return true;
	}
	mount(view: EditorView) {
		const replace = (text: string) => {
			const block = blockAt(view, this.n);
			if (block) view.dispatch({ changes: { from: block.from, to: block.to, insert: text } });
		};
		const { wasText, def } = readBlock(this.src, repo.index());
		if (wasText) queueMicrotask(() => replace(queryFence(blockSource(def))));
		this.root!.render(
			<StrictMode>
				<QueryBlockView
					n={this.n}
					onChange={(d) => replace(queryFence(blockSource(d)))}
					onDelete={() => {
						const block = blockAt(view, this.n);
						if (block)
							view.dispatch({
								changes: {
									from: block.from,
									to: Math.min(view.state.doc.length, block.to + 1),
									insert: "",
								},
							});
					}}
					src={this.src}
					thisId={this.thisId}
				/>
			</StrictMode>,
		);
	}
	override destroy() {
		const root = this.root;
		setTimeout(() => root?.unmount());
	}
	override ignoreEvent() {
		return true;
	}
}

function decos(state: EditorState, thisId?: string): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	findBlocks(state.doc.toString()).forEach((blk, n) => {
		builder.add(
			blk.from,
			blk.to,
			Decoration.replace({ widget: new BlockWidget(blk.src, n, thisId), block: true }),
		);
	});
	return builder.finish();
}

// A heading whose section holds only query blocks that hide when empty disappears with them
// when none of them has results ("Recently done" on a quiet week). It comes back as soon
// as one of them finds something.

const refresh = StateEffect.define<null>();

/** The level of a Markdown heading line (1–6), or undefined. */
const headingLevel = (text: string) => /^(#{1,6})\s/.exec(text)?.[1]?.length;

function emptySections(state: EditorState, thisId?: string): DecorationSet {
	const text = state.doc.toString();
	const blocks = findBlocks(text);
	const builder = new RangeSetBuilder<Decoration>();
	if (!blocks.some((x) => x.src.includes('"hideEmpty":true'))) return builder.finish();
	const ix = repo.index();
	const empty = (src: string) => {
		const { def } = readBlock(src, ix);
		return !!def.hideEmpty && runQuery(def, { ix, thisId }).total === 0;
	};
	const doc = state.doc;
	for (let n = 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		const level = headingLevel(line.text);
		if (!level) continue;
		// the section: blank lines and blocks up to the next heading of this level or higher
		let pos = line.to + 1;
		let inSection = 0;
		let allEmpty = true;
		let end = line.to;
		while (pos <= doc.length) {
			const blk = blocks.find((x) => x.from === pos);
			if (blk) {
				inSection++;
				if (!empty(blk.src)) allEmpty = false;
				end = blk.to;
				pos = blk.to + 1;
				continue;
			}
			const next = doc.lineAt(pos);
			const nextLevel = headingLevel(next.text);
			if (nextLevel && nextLevel <= level) break;
			if (next.text.trim()) {
				allEmpty = false; // the section has text of its own
				break;
			}
			pos = next.to + 1;
		}
		if (!inSection || !allEmpty) continue;
		// hide the heading and the blank lines that belong to it (the blocks hide themselves)
		let from = line.from;
		while (from > 0) {
			const prev = doc.lineAt(from - 1);
			if (prev.text.trim()) break;
			from = prev.from;
		}
		const firstBlock = blocks.find((x) => x.from > line.to && x.to <= end)!;
		const to = Math.max(line.to, firstBlock.from - 1);
		if (from < to) builder.add(from, to, Decoration.replace({ block: true }));
	}
	return builder.finish();
}

export function queryBlocks(thisId?: string): Extension {
	const field = StateField.define<DecorationSet>({
		create: (s) => decos(s, thisId),
		update: (d, tr) => (tr.docChanged ? decos(tr.state, thisId) : d),
		provide: (f) => [
			EditorView.decorations.from(f),
			EditorView.atomicRanges.of((v) => v.state.field(f)),
		],
	});
	const sections = StateField.define<DecorationSet>({
		create: (s) => emptySections(s, thisId),
		update: (d, tr) =>
			tr.docChanged || tr.effects.some((e) => e.is(refresh)) ? emptySections(tr.state, thisId) : d,
		provide: (f) => [
			EditorView.decorations.from(f),
			EditorView.atomicRanges.of((v) => v.state.field(f)),
		],
	});
	// data changed (not the text): check again whether the sections are still empty
	const watch = ViewPlugin.define((view) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const off = repo.subscribe(() => {
			clearTimeout(timer);
			timer = setTimeout(() => view.dispatch({ effects: refresh.of(null) }), 50);
		});
		return {
			destroy: () => {
				clearTimeout(timer);
				off();
			},
		};
	});
	return [field, sections, watch];
}

/** The new block opens in edit mode. */
export function insertQueryBlock(view: EditorView, def: QueryDef = {}) {
	const pos = view.state.selection.main.head;
	const line = view.state.doc.lineAt(pos);
	const at = line.length ? line.to : pos;
	const text = `${(line.length ? "\n" : "") + queryFence(blockSource(def))}\n`;
	view.dispatch({ changes: { from: at, insert: text } });
}
