// View tabs, shared by a type's page and query blocks. A tab's filter is added to the query.

import type { T } from "@obtion/core/i18n";
import { titleKey, type ViewKind, type ViewTab } from "@obtion/core/model";
import { type Group, groupId, orderGroups } from "@obtion/core/query";
import { keyBetween } from "@obtion/core/sortkey";
import { statusProp } from "@obtion/core/traits";
import {
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	CalendarDays,
	ChartGantt,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Copy,
	Eye,
	EyeOff,
	GripVertical,
	LayoutGrid,
	List,
	ListChecks,
	ListTree,
	Plus,
	Rows3,
	SlidersHorizontal,
	SquareKanban,
	Table2,
	Trash2,
	X,
} from "lucide-react";
import { useContext, useState } from "react";
import { setParams, useIndex, useLocalStorage, useRoute } from "../hooks";
import { useT } from "../i18n";
import { cn, moveInArray } from "../lib/utils";
import { InlineText } from "./fields";
import { fieldLabel, GroupChip } from "./groups";
import { Button, IconButton, InCard, MenuItem, Popover } from "./primitives";
import { KEYS } from "./storage";
import { FieldIcon, type ViewField } from "./view-fields";

export { useViewFields } from "./view-fields";

const TAB_KINDS: ViewKind[] = [
	"table",
	"board",
	"timeline",
	"calendar",
	"list",
	"gallery",
	"triage",
];
const KIND_ICON: Record<ViewKind, React.ComponentType<{ size?: number; className?: string }>> = {
	table: Table2,
	board: SquareKanban,
	list: List,
	tree: ListTree,
	gallery: LayoutGrid,
	triage: ListChecks,
	calendar: CalendarDays,
	timeline: ChartGantt,
};

export const tabName = (tab: Pick<ViewTab, "name" | "kind">, t: T) =>
	tab.name || t(`view.${tab.kind}`);

/** Remembered per device. `inAddress`: also in "?view=<tab>", so a shared link shows the same tab. */
export function useTabChoice(
	key: string,
	tabs: ViewTab[],
	inAddress?: boolean,
): [ViewTab, (id: string) => void] {
	const named = useRoute().query.get("view");
	const [id, setId] = useLocalStorage<string | null>(KEYS.tab(key), null);
	const tab =
		(inAddress && named ? tabs.find((x) => x.id === named) : undefined) ??
		tabs.find((x) => x.id === id) ??
		tabs[0]!;
	return [
		tab,
		(x) => {
			setId(x);
			if (inAddress) setParams({ view: x });
		},
	];
}

export interface TabEdit {
	add: (kind: ViewKind) => void;
	rename: (id: string, name: string) => void;
	duplicate: (id: string) => void;
	remove: (id: string) => void;
	move: (id: string, pos: string) => void;
	settings: () => void;
}

/** A click on the shown tab, or a right click on any tab, opens its menu. `left` stays put while the tabs scroll. */
export function ViewTabs({
	tabs,
	active,
	onPick,
	edit,
	left,
	right,
}: {
	tabs: ViewTab[];
	active: string;
	onPick: (id: string) => void;
	edit?: TabEdit;
	left?: React.ReactNode;
	right?: React.ReactNode;
}) {
	const { t } = useT();
	const inCard = useContext(InCard);
	const [menu, setMenu] = useState<string | null>(null);
	// a right click: the menu opens there. Kept while it fades out, else it jumps below the tab
	const [point, setPoint] = useState<{ id: string; x: number; y: number } | null>(null);
	const [drag, setDrag] = useState<string | null>(null);
	const [over, setOver] = useState<string | null>(null);
	const drop = (target: string) => {
		if (!edit || !drag || drag === target) return;
		const rest = tabs.filter((x) => x.id !== drag);
		const at = rest.findIndex((x) => x.id === target);
		const from = tabs.findIndex((x) => x.id === drag);
		const to = tabs.findIndex((x) => x.id === target);
		// dropped on a tab: it goes to that tab's place (before it when coming from the right)
		const before = from > to ? rest[at] : rest[at + 1];
		const after = from > to ? rest[at - 1] : rest[at];
		edit.move(drag, keyBetween(after?.pos ?? null, before?.pos ?? null));
	};
	const step = (id: string, direction: -1 | 1) => {
		const n = tabs.findIndex((x) => x.id === id);
		const after = direction < 0 ? tabs[n - 2] : tabs[n + 1];
		const before = direction < 0 ? tabs[n - 1] : tabs[n + 2];
		edit?.move(id, keyBetween(after?.pos ?? null, before?.pos ?? null));
	};
	return (
		<div className="mb-3 flex items-end gap-2 border-b border-line">
			{left && (
				<div className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-2 self-stretch py-1 pr-1">
					{left}
					<span aria-hidden className="ml-1 h-4 w-px shrink-0 bg-line" />
				</div>
			)}
			<div
				aria-label={t("view.tabs")}
				className="-mb-px flex min-w-0 flex-1 items-end overflow-x-auto [scrollbar-width:none]"
				role="tablist"
			>
				{tabs.map((tab, n) => {
					const Icon = KIND_ICON[tab.kind] ?? List;
					const on = tab.id === active;
					return (
						<Popover
							key={tab.id}
							onOpenChange={(o) => setMenu(o ? tab.id : null)}
							open={menu === tab.id}
							point={point?.id === tab.id ? point : null}
							trigger={(p) => (
								<Button
									aria-expanded={on && edit ? p["aria-expanded"] : undefined}
									aria-haspopup={on && edit ? "menu" : undefined}
									aria-selected={on}
									className={cn(
										"tap-y flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-2 text-sm",
										n === 0 && inCard && !left && "pl-0", // in a card the first tab starts on the heading's line
										on
											? "border-[var(--text)] font-medium text-fg"
											: "border-transparent text-muted-foreground hover:text-fg",
										over === tab.id && "bg-hover",
									)}
									draggable={!!edit}
									onClick={() => {
										if (!on) onPick(tab.id);
										else if (edit) {
											setPoint(null);
											p.onClick();
										}
									}}
									onContextMenu={
										edit &&
										((e) => {
											e.preventDefault();
											setPoint({ id: tab.id, x: e.clientX, y: e.clientY });
											setMenu(tab.id);
										})
									}
									onDragEnd={() => {
										setDrag(null);
										setOver(null);
									}}
									onDragLeave={() => setOver(null)}
									onDragOver={(e) => {
										if (!drag) return;
										e.preventDefault();
										setOver(tab.id);
									}}
									onDragStart={(e) => {
										e.dataTransfer.setData("obtion/tab", tab.id);
										setDrag(tab.id);
									}}
									onDrop={(e) => {
										e.preventDefault();
										drop(tab.id);
										setDrag(null);
										setOver(null);
									}}
									role="tab"
									variant="plain"
								>
									<Icon className="shrink-0" size={14} />
									{tabName(tab, t)}
								</Button>
							)}
						>
							{(close) => (
								<div className="w-60">
									<div className="px-1.5 pb-1 pt-0.5">
										<InlineText
											className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
											label={t("view.rename")}
											onCommit={(v) => edit!.rename(tab.id, v.trim())}
											placeholder={t(`view.${tab.kind}`)}
											value={tab.name ?? ""}
										/>
									</div>
									<MenuItem
										icon={<SlidersHorizontal size={14} />}
										onClick={() => {
											close();
											if (!on) onPick(tab.id);
											edit!.settings();
										}}
									>
										{t("view.settings")}
									</MenuItem>
									<MenuItem
										icon={<Copy size={14} />}
										onClick={() => {
											close();
											edit!.duplicate(tab.id);
										}}
									>
										{t("view.duplicate")}
									</MenuItem>
									{n > 0 && (
										<MenuItem icon={<ChevronLeft size={14} />} onClick={() => step(tab.id, -1)}>
											{t("view.moveLeft")}
										</MenuItem>
									)}
									{n < tabs.length - 1 && (
										<MenuItem icon={<ChevronRight size={14} />} onClick={() => step(tab.id, 1)}>
											{t("view.moveRight")}
										</MenuItem>
									)}
									{tabs.length > 1 && (
										<MenuItem
											danger
											icon={<Trash2 size={14} />}
											onClick={() => {
												close();
												edit!.remove(tab.id);
											}}
										>
											{t("view.remove")}
										</MenuItem>
									)}
								</div>
							)}
						</Popover>
					);
				})}
				{edit && (
					<Popover
						trigger={(p) => (
							<Button
								variant="plain"
								{...p}
								aria-label={t("view.add")}
								className="tap mb-1 ml-0.5 shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-hover hover:text-fg"
								title={t("view.add")}
							>
								<Plus size={15} />
							</Button>
						)}
					>
						{(close) =>
							TAB_KINDS.map((k) => {
								const Icon = KIND_ICON[k];
								return (
									<MenuItem
										icon={<Icon size={14} />}
										key={k}
										onClick={() => {
											close();
											edit.add(k);
										}}
									>
										{t(`view.${k}`)}
									</MenuItem>
								);
							})
						}
					</Popover>
				)}
			</div>
			{right && <div className="mb-1 flex shrink-0 items-center gap-1.5">{right}</div>}
		</div>
	);
}

/** What the built-in keys of sorting and grouping hold, for their icon. */
const BUILTIN_KIND: Record<string, ViewField["kind"]> = {
	status: "status",
	statusGroup: "status",
	title: "text",
	type: "select",
	due: "date",
	done: "date",
	created: "builtin-date",
	updated: "builtin-date",
};

type Part = "layout" | "props" | "sort" | "group" | "sub" | "date";

/** A line of the view's menu that leads on: what it sets and what is set now. */
function MenuRow({
	icon: Icon,
	label,
	value,
	onClick,
}: {
	icon: React.ComponentType<{ size?: number; className?: string }>;
	label: string;
	value?: string;
	onClick: () => void;
}) {
	return (
		<Button
			className="tap-row flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover"
			onClick={onClick}
			variant="plain"
		>
			<Icon className="shrink-0 text-muted-foreground" size={15} />
			<span className="min-w-0 flex-1 truncate">{label}</span>
			<span className="max-w-28 truncate text-muted-foreground">{value}</span>
			<ChevronRight className="shrink-0 text-muted-foreground" size={14} />
		</Button>
	);
}

/** A row that is switched on or off by its eye, as in the lists of properties and groups. */
function EyeRow({
	on,
	label,
	children,
	onToggle,
	...drag
}: {
	on: boolean;
	label: string;
	children: React.ReactNode;
	onToggle: () => void;
} & Pick<React.ComponentProps<"li">, "draggable" | "onDragStart" | "onDragOver" | "onDrop">) {
	return (
		<li
			className={cn(
				"flex items-center gap-2 rounded-lg py-1 pl-1 pr-1 text-sm hover:bg-hover",
				!on && "text-muted-foreground",
			)}
			{...drag}
		>
			<GripVertical
				aria-hidden
				className={cn("shrink-0 text-faint", drag.draggable ? "cursor-grab" : "invisible")}
				size={13}
			/>
			<span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
			<IconButton
				aria-pressed={on}
				icon={on ? Eye : EyeOff}
				iconSize={14}
				label={label}
				onClick={onToggle}
				size="xs"
			/>
		</li>
	);
}

/**
 * What a view shows and how: a menu that leads to one page per setting, as in Notion. Every
 * change is saved at once. `part`: that page alone, for a popover of its own (the sort pill, a
 * query block's tools); "more" is what has no tool there: properties and the date.
 */
export function ViewSettings({
	tab,
	fields,
	columns,
	groups = [],
	onLook,
	kinds = TAB_KINDS,
	part,
}: {
	tab: ViewTab;
	fields: ViewField[];
	columns?: string[];
	groups?: Group[];
	onLook: (patch: Partial<ViewTab>) => void;
	kinds?: ViewKind[];
	part?: "sort" | "group" | "more";
}) {
	const { t } = useT();
	const ix = useIndex();
	const [page, setPage] = useState<Part | null>(null);
	// which sort rule is choosing its field ("new": one more)
	const [choosing, setChoosing] = useState<number | "new" | null>(null);
	const [dragged, setDragged] = useState<string | null>(null);
	const [draggedGroup, setDraggedGroup] = useState<string | null>(null);
	const hasStatus = [...ix.types.values()].some((x) => statusProp(x.schema));
	const groupable = [
		...(hasStatus ? ["status", "statusGroup"] : []),
		"project",
		"area",
		"type",
		"path",
		...fields
			.filter((f) => f.prop && (f.kind === "select" || f.kind === "relation"))
			.map((f) => f.key),
	];
	const sortable = [
		"title",
		...(hasStatus ? ["status"] : []),
		...fields
			.filter(
				(f) =>
					f.kind !== "relation" &&
					f.kind !== "tags" &&
					f.kind !== "computed" &&
					f.key !== "area" &&
					f.key !== "project",
			)
			.map((f) => f.key),
	];
	const dates = fields.filter((f) => f.kind === "date" || f.kind === "builtin-date");
	const shown = tab.columns ?? columns ?? []; // none chosen yet: the ones shown by default
	const kindsHere = kinds.includes(tab.kind) ? kinds : [...kinds, tab.kind];
	const groupedKind = tab.kind !== "triage" && tab.kind !== "calendar";
	const hasProps = tab.kind === "table" || tab.kind === "board";
	const hasDate = tab.kind === "calendar" || tab.kind === "timeline";
	const sorts = tab.sort ?? [];
	const name = (key: string) => fieldLabel(key, t, fields);
	const kindOf = (key: string): ViewField["kind"] =>
		fields.find((f) => titleKey(f.key) === titleKey(key))?.kind ?? BUILTIN_KIND[key] ?? "item";
	const isShown = (key: string) => shown.some((k) => titleKey(k) === titleKey(key));
	const fieldRow = (key: string, active: boolean, onClick: () => void) => (
		<MenuItem active={active} icon={<FieldIcon kind={kindOf(key)} />} key={key} onClick={onClick}>
			{name(key)}
		</MenuItem>
	);
	const heading = (text: string) => (
		<p className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground">{text}</p>
	);

	const layout = kindsHere.map((k) => {
		const Icon = KIND_ICON[k];
		return (
			<MenuItem
				active={k === tab.kind}
				icon={<Icon size={14} />}
				key={k}
				onClick={() => onLook({ kind: k })}
			>
				{t(`view.${k}`)}
			</MenuItem>
		);
	});

	const hiddenFields = fields.filter((f) => !isShown(f.key));
	const props = (
		<>
			<ul>
				{shown.map((k) => (
					<EyeRow
						draggable
						key={k}
						label={t("view.hideProp", { name: name(k) })}
						on
						onDragOver={(e) => dragged && dragged !== k && e.preventDefault()}
						onDragStart={() => setDragged(k)}
						onDrop={() => {
							if (!dragged) return;
							const from = shown.indexOf(dragged);
							const to = shown.indexOf(k);
							onLook({ columns: moveInArray(shown, from, from < to ? to + 1 : to) });
							setDragged(null);
						}}
						onToggle={() => onLook({ columns: shown.filter((x) => x !== k) })}
					>
						<FieldIcon kind={kindOf(k)} />
						<span className="truncate">{name(k)}</span>
					</EyeRow>
				))}
			</ul>
			{hiddenFields.length > 0 && heading(t("view.hidden"))}
			<ul>
				{hiddenFields.map((f) => (
					<EyeRow
						key={f.key}
						label={t("view.showProp", { name: f.label })}
						on={false}
						onToggle={() => onLook({ columns: [...shown, f.key] })}
					>
						<FieldIcon kind={f.kind} />
						<span className="truncate">{f.label}</span>
					</EyeRow>
				))}
			</ul>
		</>
	);

	const setSort = (n: number, patch: Partial<(typeof sorts)[number]>) =>
		onLook({ sort: sorts.map((x, m) => (m === n ? { ...x, ...patch } : x)) });
	const sort =
		choosing !== null ? (
			sortable
				.filter((k) => !sorts.some((s, n) => n !== choosing && titleKey(s.key) === titleKey(k)))
				.map((k) =>
					fieldRow(k, choosing !== "new" && titleKey(sorts[choosing]!.key) === titleKey(k), () => {
						if (choosing === "new") onLook({ sort: [...sorts, { key: k }] });
						else setSort(choosing, { key: k });
						setChoosing(null);
					}),
				)
		) : (
			<>
				<ul>
					{sorts.map((s, n) => (
						<li
							className="flex items-center gap-1 rounded-lg py-0.5 pl-1 pr-1 text-sm"
							draggable={sorts.length > 1}
							// biome-ignore lint/suspicious/noArrayIndexKey: sort rules have no id; a rule is its place in the list
							key={n}
							onDragOver={(e) => dragged && dragged !== String(n) && e.preventDefault()}
							onDragStart={() => setDragged(String(n))}
							onDrop={() => {
								if (dragged === null) return;
								const from = Number(dragged);
								onLook({ sort: moveInArray(sorts, from, from < n ? n + 1 : n) });
								setDragged(null);
							}}
						>
							<GripVertical
								aria-hidden
								className={cn(
									"shrink-0 text-faint",
									sorts.length > 1 ? "cursor-grab" : "invisible",
								)}
								size={13}
							/>
							<Button
								aria-label={t("view.sortField", { name: name(s.key) })}
								className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-hover"
								onClick={() => setChoosing(n)}
								variant="plain"
							>
								<FieldIcon kind={kindOf(s.key)} />
								<span className="min-w-0 flex-1 truncate">{name(s.key)}</span>
								<ChevronDown className="shrink-0 text-muted-foreground" size={12} />
							</Button>
							<Button
								className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-hover hover:text-fg"
								onClick={() => setSort(n, { desc: !s.desc || undefined })}
								variant="plain"
							>
								{s.desc ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
								{s.desc ? t("view.desc") : t("view.asc")}
							</Button>
							<IconButton
								icon={X}
								iconSize={13}
								label={t("view.sortRemove")}
								onClick={() => onLook({ sort: sorts.filter((_, m) => m !== n) })}
								size="xs"
							/>
						</li>
					))}
				</ul>
				{!sorts.length && (
					<p className="px-2.5 py-1.5 text-sm text-muted-foreground">{t("view.sortNone")}</p>
				)}
				<MenuItem icon={<Plus size={14} />} onClick={() => setChoosing("new")}>
					{t("view.sortAdd")}
				</MenuItem>
				{sorts.length > 0 && (
					<MenuItem danger icon={<Trash2 size={14} />} onClick={() => onLook({ sort: [] })}>
						{t("view.sortClear")}
					</MenuItem>
				)}
			</>
		);

	const hiddenGroups = tab.hiddenGroups ?? [];
	const ordered = orderGroups(groups, tab.groupOrder);
	const orderedIds = ordered.map(groupId);
	const group = (
		<>
			<MenuItem active={!tab.group} onClick={() => onLook({ group: undefined })}>
				{t("view.noGroup")}
			</MenuItem>
			{groupable.map((g) => fieldRow(g, tab.group === g, () => onLook({ group: g })))}
			{tab.group && (
				<>
					<div className="my-1 border-t border-line" />
					<MenuItem
						active={!!tab.hideEmpty}
						onClick={() => onLook({ hideEmpty: !tab.hideEmpty || undefined })}
					>
						{t("view.hideEmpty")}
					</MenuItem>
					{groups.length > 1 && heading(t("view.visibleGroups"))}
					{groups.length > 1 && (
						<ul>
							{ordered.map((g) => {
								const id = groupId(g);
								const hidden = hiddenGroups.includes(id);
								return (
									<EyeRow
										draggable
										key={g.key || "_"}
										label={t(hidden ? "view.showGroup" : "view.hideGroup")}
										on={!hidden}
										onDragOver={(e) =>
											draggedGroup !== null && draggedGroup !== id && e.preventDefault()
										}
										onDragStart={() => setDraggedGroup(id)}
										onDrop={() => {
											if (draggedGroup === null) return;
											const from = orderedIds.indexOf(draggedGroup);
											const to = orderedIds.indexOf(id);
											onLook({
												groupOrder: moveInArray(orderedIds, from, from < to ? to + 1 : to),
											});
											setDraggedGroup(null);
										}}
										onToggle={() =>
											onLook({
												hiddenGroups: hidden
													? hiddenGroups.filter((x) => x !== groupId(g))
													: [...hiddenGroups, groupId(g)],
											})
										}
									>
										<GroupChip by={tab.group!} byLabel={name(tab.group!)} g={g} />
									</EyeRow>
								);
							})}
						</ul>
					)}
				</>
			)}
		</>
	);
	const sub = (
		<>
			<MenuItem active={!tab.subgroup} onClick={() => onLook({ subgroup: undefined })}>
				{t("view.noGroup")}
			</MenuItem>
			{groupable
				.filter((g) => g !== (tab.group ?? "status"))
				.map((g) => fieldRow(g, tab.subgroup === g, () => onLook({ subgroup: g })))}
		</>
	);
	const date = (
		<>
			<MenuItem active={!tab.date} onClick={() => onLook({ date: undefined })}>
				{t("view.dateAuto")}
			</MenuItem>
			{dates.map((f) => fieldRow(f.key, tab.date === f.key, () => onLook({ date: f.key })))}
		</>
	);

	const pages: Record<Part, { title: string; body: React.ReactNode }> = {
		layout: { title: t("view.layout"), body: layout },
		props: { title: t(tab.kind === "board" ? "view.cardProps" : "view.properties"), body: props },
		sort: { title: t("view.sort"), body: sort },
		group: { title: t("view.groupBy"), body: group },
		sub: { title: t("view.subgroup"), body: sub },
		date: { title: t("view.date"), body: date },
	};
	const box = "w-[min(18rem,85vw)] text-sm";
	if (part === "sort") return <div className={box}>{sort}</div>;
	if (part === "group")
		return (
			<div className={box}>
				{group}
				{tab.kind === "board" && (
					<>
						{heading(t("view.subgroup"))}
						{sub}
					</>
				)}
			</div>
		);
	if (part === "more")
		return (
			<div className={box}>
				{hasProps && props}
				{hasDate && date}
			</div>
		);
	if (page)
		return (
			<div className={box}>
				<Button
					className="mb-1 flex w-full items-center gap-1 rounded-lg px-1.5 py-1 text-left text-xs font-medium text-muted-foreground hover:text-fg"
					onClick={() => (choosing !== null ? setChoosing(null) : setPage(null))}
					variant="plain"
				>
					<ChevronLeft size={13} /> {pages[page].title}
				</Button>
				{pages[page].body}
			</div>
		);
	return (
		<div className={box}>
			<MenuRow
				icon={KIND_ICON[tab.kind]}
				label={t("view.layout")}
				onClick={() => setPage("layout")}
				value={t(`view.${tab.kind}`)}
			/>
			{hasProps && (
				<MenuRow
					icon={Eye}
					label={pages.props.title}
					onClick={() => setPage("props")}
					value={t("view.shownCount", { count: shown.length })}
				/>
			)}
			{tab.kind !== "triage" && (
				<MenuRow
					icon={ArrowUpDown}
					label={t("view.sort")}
					onClick={() => setPage("sort")}
					value={
						sorts.length > 1
							? t("view.sortCount", { count: sorts.length })
							: sorts[0] && name(sorts[0].key)
					}
				/>
			)}
			{groupedKind && (
				<MenuRow
					icon={Rows3}
					label={t("view.groupBy")}
					onClick={() => setPage("group")}
					value={tab.group ? name(tab.group) : t("view.noGroup")}
				/>
			)}
			{tab.kind === "board" && (
				<MenuRow
					icon={Rows3}
					label={t("view.subgroup")}
					onClick={() => setPage("sub")}
					value={tab.subgroup ? name(tab.subgroup) : t("view.noGroup")}
				/>
			)}
			{hasDate && (
				<MenuRow
					icon={CalendarDays}
					label={t("view.date")}
					onClick={() => setPage("date")}
					value={tab.date ? name(tab.date) : t("view.dateAuto")}
				/>
			)}
		</div>
	);
}

/** How a view is sorted, as a pill in the line of its filters: its popover holds the rules. */
export function SortPill({
	tab,
	fields,
	onLook,
}: {
	tab: ViewTab;
	fields: ViewField[];
	onLook: (patch: Partial<ViewTab>) => void;
}) {
	const { t } = useT();
	const sorts = tab.sort ?? [];
	if (!sorts.length) return null;
	const first = sorts[0]!;
	return (
		<Popover
			trigger={(p) => (
				<Button
					variant="plain"
					{...p}
					className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-2.5 text-[13px] text-fg hover:bg-hover aria-expanded:border-focus"
				>
					{first.desc ? (
						<ArrowDown className="text-muted-foreground" size={13} />
					) : (
						<ArrowUp className="text-muted-foreground" size={13} />
					)}
					{sorts.length > 1
						? t("view.sortCount", { count: sorts.length })
						: fieldLabel(first.key, t, fields)}
					<ChevronDown className="text-muted-foreground" size={12} />
				</Button>
			)}
		>
			<ViewSettings fields={fields} onLook={onLook} part="sort" tab={tab} />
		</Popover>
	);
}
