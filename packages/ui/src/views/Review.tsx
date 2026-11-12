// The inbox panel: the list on the left, the chosen entry on the right to read, edit and sort; on a
// phone the list, and the entry as a sheet over it. Sorting moves on to the next entry and the sorted
// one down under "Sorted" in the list, with its undo. The entry's card keeps one height, so the
// choices below it never move.

import type { Item } from "@obtion/core/model";
import { ArrowLeft, Check, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { replica, spaceById, useAccounts } from "../accounts";
import { openItem, useOnChange, useRepo } from "../hooks";
import { titleOf, useT } from "../i18n";
import { cn } from "../lib/utils";
import {
	closeShelf,
	dismissShelf,
	type InboxEntry,
	openShelf,
	useInboxItems,
	useLaterItems,
	useShelf,
} from "../ui/inbox";
import { NoteCard } from "../ui/NoteCard";
import { Button, Empty, IconButton } from "../ui/primitives";
import { backNow, InboxList } from "../ui/Shelf";
import { SortChoices } from "../ui/SortChoices";
import { SpaceScope } from "../ui/Spaces";
import { KEYS, readJSON, writeJSON } from "../ui/storage";
import { revert, type Undo, usePickers, useTriageActions } from "../ui/TriageActions";

interface Sorted {
	key: string;
	title: string;
	what: string;
	undo: Undo;
}

/** The sorting on this device: kept while the panel is closed. What was sorted stays, also across a reload and into tomorrow, until "Fertig" or cleared by hand. */
let session: { order: string[]; at?: string } | null = null;
const storedSorted = () => readJSON<Sorted[]>(KEYS.inboxSorted, []);

/** Pixels the arrow keys scroll a long entry. */
const ARROW_SCROLL = 80;
/** Pixels a swipe on a phone must travel to step to the next entry. */
const SWIPE = 70;
/** Above this many entries the progress is a bar instead of steps. */
const MAX_STEPS = 16;
/** An open dialog or menu (a tooltip's popper does not count): Escape is theirs. */
const OVERLAY_OPEN =
	"[role=dialog][data-state=open], [data-radix-popper-content-wrapper]:not(:has([role=tooltip]))";

/** Pinned (on desktop Heute) it is part of the page: no close, and the keys only while the focus is in it. */
export function InboxPanel({ desktop, pinned }: { desktop: boolean; pinned?: boolean }) {
	const { t } = useT();
	const { at } = useShelf();
	const self = useRef<HTMLDivElement>(null);
	// take the keys from the button that opened the panel
	const focusOnOpen = useEffectEvent(() => {
		if (!pinned) self.current?.focus();
	});
	useEffect(() => focusOnOpen(), []);
	useEffect(() => {
		if (pinned) return;
		const was = document.title;
		document.title = t("review.title");
		return () => {
			document.title = was;
		};
	}, [pinned, t]);
	// on a phone the list, an entry over it as a sheet
	const sheet = !desktop && !!at;
	return (
		<div
			className={cn(
				"flex flex-col overflow-hidden border border-line bg-surface outline-none",
				pinned
					? "h-full rounded-2xl shadow-[0_6px_24px_-12px_rgb(0_0_0/0.25)]"
					: cn(
							"shadow-[0_18px_50px_-12px_rgb(0_0_0/0.45)]",
							desktop
								? "h-[min(900px,calc(100dvh-150px))] rounded-2xl"
								: sheet
									? "h-full rounded-t-2xl"
									: "max-h-[min(70dvh,560px)] rounded-2xl",
						),
			)}
			data-shelf-panel={pinned ? "pinned" : "open"}
			// a link inside leads away: the panel closes behind it
			onClickCapture={(e) => (e.target as HTMLElement).closest("a[href]") && closeShelf()}
			ref={self}
			// pinned it is part of the tray's region, else a dialog over the page
			{...(pinned ? {} : { "aria-label": t("review.title"), role: "dialog" })}
			tabIndex={-1}
		>
			{!desktop && (
				<div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line" />
			)}
			<Inbox at={at} desktop={desktop} panel={self} pinned={!!pinned} />
		</div>
	);
}

/** A key that belongs to a field, or to a menu or dialog above the panel. */
function othersKey(el: Element) {
	if (el.closest("input, textarea, select, [contenteditable=true], .cm-editor")) return true;
	const layer = el.closest("[role=dialog], [role=menu], [role=listbox]");
	return !!layer && !layer.hasAttribute("data-shelf-panel");
}

/** `at`: the entry asked for, "<workspace>/<id>" (a card on Heute, a row on a phone). */
function Inbox({
	at,
	desktop,
	pinned,
	panel,
}: {
	at?: string;
	desktop: boolean;
	pinned: boolean;
	panel: React.RefObject<HTMLDivElement | null>;
}) {
	const { t } = useT();
	const entries = useInboxItems();
	const later = useLaterItems();
	const { shown } = useAccounts();
	const order = useRef<string[]>(session?.order ?? []);
	// what arrives meanwhile joins the end
	for (const e of entries) if (!order.current.includes(e.key)) order.current.push(e.key);
	const [sorted, setSorted] = useState<Sorted[]>(storedSorted);
	const [chosen, setChosen] = useState<string | undefined>(at ?? session?.at);
	// another entry asked for while open
	useEffect(() => {
		if (at) setChosen(at);
	}, [at]);
	const card = useRef<HTMLDivElement>(null);
	const byKey = new Map([...entries, ...later].map((e) => [e.key, e]));
	// set aside till tomorrow and back in the inbox now: waiting again, no longer sorted
	const due = sorted.filter(
		(s) =>
			s.undo.steps.some((step) => step.later !== undefined) && entries.some((e) => e.key === s.key),
	);
	useOnChange(due.length, () => {
		if (due.length) setSorted((list) => list.filter((s) => !due.includes(s)));
	});
	const done = (k: string) => sorted.some((s) => s.key === k && !due.includes(s));
	const left = order.current.filter((k) => entries.some((e) => e.key === k) && !done(k));
	// back tomorrow and not just sent there here (that one is under "Sorted")
	const waitingLater = later.filter((e) => !done(e.key));
	const isLater = (k?: string) => !!k && waitingLater.some((e) => e.key === k);
	// the chosen entry while it still waits (also one back tomorrow), else the next one after its place
	const pickAt = (wanted?: string) =>
		wanted && (left.includes(wanted) || isLater(wanted))
			? wanted
			: (order.current
					.slice(order.current.indexOf(wanted ?? "") + 1)
					.find((k) => left.includes(k)) ?? left.at(-1));
	const key = pickAt(chosen);
	const entry = key ? byKey.get(key) : undefined;
	const waiting = isLater(key);
	// a phone shows the entry only when one was asked for
	const listOnly = !desktop && !at;
	useEffect(() => {
		session = { order: order.current, at: key };
	}, [key]);
	useEffect(() => writeJSON(KEYS.inboxSorted, sorted), [sorted]);

	const act = useTriageActions(() => entry!.space, { quiet: true });
	const record = (target: InboxEntry, what: string, undo?: Undo | null) => {
		if (!undo) return;
		const title = replica(target.space).repo.get(target.item.id)?.title ?? target.item.title; // may have just been edited
		setSorted((list) => [
			...list.filter((s) => s.key !== target.key),
			{ key: target.key, title: titleOf({ title, file: target.item.file }, t), what, undo },
		]);
		setChosen(target.key);
	};
	const placeIn = (list: Item[], place: string) =>
		entry &&
		record(
			entry,
			`→ ${replica(entry.space).repo.index().get(place)?.title ?? ""}`,
			act.place(list, place),
		);
	const typeAs = (list: Item[], type: string) =>
		entry &&
		record(entry, replica(entry.space).repo.index().typeName(type) ?? "", act.giveType(list, type));
	const pick = usePickers(() => entry!.space, placeIn, typeAs);
	const later_ = () =>
		entry &&
		(waiting
			? backNow(replica(entry.space).repo, entry.item.id)
			: record(entry, t("review.done.later"), act.later([entry.item])));
	const pin = () => entry && record(entry, t("review.done.pinned"), act.pin([entry.item]));
	const trash = () =>
		entry &&
		void act.trash([entry.item]).then((back) => record(entry, t("review.done.trashed"), back));
	const undo = (target = sorted.at(-1)) => {
		if (!target) return;
		revert(target.undo);
		setSorted((list) => list.filter((s) => s !== target));
		setChosen(target.key);
	};
	const choose = (k: string) => {
		setChosen(k);
		if (!desktop) openShelf(k);
	};
	const step = (direction: 1 | -1) => {
		const index = key ? left.indexOf(key) : -1;
		const next = left[index + direction];
		if (next) setChosen(next);
	};
	const finish = () => {
		session = null;
		writeJSON(KEYS.inboxSorted, []); // closing unmounts before the effect would store it
		setSorted([]);
		dismissShelf();
	};

	// on the window in the capture phase, so the page below the panel does not get the keys
	const keys = useRef<(e: KeyboardEvent) => void>(null);
	keys.current = (e) => {
		const el = e.target as HTMLElement;
		// pinned the panel is part of the page: its keys only while the focus is in it
		if (pinned && !panel.current?.contains(document.activeElement)) return;
		// in the title or the text the keys are theirs (Esc: below, after the editor)
		if (pick.placing || pick.typing || othersKey(el) || e.metaKey || e.ctrlKey || e.altKey) return;
		const pressed = e.key;
		// Enter on a button or link is its own; Tab moves the focus
		if ((pressed === "Enter" && el.closest("button, a")) || pressed === "Tab") return;
		// a menu or popover open above (a tooltip aside) gets its own Esc
		if (pressed === "Escape" && document.querySelector(OVERLAY_OPEN)) return;
		if (listOnly && pressed !== "Escape") return;
		e.stopPropagation();
		const isNote = entry?.item.kind === "note";
		if (pressed === "Escape") {
			if (!desktop && at) openShelf();
			else if (!pinned) dismissShelf();
			else return;
		} else if (pressed === "u" || pressed === "z") undo();
		else if (!entry) return;
		else if (pressed === "e") pick.setPlacing([entry.item]);
		else if (pressed === "y" && isNote) pick.setTyping([entry.item]);
		else if (pressed === "s") later_();
		else if (pressed === "a") pin();
		else if (pressed === "x" || pressed === "Delete") trash();
		else if (pressed === "ArrowDown" || pressed === "ArrowUp")
			card.current?.scrollBy({ top: pressed === "ArrowDown" ? ARROW_SCROLL : -ARROW_SCROLL });
		else if (pressed === "j" || pressed === "ArrowRight") step(1);
		else if (pressed === "k" || pressed === "ArrowLeft") step(-1);
		else if (pressed === "Enter" || pressed === "o") {
			closeShelf();
			openItem(entry.item.id, { space: entry.space });
		} else return;
		e.preventDefault();
	};
	// Esc leaves the title or the text, unless the editor used it (its completions close first); the keys are the panel's again (pinned: only with the focus in it)
	const onEscapeKey = useRef<(e: KeyboardEvent) => void>(null);
	onEscapeKey.current = (e) => {
		const el = document.activeElement as HTMLElement | null;
		if (
			e.key === "Escape" &&
			!e.defaultPrevented &&
			!pick.placing &&
			!pick.typing &&
			el &&
			card.current?.contains(el)
		) {
			e.preventDefault();
			el.blur();
			panel.current?.focus();
		}
	};
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => keys.current?.(e);
		const onEscape = (e: KeyboardEvent) => onEscapeKey.current?.(e);
		addEventListener("keydown", onKey, true);
		addEventListener("keydown", onEscape);
		return () => {
			removeEventListener("keydown", onKey, true);
			removeEventListener("keydown", onEscape);
		};
	}, []);

	const total = sorted.length + left.length;
	const several = shown.length > 1;
	const touchX = useRef<number | null>(null);
	const list = (
		<InboxList
			current={desktop ? key : undefined}
			later={waitingLater}
			onClear={() => setSorted([])}
			onPick={choose}
			onUndo={(k) => undo(sorted.find((s) => s.key === k))}
			sorted={sorted}
			waiting={left.map((k) => byKey.get(k)!)}
		/>
	);
	const head = (
		<ReviewHead
			at={entry && !waiting ? sorted.length + 1 : total}
			onBack={desktop ? undefined : () => openShelf()}
			onClose={pinned ? undefined : dismissShelf}
			sorted={sorted.length}
			total={total}
		/>
	);
	const body = entry ? (
		<SpaceScope id={entry.space}>
			<Entry
				entry={entry}
				key={entry.key}
				scroller={card}
				space={several ? spaceById(entry.space)?.name : undefined}
			/>
			<SortChoices
				className="mt-6"
				item={entry.item}
				keys={desktop}
				onLater={later_}
				onPick={() => pick.setPlacing([entry.item])}
				onPin={pin}
				onTrash={trash}
				onTypes={() => pick.setTyping([entry.item])}
				waiting={waiting}
			/>
		</SpaceScope>
	) : (
		<Finished count={sorted.length} onDone={pinned ? undefined : finish} />
	);

	if (listOnly)
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				{list}
				{pick.node}
			</div>
		);
	if (!desktop)
		return (
			<div
				className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 pb-4 pt-2"
				onTouchEnd={(e) => {
					const dx = (e.changedTouches[0]?.clientX ?? 0) - (touchX.current ?? 0);
					if (touchX.current !== null && Math.abs(dx) > SWIPE) step(dx < 0 ? 1 : -1);
					touchX.current = null;
				}}
				// a swipe steps to the next entry, but not one in the title or the text (it selects there)
				onTouchStart={(e) =>
					(touchX.current = othersKey(e.target as Element) ? null : e.touches[0]!.clientX)
				}
			>
				{head}
				<div className="mt-4 flex min-h-0 flex-1 flex-col">{body}</div>
				{/* below, so nothing above moves */}
				{sorted.length > 0 && <LastSorted last={sorted.at(-1)!} onUndo={() => undo()} />}
				{pick.node}
			</div>
		);
	return (
		<div className="flex min-h-0 flex-1">
			<div className="flex w-[280px] shrink-0 flex-col border-r border-line">{list}</div>
			<div className="flex min-w-0 flex-1 flex-col p-6">
				{head}
				<div className="mt-5 flex min-h-0 flex-1 flex-col">{body}</div>
			</div>
			{pick.node}
		</div>
	);
}

function ReviewHead({
	total,
	at,
	sorted,
	onBack,
	onClose,
}: {
	total: number;
	at: number;
	sorted: number;
	onBack?: () => void;
	onClose?: () => void;
}) {
	const { t } = useT();
	return (
		<header className="shrink-0">
			<div className="flex items-center gap-3">
				{onBack && (
					<IconButton
						className="-ml-1.5 shrink-0"
						icon={ArrowLeft}
						iconSize={16}
						label={t("tray.title")}
						onClick={onBack}
						title={t("tray.title")}
					/>
				)}
				<div className="min-w-0 flex-1">
					<h2 className="truncate text-lg font-semibold leading-6">{t("review.heading")}</h2>
					<p className="truncate text-[13px] tabular-nums text-muted-foreground">
						{total ? t("review.position", { at, count: total }) : t("review.empty")}
					</p>
				</div>
				{onClose && (
					<IconButton
						className="shrink-0 self-start"
						icon={X}
						iconSize={16}
						label={t("review.close")}
						onClick={onClose}
						title={t("review.close")}
					/>
				)}
			</div>
			{total > 0 && <Steps done={sorted} total={total} />}
		</header>
	);
}

function Steps({ total, done }: { total: number; done: number }) {
	const { t } = useT();
	const label = t("review.position", { at: Math.min(done + 1, total), count: total });
	if (total > MAX_STEPS)
		return (
			<div
				aria-label={label}
				aria-valuemax={total}
				aria-valuemin={0}
				aria-valuenow={done}
				className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-2 dark:bg-hover"
				role="progressbar"
			>
				<div
					className="h-full rounded-full bg-[var(--ok)]"
					style={{ width: `${(done / total) * 100}%` }}
				/>
			</div>
		);
	return (
		<div
			aria-label={label}
			aria-valuemax={total}
			aria-valuemin={0}
			aria-valuenow={done}
			className="mt-4 flex gap-1"
			role="progressbar"
		>
			{Array.from({ length: total }, (_, n) => (
				<span
					className={cn(
						"h-1 flex-1 rounded-full",
						n < done ? "bg-[var(--ok)]" : n === done ? "bg-inbox" : "bg-line",
					)}
					// biome-ignore lint/suspicious/noArrayIndexKey: a segment is its position in the bar
					key={n}
				/>
			))}
		</div>
	);
}

/** The entry's card, as tall as the panel leaves, the same for every entry, so the choices below never move. */
function Entry({
	entry,
	space,
	scroller,
}: {
	entry: InboxEntry;
	space?: string;
	scroller: React.RefObject<HTMLDivElement | null>;
}) {
	const item = useRepo().get(entry.item.id) ?? entry.item;
	return (
		<NoteCard
			className="flex-1"
			item={item}
			meta={space && <span>{space}</span>}
			scroller={scroller}
		/>
	);
}

/** The phone's "Done" in place of the list. */
function LastSorted({ last, onUndo }: { last: Sorted; onUndo: () => void }) {
	const { t } = useT();
	return (
		<div
			aria-live="polite"
			className="mt-4 flex items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--ok)_35%,transparent)] bg-[color-mix(in_srgb,var(--ok)_8%,transparent)] px-3 py-2 text-[13px]"
		>
			<Check className="shrink-0 text-ok" size={15} />
			<span className="min-w-0 flex-1 truncate">
				{last.title} <span className="text-muted-foreground">· {last.what}</span>
			</span>
			<Button
				className="tap shrink-0 font-medium text-link hover:underline"
				onClick={onUndo}
				variant="plain"
			>
				{t("triage.undo")}
			</Button>
		</div>
	);
}

function Finished({ count, onDone }: { count: number; onDone?: () => void }) {
	const { t } = useT();
	return (
		<div className="flex flex-1 flex-col justify-center rounded-2xl border border-line bg-surface">
			<Empty
				icon={<Check className="text-ok" size={22} />}
				title={count ? t("review.finished", { count }) : t("inbox.empty")}
			>
				{onDone && (
					<Button className="mt-2" onClick={onDone} variant="primary">
						{t("review.finish")}
					</Button>
				)}
			</Empty>
		</div>
	);
}
