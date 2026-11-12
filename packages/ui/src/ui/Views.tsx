// View tabs, shared by a type's page and query blocks. A tab's filter is added to the query.

import type { T } from "@obtion/core/i18n";
import { type PropDef, titleKey, type ViewKind, type ViewTab } from "@obtion/core/model";
import {
	type Cond,
	type Group,
	groupId,
	parseQuery,
	typesIn,
	viewTypeIds,
} from "@obtion/core/query";
import { keyBetween } from "@obtion/core/sortkey";
import { statusProp } from "@obtion/core/traits";
import {
	CalendarDays,
	ChartGantt,
	ChevronLeft,
	ChevronRight,
	Copy,
	GripVertical,
	LayoutGrid,
	List,
	ListChecks,
	ListTree,
	Plus,
	SlidersHorizontal,
	SquareKanban,
	Table2,
	Trash2,
	X,
} from "lucide-react";
import { useContext, useState } from "react";
import { Checkbox } from "../components/ui/checkbox";
import { NativeSelect } from "../components/ui/native-select";
import { setParams, useIndex, useLocalStorage, useRoute } from "../hooks";
import { useT } from "../i18n";
import { cn, moveInArray } from "../lib/utils";
import { InlineText } from "./fields";
import { fieldLabel, GroupChip } from "./groups";
import { Button, Card, DraftBar, IconButton, InCard, MenuItem, Popover, Seg } from "./primitives";
import { QueryEditor } from "./QueryEditor";
import { KEYS } from "./storage";

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
	return [tab, (x) => (setId(x), inAddress && setParams({ view: x }))];
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
									onClick={() => (on ? edit && (setPoint(null), p.onClick()) : onPick(tab.id))}
									onContextMenu={
										edit &&
										((e) => (
											e.preventDefault(),
											setPoint({ id: tab.id, x: e.clientX, y: e.clientY }),
											setMenu(tab.id)
										))
									}
									onDragEnd={() => (setDrag(null), setOver(null))}
									onDragLeave={() => setOver(null)}
									onDragOver={(e) => drag && (e.preventDefault(), setOver(tab.id))}
									onDragStart={(e) => (
										e.dataTransfer.setData("obtion/tab", tab.id), setDrag(tab.id)
									)}
									onDrop={(e) => (e.preventDefault(), drop(tab.id), setDrag(null), setOver(null))}
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
										onClick={() => (close(), on || onPick(tab.id), edit!.settings())}
									>
										{t("view.settings")}
									</MenuItem>
									<MenuItem
										icon={<Copy size={14} />}
										onClick={() => (close(), edit!.duplicate(tab.id))}
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
											onClick={() => (close(), edit!.remove(tab.id))}
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
										onClick={() => (close(), edit.add(k))}
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

interface ViewField {
	key: string; // stored in columns / sort / group: a built-in field or the property's name
	label: string;
	kind: PropDef["kind"] | "item" | "tags" | "builtin-date";
	prop?: PropDef;
}

/** Fields of the types a view lists (and the built-in ones), for columns, sorting, grouping and dates. */
export function useViewFields(
	where: Cond | undefined,
	sample: { type: string | null }[] = [],
): ViewField[] {
	const ix = useIndex();
	const { t } = useT();
	const typeIds = viewTypeIds(where, sample, ix);
	const out: ViewField[] = [];
	const seen = new Set<string>();
	const push = (f: ViewField) =>
		!seen.has(titleKey(f.key)) && (seen.add(titleKey(f.key)), out.push(f));
	for (const id of typeIds)
		for (const p of ix.types.get(id)!.schema.properties)
			push({ key: p.name, label: p.name, kind: p.kind, prop: p });
	// the other side of relations that can point here ("Blockiert diese")
	for (const type of ix.types.values())
		for (const p of type.schema.properties) {
			if (p.kind !== "relation" || p.symmetric || !p.inverseName) continue;
			const target = p.target ? typesIn(parseQuery(p.target, ix).def.where) : [];
			if (target.length && !target.some((x) => typeIds.includes(x))) continue;
			if (!typeIds.includes(type.id) && !target.length) continue;
			push({ key: p.inverseName, label: p.inverseName, kind: "relation" });
		}
	push({ key: "project", label: t("field.project"), kind: "item" });
	push({ key: "area", label: t("field.area"), kind: "item" });
	push({ key: "tags", label: t("item.tags"), kind: "tags" });
	push({ key: "created", label: t("field.created"), kind: "builtin-date" });
	push({ key: "updated", label: t("field.updated"), kind: "builtin-date" });
	return out;
}

interface FilterDraft {
	where: Cond | undefined;
	onChange: (where: Cond | undefined) => void;
	dirty: boolean;
	save: () => void;
	discard: () => void;
}

/** The look is saved at once; the filter stays a draft until "Save". */
export function ViewSettings({
	tab,
	fields,
	columns,
	groups = [],
	onLook,
	filter,
	onClose,
	kinds = TAB_KINDS,
	part,
}: {
	tab: ViewTab;
	fields: ViewField[];
	columns?: string[];
	groups?: Group[];
	onLook: (patch: Partial<ViewTab>) => void;
	filter?: FilterDraft;
	onClose: () => void;
	kinds?: ViewKind[] /** one part only, for a popover (a query block's tools): no card, kind switch, filter or close button */;
	part?: "sort" | "group" | "more";
}) {
	const { t } = useT();
	const ix = useIndex();
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
	const [dragCol, setDragCol] = useState<string | null>(null);
	const select = "rounded-md border border-line bg-bg px-2 py-1 text-sm";
	const row = "flex flex-wrap items-center gap-2";
	const label = "w-28 shrink-0 text-xs text-muted-foreground";
	const kindsHere = kinds.includes(tab.kind) ? kinds : [...kinds, tab.kind];
	const groupedKind = tab.kind !== "triage" && tab.kind !== "calendar";
	const sorts = tab.sort ?? [];
	const patchSort = (
		n: number,
		patch: (s: (typeof sorts)[number]) => Partial<(typeof sorts)[number]>,
	) => onLook({ sort: sorts.map((x, m) => (m === n ? { ...x, ...patch(x) } : x)) });
	const isShown = (key: string) => shown.some((k) => titleKey(k) === titleKey(key));
	// the shown ones first, in their order, then the others
	const Box = part ? "div" : Card;
	const shows = (x: "sort" | "group" | "more") => !part || part === x;
	const columnFields = [
		...shown.map(
			(k) =>
				fields.find((f) => titleKey(f.key) === titleKey(k)) ?? {
					key: k,
					label: fieldLabel(k, t, fields),
					kind: "text" as const,
				},
		),
		...fields.filter((f) => !isShown(f.key)),
	];
	return (
		<Box className={cn("space-y-3 text-sm", !part && "mb-4 p-3")}>
			{/* in a query block another kind is another tab: add it with "+" and remove the old one */}
			{!part && (
				<div className="flex items-start gap-2">
					<div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
						<Seg
							label={t("view.label")}
							onChange={(k) => onLook({ kind: k })}
							options={kindsHere.map((k) => ({ value: k, label: t(`view.${k}`) }))}
							value={tab.kind}
						/>
					</div>
					<IconButton
						icon={X}
						iconSize={15}
						label={t("view.closeSettings")}
						onClick={onClose}
						size="sm"
					/>
				</div>
			)}

			{filter && !part && (
				<div>
					<p className="mb-1 text-xs text-muted-foreground">{t("view.filter")}</p>
					<QueryEditor def={{ where: filter.where }} onChange={(d) => filter.onChange(d.where)} />
					{filter.dirty && (
						<DraftBar className="mt-2" onDiscard={filter.discard} onSave={filter.save} />
					)}
				</div>
			)}

			{groupedKind && shows("group") && (
				<div className={row}>
					<span className={label}>{t("view.groupBy")}</span>
					<NativeSelect
						aria-label={t("view.groupBy")}
						className={select}
						onChange={(e) => onLook({ group: e.target.value || undefined })}
						value={tab.group ?? ""}
					>
						<option value="">{t("view.noGroup")}</option>
						{groupable.map((g) => (
							<option key={g} value={g}>
								{fieldLabel(g, t, fields)}
							</option>
						))}
					</NativeSelect>
					{tab.group && (
						<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<Checkbox
								checked={!!tab.hideEmpty}
								onCheckedChange={(checked) => onLook({ hideEmpty: checked === true || undefined })}
							/>
							{t("view.hideEmpty")}
						</label>
					)}
				</div>
			)}
			{tab.group && groups.length > 1 && groupedKind && shows("group") && (
				<div className={cn(row, "items-start")}>
					<span className={cn(label, "pt-1")}>{t("view.visibleGroups")}</span>
					<ul className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1.5">
						{groups.map((g) => {
							const hidden = (tab.hiddenGroups ?? []).includes(groupId(g));
							return (
								<li className="min-w-0 max-w-full" key={g.key || "_"}>
									<label className="flex min-w-0 cursor-pointer items-center gap-1.5">
										<Checkbox
											checked={!hidden}
											onCheckedChange={(checked) =>
												onLook({
													hiddenGroups:
														checked === true
															? (tab.hiddenGroups ?? []).filter((x) => x !== groupId(g))
															: [...(tab.hiddenGroups ?? []), groupId(g)],
												})
											}
										/>
										<GroupChip by={tab.group!} byLabel={fieldLabel(tab.group!, t, fields)} g={g} />
									</label>
								</li>
							);
						})}
					</ul>
				</div>
			)}
			{tab.kind === "board" && shows("group") && (
				<div className={row}>
					<span className={label}>{t("view.subgroup")}</span>
					<NativeSelect
						aria-label={t("view.subgroup")}
						className={select}
						onChange={(e) => onLook({ subgroup: e.target.value || undefined })}
						value={tab.subgroup ?? ""}
					>
						<option value="">{t("view.noGroup")}</option>
						{groupable
							.filter((g) => g !== (tab.group ?? "status"))
							.map((g) => (
								<option key={g} value={g}>
									{fieldLabel(g, t, fields)}
								</option>
							))}
					</NativeSelect>
				</div>
			)}
			{(tab.kind === "calendar" || tab.kind === "timeline") && shows("more") && (
				<div className={row}>
					<span className={label}>{t("view.date")}</span>
					<NativeSelect
						aria-label={t("view.date")}
						className={select}
						onChange={(e) => onLook({ date: e.target.value || undefined })}
						value={tab.date ?? ""}
					>
						<option value="">{t("view.dateAuto")}</option>
						{dates.map((f) => (
							<option key={f.key} value={f.key}>
								{f.label}
							</option>
						))}
					</NativeSelect>
				</div>
			)}

			{tab.kind !== "triage" && shows("sort") && (
				<div className={row}>
					<span className={label}>{t("view.sort")}</span>
					<div className="flex flex-wrap items-center gap-1.5">
						{sorts.map((s, n) => (
							<span
								className="inline-flex items-center gap-1 rounded-md border border-line bg-bg py-0.5 pl-1 pr-0.5"
								key={n}
							>
								<NativeSelect
									aria-label={t("view.sort")}
									className="bg-transparent text-sm outline-none"
									onChange={(e) => patchSort(n, () => ({ key: e.target.value }))}
									value={s.key}
								>
									{[...new Set([s.key, ...sortable])].map((k) => (
										<option key={k} value={k}>
											{fieldLabel(k, t, fields)}
										</option>
									))}
								</NativeSelect>
								<Button
									className="tap rounded px-1 text-xs text-muted-foreground hover:bg-hover hover:text-fg"
									onClick={() => patchSort(n, (x) => ({ desc: !x.desc || undefined }))}
									variant="plain"
								>
									{s.desc ? t("view.desc") : t("view.asc")}
								</Button>
								<IconButton
									icon={X}
									iconSize={12}
									label={t("view.sortRemove")}
									onClick={() => onLook({ sort: sorts.filter((_, m) => m !== n) })}
									size="xs"
								/>
							</span>
						))}
						<Button
							className="tap inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-hover hover:text-fg"
							onClick={() =>
								onLook({
									sort: [
										...sorts,
										{ key: sortable.find((k) => !sorts.some((s) => s.key === k)) ?? "title" },
									],
								})
							}
							variant="plain"
						>
							<Plus size={12} /> {sorts.length ? t("view.sortMore") : t("view.sortAdd")}
						</Button>
					</div>
				</div>
			)}

			{/* properties: columns of a table, lines on board cards (lists and galleries show their own) */}
			{(tab.kind === "table" || tab.kind === "board") && shows("more") && (
				<div className={cn(row, "items-start")}>
					<span className={cn(label, "pt-1")}>
						{tab.kind === "table" ? t("view.columns") : t("view.cardProps")}
					</span>
					<ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
						{columnFields.map((f) => {
							const on = isShown(f.key);
							return (
								<li
									draggable={on}
									key={f.key}
									onDragOver={(e) => dragCol && on && e.preventDefault()}
									onDragStart={() => setDragCol(f.key)}
									onDrop={() => {
										if (!dragCol || dragCol === f.key) return;
										onLook({
											columns: moveInArray(shown, shown.indexOf(dragCol), shown.indexOf(f.key)),
										});
										setDragCol(null);
									}}
								>
									<label
										className={cn(
											"inline-flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
											on
												? "border-line bg-bg text-fg"
												: "border-dashed border-line text-muted-foreground hover:text-fg",
										)}
									>
										{on && (
											<GripVertical
												aria-hidden
												className="cursor-grab text-muted-foreground"
												size={11}
											/>
										)}
										<Checkbox
											checked={on}
											className="sr-only"
											onCheckedChange={(checked) =>
												onLook({
													columns:
														checked === true
															? [...shown, f.key]
															: shown.filter((k) => titleKey(k) !== titleKey(f.key)),
												})
											}
										/>
										{f.label}
									</label>
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</Box>
	);
}
