import { type Item, todayISO, type ViewKind } from "@orbis/core/model";
import { type EvalCtx, groupItems, pathBase, type QueryDef, runQuery } from "@orbis/core/query";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { useIndex } from "../hooks";
import { titleOf, useT } from "../i18n";
import { BoardView } from "./Board";
import { GalleryView } from "./Gallery";
import { fieldLabel, HiddenGroups, hiddenPatch, splitHidden } from "./groups";
import { openShelf } from "./inbox";
import { Button } from "./primitives";
import { Group, ItemRow, pathLabel, treeOrder } from "./Row";
import { GroupedTable, type Look } from "./Table";
import { CalendarView, TimelineView } from "./TimeViews";
import { Triage } from "./Triage";

// Lists and query blocks take the default columns from here, next to Results.
export { defaultColumns } from "./cells";

export function useQuery(def: QueryDef, thisId?: string) {
	const ix = useIndex();
	const ctx: EvalCtx = { ix, thisId };
	const res = runQuery(def, ctx);
	return { ...res, ctx };
}

/** Rows a long result shows at first, and how many more each "more" adds. */
const FIRST_PAGE = 100;
const NEXT_PAGE = 200;
/** Views that always show every result. */
const UNPAGED: string[] = ["triage", "calendar", "timeline"];

const isInboxQuery = (def: QueryDef) => !!def.where && "inbox" in def.where;

/** Under a shortened inbox list: how much is waiting, and a clear way to work through it. */
function InboxNudge({ total }: { total: number }) {
	const { t } = useT();
	return (
		<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 pt-1 text-sm">
			<span className="tabular-nums text-muted-foreground">
				{t("inbox.waiting", { count: total })}
			</span>
			<Button
				className="font-medium text-fg underline-offset-2 hover:underline"
				onClick={() => openShelf()}
				variant="plain"
			>
				{t("inbox.sortNow")}
			</Button>
		</div>
	);
}

function MissingTypes({ ids }: { ids: string[] }) {
	const { t } = useT();
	const ix = useIndex();
	if (!ids.length) return null;
	return (
		<p className="mb-2 flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-warn">
			<AlertTriangle size={13} />{" "}
			{t("query.typeDeleted", {
				names: ids.map((id) => ix.all.get(id)?.schema?.name ?? id).join(", "),
			})}
		</p>
	);
}

export function Results({
	def,
	thisId,
	display,
	empty,
	keyPrefix = "",
	look,
}: {
	def: QueryDef;
	thisId?: string;
	display?: ViewKind;
	empty?: React.ReactNode;
	keyPrefix?: string;
	look?: Look;
}) {
	const { t } = useT();
	const res = useQuery(def, thisId);
	const { total, missingTypes, ctx } = res;
	// long results render in pages, so a collection of hundreds stays responsive
	const [shown, setShown] = useState(FIRST_PAGE);
	const view = display ?? def.view ?? "list";
	const items = res.items.slice(0, UNPAGED.includes(view) ? undefined : shown);
	return (
		<div>
			<MissingTypes ids={missingTypes} />
			{!items.length &&
			!missingTypes.length &&
			!(look?.add && (view === "table" || view === "board")) ? (
				(empty ?? <p className="px-2 py-1.5 text-sm text-muted-foreground">{t("query.empty")}</p>)
			) : view === "table" ? (
				<GroupedTable ctx={ctx} def={def} items={items} look={look ?? { key: keyPrefix }} />
			) : view === "board" ? (
				<BoardView ctx={ctx} def={def} items={items} look={look} />
			) : view === "calendar" ? (
				<CalendarView ctx={ctx} def={def} items={items} look={look} />
			) : view === "timeline" ? (
				<TimelineView ctx={ctx} def={def} items={items} look={look} />
			) : view === "tree" ? (
				<TreeView items={items} />
			) : view === "gallery" ? (
				<GalleryView ctx={ctx} items={items} />
			) : view === "triage" ? (
				<Triage items={items} />
			) : (
				<ListView ctx={ctx} def={def} items={items} look={look} />
			)}
			{def.limit &&
				total > res.items.length &&
				(isInboxQuery(def) ? (
					<InboxNudge total={total} />
				) : (
					<p className="px-2 pt-1 text-xs text-muted-foreground">
						{t("query.more", { count: total - res.items.length })}
					</p>
				))}
			{res.items.length > items.length && (
				<Button
					className="mt-2 w-full py-2 text-sm text-muted-foreground hover:text-fg"
					onClick={() => setShown(shown + NEXT_PAGE)}
					variant="plain"
				>
					{t("query.more", { count: res.items.length - items.length })}
				</Button>
			)}
		</div>
	);
}

function ListView({
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
	const base = pathBase(def, ctx);
	const [groups, hidden] = def.group
		? splitHidden(groupItems(items, def.group, ctx, base), look?.tab)
		: [groupItems(items, def.group, ctx, base), []];
	const ix = ctx.ix;
	// "columns:next" in a list: each entry shows its next task below the title
	const withNext = def.columns?.includes("next");
	const by = def.group ?? "";
	const byLabel = fieldLabel(by, t);
	const headingOf = (g: (typeof groups)[number]) => {
		if (!def.group) return;
		if (def.group === "path") return g.path?.length ? pathLabel(g.path) : t("group.thisLevel");
		return (
			g.label ||
			(g.statusGroup ? t(`group.${g.statusGroup}`) : t("group.without", { name: byLabel }))
		);
	};
	return (
		<div className="-mx-2">
			{groups.map((g, gi) => (
				<Group count={g.items.length} first={gi === 0} heading={headingOf(g)} key={g.key}>
					{treeOrder(g.items).map(({ item: i, depth }) => {
						// sub-items whose parent is listed too follow it, indented. Every other entry says
						// where it lives: relative to the page, or (in global lists) its home path.
						const rel = base ? ix.relPath(base, i.id) : ix.homePath(i.id);
						const showPath =
							def.group !== "path" && !depth && rel && rel.length > 0 ? rel : undefined;
						const next = withNext ? ix.nextTask(i.id, todayISO()) : undefined;
						return (
							<ItemRow
								item={i}
								key={i.id}
								note={next && t("row.next", { title: titleOf(next, t) })}
								path={showPath}
								sub={depth}
							/>
						);
					})}
				</Group>
			))}
			{def.group && (
				<HiddenGroups
					by={by}
					byLabel={byLabel}
					groups={hidden}
					onShow={look?.onLook ? (g) => look.onLook!(hiddenPatch(look.tab, g, false)) : undefined}
				/>
			)}
		</div>
	);
}

function TreeView({ items }: { items: Item[] }) {
	const ix = useIndex();
	const set = new Set(items.map((i) => i.id));
	const parentOf = (id: string) => {
		const home = ix.home(id);
		if (home && set.has(home)) return home;
		return ix.parentsOf(id).find((p) => set.has(p));
	};
	const kids = new Map<string, Item[]>();
	const roots: Item[] = [];
	for (const i of items) {
		const p = parentOf(i.id);
		if (p) (kids.get(p) ?? kids.set(p, []).get(p)!).push(i);
		else roots.push(i);
	}
	const render = (i: Item, depth: number, seen: Set<string>): React.ReactNode =>
		seen.has(i.id) ? null : (
			<div key={i.id}>
				<div style={{ paddingLeft: depth * 18 }}>
					<ItemRow item={i} />
				</div>
				{(kids.get(i.id) ?? []).map((k) => render(k, depth + 1, new Set([...seen, i.id])))}
			</div>
		);
	return <div className="-mx-2">{roots.map((r) => render(r, 0, new Set()))}</div>;
}
