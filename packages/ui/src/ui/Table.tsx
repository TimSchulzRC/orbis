import { fmtDate } from "@obtion/core/i18n";
import {
	type Item,
	type ItemInit,
	type PropDef,
	parseRange,
	propByName,
	type StatusGroup,
	type ViewTab,
} from "@obtion/core/model";
import {
	type EvalCtx,
	FIELDS,
	fieldOf,
	type Group,
	groupItems,
	pathBase,
	type QueryDef,
	viewTypeIds,
} from "@obtion/core/query";
import { firstOfGroup, statusProp } from "@obtion/core/traits";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Input } from "../components/ui/input";
import {
	Table as ShadcnTable,
	TableCell as ShadcnTableCell,
	TableBody,
	TableHead,
	TableHeader,
	TableRow,
} from "../components/ui/table";
import { itemHref, useIndex, useNarrow, useStoredSet } from "../hooks";
import { titleOf, useT } from "../i18n";
import { type DropZone, dropZone, startPointerDrag } from "../lib/drag";
import { cn, moveInArray } from "../lib/utils";
import { repo } from "../repo";
import { CellValue, defaultColumns } from "./cells";
import { notify } from "./feedback";
import { DateField, InlineText } from "./fields";
import { AreaChip, fieldLabel, GroupChip, HiddenGroups, hiddenPatch, splitHidden } from "./groups";
import { EmptyDash, ItemIcon } from "./item-look";
import { OptionSelect, PropertyField, RangeEditor } from "./Properties";
import { Button, IconButton, MenuItem, MoreMenu, Popover } from "./primitives";
import { PercentBar } from "./progress";
import { groupSetter, treeOrder } from "./Row";
import { KEYS } from "./storage";

/** What a view adds to the query when showing it: its tab (grouping options, widths) and how to save. */
export interface Look {
	key: string; // per-device state: folded groups, opened sub-items
	tab?: ViewTab;
	onLook?: (patch: Partial<ViewTab>) => void;
	/** "+ Task" in each group: new entries of this type (with the group's value). */
	add?: { type: string; init?: ItemInit };
}

/**
 * The row being dragged by its title: from which table (rows stay in theirs), from which group and
 * below which listed entry it is shown there.
 */
let rowDrag: { id: string; table: string; group: string; from?: string } | null = null;
/**
 * What shows where a dragged row lands, as in the sidebar: a line between two rows, a frame around
 * the row it goes into.
 */
const AIM: Record<DropZone, string> = {
	before: "[&>td]:shadow-[inset_0_2px_0_0_var(--focus)]",
	after: "[&>td]:shadow-[inset_0_-2px_0_0_var(--focus)]",
	inside: cn(
		"[&>td]:shadow-[inset_0_2px_0_0_var(--focus),inset_0_-2px_0_0_var(--focus)]",
		"[&>td:first-child]:shadow-[inset_2px_2px_0_0_var(--focus),inset_0_-2px_0_0_var(--focus)]",
		"[&>td:last-child]:shadow-[inset_-2px_2px_0_0_var(--focus),inset_0_-2px_0_0_var(--focus)]",
	),
};

/** Bounds for a column width dragged by its border. */
const MIN_WIDTH = 60;
const MAX_WIDTH = 800;

const WIDTH: Record<string, number> = {
	status: 150,
	select: 130,
	multiselect: 170,
	date: 130,
	range: 230,
	computed: 160,
	relation: 190,
	text: 220,
	number: 100,
	checkbox: 80,
	url: 180,
	item: 170,
	tags: 170,
};

/** A select is as wide as what it holds: one option or several. */
function widthKey(p: PropDef): string {
	if (p.kind === "date" && p.range) return "range";
	return p.kind === "select" && p.multiple ? "multiselect" : p.kind;
}

function defaultWidth(col: string, items: Item[], ctx: EvalCtx): number {
	if (col === "title") return 300;
	if (col === "area") return 130;
	if (col === "project") return 190;
	if (col === "tags") return WIDTH.tags!;
	if ((FIELDS as readonly string[]).includes(col)) return 120;
	for (const i of items.slice(0, 30)) {
		const hit = fieldOf(i, col, ctx.ix);
		if (hit?.prop) return WIDTH[widthKey(hit.prop)] ?? 160;
		if (hit) return WIDTH[hit.kind] ?? 160;
	}
	return 160;
}

/** A property's value if it is text. */
const textProp = (item: Item, id: string) =>
	typeof item.props[id] === "string" ? (item.props[id] as string) : undefined;

function RangeCell({ item, prop }: { item: Item; prop: PropDef }) {
	const { t, lang } = useT();
	const value = textProp(item, prop.id) ?? "";
	const { start, end } = parseRange(value);
	return (
		<Popover
			trigger={(p) => (
				<Button
					variant="plain"
					{...p}
					aria-label={t("props.set", { name: prop.name })}
					className="tap-y w-full truncate text-left tabular-nums hover:text-fg"
				>
					{start || end ? (
						`${start ? fmtDate(lang, start) : "…"} – ${end ? fmtDate(lang, end) : "…"}`
					) : (
						<span className="text-muted-foreground">{t("props.empty")}</span>
					)}
				</Button>
			)}
		>
			<RangeEditor
				autoFocus={!start}
				className="p-2 text-sm"
				onChange={(x) => repo.setProp(item.id, prop.id, x || null)}
				value={value}
			/>
		</Popover>
	);
}

/** Editable in place only where `col` is a property of the entry's type. */
export function TableCell({ item, col, ctx }: { item: Item; col: string; ctx: EvalCtx }) {
	const { t } = useT();
	const ix = ctx.ix;
	if (col === "area") {
		const area = ix.area(item.id);
		return area ? <AreaChip id={area} /> : <EmptyDash />;
	}
	if (col === "progress") {
		const progress = ix.progressOf(item);
		return progress ? <PercentBar done={progress.done} total={progress.total} /> : <EmptyDash />;
	}
	const hit = fieldOf(item, col, ix);
	const prop = hit?.prop;
	const own = prop && !hit.inverse && ix.schemaOf(item)?.properties.some((x) => x.id === prop.id);
	if (prop?.kind === "computed" && prop.computed?.fn !== "count") {
		const progress = ix.progress(item.id, prop.computed?.of);
		return <PercentBar done={progress.done} total={progress.total} />;
	}
	if (!own || !prop) return <CellValue ctx={ctx} item={item} name={col} />;
	switch (prop.kind) {
		case "status":
		case "select":
			if (prop.multiple)
				return (
					<span className="cell-tools flex min-w-0 items-center gap-1 overflow-hidden">
						<PropertyField item={item} prop={prop} />
					</span>
				);
			return <OptionSelect className="flex min-h-6 w-full" item={item} prop={prop} />;
		case "date":
			return prop.range ? (
				<RangeCell item={item} prop={prop} />
			) : (
				<span className="cell-tools block">
					<DateField
						label={prop.name}
						onChange={(x) => repo.setProp(item.id, prop.id, x || null)}
						value={textProp(item, prop.id)}
					/>
				</span>
			);
		case "text":
		case "url":
			return (
				<InlineText
					className="truncate"
					label={prop.name}
					onCommit={(x) => repo.setProp(item.id, prop.id, x.trim() || null)}
					placeholder={t("props.empty")}
					value={String(item.props[prop.id] ?? "")}
				/>
			);
		default:
			return (
				<span className="cell-tools flex min-w-0 items-center gap-1 overflow-hidden">
					<PropertyField item={item} prop={prop} />
				</span>
			);
	}
}

export function GroupedTable({
	items,
	def,
	ctx,
	look,
}: {
	items: Item[];
	def: QueryDef;
	ctx: EvalCtx;
	look?: Look;
}) {
	const { t } = useT();
	const ix = ctx.ix;
	const key = look?.key ?? "";
	const tab = look?.tab;
	const cols = def.columns?.length ? def.columns : defaultColumns(items, ctx);
	const typeIds = viewTypeIds(def.where, items, ix);
	const by = def.group;
	// empty groups show too (every type, every option) unless the view hides them
	const allGroups = () =>
		groupItems(
			items,
			by!,
			ctx,
			pathBase(def, ctx),
			tab?.hideEmpty ? undefined : { types: typeIds, where: def.where },
		).filter((g) => !tab?.hideEmpty || g.items.length);
	const all = by ? allGroups() : [{ key: "", items } as Group];
	const [groups, hiddenGroups] = by ? splitHidden(all, tab) : [all, []];
	// grouped by place with everything on this level: one table without a heading
	const heads = !!by && !(by === "path" && all.length === 1 && !all[0]!.key);
	const [folded, fold, setFolded] = useStoredSet(KEYS.fold(key));
	const [opened, open] = useStoredSet(KEYS.open(key));
	// widths: saved per view; while dragging a border only here
	const [live, setLive] = useState<Record<string, number>>({});
	const width = (c: string) => live[c] ?? tab?.widths?.[c] ?? defaultWidth(c, items, ctx);
	// on a phone the title column leaves room for the next one; the table scrolls sideways
	const narrow = useNarrow();
	const titleW = narrow ? Math.min(width("title"), 190) : width("title");
	// plus room for the empty last column: it draws the right edge of the frame around a drop target
	const total = titleW + cols.reduce((s, c) => s + width(c), 0) + 2;
	const label = (c: string) => {
		if ((FIELDS as readonly string[]).includes(c)) return t(`field.${c}`);
		if (c === "tags") return t("item.tags");
		for (const i of items) {
			const hit = fieldOf(i, c, ix);
			if (hit?.prop) return hit.prop.name;
			const free = Object.keys(i.extra).find((n) => n.toLowerCase() === c.toLowerCase());
			if (free) return free;
		}
		return c;
	};
	const byLabel = by ? fieldLabel(by, t, [{ key: by, label: label(by) }]) : "";
	const [dragCol, setDragCol] = useState<string | null>(null);
	// Rows are dragged by their title. On another row's middle: below that entry. Between two rows:
	// on their level, and there in the order – kept in the view, so only while it has no sort of
	// its own. Into another group: its value too. As in the sidebar, Alt adds a place instead of
	// moving.
	const tableId = useId();
	const [aim, setAim] = useState<{ id: string; zone: DropZone } | { group: string } | null>(null);
	const dragged = () => (rowDrag?.table === tableId ? rowDrag : null);
	/** The entry of this group the row is shown below (as `treeOrder` nests them). */
	const listedParent = (g: Group, id: string) => {
		const ids = new Set(g.items.map((x) => x.id));
		return ix.parentsOf(id).find((p) => ids.has(p));
	};
	/**
	 * The entry a drop on `target` goes below (none: the top level of the list). Below an open row
	 * with sub-items is the place of its first one.
	 */
	const landing = (g: Group, target: Item, zone: DropZone, hasOpenKids: boolean) =>
		zone === "inside" || (zone === "after" && hasOpenKids) ? target.id : listedParent(g, target.id);
	/** With Alt held, going below another entry adds that place and keeps the one it came from. */
	const dropRow = (
		g: Group,
		parent: string | undefined,
		zone: DropZone,
		target: Item,
		keep: boolean,
	) => {
		const d = dragged();
		rowDrag = null;
		setAim(null);
		const item = d && ix.get(d.id);
		if (!d || !item) return;
		if (parent !== d.from) {
			if (parent) {
				if (!(keep ? repo.addParent(d.id, parent) : repo.moveParent(d.id, d.from ?? null, parent)))
					return;
			} else if (d.from) repo.removeParent(d.id, d.from);
		}
		if (by && d.group !== g.key) groupSetter(item, by, g)?.();
		if (zone === "inside") return open(target.id, true);
		if (!look?.onLook) return;
		// a sorted view keeps its order: say so where the drop changed nothing else
		if (def.sort?.length)
			return void (parent === d.from && d.group === g.key && notify(t("table.sorted")));
		// the rows as they are shown (sub-items after their parent), without the dragged one
		const rows = new Map<string, number>();
		for (const gr of all)
			for (const o of treeOrder(gr.items))
				if (o.item.id !== d.id && !rows.has(o.item.id)) rows.set(o.item.id, o.depth);
		const order = [...rows.keys()];
		const depths = [...rows.values()];
		let at = order.indexOf(target.id);
		if (zone === "after") {
			at++;
			// after the row and everything below it – unless it lands there as the first sub-item
			if (parent !== target.id) while (at < order.length && depths[at]! > depths[at - 1]!) at++;
		}
		order.splice(at, 0, d.id);
		look.onLook({ order });
	};
	const resize = (c: string, e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const x0 = e.clientX;
		const w0 = width(c);
		let w = w0;
		startPointerDrag(
			(ev) => {
				w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w0 + ev.clientX - x0)));
				setLive((l) => ({ ...l, [c]: w }));
			},
			() => {
				if (w !== w0) look?.onLook?.({ widths: { ...(tab?.widths ?? {}), [c]: w } });
				setTimeout(
					() =>
						setLive((l) => {
							const { [c]: _, ...rest } = l;
							return rest;
						}),
					0,
				);
			},
		);
	};
	const sticky = "sticky left-0 z-[1] bg-bg";
	// the last, empty column takes the rest of the row, so a table with few columns still spans the page
	// (up to the right edge of the content: the wrapper reaches 0.5rem past it on both sides)
	const filler = "border-b border-l border-line p-0";
	const head = (
		<TableHeader>
			<TableRow className="text-left text-xs text-muted-foreground">
				<TableHead className={cn(sticky, "relative border-b border-line px-2 py-1.5 font-medium")}>
					{t("field.title")}
					{look?.onLook && <Resizer onPointerDown={(e) => resize("title", e)} />}
				</TableHead>
				{cols.map((c) => (
					<TableHead
						className="relative truncate whitespace-nowrap border-b border-l border-line px-2 py-1.5 font-medium"
						draggable={!!look?.onLook}
						key={c}
						onDragEnd={() => setDragCol(null)}
						onDragOver={(e) => dragCol && e.preventDefault()}
						onDragStart={() => setDragCol(c)}
						onDrop={() => {
							if (!dragCol || dragCol === c) return;
							const from = cols.indexOf(dragCol);
							const to = cols.indexOf(c);
							look?.onLook?.({ columns: moveInArray(cols, from, from < to ? to + 1 : to) });
						}}
					>
						{label(c)}
						{look?.onLook && <Resizer onPointerDown={(e) => resize(c, e)} />}
					</TableHead>
				))}
				<TableHead aria-hidden className={filler} />
			</TableRow>
		</TableHeader>
	);
	const colgroup = (
		<colgroup>
			<col style={{ width: titleW }} />
			{cols.map((c) => (
				<col key={c} style={{ width: width(c) }} />
			))}
			<col />
		</colgroup>
	);
	const rows = (g: Group) => {
		const order = treeOrder(g.items);
		const out: React.ReactNode[] = [];
		let hideBelow = Number.POSITIVE_INFINITY;
		order.forEach(({ item: i, depth }, n) => {
			if (depth > hideBelow) return;
			hideBelow = Number.POSITIVE_INFINITY;
			const kids = countKids(order, n);
			const isOpen = opened.has(i.id);
			if (kids && !isOpen) hideBelow = depth;
			const landingAt = (e: React.DragEvent) => {
				const d = dragged();
				if (!d || d.id === i.id) return;
				const box = e.currentTarget.getBoundingClientRect();
				const zone = dropZone(e.clientY - box.top, box.height);
				const parent = landing(g, i, zone, kids > 0 && isOpen);
				// not into itself or anything below it
				if (parent && ix.wouldCycle(d.id, parent)) return;
				return { zone, parent };
			};
			out.push(
				<TableRow
					className={cn(
						"group/row hover:bg-hover",
						aim && "id" in aim && aim.id === i.id && AIM[aim.zone],
					)}
					data-id={i.id}
					key={i.id}
					// from one cell to the next the row keeps its mark: only leaving the row clears it
					onDragLeave={(e) =>
						!e.currentTarget.contains(e.relatedTarget as Node | null) && setAim(null)
					}
					onDragOver={(e) => {
						const at = landingAt(e);
						if (!at) return;
						e.preventDefault();
						e.stopPropagation();
						setAim({ id: i.id, zone: at.zone });
					}}
					onDrop={(e) => {
						const at = landingAt(e);
						if (!at) return;
						e.preventDefault();
						e.stopPropagation();
						dropRow(g, at.parent, at.zone, i, e.altKey);
					}}
				>
					<ShadcnTableCell
						className={cn(
							sticky,
							"border-b border-line px-2 py-1 align-middle group-hover/row:bg-hover",
						)}
					>
						{/* biome-ignore lint/a11y/noStaticElementInteractions: dragging a row to another place; the page's places and its properties do the same by keyboard */}
						<span
							className="flex min-w-0 items-center gap-1"
							draggable
							onDragEnd={() => {
								rowDrag = null;
								setAim(null);
							}}
							onDragStart={(e) => {
								rowDrag = {
									id: i.id,
									table: tableId,
									group: g.key,
									from: listedParent(g, i.id),
								};
								e.dataTransfer.setData("text/plain", titleOf(i, t));
								e.dataTransfer.effectAllowed = "copyMove";
							}}
							style={{ paddingLeft: depth * 20 }}
						>
							{kids ? (
								<IconButton
									aria-expanded={isOpen}
									className="-ml-1 shrink-0 hover:bg-surface-2"
									icon={isOpen ? ChevronDown : ChevronRight}
									iconSize={14}
									label={t(isOpen ? "table.closeSub" : "table.openSub", { count: kids })}
									onClick={() => open(i.id, !isOpen)}
									size="xs"
								/>
							) : (
								depth > 0 && <span className="w-4 shrink-0" />
							)}
							<a
								className="flex min-w-0 items-center gap-2 hover:underline"
								draggable={false}
								href={itemHref(i.id)}
							>
								<ItemIcon className="shrink-0" item={i} size={14} />
								<span className="truncate font-medium">{titleOf(i, t)}</span>
							</a>
							{kids > 0 && !isOpen && (
								<span className="shrink-0 text-xs tabular-nums text-muted-foreground">{kids}</span>
							)}
						</span>
					</ShadcnTableCell>
					{cols.map((c) => (
						<ShadcnTableCell
							className="overflow-hidden border-b border-l border-line px-2 py-1 align-middle text-muted-foreground"
							key={c}
						>
							<TableCell col={c} ctx={ctx} item={i} />
						</ShadcnTableCell>
					))}
					<ShadcnTableCell aria-hidden className={filler} />
				</TableRow>,
			);
		});
		return out;
	};
	const addInit = (g: Group) => (look?.add ? groupInit(newInit(look.add), by, g, ix) : undefined);
	const allKeys = groups.map((g) => g.key);
	return (
		<div className="-mx-2 overflow-x-auto pb-2 text-sm">
			{groups.map((g) => {
				const isFolded = heads ? folded.has(g.key) : false;
				const init = addInit(g);
				return (
					<section
						aria-label={heads ? g.label || g.key || byLabel : undefined}
						className={cn(
							heads && "mb-5",
							aim && "group" in aim && aim.group === g.key && "rounded-lg ring-2 ring-focus",
						)}
						key={g.key || "_"}
						onDragLeave={(e) =>
							!e.currentTarget.contains(e.relatedTarget as Node | null) && setAim(null)
						}
						onDragOver={(e) => {
							const d = dragged();
							const item = d && ix.get(d.id);
							if (!by || !d || !item || d.group === g.key || !groupSetter(item, by, g)) return;
							e.preventDefault();
							setAim({ group: g.key });
						}}
						onDrop={(e) => {
							const d = dragged();
							const item = d && ix.get(d.id);
							rowDrag = null;
							setAim(null);
							if (!by || !d || !item || d.group === g.key) return;
							e.preventDefault();
							groupSetter(item, by, g)?.();
						}}
					>
						{heads && (
							<div className="group/head sticky left-0 flex w-fit max-w-full items-center gap-2 px-2 py-1.5">
								<IconButton
									aria-expanded={!isFolded}
									className="-ml-1"
									icon={isFolded ? ChevronRight : ChevronDown}
									iconSize={15}
									label={t(isFolded ? "table.unfold" : "table.fold")}
									onClick={() => fold(g.key, !isFolded)}
									size="xs"
								/>
								<GroupChip by={by} byLabel={byLabel} g={g} />
								<span className="text-xs tabular-nums text-muted-foreground">{g.items.length}</span>
								<span className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/head:opacity-100 pointer-coarse:opacity-100">
									<MoreMenu align="left" iconSize={15} label={t("table.groupMenu")} size="xs">
										{(close) => (
											<>
												{look?.onLook && (
													<MenuItem
														onClick={() => {
															close();
															look.onLook!(hiddenPatch(tab, g, true));
														}}
													>
														{t("view.hideGroup")}
													</MenuItem>
												)}
												<MenuItem
													onClick={() => {
														close();
														setFolded(allKeys.filter((k) => k !== g.key));
													}}
												>
													{t("table.foldOthers")}
												</MenuItem>
												<MenuItem
													onClick={() => {
														close();
														setFolded([]);
													}}
												>
													{t("table.unfoldAll")}
												</MenuItem>
												{look?.onLook && (
													<MenuItem
														active={!!tab?.hideEmpty}
														onClick={() => {
															close();
															look.onLook!({ hideEmpty: !tab?.hideEmpty || undefined });
														}}
													>
														{t("view.hideEmpty")}
													</MenuItem>
												)}
											</>
										)}
									</MoreMenu>
									{init && (
										<NewRowButton
											compact
											init={init}
											label={t("table.addIn", { name: ix.typeName(init.type ?? null) ?? "" })}
										/>
									)}
								</span>
							</div>
						)}
						{!isFolded && (
							<ShadcnTable
								className="table-fixed border-collapse"
								style={{ width: "calc(100% - 0.5rem)", minWidth: total }}
							>
								{colgroup}
								{head}
								<TableBody>{rows(g)}</TableBody>
							</ShadcnTable>
						)}
						{!isFolded && init && (
							<div className="sticky left-0 w-fit">
								<NewRowButton
									init={init}
									label={t("table.addIn", { name: ix.typeName(init.type ?? null) ?? "" })}
								/>
							</div>
						)}
					</section>
				);
			})}
			{by && (
				<HiddenGroups
					by={by}
					byLabel={byLabel}
					groups={hiddenGroups}
					onShow={look?.onLook ? (g) => look.onLook!(hiddenPatch(tab, g, false)) : undefined}
				/>
			)}
		</div>
	);
}

function Resizer({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
	return (
		<span
			aria-hidden
			className="absolute -right-1 top-0 z-[2] h-full w-2 cursor-col-resize touch-none hover:bg-focus/40"
			onDragStart={(e) => e.preventDefault()}
			onPointerDown={onPointerDown}
		/>
	);
}

/** Number of sub-items right after row n (deeper rows until one at the same depth or above). */
function countKids(order: { depth: number }[], n: number): number {
	const depth = order[n]!.depth;
	let count = 0;
	for (let m = n + 1; m < order.length && order[m]!.depth > depth; m++)
		if (order[m]!.depth === depth + 1) count++;
	return count;
}

/** What "+ New" starts from: the view's type and its fixed values. */
export function newInit(add: NonNullable<Look["add"]>): ItemInit {
	return { ...add.init, type: add.type, props: { ...(add.init?.props ?? {}) } };
}

/** The entry `init` with the value of group g set, so a new entry lands in that group. */
export function groupInit(init: ItemInit, by: string | undefined, g: Group, ix: EvalCtx["ix"]) {
	if (!by || !g.key) return init;
	const out: ItemInit = { ...init, props: { ...init.props } };
	const schema = ix.types.get(out.type ?? "")?.schema;
	if (by === "status" && g.option) out.props![statusProp(schema)?.id ?? ""] = g.option.id;
	else if (by === "statusGroup") {
		const option = firstOfGroup(schema, g.key as StatusGroup);
		if (option) out.props![statusProp(schema)!.id] = option.id;
	} else if (by === "type") out.type = g.key;
	else if (by === "path" && g.path?.length) out.parents = [g.path.at(-1)!];
	else if (g.option) {
		const prop = propByName(schema, by);
		if (prop) out.props![prop.id] = prop.multiple ? [g.option.id] : g.option.id;
	} else if (g.ref && (by === "project" || by === "area")) out.parents = [g.ref];
	else if (g.ref) {
		const prop = propByName(schema, by, (x) => x.kind === "relation");
		if (prop) out.rels = { ...out.rels, [prop.id]: [g.ref] };
	}
	return out;
}

/** Nothing is created before there is a title. */
export function NewRowButton({
	init,
	label,
	compact,
	card,
}: {
	init: ItemInit;
	label: string;
	compact?: boolean;
	/** At the foot of a board column: as wide as the cards. */
	card?: boolean;
}) {
	const { t } = useT();
	const ix = useIndex();
	const aria = t("view.new", { name: ix.typeName(init.type ?? null) ?? "" });
	const [typing, setTyping] = useState(false);
	const [title, setTitle] = useState("");
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => void (typing && ref.current?.focus()), [typing]);
	const create = () => {
		const trimmed = title.trim();
		if (trimmed) repo.create({ ...init, title: trimmed });
		setTitle("");
		return !!trimmed;
	};
	if (typing)
		return (
			<Input
				aria-label={aria}
				className={compact ? "w-48" : card ? "w-full" : "ml-2 mt-1 w-72"}
				onBlur={() => {
					create();
					setTyping(false);
				}}
				onChange={(e) => setTitle(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") create(); // and the next one
					if (e.key === "Escape") {
						setTitle("");
						setTyping(false);
					}
				}}
				placeholder={t("table.newTitle")}
				ref={ref}
				value={title}
				variant="sm"
			/>
		);
	return compact ? (
		<IconButton icon={Plus} iconSize={15} label={aria} onClick={() => setTyping(true)} size="xs" />
	) : (
		<Button
			aria-label={aria}
			className={cn(
				"tap-y flex items-center gap-1.5 px-2 py-1.5 text-sm text-muted-foreground hover:text-fg",
				card && "w-full rounded-lg hover:bg-hover",
			)}
			onClick={() => setTyping(true)}
			variant="plain"
		>
			<Plus size={14} /> {label}
		</Button>
	);
}
