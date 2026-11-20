import type { Item } from "@orbis/core/model";
import {
	type EvalCtx,
	fieldOf,
	groupItems,
	type Group as QGroup,
	type QueryDef,
	viewTypeIds,
} from "@orbis/core/query";
import { ChevronDown, ChevronRight, EyeOff } from "lucide-react";
import { useState } from "react";
import { itemHref, openItem, useRepo } from "../hooks";
import { titleOf, useT } from "../i18n";
import { cn } from "../lib/utils";
import { CellValue } from "./cells";
import { AreaChip, fieldLabel, GroupChip, HiddenGroups, hiddenPatch, splitHidden } from "./groups";
import { ItemIcon } from "./item-look";
import { Button, IconButton } from "./primitives";
import { PercentBar, ProgressCount } from "./progress";
import { groupSetter } from "./Row";
import { groupInit, type Look, NewRowButton, newInit } from "./Table";

export function BoardView({
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
	const by = def.group && def.group !== "path" ? def.group : "status";
	const tab = look?.tab;
	// empty options stay as columns so there is somewhere to drag to ("Done" before anything is done)
	const typeIds = viewTypeIds(def.where, items, ix, items.length);
	const [columns, hiddenCols] = splitHidden(
		groupItems(
			items,
			by,
			ctx,
			undefined,
			tab?.hideEmpty ? undefined : { types: typeIds, where: def.where },
		).filter((g) => !tab?.hideEmpty || g.items.length),
		tab,
	);
	const lanes = tab?.subgroup
		? groupItems(items, tab.subgroup, ctx).filter((g) => g.items.length)
		: [{ key: "", items } as QGroup];
	const [over, setOver] = useState<string | null>(null);
	const [folded, setFolded] = useState<Set<string>>(new Set());
	const repo = useRepo();
	const drop = (id: string, g: QGroup) => {
		const item = repo.get(id);
		if (item) groupSetter(item, by, g, repo)?.();
	};
	// fade the right edge while more columns are off-screen, so it is clear the board scrolls
	const [more, setMore] = useState(false);
	const scroller = (el: HTMLDivElement | null) => {
		if (!el) return;
		const check = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
		check();
		el.onscroll = check;
	};
	const toggleFold = (key: string) =>
		setFolded((f) => new Set(f.has(key) ? [...f].filter((k) => k !== key) : [...f, key]));
	const byLabel = fieldLabel(by, t);
	const subLabel = tab?.subgroup ? fieldLabel(tab.subgroup, t) : "";
	return (
		<div
			className={cn(
				"-mx-2 overflow-x-auto pb-2",
				more && "[mask-image:linear-gradient(to_right,black_88%,transparent)]",
			)}
			ref={scroller}
		>
			{lanes.map((lane) => {
				const inLane = new Set(lane.items.map((i) => i.id));
				const isFolded = folded.has(lane.key);
				return (
					<section className={tab?.subgroup ? "mb-4" : undefined} key={lane.key || "_"}>
						{tab?.subgroup && (
							<div className="sticky left-0 flex w-fit items-center gap-2 px-2 py-1.5">
								<Button
									aria-expanded={!isFolded}
									aria-label={t(isFolded ? "table.unfold" : "table.fold")}
									className="tap -ml-1 rounded p-0.5 text-muted-foreground hover:bg-hover hover:text-fg"
									onClick={() => toggleFold(lane.key)}
									variant="plain"
								>
									{isFolded ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
								</Button>
								<GroupChip by={tab.subgroup} byLabel={subLabel} g={lane} />
								<span className="text-xs tabular-nums text-muted-foreground">
									{lane.items.length}
								</span>
							</div>
						)}
						{!isFolded && (
							<ul className="flex gap-3 px-2">
								{columns.map((col) => {
									const cards = col.items.filter((i) => inLane.has(i.id));
									const k = `${lane.key}|${col.key}`;
									// "+ New" here: the column's value and the lane's
									const init =
										look?.add &&
										groupInit(groupInit(newInit(look.add), by, col, ix), tab?.subgroup, lane, ix);
									return (
										<li
											className={cn(
												"flex w-64 shrink-0 flex-col gap-1.5 rounded-xl bg-surface-2/60 p-2",
												!cards.length && !tab?.subgroup && "w-44",
												over === k && "ring-2 ring-focus",
											)}
											key={col.key || "_"}
											onDragLeave={() => setOver(null)}
											onDragOver={(e) => {
												e.preventDefault();
												setOver(k);
											}}
											onDrop={(e) => {
												setOver(null);
												drop(e.dataTransfer.getData("orbis/item"), col);
											}}
										>
											<p className="group/head flex items-center gap-2 px-1">
												<GroupChip by={by} byLabel={byLabel} g={col} />
												<span className="text-xs tabular-nums text-muted-foreground">
													{cards.length}
												</span>
												{look?.onLook && (
													<IconButton
														className="ml-auto opacity-0 focus-visible:opacity-100 group-hover/head:opacity-100 pointer-coarse:opacity-100"
														icon={EyeOff}
														iconSize={13}
														label={t("view.hideColumn")}
														onClick={() => look.onLook!(hiddenPatch(tab, col, true))}
														size="xs"
													/>
												)}
											</p>
											{/* with sub-rows the empty cells stay quiet */}
											{!cards.length && !tab?.subgroup && !init && (
												<p className="rounded-lg border border-dashed border-line px-2 py-3 text-center text-xs text-muted-foreground">
													{t("board.dropHere")}
												</p>
											)}
											{cards.map((i) => (
												<BoardCard cols={def.columns ?? []} ctx={ctx} item={i} key={i.id} />
											))}
											{init && (
												<NewRowButton
													card
													init={init}
													label={t("table.addIn", { name: ix.typeName(init.type ?? null) ?? "" })}
												/>
											)}
										</li>
									);
								})}
							</ul>
						)}
					</section>
				);
			})}
			<HiddenGroups
				by={by}
				byLabel={byLabel}
				groups={hiddenCols}
				onShow={look?.onLook ? (g) => look.onLook!(hiddenPatch(tab, g, false)) : undefined}
			/>
		</div>
	);
}

function BoardCard({ item: i, cols, ctx }: { item: Item; cols: string[]; ctx: EvalCtx }) {
	const { t } = useT();
	const shown = cols.filter((c) => {
		const hit =
			c === "area" ? (ctx.ix.area(i.id) ? { value: 1 } : undefined) : fieldOf(i, c, ctx.ix);
		return hit && !isEmpty(hit.value);
	});
	const pr = !cols.length ? ctx.ix.progressOf(i) : undefined;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the click only widens the title link to the whole card; that link is the way for keyboards
		<div
			className="flex cursor-pointer flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5 text-sm shadow-sm hover:shadow"
			data-id={i.id}
			draggable
			onClick={(e) => {
				if (!(e.target as HTMLElement).closest("a,button,select,input")) openItem(i.id);
			}}
			onDragStart={(e) => e.dataTransfer.setData("orbis/item", i.id)}
		>
			<a className="flex items-start gap-2" draggable={false} href={itemHref(i.id)}>
				<ItemIcon className="mt-0.5 shrink-0" item={i} size={14} />
				<span className="min-w-0 flex-1 font-medium">{titleOf(i, t)}</span>
			</a>
			{shown.map((c) => (
				<span className="flex min-w-0 text-xs text-muted-foreground" key={c}>
					{c === "area" ? (
						<AreaChip id={ctx.ix.area(i.id)!} />
					) : (
						<CardValue ctx={ctx} item={i} name={c} />
					)}
				</span>
			))}
			{pr?.total ? (
				<ProgressCount className="text-xs text-muted-foreground" done={pr.done} total={pr.total} />
			) : null}
		</div>
	);
}

function isEmpty(value: unknown): boolean {
	return (
		value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)
	);
}

function CardValue({ item, name, ctx }: { item: Item; name: string; ctx: EvalCtx }) {
	const { t } = useT();
	if (name === "progress") {
		const pr = ctx.ix.progressOf(item);
		return pr ? <PercentBar done={pr.done} total={pr.total} /> : null;
	}
	const hit = fieldOf(item, name, ctx.ix);
	if (name === "subtasks")
		return <span>{t("card.subtasks", { count: Number(hit?.value ?? 0) })}</span>;
	if (hit?.prop?.kind === "computed" && hit.prop.computed?.fn !== "count") {
		const pr = ctx.ix.progress(item.id, hit.prop.computed?.of);
		return <PercentBar done={pr.done} total={pr.total} />;
	}
	return <CellValue ctx={ctx} item={item} name={name} />;
}
