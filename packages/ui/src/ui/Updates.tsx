// The side panel of a page: its updates (for types that have them; the newest also as one line in
// the page's head) and its "Verlauf", every change to it. On wide screens the panel sits beside the
// page (the page moves aside, both stay usable); on narrower ones it opens over the page, on phones
// from the bottom.

import { dateOf } from "@obtion/core/date";
import type { T } from "@obtion/core/i18n";
import { fmtRelative, fmtTime } from "@obtion/core/i18n";
import type { Item } from "@obtion/core/model";
import { statusProp } from "@obtion/core/traits";
import {
	byAgent,
	type FeedEntry,
	markRead,
	NOT_READ,
	type ReadMark,
	unread,
	updateFeed,
} from "@obtion/core/updates";
import { Bot, ChevronRight, History, MessageSquareText, Plus, Send, Trash2, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Checkbox } from "../components/ui/checkbox";
import { Dialog, DialogTitle, SheetContent } from "../components/ui/dialog";
import { NativeSelect } from "../components/ui/native-select";
import { Textarea } from "../components/ui/textarea";
import { itemHref, useIndex, useMediaQuery, useOnChange, usePhone, useSpaceId } from "../hooks";
import { useT } from "../i18n";
import { modName } from "../lib/platform";
import { cn } from "../lib/utils";
import { repo } from "../repo";
import { agentLabel, agentName } from "./AgentNotice";
import { DayList, META } from "./changes";
import { confirmAction, notify } from "./feedback";
import { ItemIcon, statusColor } from "./item-look";
import { PageHistory } from "./PageHistory";
import { Button, IconButton, Kbd, REVEAL, Seg } from "./primitives";
import { KEYS, readJSON, writeJSON } from "./storage";

/** Entries shown in the panel at first, and added with "Show older". */
const PAGE = 30;

/** From this width the panel docks beside the page instead of covering it. */
const DOCKED = "(min-width: 1440px)";

/** The updates (with those of the pages below or without), or every change to this page. */
type View = "updates" | "history";

/** What is being written, kept while the panel is closed so a click beside it loses nothing. */
type Draft = { text: string; status: string };

/** Who wrote an update: "Du", an import, or the agent's name. */
function authorLabel(by: string, t: T): string {
	if (by === "you") return t("updates.you");
	if (by.startsWith("import:")) return t("updates.import");
	return agentLabel(agentName(by) ?? by, t);
}

/** The status an update set, in the type of the page it was written on. */
function useStatusOption() {
	const ix = useIndex();
	return ({ u, from }: FeedEntry) =>
		u.status ? statusProp(ix.schemaOf(from))?.options?.find((o) => o.id === u.status) : undefined;
}
function useStatusName() {
	const option = useStatusOption();
	return (e: FeedEntry) => option(e)?.name;
}
/** The colour of the status an update set, as the status badge has it; none without one. */
function useStatusTone() {
	const option = useStatusOption();
	return (e: FeedEntry) => {
		const o = option(e);
		return o ? statusColor(o) : undefined;
	};
}

/** Where an update was written (when not on this page) and the status it set. */
function Origin({
	e,
	item,
	onLeave,
	className,
}: {
	e: FeedEntry;
	item: Item;
	onLeave?: () => void;
	className?: string;
}) {
	const { t } = useT();
	const status = useStatusName()(e);
	const tone = useStatusTone()(e);
	const other = e.from.id !== item.id;
	if (!other && !status) return null;
	const page = (
		<>
			<ItemIcon item={e.from} size={11} /> <span className="truncate">{e.from.title}</span>
		</>
	);
	return (
		// the outer span carries the "·" of META; a flex box would put its gap between "·" and the text
		<span className={cn("min-w-0 max-w-full", className)}>
			<span className="inline-flex min-w-0 max-w-full items-center gap-1">
				{other &&
					(onLeave ? (
						<a
							className="inline-flex min-w-0 max-w-[14rem] items-center gap-1 hover:text-fg hover:underline"
							href={itemHref(e.from.id)}
							onClick={onLeave}
						>
							{page}
						</a>
					) : (
						<span className="inline-flex min-w-0 max-w-[14rem] items-center gap-1">{page}</span>
					))}
				{status && (
					<span className="truncate" style={{ color: tone }}>
						{other ? `→ ${status}` : t("updates.statusTo", { name: status })}
					</span>
				)}
			</span>
		</span>
	);
}

/** Following an update's link with the panel docked: it stays open, nothing to do. */
const keepPanel = () => undefined;

const EMPTY: Draft = { text: "", status: "" };
/** The panel's view, kept from one opening to the next. */
let lastView: View = "updates";
/** The docked panel stays open from page to page until it is closed. */
let dockedOpen = false;
/** Pages holding the docked panel open; the page keeps its room while one hands over to the next. */
let rooms = 0;

/** What has been read of a page's updates on this device. */
function readMark(pageId: string): ReadMark {
	return readJSON<ReadMark>(KEYS.updatesSeen(pageId), NOT_READ);
}

/**
 * One opening of the panel: what was new then, what has been on screen since. `quiet`: opened
 * again by moving to another page with the panel docked, so no slide and the focus stays put.
 */
type Session = {
	openedAt: number;
	fresh: Set<string>;
	onScreen: Set<string>;
	quiet: boolean;
};

/**
 * The side panel of every page, and zone 1 of a page whose type has updates (`updates`): the newest
 * one. `bar`: the page's top bar, which stays in view; its buttons open the panel.
 */
export function PagePanel({
	item,
	bar,
	updates,
}: {
	item: Item;
	bar?: HTMLElement | null;
	updates: boolean;
}) {
	const { t, lang } = useT();
	const ix = useIndex();
	const docked = useMediaQuery(DOCKED);
	const feed = useMemo(() => updateFeed(ix, item.id), [ix, item.id]);
	// what has been read of each page of the feed (on this device): read once per change
	const [looked, setLooked] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `looked` counts closings; each one reads the marks from storage again
	const marks = useMemo(
		() => new Map([...new Set(feed.map((e) => e.from.id))].map((id) => [id, readMark(id)])),
		[feed, looked],
	);
	const news = unread(feed, (id) => marks.get(id) ?? NOT_READ);

	const [open, setOpen] = useState<false | "read" | "write">(false);
	const [round, setRound] = useState(0);
	// kept per page on this device: closing the panel, leaving the page or reloading loses nothing
	const [draft, setDraftState] = useState<Draft>(() =>
		readJSON<Draft>(KEYS.updatesDraft(item.id), EMPTY),
	);
	const setDraft = (d: Draft) => {
		setDraftState(d);
		if (d.text || d.status) writeJSON(KEYS.updatesDraft(item.id), d);
		else localStorage.removeItem(KEYS.updatesDraft(item.id));
	};
	const session = useRef<Session | null>(null);
	const feedNow = useRef(feed);
	feedNow.current = feed;
	const trigger = useRef<HTMLButtonElement>(null);
	// where the panel was opened from: the focus goes back there
	const from = useRef<HTMLElement | null>(null);
	const textId = useId();

	// the view as last chosen while the app is open (on another page, too); each way in picks its own
	const [chosen, setChosen] = useState<View>(lastView);
	const pick = (v: View) => {
		lastView = v;
		setChosen(v);
	};
	const current: View = updates ? chosen : "history";
	// already open: only the view changes
	const show = (mode: "read" | "write", quiet = false, view?: View) => {
		if (view) pick(view);
		if (session.current) return;
		from.current = quiet ? null : (document.activeElement as HTMLElement | null);
		session.current = {
			openedAt: Date.now(),
			fresh: new Set(news.map((e) => e.u.id)),
			onScreen: new Set(),
			quiet,
		};
		setRound((n) => n + 1);
		setOpen(mode);
	};
	// what has been on screen counts as read, one by one (core/updates.ts markRead)
	const commit = () => {
		const s = session.current;
		if (!s) return;
		session.current = null;
		const now = Date.now();
		for (const id of new Set(feedNow.current.map((e) => e.from.id)))
			writeJSON(KEYS.updatesSeen(id), markRead(feedNow.current, id, readMark(id), s.onScreen, now));
	};
	const close = () => {
		commit();
		dockedOpen = false;
		setLooked((n) => n + 1);
		setOpen(false);
	};
	// leaving the page with the panel open: what was read counts; docked, the next page opens it again
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per page, on arriving and on leaving; both work from refs
	useEffect(() => {
		if (dockedOpen && matchMedia(DOCKED).matches) show("read", true);
		return commit;
	}, []);
	useEffect(() => {
		if (open) dockedOpen = docked;
	}, [open, docked]);

	// docked: the page makes room for the panel
	const room = !!open && docked;
	useEffect(() => {
		if (!room) return;
		rooms++;
		document.documentElement.setAttribute("data-side-panel", "");
		return () => {
			rooms--;
			// moving to another page with the panel docked: the next page takes over without a jump
			setTimeout(() => rooms || document.documentElement.removeAttribute("data-side-panel"));
		};
	}, [room]);

	// the card shows the newest unread update, else the newest, and says which of the two it is;
	// while the panel is open, the panel shows what is new
	const fresh = open ? [] : news;
	const tone = useStatusTone();
	const latest = fresh[0] ?? feed[0];
	const status = latest?.u.status
		? statusProp(ix.schemaOf(latest.from))?.options?.find((o) => o.id === latest.u.status)?.name
		: undefined;
	const where =
		latest &&
		[
			latest.from.id !== item.id ? latest.from.title : "",
			status ? t("updates.statusTo", { name: status }) : "",
		]
			.filter(Boolean)
			.join(", ");
	return (
		<>
			{!updates ? null : latest ? (
				<Button
					aria-describedby={textId}
					aria-expanded={!!open}
					aria-haspopup="dialog"
					aria-label={[
						`${fresh.length ? t("updates.newOne") : t("updates.latest")}, ${fmtRelative(lang, latest.u.at)}, ${authorLabel(latest.u.by, t)}${where ? `, ${where}` : ""}`,
						fresh.length ? t("updates.newCount", { count: fresh.length }) : "",
						t("updates.openAll", { count: feed.length }),
					]
						.filter(Boolean)
						.join(". ")}
					// a card: what someone reported, apart from the page's own text
					className="group mt-5 flex w-full items-start gap-2.5 rounded-[10px] border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:bg-hover focus-visible:bg-hover"
					onClick={() => show("read", false, "updates")}
					ref={trigger}
					variant="plain"
				>
					<span className="min-w-0 flex-1">
						{/* what it is, in the colour of the status it set; a new one says so in green */}
						<span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
							<MessageSquareText aria-hidden size={13} style={{ color: tone(latest) }} />
							{fresh.length ? t("updates.newOne") : t("updates.latest")}
							{fresh.length > 0 && (
								<span className="normal-case tracking-normal text-ok">
									· {t("updates.newCount", { count: fresh.length })}
								</span>
							)}
						</span>
						<span className={cn(META, "mt-1")}>
							<time dateTime={new Date(latest.u.at).toISOString()}>
								{fmtRelative(lang, latest.u.at)}
							</time>
							<span>{authorLabel(latest.u.by, t)}</span>
							<Origin className="max-md:hidden" e={latest} item={item} />
						</span>
						{/* on phones the origin gets a row of its own, so no "·" starts a wrapped line */}
						<Origin
							className="mt-0.5 block text-xs text-muted-foreground md:hidden"
							e={latest}
							item={item}
						/>
						<span
							className="mt-0.5 line-clamp-2 text-sm text-fg [overflow-wrap:anywhere]"
							id={textId}
						>
							{latest.u.text}
						</span>
					</span>
					<span className="flex shrink-0 items-center gap-0.5 self-center whitespace-nowrap text-xs text-muted-foreground group-hover:text-fg">
						{feed.length > 1 && <span>{t("updates.all", { count: feed.length })}</span>}
						<ChevronRight aria-hidden size={14} />
					</span>
				</Button>
			) : (
				<Button
					aria-expanded={!!open}
					aria-haspopup="dialog"
					className="tap-y -ml-1.5 mt-3 flex h-7 items-center gap-1 rounded-md px-1.5 text-[13px] text-muted-foreground hover:bg-hover hover:text-fg"
					onClick={() => show("write", false, "updates")}
					ref={trigger}
					variant="plain"
				>
					<Plus aria-hidden size={14} /> {t("updates.first")}
				</Button>
			)}
			{round > 0 && (
				<UpdatesSheet
					docked={docked}
					draft={draft}
					feed={feed}
					item={item}
					key={round}
					onClose={close}
					onClosed={() =>
						(from.current?.isConnected ? from.current : trigger.current)?.focus({
							preventScroll: true,
						})
					}
					onDraft={setDraft}
					onView={pick}
					open={!!open}
					session={session.current}
					updates={updates}
					view={chosen}
					write={open === "write"}
				/>
			)}
			{bar &&
				createPortal(
					<>
						{updates && (
							<span className="relative inline-flex">
								<IconButton
									aria-expanded={!!open}
									aria-haspopup="dialog"
									className={cn(open && current === "updates" && "bg-hover text-fg")}
									icon={MessageSquareText}
									label={[
										t("updates.title"),
										fresh.length ? t("updates.newCount", { count: fresh.length }) : "",
									]
										.filter(Boolean)
										.join(", ")}
									onClick={() =>
										open && current === "updates"
											? close()
											: show(feed.length ? "read" : "write", false, "updates")
									}
								/>
								{fresh.length > 0 && (
									<span
										aria-hidden
										className="pointer-events-none absolute right-1 top-1 size-2 rounded-full border-2 border-surface bg-ok"
									/>
								)}
							</span>
						)}
						<IconButton
							aria-expanded={!!open}
							aria-haspopup="dialog"
							className={cn(open && current === "history" && "bg-hover text-fg")}
							icon={History}
							label={t("item.history")}
							onClick={() =>
								open && current === "history" ? close() : show("read", false, "history")
							}
						/>
					</>,
					bar,
				)}
		</>
	);
}

function UpdatesSheet({
	open,
	docked,
	item,
	updates: hasUpdates,
	view: chosen,
	onView,
	feed,
	session,
	write,
	draft,
	onDraft,
	onClose,
	onClosed,
}: {
	open: boolean;
	docked: boolean;
	item: Item;
	updates: boolean;
	view: View;
	onView: (v: View) => void;
	feed: FeedEntry[];
	session: Session | null;
	write: boolean;
	draft: Draft;
	onDraft: (d: Draft) => void;
	onClose: () => void;
	onClosed: () => void;
}) {
	const { t, lang } = useT();
	const tone = useStatusTone();
	// with the pages below or not as last chosen on this device
	const [withBelow, setWithBelow] = useState(() => readJSON<boolean>(KEYS.updatesWithBelow, true));
	const chooseBelow = (v: boolean) => {
		setWithBelow(v);
		writeJSON(KEYS.updatesWithBelow, v);
	};
	const space = useSpaceId();
	// without updates only the history; without a server no history
	const view: View = !hasUpdates ? "history" : space ? chosen : "updates";
	const [shown, setShown] = useState(PAGE);
	const [said, setSaid] = useState("");
	const panel = useRef<HTMLDivElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	// the portal mounts a moment after the panel opens: watch the list once it is there
	const [listBox, setListBox] = useState<HTMLDivElement | null>(null);
	const listRef = useCallback((el: HTMLDivElement | null) => {
		scroller.current = el;
		setListBox(el);
	}, []);
	// the marks of this opening, kept while the panel slides out; what arrives while it is open is new too
	const [fresh] = useState(() => session?.fresh ?? new Set<string>());
	const [openedAt] = useState(() => session?.openedAt ?? Date.now());
	const isNew = (e: FeedEntry) => fresh.has(e.u.id) || (byAgent(e.u.by) && e.u.at > openedAt);
	const quiet = !!session?.quiet;
	// "with the pages below" only where there are updates below
	const below = feed.some((e) => e.from.id !== item.id);
	const updates = feed.filter((e) => withBelow || !below || e.from.id === item.id);
	const list = view === "history" ? [] : updates;
	const visible = list.slice(0, shown);
	const firstNew = visible.find(isNew)?.u.id;
	// as many as the list holds: without the pages below, without theirs
	const count = updates.length > 0 && (
		<span className="ml-1 font-normal tabular-nums text-muted-foreground">{updates.length}</span>
	);
	const views: { value: View; label: ReactNode }[] = [
		{
			value: "updates",
			label: (
				<>
					{t("updates.title")}
					{count}
				</>
			),
		},
		{ value: "history", label: t("item.history") },
	];
	const visibleKey = visible.map((e) => e.u.id).join();

	// what scrolls into view counts as read, not what was merely rendered further down
	// biome-ignore lint/correctness/useExhaustiveDependencies: rows shown later (`visibleKey`) are watched too, so the observer starts again
	useEffect(() => {
		const root = listBox;
		if (!open || !session || !root) return;
		// read: half of it in view, or, taller than the list, half the list filled by it
		const watch = new IntersectionObserver(
			(seen) => {
				for (const e of seen) {
					const enough =
						e.intersectionRatio >= 0.5 || e.intersectionRect.height >= root.clientHeight / 2;
					if (e.isIntersecting && enough)
						session.onScreen.add((e.target as HTMLElement).dataset.update!);
				}
			},
			{ root, threshold: [0, 0.25, 0.5, 0.75, 1] },
		);
		for (const el of root.querySelectorAll("[data-update]")) watch.observe(el);
		return () => watch.disconnect();
	}, [open, session, visibleKey, listBox]);

	const emptyText = !feed.length ? t("updates.empty") : t("updates.emptyHere");
	// a live region only speaks when its text changes
	const say = (text: string) => {
		setSaid("");
		setTimeout(() => setSaid(text), 50);
	};
	// another view, also chosen from the page's buttons: from its top
	useOnChange(view, () => {
		setShown(PAGE);
		scroller.current?.scrollTo({ top: 0 });
	});
	// asked first; deleted, it is gone from the list and kept in the page's changes, and "Undo"
	// puts it back where it was
	const remove = async (e: FeedEntry) => {
		const text = e.u.text.length > 120 ? `${e.u.text.slice(0, 120)}…` : e.u.text;
		if (
			!(await confirmAction({
				title: t("updates.deleteAsk"),
				body: t("updates.deleteBody", { text }),
				yes: t("updates.deleteYes"),
				danger: true,
			}))
		)
			return;
		const back = repo.removeUpdate(e.from.id, e.u.id);
		if (!back) return;
		panel.current?.focus({ preventScroll: true });
		notify.undo(t("updates.deleted"), back);
	};
	const posted = () => {
		// the new update is the user's: show it, at the top
		if (view === "history") onView("updates");
		scroller.current?.scrollTo({ top: 0 });
		say(t("updates.posted"));
	};

	return (
		<Dialog modal={!docked} onOpenChange={(o) => !o && onClose()} open={open}>
			<SheetContent
				aria-describedby={undefined}
				className={quiet ? "data-[state=open]:animate-none" : undefined}
				modal={!docked}
				onCloseAutoFocus={(e) => {
					e.preventDefault();
					onClosed();
				}}
				onEscapeKeyDown={(e) =>
					docked && !panel.current?.contains(document.activeElement) && e.preventDefault()
				}
				// docked, the page beside it stays in use: a click there does not close the panel, nor does
				// Escape pressed in the page (an editor menu, a selection)
				onInteractOutside={(e) => docked && e.preventDefault()}
				onOpenAutoFocus={(e) => {
					// reading: focus the panel, not the text box (no keyboard popping up on phones); opened
					// again on another page: the focus stays where the user is
					if (write && !quiet) return;
					e.preventDefault();
					if (!quiet) (e.currentTarget as HTMLElement).focus();
				}}
				ref={panel}
				tabIndex={-1}
			>
				<div className="flex items-center gap-2 border-b border-line px-4 py-3">
					{/* the page it is about: what it holds, the bar below says */}
					<DialogTitle className="sr-only">
						{t(hasUpdates ? "updates.titleOf" : "history.title", {
							title: item.title || t("untitled"),
						})}
					</DialogTitle>
					<p className="flex min-w-0 flex-1 items-center gap-1.5 text-base font-semibold">
						<ItemIcon item={item} size={15} />
						<span className="truncate">{item.title || t("untitled")}</span>
					</p>
					<IconButton icon={X} label={t("close")} onClick={onClose} />
				</div>
				<p aria-live="polite" className="sr-only">
					{said}
				</p>
				{/* outside the list: it stays in reach however far the list is scrolled. Above, what is
            shown; beside it, which of it */}
				<div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 pb-1">
					{hasUpdates && space ? (
						<Seg label={t("updates.view.label")} onChange={onView} options={views} value={view} />
					) : (
						// one view only: named, as the bar would
						<span className="text-xs font-medium">
							{hasUpdates ? t("updates.title") : t("item.history")}
							{hasUpdates && count}
						</span>
					)}
					{view === "updates" && below && (
						<label className="tap-y ml-auto inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-fg">
							<Checkbox
								checked={withBelow}
								className="size-3.5"
								onCheckedChange={(c) => {
									chooseBelow(c === true);
									setShown(PAGE);
								}}
							/>
							{t("updates.withBelow")}
						</label>
					)}
				</div>
				{/* writing belongs to the updates, not above the history */}
				{view === "updates" && (
					<div className="border-b border-line px-4 pb-4 pt-2">
						<Composer
							autoFocus={write}
							draft={draft}
							item={item}
							onDraft={onDraft}
							onPosted={posted}
						/>
					</div>
				)}
				<div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-2" ref={listRef}>
					{view === "history" &&
						(space ? (
							<PageHistory item={item} space={space} />
						) : (
							<p className="pt-1 text-sm text-muted-foreground">{t("history.offline")}</p>
						))}
					{view === "updates" && !list.length && (
						<p className="pt-1 text-sm text-muted-foreground">{emptyText}</p>
					)}
					<DayList
						day={(e) => dateOf(e.u.at)}
						render={(e) => {
							const marked = isNew(e);
							return {
								key: e.u.id,
								dot: marked ? "bg-ok" : undefined,
								dotColor: marked ? undefined : tone(e),
								props: {
									"data-update": e.u.id,
									tabIndex: -1,
									className:
										"group relative rounded-sm outline-none transition-[background-color,box-shadow] duration-700 focus:bg-hover focus:shadow-[0_0_0_6px_var(--hover)]",
								},
								body: (
									<>
										<div className={cn(META, "pr-7")}>
											<time dateTime={new Date(e.u.at).toISOString()}>{fmtTime(lang, e.u.at)}</time>
											<span title={e.u.by}>
												<span className="inline-flex items-center gap-1">
													{byAgent(e.u.by) && <Bot aria-hidden size={12} />}
													{authorLabel(e.u.by, t)}
												</span>
											</span>
											{/* docked, following the link keeps the panel open beside the next page */}
											<Origin e={e} item={item} onLeave={docked ? keepPanel : onClose} />
											{/* the word once, at the first new one, explains the green dots */}
											{e.u.id === firstNew && (
												<span className="font-medium text-ok">{t("updates.new")}</span>
											)}
										</div>
										<IconButton
											className={cn("absolute right-0 top-0 hover:text-destructive", REVEAL.any)}
											icon={Trash2}
											iconSize={14}
											label={t("updates.delete")}
											onClick={() => remove(e)}
											size="sm"
										/>
										{marked && e.u.id !== firstNew && (
											<span className="sr-only">{t("updates.new")}</span>
										)}
										<div className="mt-0.5 whitespace-pre-wrap text-[15px] [overflow-wrap:anywhere]">
											{e.u.text}
										</div>
									</>
								),
							};
						}}
						rows={visible}
					/>
					{list.length > shown && (
						<Button
							className="tap-y mt-4 text-[13px] text-muted-foreground hover:text-fg"
							onClick={() => setShown(shown + PAGE)}
							variant="plain"
						>
							{t("updates.older", { count: list.length - shown })}
						</Button>
					)}
				</div>
			</SheetContent>
		</Dialog>
	);
}

/**
 * Write an update, optionally changing the page's status with it. Enter breaks the line, ⌘/Strg+Enter
 * posts. One line until it is used, so reading the updates below has the room.
 */
function Composer({
	item,
	draft,
	onDraft,
	autoFocus,
	onPosted,
}: {
	item: Item;
	draft: Draft;
	onDraft: (d: Draft) => void;
	autoFocus: boolean;
	onPosted: () => void;
}) {
	const { t, lang } = useT();
	const ix = useIndex();
	const statusProperty = statusProp(ix.schemaOf(item));
	const choices =
		statusProperty?.options?.filter((o) => o.id !== item.props[statusProperty.id]) ?? [];
	const box = useRef<HTMLTextAreaElement>(null);
	const hintId = useId();
	const phone = usePhone();
	// opens up once used and stays so while the panel is open: folding on blur would move what is
	// below it under the pointer, between press and release
	const [used, setUsed] = useState(autoFocus);
	const expanded = used || !!draft.text;
	const submit = () => {
		if (!draft.text.trim()) return;
		// the status chosen earlier may be the page's status by now
		const status = statusProperty && choices.some((o) => o.id === draft.status) ? draft.status : "";
		repo.addUpdate(
			item.id,
			draft.text.trim(),
			status ? { prop: statusProperty!.id, option: status } : undefined,
		);
		onDraft({ text: "", status: "" });
		onPosted();
		box.current?.focus();
	};
	return (
		<div className="rounded-xl border border-line bg-bg px-3 py-2 focus-within:border-focus">
			<Textarea
				aria-describedby={phone ? undefined : hintId}
				aria-keyshortcuts="Control+Enter Meta+Enter"
				aria-label={t("updates.writeOn", { title: item.title || t("untitled") })}
				autoFocus={autoFocus}
				className={cn(
					"w-full resize-none bg-transparent py-0.5 text-[15px] leading-6 max-md:text-base outline-none placeholder:text-muted-foreground",
					expanded ? "max-h-60 min-h-[78px]" : "h-7 overflow-hidden whitespace-nowrap",
				)}
				onChange={(e) => onDraft({ ...draft, text: e.target.value })}
				// the status and the button only show once used, so the text is what gets focus first
				onFocus={() => setUsed(true)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
						e.preventDefault();
						submit();
					}
				}}
				placeholder={t(expanded ? "updates.placeholder" : "updates.placeholderShort")}
				ref={box}
				rows={expanded ? 3 : 1}
				value={draft.text}
				variant="inline"
			/>
			{!phone && (
				<span className="sr-only" id={hintId}>
					{t("updates.postHint", { key: modName(lang) })}
				</span>
			)}
			{expanded && (
				<div className="mt-2 flex flex-wrap items-center gap-2">
					{statusProperty && (
						<NativeSelect
							aria-label={t("updates.status")}
							className="h-8 rounded-lg border-line bg-surface pl-2.5 pr-8 text-xs text-muted-foreground"
							onChange={(e) => onDraft({ ...draft, status: e.target.value })}
							size="sm"
							value={draft.status}
						>
							<option value="">{t("updates.keepStatus")}</option>
							{choices.map((o) => (
								<option key={o.id} value={o.id}>
									→ {o.name}
								</option>
							))}
						</NativeSelect>
					)}
					<span
						aria-hidden
						className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground max-md:hidden"
					>
						<Kbd>{modName(lang)}</Kbd> <Kbd>Enter</Kbd>
					</span>
					<Button
						className="max-md:ml-auto disabled:border disabled:border-line disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100"
						disabled={!draft.text.trim()}
						onClick={submit}
						variant="primary"
					>
						<Send aria-hidden size={14} /> {t("updates.post")}
					</Button>
				</div>
			)}
		</div>
	);
}
