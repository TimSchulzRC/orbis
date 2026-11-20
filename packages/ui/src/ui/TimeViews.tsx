// Calendar and timeline: entries at their date or range. Dragging moves the date (and in the
// timeline the start or the end); entries without a date are listed below.

import { addDays, dayOf, diffDays, timeOf, todayISO, withTime } from "@orbis/core/date";
import { formatRange, type Item, type PropDef, parseRange, propByName } from "@orbis/core/model";
import {
	type EvalCtx,
	fieldOf,
	type Group,
	groupItems,
	type QueryDef,
	viewTypeIds,
} from "@orbis/core/query";
import { dueProp } from "@orbis/core/traits";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { itemHref, openItem, useLocalStorage, useNarrow } from "../hooks";
import { titleOf, useT } from "../i18n";
import { startPointerDrag } from "../lib/drag";
import { cn } from "../lib/utils";
import { repo } from "../repo";
import { fieldLabel, GroupChip, HiddenGroups, hiddenPatch, splitHidden } from "./groups";
import { ItemIcon, ItemLink } from "./item-look";
import { Button, IconButton, Seg } from "./primitives";
import { KEYS } from "./storage";
import type { Look } from "./Table";

// Dates are ISO strings, computed in UTC so no time zone moves a day.
const ms = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(ms(d)).getUTCDay(); // 0 = Sunday
const firstDay = (lang: string) => (lang === "en" ? 0 : 1);
const startOfWeek = (d: string, lang: string) =>
	addDays(d, -((weekday(d) - firstDay(lang) + 7) % 7));
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

/** Entries a calendar week shows one above the other before "+ n more". */
const MAX_LANES = 3;

interface Span {
	start: string;
	end: string;
}

/** The date a view places entries by: chosen, else the first date property (a due date before others). */
function dateKey(def: QueryDef, items: Item[], ctx: EvalCtx, chosen?: string): string | undefined {
	if (chosen) return chosen;
	for (const id of viewTypeIds(def.where, items, ctx.ix, 100)) {
		const schema = ctx.ix.types.get(id)!.schema;
		const prop =
			schema.properties.find((x) => x.kind === "date" && x.range) ??
			dueProp(schema) ??
			schema.properties.find((x) => x.kind === "date");
		if (prop) return prop.name;
	}
	return undefined;
}

function spanOf(item: Item, key: string, ctx: EvalCtx): Span | undefined {
	const hit = fieldOf(item, key, ctx.ix);
	if (hit?.kind !== "date" || typeof hit.value !== "string" || !hit.value) return undefined;
	// a time of day doesn't move the bar: it spans whole days
	const range = parseRange(hit.value);
	const [from, to] = [dayOf(range.start), dayOf(range.end)];
	const start = isDay(from) ? from : isDay(to) ? to : undefined;
	const end = isDay(to) ? to : start;
	if (!start || !end) return undefined;
	return ms(end) < ms(start) ? { start: end, end: start } : { start, end };
}

/** The property behind a date key on this entry, if it can be written (not "Created", not "Updated"). */
function writable(item: Item, key: string, ctx: EvalCtx): PropDef | undefined {
	const schema = ctx.ix.schemaOf(item);
	if (key === "due") return dueProp(schema);
	if (key === "created" || key === "updated" || key === "done") return undefined;
	return propByName(schema, key, (p) => p.kind === "date");
}

/** Moving a bar changes the days; a time the value had stays. */
function writeSpan(item: Item, key: string, span: Span, ctx: EvalCtx) {
	const prop = writable(item, key, ctx);
	if (!prop) return;
	const was = parseRange(item.props[prop.id]);
	const start = withTime(span.start, timeOf(was.start));
	repo.setProp(
		item.id,
		prop.id,
		prop.range ? formatRange(start, withTime(span.end, timeOf(was.end))) : start,
	);
}

/** A span after dragging by `days`: the whole bar, or one edge (never past the other). */
function draggedSpan(span: Span, mode: "move" | "start" | "end", days: number): Span {
	if (mode === "move") return { start: addDays(span.start, days), end: addDays(span.end, days) };
	if (mode === "start") {
		const start = addDays(span.start, days);
		return { start: ms(start) > ms(span.end) ? span.end : start, end: span.end };
	}
	const end = addDays(span.end, days);
	return { start: span.start, end: ms(end) < ms(span.start) ? span.start : end };
}

export function CalendarView({
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
	const { t, lang } = useT();
	const key = dateKey(def, items, ctx, look?.tab?.date);
	const today = todayISO();
	const [month, setMonth] = useState(() => monthStart(today));
	const [drag, setDrag] = useState<{ id: string; from: string } | null>(null);
	const [over, setOver] = useState<string | null>(null);
	const placed = key
		? items
				.map((i) => ({ item: i, span: spanOf(i, key, ctx) }))
				.filter((x): x is { item: Item; span: Span } => !!x.span)
		: [];
	const undated = items.filter((i) => !placed.some((p) => p.item.id === i.id));
	const first = startOfWeek(month, lang);
	const nextMonth = iso(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1));
	const weeks: string[] = [];
	for (let w = first; ms(w) < ms(nextMonth); w = addDays(w, 7)) weeks.push(w);
	const shift = (n: number) =>
		setMonth(iso(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + n, 1)));
	const dayNames = Array.from({ length: 7 }, (_, n) =>
		new Intl.DateTimeFormat(lang, { weekday: "short", timeZone: "UTC" }).format(
			new Date(ms(addDays(first, n))),
		),
	);
	const drop = (day: string) => {
		if (!drag || !key) return;
		const entry = placed.find((x) => x.item.id === drag.id);
		if (!entry) return;
		const days = diffDays(drag.from, day);
		if (days)
			writeSpan(
				entry.item,
				key,
				{ start: addDays(entry.span.start, days), end: addDays(entry.span.end, days) },
				ctx,
			);
	};
	if (!key) return <p className="px-2 py-1.5 text-sm text-muted-foreground">{t("view.noDate")}</p>;
	return (
		<div className="text-sm">
			<div className="mb-2 flex items-center gap-1">
				<h3 className="mr-2 text-base font-semibold capitalize">
					{new Intl.DateTimeFormat(lang, {
						month: "long",
						year: "numeric",
						timeZone: "UTC",
					}).format(new Date(ms(month)))}
				</h3>
				<IconButton icon={ChevronLeft} label={t("cal.prev")} onClick={() => shift(-1)} size="sm" />
				<Button
					className="tap rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-hover hover:text-fg"
					onClick={() => setMonth(monthStart(today))}
					variant="plain"
				>
					{t("time.today")}
				</Button>
				<IconButton icon={ChevronRight} label={t("cal.next")} onClick={() => shift(1)} size="sm" />
			</div>
			<div className="overflow-x-auto">
				<div className="min-w-[640px] overflow-hidden rounded-xl border border-line">
					<div className="grid grid-cols-7 border-b border-line bg-surface-2/50 text-xs text-muted-foreground">
						{dayNames.map((d) => (
							<div className="px-2 py-1" key={d}>
								{d}
							</div>
						))}
					</div>
					{weeks.map((w) => {
						const days = Array.from({ length: 7 }, (_, n) => addDays(w, n));
						const end = days[6]!;
						// entries in this week, longest first, each in the first free lane
						const here = placed
							.filter((p) => ms(p.span.start) <= ms(end) && ms(p.span.end) >= ms(w))
							.sort(
								(a, b) =>
									diffDays(b.span.start, b.span.end) - diffDays(a.span.start, a.span.end) ||
									a.span.start.localeCompare(b.span.start),
							);
						const lanes: string[][] = [];
						const pos = here.map((p) => {
							const s = Math.max(0, diffDays(w, p.span.start));
							const e = Math.min(6, diffDays(w, p.span.end));
							let lane = lanes.findIndex((l) => l.slice(s, e + 1).every((x) => !x));
							if (lane < 0) {
								lanes.push(new Array(7).fill(""));
								lane = lanes.length - 1;
							}
							for (let n = s; n <= e; n++) lanes[lane]![n] = p.item.id;
							return { ...p, s, e, lane };
						});
						const shownLanes = Math.min(lanes.length, MAX_LANES);
						return (
							<div
								className="relative grid min-h-24 grid-cols-7 border-b border-line last:border-b-0"
								key={w}
								style={{
									gridTemplateRows: `1.75rem repeat(${shownLanes + 1}, minmax(1.5rem, auto))`,
								}}
							>
								{days.map((d, n) => (
									// biome-ignore lint/a11y/noStaticElementInteractions: a drop target for dragging an entry to another day; its date field changes the day by keyboard
									<div
										className={cn(
											"border-l border-line first:border-l-0",
											d.slice(0, 7) !== month.slice(0, 7) && "bg-surface-2/40",
											over === d && "bg-hover",
										)}
										key={d}
										onDragLeave={() => setOver(null)}
										onDragOver={(e) => {
											if (!drag) return;
											e.preventDefault();
											setOver(d);
										}}
										onDrop={(e) => {
											e.preventDefault();
											drop(d);
											setDrag(null);
											setOver(null);
										}}
										style={{ gridColumn: n + 1, gridRow: `1 / span ${shownLanes + 2}` }}
									>
										<span
											className={cn(
												"m-1 inline-flex size-6 items-center justify-center rounded-full text-xs tabular-nums",
												d === today ? "bg-ink font-medium text-ink-text" : "text-muted-foreground",
											)}
										>
											{+d.slice(8, 10)}
										</span>
									</div>
								))}
								{pos
									.filter((p) => p.lane < MAX_LANES)
									.map((p) => (
										<a
											className={cn(
												"z-[1] mx-1 my-px flex min-w-0 items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-xs",
												p.span.start === p.span.end
													? "border-line bg-surface shadow-sm hover:bg-hover"
													: SPAN,
												ms(p.span.start) < ms(w) && "ml-0 rounded-l-none border-l-0",
												ms(p.span.end) > ms(end) && "mr-0 rounded-r-none border-r-0",
											)}
											draggable={!!writable(p.item, key, ctx)}
											href={itemHref(p.item.id)}
											key={p.item.id}
											onDragEnd={() => setDrag(null)}
											onDragStart={(e) => {
												e.dataTransfer.setData("orbis/item", p.item.id);
												setDrag({ id: p.item.id, from: days[p.s]! });
											}}
											style={{ gridColumn: `${p.s + 1} / ${p.e + 2}`, gridRow: p.lane + 2 }}
											title={p.item.title}
										>
											<ItemIcon className="shrink-0" item={p.item} size={12} />
											<span className="truncate">{titleOf(p.item, t)}</span>
										</a>
									))}
								{days.map((d, n) => {
									const more = pos.filter(
										(p) => p.lane >= MAX_LANES && p.s <= n && p.e >= n,
									).length;
									return more ? (
										<span
											className="z-[1] mx-1.5 text-xs text-muted-foreground"
											key={`m${d}`}
											style={{ gridColumn: n + 1, gridRow: MAX_LANES + 2 }}
										>
											{t("cal.more", { count: more })}
										</span>
									) : null;
								})}
							</div>
						);
					})}
				</div>
			</div>
			<Undated items={undated} label={t("view.undated", { count: undated.length })} />
		</div>
	);
}

function Undated({ items, label }: { items: Item[]; label: string }) {
	const [open, setOpen] = useState(false);
	if (!items.length) return null;
	return (
		<div className="mt-3 text-sm">
			<Button
				aria-expanded={open}
				className="tap-y flex items-center gap-1.5 text-muted-foreground hover:text-fg"
				onClick={() => setOpen(!open)}
				variant="plain"
			>
				{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {label}
			</Button>
			{open && (
				<ul className="mt-1 space-y-1 pl-5">
					{items.map((i) => (
						<li key={i.id}>
							<ItemLink item={i} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

const SPAN =
	"border-focus/40 bg-[color-mix(in_srgb,var(--focus)_14%,var(--surface))] hover:bg-[color-mix(in_srgb,var(--focus)_22%,var(--surface))]";

type Scale = "week" | "month";
const PX: Record<Scale, number> = { week: 28, month: 7 }; // pixels per day

/** Dragging a bar moves start and end; dragging its edges changes one of them. */
export function TimelineView({
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
	const { t, lang } = useT();
	const key = dateKey(def, items, ctx, look?.tab?.date);
	const today = todayISO();
	const [scale, setScale] = useLocalStorage<Scale>(KEYS.timelineScale, "week");
	const px = PX[scale];
	// while dragging: the changed span of one entry, written on release
	const [live, setLive] = useState<{ id: string; span: Span } | null>(null);
	const placed = new Map<string, Span>();
	if (key)
		for (const i of items) {
			const span = spanOf(i, key, ctx);
			if (span) placed.set(i.id, span);
		}
	const undated = items.filter((i) => !placed.has(i.id));
	const spans = [...placed.values()];
	// the shown range: all bars and today, with some room; at least three months
	const min = spans.reduce((m, s) => (ms(s.start) < ms(m) ? s.start : m), today);
	const max = spans.reduce((m, s) => (ms(s.end) > ms(m) ? s.end : m), today);
	const from = startOfWeek(addDays(min, -14), lang);
	const to = addDays(max, Math.max(30, 90 - diffDays(min, max)));
	const days = diffDays(from, to) + 1;
	const width = days * px;
	const scroller = useRef<HTMLDivElement>(null);
	const [scrollX, setScrollX] = useState(0);
	const narrow = useNarrow();
	// today in view, a bit from the left
	const todayScroll = Math.max(0, diffDays(from, today) * px - 160);
	// biome-ignore lint/correctness/useExhaustiveDependencies: jumps to today when the scale or the date field changes, not when moved bars shift today's offset
	useEffect(() => {
		const el = scroller.current;
		if (el) el.scrollLeft = todayScroll;
	}, [scale, key]);
	if (!key) return <p className="px-2 py-1.5 text-sm text-muted-foreground">{t("view.noDate")}</p>;
	const by = def.group;
	const tab = look?.tab;
	const dated = items.filter((i) => placed.has(i.id));
	const [groups, hiddenGroups] = by
		? splitHidden(
				groupItems(dated, by, ctx).filter((g) => g.items.length),
				tab,
			)
		: [[{ key: "", items: dated } as Group], []];
	const byLabel = by ? fieldLabel(by, t) : "";
	// the scale: month names (and week starts in the week scale)
	const ticks: { day: string; label: string; major: boolean }[] = [];
	for (let d = from; ms(d) <= ms(to); d = addDays(d, 1)) {
		if (d.endsWith("-01"))
			ticks.push({
				day: d,
				label: new Intl.DateTimeFormat(lang, {
					month: scale === "week" ? "long" : "short",
					year: d.slice(5, 7) === "01" || scale === "week" ? "numeric" : undefined,
					timeZone: "UTC",
				}).format(new Date(ms(d))),
				major: true,
			});
		// week starts, not right next to a month name
		else if (scale === "week" && weekday(d) === firstDay(lang) && +d.slice(8, 10) > 4)
			ticks.push({ day: d, label: String(+d.slice(8, 10)), major: false });
	}
	const drag = (item: Item, mode: "move" | "start" | "end", e: React.PointerEvent) => {
		if (!writable(item, key, ctx)) return;
		e.preventDefault();
		e.stopPropagation();
		const span0 = placed.get(item.id)!;
		const x0 = e.clientX;
		let span = span0;
		let moved = false;
		startPointerDrag(
			(ev) => {
				const days = Math.round((ev.clientX - x0) / px);
				if (days) moved = true;
				span = draggedSpan(span0, mode, days);
				setLive({ id: item.id, span });
			},
			() => {
				setLive(null);
				if (!moved) return void (mode === "move" && openItem(item.id));
				if (span.start !== span0.start || span.end !== span0.end) writeSpan(item, key, span, ctx);
			},
		);
	};
	const LEFT = narrow ? 130 : 220; // the names column; on a phone it leaves room for the bars
	const row = (i: Item) => {
		const span = live?.id === i.id ? live.span : placed.get(i.id)!;
		const left = diffDays(from, span.start) * px;
		const barWidth = (diffDays(span.start, span.end) + 1) * px;
		const canEdit = !!writable(i, key, ctx);
		return (
			<div
				className="group/row flex h-9 items-center border-b border-line hover:bg-hover"
				data-id={i.id}
				key={i.id}
			>
				<div
					className="sticky left-0 z-[2] flex h-full shrink-0 items-center gap-2 border-r border-line bg-bg px-2 group-hover/row:bg-hover"
					style={{ width: LEFT }}
				>
					<ItemIcon className="shrink-0" item={i} size={14} />
					<a className="truncate hover:underline" href={itemHref(i.id)}>
						{titleOf(i, t)}
					</a>
				</div>
				<div className="relative h-full" style={{ width }}>
					<div
						className={cn(
							"absolute top-1.5 flex h-6 items-center overflow-hidden whitespace-nowrap rounded-md border px-2 text-xs touch-none",
							SPAN,
							canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
						)}
						onPointerDown={(e) => drag(i, "move", e)}
						style={{ left, width: Math.max(barWidth, px) }}
						title={`${i.title} · ${span.start === span.end ? span.start : `${span.start} – ${span.end}`}`}
					>
						{canEdit && (
							<span
								aria-hidden
								className="absolute inset-y-0 left-0 w-2 cursor-ew-resize"
								onPointerDown={(e) => drag(i, "start", e)}
							/>
						)}
						{/* a long bar keeps its name in view while scrolling */}
						<span
							className="truncate"
							style={{ paddingLeft: Math.max(0, Math.min(scrollX - left, barWidth - 120)) }}
						>
							{titleOf(i, t)}
						</span>
						{canEdit && (
							<span
								aria-hidden
								className="absolute inset-y-0 right-0 w-2 cursor-ew-resize"
								onPointerDown={(e) => drag(i, "end", e)}
							/>
						)}
					</div>
				</div>
			</div>
		);
	};
	return (
		<div className="text-sm">
			<div className="mb-2 flex items-center gap-2">
				<Seg
					label={t("timeline.scale")}
					onChange={setScale}
					options={[
						{ value: "week", label: t("timeline.weeks") },
						{ value: "month", label: t("timeline.months") },
					]}
					value={scale}
				/>
				<Button
					className="tap rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-hover hover:text-fg"
					onClick={() => {
						if (scroller.current) scroller.current.scrollLeft = todayScroll;
					}}
					variant="plain"
				>
					{t("time.today")}
				</Button>
			</div>
			<div
				className="relative overflow-x-auto rounded-xl border border-line"
				onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}
				ref={scroller}
			>
				<div className="relative" style={{ width: width + LEFT }}>
					<div className="sticky top-0 z-[3] flex h-8 border-b border-line bg-surface-2/60 text-xs text-muted-foreground">
						<div
							className="sticky left-0 z-[2] shrink-0 border-r border-line bg-surface-2"
							style={{ width: LEFT }}
						/>
						<div className="relative" style={{ width }}>
							{ticks.map((k) => (
								<span
									className={cn(
										"absolute top-0 h-full whitespace-nowrap border-l pl-1 pt-1.5",
										k.major ? "border-line font-medium text-muted-foreground" : "border-line/50",
									)}
									key={k.day}
									style={{ left: diffDays(from, k.day) * px }}
								>
									{k.label}
								</span>
							))}
						</div>
					</div>
					<div
						aria-hidden
						className="pointer-events-none absolute bottom-0 top-0 z-[1] w-px bg-[var(--danger)] opacity-60"
						style={{ left: LEFT + diffDays(from, today) * px + px / 2 }}
					/>
					{groups.map((g) => (
						<div key={g.key || "_"}>
							{by && (
								<div className="sticky left-0 flex h-9 w-fit items-center gap-2 px-2">
									<GroupChip by={by} byLabel={byLabel} g={g} />
									<span className="text-xs tabular-nums text-muted-foreground">
										{g.items.length}
									</span>
								</div>
							)}
							{g.items.map(row)}
						</div>
					))}
				</div>
			</div>
			{by && (
				<HiddenGroups
					by={by}
					byLabel={byLabel}
					groups={hiddenGroups}
					onShow={look?.onLook ? (g) => look.onLook!(hiddenPatch(tab, g, false)) : undefined}
				/>
			)}
			<Undated items={undated} label={t("view.undatedRange", { count: undated.length })} />
		</div>
	);
}
