// The inbox panel, where the user works: the list on the left, the chosen entry on the right to
// read, edit and sort; on a phone the list, and the entry as a sheet over it. Sorting, typing and
// pinning happen in place, the entry stays. "Done", "Tomorrow" and "Delete" move on to the next
// entry and the one left down under "Done" in the list, with its undo. The list shows all entries
// or only the to-dos, ticked off right there. The entry's card keeps one height, so the choices
// below it never move.

import type { Item } from "@orbis/core/model";
import { canCheckOff } from "@orbis/core/placement";
import { ArrowLeft, Check, ChevronDown, Layers, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { replica, spaceById, useAccounts } from "../accounts";
import { isBlank } from "../actions";
import { openItem, useOnChange, useRepo } from "../hooks";
import { titleOf, useT } from "../i18n";
import { cn } from "../lib/utils";
import {
	closeShelf,
	dismissShelf,
	dropDraft,
	entryKey,
	type InboxEntry,
	isTodo,
	newNote,
	newTodo,
	openShelf,
	todoType,
	useDraftKey,
	useInboxItems,
	useLaterItems,
	useShelf,
} from "../ui/inbox";
import { NoteCard } from "../ui/NoteCard";
import { Button, Empty, IconButton, MenuItem, Popover } from "../ui/primitives";
import { backNow, InboxList, type InboxView } from "../ui/Shelf";
import { SortChoices } from "../ui/SortChoices";
import { moveTo, SpaceScope } from "../ui/Spaces";
import { KEYS, readJSON, writeJSON } from "../ui/storage";
import { revert, type Undo, usePickers, useTriageActions } from "../ui/TriageActions";

interface Sorted {
	key: string;
	title: string;
	what: string;
	undo: Undo;
}

/** The work on this device: kept while the panel is closed. What was done stays, also across a reload and into tomorrow, until "Fertig" or cleared by hand. */
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

export function InboxPanel({ desktop }: { desktop: boolean }) {
	const { t } = useT();
	const { at } = useShelf();
	const self = useRef<HTMLDivElement>(null);
	// take the keys from the button that opened the panel (a new note keeps the caret in its title)
	const focusOnOpen = useEffectEvent(() => {
		if (!self.current?.contains(document.activeElement)) self.current?.focus();
	});
	useEffect(() => focusOnOpen(), []);
	useEffect(() => {
		const was = document.title;
		document.title = t("review.title");
		return () => {
			document.title = was;
		};
	}, [t]);
	// on a phone the list, an entry over it as a sheet
	const sheet = !desktop && !!at;
	return (
		<div
			aria-label={t("review.title")}
			className={cn(
				"flex flex-col overflow-hidden border border-line bg-surface shadow-[0_18px_50px_-12px_rgb(0_0_0/0.45)] outline-none",
				desktop
					? "h-[min(900px,calc(100dvh-150px))] rounded-2xl"
					: sheet
						? "h-full rounded-t-2xl"
						: "max-h-[min(70dvh,560px)] rounded-2xl",
			)}
			data-shelf-panel="open"
			// a link inside leads away: the panel closes behind it
			onClickCapture={(e) => (e.target as HTMLElement).closest("a[href]") && closeShelf()}
			ref={self}
			role="dialog"
			tabIndex={-1}
		>
			{!desktop && (
				<div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line" />
			)}
			<Inbox at={at} desktop={desktop} panel={self} />
		</div>
	);
}

/** A key that belongs to a field, or to a menu or dialog above the panel. */
function othersKey(el: Element) {
	if (el.closest("input, textarea, select, [contenteditable=true], .cm-editor")) return true;
	const layer = el.closest("[role=dialog], [role=menu], [role=listbox]");
	return !!layer && !layer.hasAttribute("data-shelf-panel");
}

/** `at`: the entry asked for, "<workspace>/<id>" (a row on a phone). */
function Inbox({
	at,
	desktop,
	panel,
}: {
	at?: string;
	desktop: boolean;
	panel: React.RefObject<HTMLDivElement | null>;
}) {
	const { t } = useT();
	const entries = useInboxItems();
	const later = useLaterItems();
	const { shown } = useAccounts();
	const drafting = useDraftKey();
	const order = useRef<string[]>(session?.order ?? []);
	// what arrives meanwhile joins the end, a new note the top
	for (const e of entries)
		if (!order.current.includes(e.key))
			e.key === drafting ? order.current.unshift(e.key) : order.current.push(e.key);
	const [sorted, setSorted] = useState<Sorted[]>(storedSorted);
	const [chosen, setChosen] = useState<string | undefined>(at ?? session?.at);
	const [chosenView, setViewNow] = useState<InboxView>(() =>
		readJSON<InboxView>(KEYS.inboxView, "all") === "todos" ? "todos" : "all",
	);
	// to-dos need a type with a status in one of the workspaces shown
	const canTodo = shown.some((s) => todoType(replica(s.id).repo.index()));
	const view = canTodo ? chosenView : "all";
	const setView = (v: InboxView) => {
		setViewNow(v);
		writeJSON(KEYS.inboxView, v);
	};
	// to-dos ticked off in the list: they left the inbox, but stay in the list until the panel closes
	const [ticked, setTicked] = useState<InboxEntry[]>([]);
	const todo = (e: InboxEntry) => isTodo(e.item, replica(e.space).repo.index());
	// another entry asked for while open
	useEffect(() => {
		if (at) setChosen(at);
	}, [at]);
	const card = useRef<HTMLDivElement>(null);
	const byKey = new Map([...entries, ...later].map((e) => [e.key, e]));
	// an entry asked for that is no to-do (a new note too) shows among all, once it is there
	const askedSeen = useRef<string | undefined>(undefined);
	useEffect(() => {
		const asked = at ? byKey.get(at) : undefined;
		if (!asked || at === askedSeen.current) return;
		askedSeen.current = at;
		if (view === "todos" && !todo(asked)) setView("all");
	});
	// back in the inbox (tomorrow has come, put in again on its page): waiting again, no longer done
	const due = sorted.filter((s) => entries.some((e) => e.key === s.key));
	useOnChange(due.length, () => {
		if (due.length) setSorted((list) => list.filter((s) => !due.includes(s)));
	});
	const done = (k: string) => sorted.some((s) => s.key === k && !due.includes(s));
	const shownHere = (k: string) => view === "all" || todo(byKey.get(k)!);
	const left = order.current.filter(
		(k) => entries.some((e) => e.key === k) && !done(k) && shownHere(k),
	);
	// back tomorrow and not just sent there here (that one is under "Sorted")
	const waitingLater = later.filter((e) => !done(e.key) && shownHere(e.key));
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
	// on from the new note: left empty, it goes
	const shownKey = useRef(key);
	useEffect(() => {
		if (shownKey.current === drafting && key !== drafting) dropDraft();
		shownKey.current = key;
	}, [key, drafting]);
	useEffect(() => writeJSON(KEYS.inboxSorted, sorted), [sorted]);

	// "Done", "Tomorrow" and "Delete" move on and show under "Done"; sorting stays, with a notice
	const act = useTriageActions(() => entry!.space, { quiet: true });
	const sort = useTriageActions(() => entry!.space);
	const record = (target: InboxEntry, what: string, undo?: Undo | null) => {
		if (!undo) return;
		const title = replica(target.space).repo.get(target.item.id)?.title ?? target.item.title; // may have just been edited
		setSorted((list) => [
			...list.filter((s) => s.key !== target.key),
			{ key: target.key, title: titleOf({ title, file: target.item.file }, t), what, undo },
		]);
		setChosen(target.key);
	};
	const placeIn = (list: Item[], place: string) => sort.place(list, place);
	const typeAs = (list: Item[], type: string) => sort.giveType(list, type);
	const pick = usePickers(() => entry!.space, placeIn, typeAs);
	const current = entry && (replica(entry.space).repo.get(entry.item.id) ?? entry.item);
	const canDone = !!current && canCheckOff(current, replica(entry!.space).repo.index());
	const checkOff = () =>
		current && canDone && record(entry!, t("review.done.checkedOff"), act.checkOff([current]));
	const later_ = () =>
		entry &&
		(waiting
			? backNow(replica(entry.space).repo, entry.item.id)
			: record(entry, t("review.done.later"), act.later([entry.item])));
	const pin = () => current && sort.pin([current]);
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
	const tick = (e: InboxEntry, done: boolean) => {
		if (done) setTicked((list) => [...list.filter((x) => x.key !== e.key), e]);
		else setTicked((list) => list.filter((x) => x.key !== e.key));
	};
	// a new to-do joins the top of the list, the caret stays in the field for the next
	const addTodo = (title: string) => {
		const k = newTodo(title);
		if (k) order.current.unshift(k);
		return !!k;
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
			else dismissShelf();
		} else if (pressed === "u" || pressed === "z") undo();
		else if (!entry) return;
		else if (pressed === "d") checkOff();
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
	// Esc leaves the title or the text, unless the editor used it (its completions close first); the keys are the panel's again
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
			canTodo={canTodo}
			count={entries.length}
			current={desktop ? key : undefined}
			later={waitingLater}
			onAddTodo={addTodo}
			onClear={() => setSorted([])}
			onPick={choose}
			onTick={tick}
			onUndo={(k) => undo(sorted.find((s) => s.key === k))}
			onView={setView}
			sorted={sorted}
			ticked={view === "todos" ? ticked.filter((e) => !byKey.has(e.key)) : []}
			todos={entries.filter(todo).length}
			view={view}
			waiting={left.map((k) => byKey.get(k)!)}
		/>
	);
	const head = (
		<ReviewHead
			at={entry && !waiting ? sorted.length + 1 : total}
			onBack={desktop ? undefined : () => openShelf()}
			onClose={dismissShelf}
			sorted={sorted.length}
			total={total}
		/>
	);
	const body = entry ? (
		<SpaceScope id={entry.space}>
			<Entry
				entry={entry}
				fresh={entry.key === drafting}
				key={entry.key}
				scroller={card}
				space={several ? spaceById(entry.space)?.name : undefined}
			/>
			<SortChoices
				canDone={canDone}
				className="mt-6"
				item={entry.item}
				keys={desktop}
				onDone={checkOff}
				onLater={later_}
				onPick={() => pick.setPlacing([entry.item])}
				onPin={pin}
				onTrash={trash}
				onTypes={() => pick.setTyping([entry.item])}
				waiting={waiting}
			/>
		</SpaceScope>
	) : (
		<Finished count={sorted.length} onDone={finish} todos={view === "todos"} />
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

/**
 * The entry's card, as tall as the panel leaves, the same for every entry, so the choices below never
 * move. `fresh`: the new note, the caret in its title, its workspace to choose.
 */
function Entry({
	entry,
	fresh,
	space,
	scroller,
}: {
	entry: InboxEntry;
	fresh: boolean;
	space?: string;
	scroller: React.RefObject<HTMLDivElement | null>;
}) {
	const item = useRepo().get(entry.item.id) ?? entry.item;
	return (
		<NoteCard
			autoFocus={fresh}
			className="flex-1"
			item={item}
			live={fresh}
			meta={space && (fresh ? <SpaceChoice entry={entry} name={space} /> : <span>{space}</span>)}
			scroller={scroller}
		/>
	);
}

/** Which workspace the new note goes to. Already written in, it moves there. */
function SpaceChoice({ entry, name }: { entry: InboxEntry; name: string }) {
	const { t } = useT();
	const { shown } = useAccounts();
	const choose = async (to: string) => {
		if (to === entry.space) return;
		writeJSON(KEYS.captureSpace, to);
		const from = replica(entry.space).repo;
		const item = from.get(entry.item.id);
		if (!item || isBlank(item, from.index())) return newNote(to);
		(document.activeElement as HTMLElement | null)?.blur();
		const moved = await moveTo(item.id, entry.space, to);
		if (moved) openShelf(entryKey(to, moved));
	};
	return (
		<Popover
			trigger={(p) => (
				<Button
					variant="plain"
					{...p}
					aria-label={t("capture.spaceLabel", { name })}
					className="tap-y inline-flex items-center gap-1 rounded-md px-1 hover:bg-hover hover:text-fg"
				>
					<Layers size={12} />
					{name}
					<ChevronDown size={12} />
				</Button>
			)}
		>
			{(close) =>
				shown.map((s) => (
					<MenuItem
						active={s.id === entry.space}
						key={s.id}
						onClick={() => {
							close();
							void choose(s.id);
						}}
					>
						{s.name}
					</MenuItem>
				))
			}
		</Popover>
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

function Finished({
	count,
	todos,
	onDone,
}: {
	count: number;
	todos: boolean;
	onDone?: () => void;
}) {
	const { t } = useT();
	return (
		<div className="flex flex-1 flex-col justify-center rounded-2xl border border-line bg-surface">
			<Empty
				icon={<Check className="text-ok" size={22} />}
				title={
					todos ? t("inbox.noTodos") : count ? t("review.finished", { count }) : t("inbox.empty")
				}
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
