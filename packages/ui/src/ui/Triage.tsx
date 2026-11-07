// "Sortieren" (design rules § 5) for any list or query block. An entry leaves the list as soon as
// it no longer matches the query.

import { DAY_MS } from "@obtion/core/date";
import type { Index } from "@obtion/core/graph";
import type { T } from "@obtion/core/i18n";
import { type Item, setMeta } from "@obtion/core/model";
import { belowOf } from "@obtion/core/placement";
import { ArrowRight, Check, FolderInput, Shapes, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { recentPlaces } from "../actions";
import { Checkbox } from "../components/ui/checkbox";
import {
	isTypingTarget,
	openItem,
	useDesktop,
	useIndex,
	useItemHref,
	useRepo,
	useSpaceId,
	useWindowKeys,
} from "../hooks";
import { titleOf, useT } from "../i18n";
import { cn, toggled } from "../lib/utils";
import { NOTE_ICON } from "./icons";
import { BelowList, ItemIcon, RelTime, Tag, TypeGlyph } from "./item-look";
import { Markdown } from "./Markdown";
import { Button, Card, Kbd } from "./primitives";
import { placeSuggestions } from "./suggest";
import { TagInput } from "./TagInput";
import { usePickers, useTriageActions } from "./TriageActions";
import { filePreview } from "./text";

/** Rows shown at first and added by "more". */
const PAGE = 60;
/** Places the detail offers to sort into. */
const MAX_PLACES = 4;

function ageGroup(created: number, now = Date.now()): "week" | "month" | "older" {
	const days = (now - created) / DAY_MS;
	return days <= 7 ? "week" : days <= 30 ? "month" : "older";
}

/** The agent's suggestion in words: its type and places ("Task · Relaunch"). */
function suggestionText(sug: NonNullable<Item["suggestion"]>, ix: Index): string {
	return [
		sug.type ? ix.typeName(sug.type) : null,
		...(sug.parents ?? []).map((p) => ix.get(p)?.title),
	]
		.filter(Boolean)
		.join(" · ");
}

/** The quiet hint of a row: the agent's suggestion, a mentioned place, or the notes bundled below. */
function rowHint(item: Item, ix: Index, t: T): { icon: React.ReactNode; text: string } | null {
	const sug = item.suggestion;
	if (sug) {
		const what = suggestionText(sug, ix);
		if (what) return { icon: <Sparkles size={12} />, text: what };
	}
	const mentioned = ix.items(ix.mentions(item)).find((x) => x.kind === "note");
	if (mentioned) return { icon: <ArrowRight size={12} />, text: mentioned.title };
	const kids = belowOf(item.id, ix).length;
	if (kids) return { icon: <NOTE_ICON size={12} />, text: t("triage.notes", { count: kids }) };
	return null;
}

/** The mark box: always in the same place, 16 in a 24 area (44 on touch). */
function MarkBox({ on, onToggle, title }: { on: boolean; onToggle: () => void; title: string }) {
	const { t } = useT();
	const id = useId();
	// a click here marks the entry, it does not select or open it (the row skips clicks from [data-mark])
	return (
		<label
			className="tap-edge relative flex size-6 shrink-0 cursor-pointer items-center justify-center"
			data-mark
			htmlFor={id}
		>
			<Checkbox
				aria-label={t("triage.markNamed", { title })}
				checked={on}
				className="size-4 cursor-pointer pointer-coarse:size-[18px]"
				id={id}
				onCheckedChange={onToggle}
			/>
		</label>
	);
}

/** The keys go to one list only (a page may show several): the one used last, else the first. */
let keyOwner: symbol | null = null;

const keyOf = (i: Item) => i.id;

export function Triage({ items }: { items: Item[] }) {
	const { t } = useT();
	const here = useSpaceId()!;
	const ix = useIndex();
	const spaceOf = (_: Item) => here;
	const phone = !useDesktop();
	const [sel, setSel] = useState(0);
	const [marked, setMarked] = useState<Set<string>>(new Set());
	const [limit, setLimit] = useState(PAGE);
	const act = useTriageActions(spaceOf);
	const pick = usePickers(spaceOf, act.place, act.giveType, () => setMarked(new Set()));
	const list = useRef<HTMLDivElement>(null);
	const me = useRef(Symbol()).current;
	const claim = () => {
		keyOwner = me;
	};
	useEffect(() => {
		keyOwner ??= me;
		return () => {
			if (keyOwner === me) keyOwner = null;
		};
	}, [me]);

	// what an action applies to: the marked entries, else the selected one
	const targets = (): Item[] => {
		const markedItems = items.filter((i) => marked.has(keyOf(i)));
		if (markedItems.length) return markedItems;
		return items[sel] ? [items[sel]!] : [];
	};
	const toggle = (id: string, on?: boolean) =>
		setMarked((m) => (on === undefined || on !== m.has(id) ? toggled(m, id) : m));
	const trash = (l: Item[]) => void act.trash(l).then((ok) => ok && setMarked(new Set()));

	useWindowKeys((e) => {
		if (
			keyOwner !== me ||
			pick.placing ||
			pick.typing ||
			isTypingTarget(e.target as Element) ||
			e.metaKey ||
			e.ctrlKey ||
			e.altKey
		)
			return;
		const cur = items[sel];
		const k = e.key;
		// Shift: marks the selected entry and the one it moves to
		const markOnTo = (n: number) => {
			if (cur) toggle(keyOf(cur), true);
			if (items[n]) toggle(keyOf(items[n]!), true);
			setSel(n);
		};
		if (k === "J" || (k === "ArrowDown" && e.shiftKey))
			markOnTo(Math.min(items.length - 1, sel + 1));
		else if (k === "K" || (k === "ArrowUp" && e.shiftKey)) markOnTo(Math.max(0, sel - 1));
		else if (k === "j" || k === "ArrowDown") setSel((s) => Math.min(items.length - 1, s + 1));
		else if (k === "k" || k === "ArrowUp") setSel((s) => Math.max(0, s - 1));
		else if (k === " " && cur) toggle(keyOf(cur));
		else if (k === "Escape" && marked.size) setMarked(new Set());
		else if (k === "e" && cur) pick.setPlacing(targets());
		else if (k === "c" && act.firstType(cur) && cur && new Set(targets().map(spaceOf)).size === 1) {
			act.giveType(targets(), act.firstType(cur)!);
			setMarked(new Set());
		} else if (k === "y" && cur) pick.setTyping(targets().filter((i) => i.kind === "note"));
		else if ((k === "x" || k === "Delete") && cur) trash(targets());
		else if (k === "u" || k === "z") act.undo();
		else if ((k === "Enter" || k === "o") && cur) openItem(cur.id, { space: spaceOf(cur) });
		else return;
		e.preventDefault();
	});
	useEffect(() => {
		// after an action the entry leaves: the selection stays at its place, so the next one is selected
		if (sel >= items.length && items.length) setSel(items.length - 1);
		list.current?.querySelector(`[data-triage="${sel}"]`)?.scrollIntoView({ block: "nearest" });
	}, [sel, items.length]);
	// marks of entries that left the list go with them
	useEffect(() => {
		const listed = (id: string) => items.some((i) => keyOf(i) === id);
		setMarked((marked) =>
			marked.size && [...marked].some((id) => !listed(id))
				? new Set([...marked].filter(listed))
				: marked,
		);
	}, [items]);

	const shown = items.slice(0, limit);
	const sorted = [...items].every((x, n, a) => n === 0 || a[n - 1]!.created >= x.created);
	const many = marked.size > 0 ? items.filter((i) => marked.has(keyOf(i))) : null;
	const current = items[sel];

	const rows = (
		<div
			aria-label={t("triage.list")}
			className="min-h-0 flex-1 overflow-y-auto"
			ref={list}
			role="listbox"
		>
			{shown.map((i, n) => {
				const g = ageGroup(i.created);
				const head = sorted && (n === 0 || ageGroup(shown[n - 1]!.created) !== g);
				const count = head ? shown.filter((x) => ageGroup(x.created) === g).length : 0;
				const hint = rowHint(i, ix, t);
				const on = n === sel && !phone;
				return (
					<div key={keyOf(i)}>
						{head && (
							<p className="px-3 pb-1 pt-3 text-xs font-semibold text-muted-foreground lg:pl-11">
								{t(`triage.age.${g}`)} <span className="font-normal tabular-nums">{count}</span>
							</p>
						)}
						{/* biome-ignore lint/a11y/useKeyWithClickEvents: the list's keys work at window level (useWindowKeys above), arrows and Enter included */}
						<div
							aria-selected={on}
							className={cn(
								"relative grid cursor-default items-center gap-x-2 px-3 hover:bg-hover",
								phone
									? "min-h-12 grid-cols-[44px_minmax(0,1fr)_auto] py-1.5"
									: "h-10 grid-cols-[24px_minmax(0,1fr)_auto_minmax(64px,auto)]",
								on &&
									"bg-selected before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r before:bg-focus",
							)}
							data-triage={n}
							onClick={(e) => {
								if ((e.target as Element).closest("[data-mark]")) return;
								if (phone) openItem(i.id, { space: here });
								else setSel(n);
							}}
							role="option"
							tabIndex={-1}
						>
							<MarkBox
								on={marked.has(keyOf(i))}
								onToggle={() => toggle(keyOf(i))}
								title={titleOf(i, t)}
							/>
							{phone ? (
								<span className="flex min-w-0 flex-col">
									<span className="truncate text-[15px]">{titleOf(i, t)}</span>
									{hint && (
										<span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
											<span className="shrink-0">{hint.icon}</span>
											<span className="truncate">{hint.text}</span>
										</span>
									)}
								</span>
							) : (
								<>
									<span className="truncate text-sm">{titleOf(i, t)}</span>
									<span className="flex max-w-[104px] items-center gap-1 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
										{hint && (
											<>
												<span className="shrink-0">{hint.icon}</span>
												<span className="truncate">{hint.text}</span>
											</>
										)}
									</span>
								</>
							)}
							<span className="whitespace-nowrap text-right text-xs text-muted-foreground">
								<RelTime ts={i.created} />
							</span>
						</div>
					</div>
				);
			})}
			{items.length > limit && (
				<Button
					className="w-full py-3 text-sm text-muted-foreground hover:text-fg"
					onClick={() => setLimit(limit + PAGE)}
					variant="plain"
				>
					{t("query.more", { count: items.length - limit })}
				</Button>
			)}
		</div>
	);

	// the bar over the list: order and key hint, or – with marked entries – what to do with them (same height)
	const bar = many ? (
		<div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-[color-mix(in_srgb,var(--focus)_8%,var(--surface))] px-3 text-[13px]">
			<MarkBox on onToggle={() => setMarked(new Set())} title={t("triage.unmark")} />
			<b className="whitespace-nowrap font-semibold">
				{t("triage.marked", { count: many.length })}
			</b>
			<span className="flex-1" />
			<Button
				className="h-7 px-2 text-[13px]"
				onClick={() => pick.setPlacing(many)}
				variant="outline"
			>
				<FolderInput size={14} /> {t("triage.place")}
			</Button>
			<Button
				aria-label={t("triage.type")}
				className="h-7 px-1.5"
				onClick={() => pick.setTyping(many.filter((i) => i.kind === "note"))}
				title={t("triage.type")}
			>
				<Shapes size={14} />
			</Button>
			<Button
				aria-label={t("triage.delete")}
				className="h-7 px-1.5"
				onClick={() => trash(many)}
				title={t("triage.delete")}
				variant="danger"
			>
				<Trash2 size={14} />
			</Button>
		</div>
	) : (
		<div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 text-[13px] text-muted-foreground">
			<span className="flex-1">{sorted ? t("triage.newestFirst") : ""}</span>
			{!phone && (
				<span className="flex items-center gap-1">
					<Kbd>j</Kbd> <Kbd>k</Kbd> {t("triage.keys.move")}
				</span>
			)}
		</div>
	);

	if (phone)
		return (
			<Card className="overflow-hidden" onPointerDownCapture={claim}>
				{many && bar}
				{rows}
				{pick.node}
			</Card>
		);
	return (
		<Card
			className="grid h-[calc(100dvh-170px)] min-h-[520px] grid-cols-[380px_minmax(0,1fr)] overflow-hidden"
			onFocusCapture={claim}
			onPointerDownCapture={claim}
		>
			<div className="flex min-h-0 min-w-0 flex-col border-r border-line">
				{bar}
				{rows}
			</div>
			<div className="flex min-h-0 min-w-0 flex-col">
				{many ? (
					<div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
						<h2 className="text-xl font-semibold">
							{t("triage.markedTitle", { count: many.length })}
						</h2>
						<ul className="mt-3 space-y-1 text-sm">
							{many.map((i) => (
								<li className="flex items-center gap-2" key={keyOf(i)}>
									<ItemIcon item={i} size={14} /> <span className="truncate">{titleOf(i, t)}</span>
								</li>
							))}
						</ul>
					</div>
				) : current ? (
					<Detail item={current} onPlaced={(p) => act.place([current], p)} />
				) : null}
				<ActionBar
					onPlace={() => pick.setPlacing(targets())}
					onToType={(type) => act.giveType(targets(), type)}
					onTrash={() => trash(targets())}
					onType={() => pick.setTyping(targets().filter((i) => i.kind === "note"))}
					toType={
						!many &&
						current?.kind === "note" &&
						act.firstType(current) &&
						act.firstType(current) !== current.type
							? act.firstType(current)
							: undefined
					}
				/>
			</div>
			{pick.node}
		</Card>
	);
}

/** The selected entry in full: title, when and what it mentions, the text, then what helps to decide. */
function Detail({ item, onPlaced }: { item: Item; onPlaced: (p: string) => void }) {
	const { t } = useT();
	const repo = useRepo();
	const hrefOf = useItemHref();
	const ix = repo.index();
	const mentioned = ix.items(new Set(ix.mentions(item))).filter((x) => x.kind === "note");
	const kids = belowOf(item.id, ix);
	const sug = item.suggestion;
	const places = useMemo(() => {
		const offered = placeSuggestions(item, repo)
			.slice(0, MAX_PLACES)
			.map((x) => ({ id: x.id, why: t(`triage.why.${x.reason}`) }));
		for (const id of recentPlaces(repo))
			if (
				offered.length < MAX_PLACES &&
				!offered.some((x) => x.id === id) &&
				id !== item.id &&
				!item.parents[id] &&
				!ix.wouldCycle(item.id, id)
			)
				offered.push({ id, why: t("triage.why.recent") });
		return offered;
	}, [item, repo, ix, t]);
	const dismissSuggestion = () => repo.change(item.id, (doc) => setMeta(doc, { suggestion: null }));
	const applySuggestion = () => {
		if (!sug) return;
		if (sug.type && ix.types.has(sug.type)) repo.setType(item.id, sug.type);
		for (const [prop, value] of Object.entries(sug.props ?? {})) repo.setProp(item.id, prop, value);
		for (const p of sug.parents ?? []) if (ix.get(p)) onPlaced(p);
		dismissSuggestion();
	};
	const section = "mt-5";
	const label = "mb-1.5 text-xs font-semibold text-muted-foreground";
	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
			<a
				className="block text-xl font-semibold leading-[26px] hover:underline"
				href={hrefOf(item.id)}
			>
				{titleOf(item, t)}
			</a>
			<p className="mt-1 text-xs text-muted-foreground">
				{t("triage.captured")} <RelTime ts={item.created} />
				{mentioned.length > 0 && (
					<> · {t("triage.mentions", { list: mentioned.map((m) => m.title).join(", ") })}</>
				)}
			</p>
			{item.body.trim() ? (
				<div className="mt-4 max-w-[64ch] text-[15px] leading-[1.65]">
					<Markdown src={item.body} />
				</div>
			) : item.file?.text ? (
				<p className="mt-4 max-w-[64ch] text-[15px] leading-[1.65] text-muted-foreground">
					{filePreview(item.file.text)}
				</p>
			) : null}
			<BelowList className={section} items={kids} />
			{item.tags.length > 0 && (
				<div className={section}>
					<p className={label}>{t("item.tags")}</p>
					<div className="flex flex-wrap items-center gap-1.5">
						{item.tags.map((x) => (
							<Tag key={x} onRemove={() => repo.setMember(item.id, "tags", x, false)} tag={x} />
						))}
						<TagInput exclude={item.tags} onAdd={(x) => repo.setMember(item.id, "tags", x, true)} />
					</div>
				</div>
			)}
			{sug && (
				<div className={section}>
					<p className={label}>{t("triage.fromAgent")}</p>
					<div className="flex flex-wrap items-center gap-2.5 rounded-[10px] bg-surface-2 px-3 py-2 text-sm">
						<Sparkles className="shrink-0 text-muted-foreground" size={15} />
						<span className="min-w-0 flex-1 basis-48">
							{suggestionText(sug, ix)}
							{sug.note && <span className="text-muted-foreground"> – {sug.note}</span>}
						</span>
						<Button
							className="h-7 shrink-0 px-2 text-[13px]"
							onClick={applySuggestion}
							variant="outline"
						>
							<Check size={13} /> {t("triage.accept")}
						</Button>
						<Button
							aria-label={t("triage.dismiss")}
							className="tap shrink-0 rounded p-1 text-faint hover:bg-hover hover:text-fg"
							onClick={dismissSuggestion}
							variant="plain"
						>
							<X size={14} />
						</Button>
					</div>
				</div>
			)}
			{places.length > 0 && (
				<div className={section}>
					<p className={label}>{t("triage.placeIn")}</p>
					<div className="flex flex-wrap gap-1.5">
						{places.map((p) => (
							<Button
								className="tap-y inline-flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 text-[13px] hover:bg-hover"
								key={p.id}
								onClick={() => onPlaced(p.id)}
								variant="plain"
							>
								<FolderInput className="text-muted-foreground" size={13} /> {ix.get(p.id)?.title}
								<span className="text-xs text-muted-foreground">{p.why}</span>
							</Button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

/** The fixed action bar under the detail: Place (primary), Choose type, To card, Delete; key hints below. */
function ActionBar({
	onPlace,
	onType,
	toType,
	onToType,
	onTrash,
}: {
	onPlace: () => void;
	onType: () => void;
	toType?: string;
	onToType: (t: string) => void;
	onTrash: () => void;
}) {
	const { t } = useT();
	const ix = useIndex();
	return (
		<div className="shrink-0 border-t border-line">
			<div className="flex items-center gap-1.5 px-7 py-3">
				<Button onClick={onPlace} variant="primary">
					<FolderInput size={15} /> {t("triage.place")} <Kbd>e</Kbd>
				</Button>
				<Button onClick={onType} variant="outline">
					{t("triage.type")} <Kbd>y</Kbd>
				</Button>
				{toType && (
					<Button onClick={() => onToType(toType)} variant="outline">
						<TypeGlyph schema={ix.types.get(toType)?.schema} size={14} />{" "}
						{t("triage.toType", { name: ix.typeName(toType) })} <Kbd>c</Kbd>
					</Button>
				)}
				<span className="flex-1" />
				<Button onClick={onTrash} variant="danger">
					<Trash2 size={15} /> {t("triage.delete")} <Kbd>x</Kbd>
				</Button>
			</div>
			<p className="flex flex-wrap gap-x-3 px-7 pb-3 text-xs text-muted-foreground">
				<span>
					<Kbd>j</Kbd> <Kbd>k</Kbd> {t("triage.keys.next")}
				</span>
				<span>
					<Kbd>{t("triage.keys.space")}</Kbd> {t("triage.keys.select")}
				</span>
				<span>
					<Kbd>u</Kbd> {t("triage.keys.undo")}
				</span>
			</p>
		</div>
	);
}
