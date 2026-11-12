// The inbox panel's list (left of the entry on a desktop, the panel itself on a phone): what waits,
// what was sorted with its undo (kept until cleared), and folded below what comes back tomorrow ("Back tomorrow").
// Also the newest entries as cards on Heute, and the rule of what lands in the inbox.

import { sameValue } from "@obtion/core/equal";
import { fmtBytes, type Lang, type T } from "@obtion/core/i18n";
import { inboxWhere } from "@obtion/core/inbox";
import { SETTINGS_ID, setMeta, setSettings } from "@obtion/core/model";
import { belowOf } from "@obtion/core/placement";
import type { QueryDef } from "@obtion/core/query";
import { plainText } from "@obtion/core/search";
import { resetInbox } from "@obtion/core/setup";
import type { Repo } from "@obtion/sync";
import {
	ArrowUp,
	Check,
	ChevronDown,
	ChevronRight,
	ListX,
	Maximize2,
	RotateCcw,
	SlidersHorizontal,
	Undo2,
} from "lucide-react";
import { useState } from "react";
import { replica, spaceById, useAccounts } from "../accounts";
import { Tip } from "../components/ui/tooltip";
import { itemPath, spaceHref, useRepo } from "../hooks";
import { titleOf, useT } from "../i18n";
import { cn } from "../lib/utils";
import { notify } from "./feedback";
import { type InboxEntry, openShelf } from "./inbox";
import { ItemIcon, RelTime } from "./item-look";
import { Button, Dialog, DraftBar, IconButton, MenuItem, MoreMenu } from "./primitives";
import { QueryEditor } from "./QueryEditor";
import { SpaceFilter, SpaceScope } from "./Spaces";

/** A waiting entry ("Back tomorrow") comes back into the inbox now. */
export const backNow = (repo: Repo, id: string) =>
	repo.change(id, (d) => setMeta(d, { later: null }));

/** Sorted entries shown before "Show all". */
const SORTED_SHOWN = 5;

export interface SortedRow {
	key: string;
	title: string;
	what: string;
}

/** `current`: the entry shown beside (none on a phone's list). */
/** `onClear`: empties "Sorted"; the entries stay where they were sorted to. */
export function InboxList({
	waiting,
	later,
	sorted,
	current,
	onPick,
	onUndo,
	onClear,
}: {
	waiting: InboxEntry[];
	later: InboxEntry[];
	sorted: SortedRow[];
	current?: string;
	onPick: (key: string) => void;
	onUndo: (key: string) => void;
	onClear: () => void;
}) {
	const { t } = useT();
	const { shown } = useAccounts();
	const [laterOpen, setLaterOpen] = useState(false);
	const [allSorted, setAllSorted] = useState(false);
	const [rule, setRule] = useState<string | null>(null);
	const space = (e: InboxEntry) => spaceById(e.space)?.name;
	const newestSorted = [...sorted].reverse();
	const sortedShown = allSorted ? newestSorted : newestSorted.slice(0, SORTED_SHOWN);
	const section = "mt-1 border-t border-line pt-1";
	const fold =
		"flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-[13px] text-muted-foreground hover:bg-hover hover:text-fg";
	return (
		<>
			<div className="flex shrink-0 items-center gap-2 border-b border-line py-2.5 pl-5 pr-2">
				<h2 className="text-[15px] font-semibold">
					{t("tray.title")} <span className="tabular-nums text-warn">{waiting.length}</span>
				</h2>
				<span className="flex-1" />
				<MoreMenu>
					{(close) =>
						shown.map((s) => (
							<MenuItem
								icon={<SlidersHorizontal size={14} />}
								key={s.id}
								onClick={() => (close(), setRule(s.id))}
							>
								{shown.length > 1 ? t("inbox.whatLandsIn", { name: s.name }) : t("inbox.whatLands")}
							</MenuItem>
						))
					}
				</MoreMenu>
			</div>
			{/* several workspaces: which of them, as in the sidebar's selector */}
			<div className="shrink-0 px-5 pt-3 empty:hidden [&>div]:mb-1">
				<SpaceFilter />
			</div>
			<div aria-label={t("triage.list")} className="min-h-0 flex-1 overflow-y-auto p-1.5">
				{waiting.length ? (
					<ul>
						{waiting.map((e) => (
							<Row
								current={e.key === current}
								entry={e}
								key={e.key}
								onPick={() => onPick(e.key)}
								space={space(e)}
								waiting={false}
							/>
						))}
					</ul>
				) : (
					<p className="px-4 py-8 text-center text-[15px] text-muted-foreground">
						{t("inbox.empty")}
					</p>
				)}
				{sorted.length > 0 && (
					<section aria-label={t("review.sorted")} className={section}>
						<div className="flex items-center gap-1.5 py-1 pl-3 pr-3 text-[13px] text-muted-foreground">
							<Check className="text-ok" size={14} /> {t("review.sorted")}{" "}
							<span className="tabular-nums">· {sorted.length}</span>
							<span className="flex-1" />
							<IconButton
								className="shrink-0"
								icon={ListX}
								iconSize={14}
								label={t("review.clearSorted")}
								onClick={() => (onClear(), setAllSorted(false))}
								size="sm"
								title={t("review.clearSorted")}
							/>
						</div>
						<ul>
							{sortedShown.map((s) => (
								<li
									className="group/sorted flex items-center gap-2 rounded-xl px-3 py-2"
									data-row={s.key}
									key={s.key}
								>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-[15px] text-muted-foreground">
											{s.title}
										</span>
										<span className="block truncate text-[13px] text-muted-foreground">
											{s.what}
										</span>
									</span>
									<IconButton
										className="shrink-0 opacity-60 group-hover/sorted:opacity-100 focus-visible:opacity-100"
										icon={RotateCcw}
										iconSize={14}
										label={t("review.undoNamed", { title: s.title })}
										onClick={() => onUndo(s.key)}
										size="sm"
										title={t("triage.undo")}
									/>
								</li>
							))}
						</ul>
						{sorted.length > SORTED_SHOWN && (
							<Button
								aria-expanded={allSorted}
								className={fold}
								onClick={() => setAllSorted((o) => !o)}
								variant="plain"
							>
								{allSorted ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
								{allSorted
									? t("review.sortedFewer")
									: t("review.sortedAll", { count: sorted.length })}
							</Button>
						)}
					</section>
				)}
				{later.length > 0 && (
					<section aria-label={t("review.later")} className={section}>
						<Button
							aria-expanded={laterOpen}
							className={fold}
							onClick={() => setLaterOpen((o) => !o)}
							variant="plain"
						>
							{laterOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
							{t("review.later")} <span className="tabular-nums">· {later.length}</span>
						</Button>
						{laterOpen && (
							<ul>
								{later.map((e) => (
									<Row
										current={e.key === current}
										entry={e}
										key={e.key}
										onPick={() => onPick(e.key)}
										space={space(e)}
										waiting
									/>
								))}
							</ul>
						)}
					</section>
				)}
			</div>
			{rule && shown.some((s) => s.id === rule) && (
				<SpaceScope id={rule}>
					<InboxRule
						name={shown.length > 1 ? spaceById(rule)?.name : undefined}
						onClose={() => setRule(null)}
					/>
				</SpaceScope>
			)}
		</>
	);
}

/** The newest entries side by side, as on Today: a card opens the panel at it, "See all" at the list. */
export function ShelfCards({ entries }: { entries: InboxEntry[] }) {
	const { t, lang } = useT();
	const { shown } = useAccounts();
	return (
		<section className="mt-9" data-shelf-cards>
			<div className="mb-2.5 flex min-h-8 items-center gap-2">
				<h2 className="text-[15px] font-semibold leading-[22px]">
					{t("tray.title")} <span className="tabular-nums text-warn">{entries.length}</span>
				</h2>
				<span className="flex-1" />
				<Button
					className="tap-y inline-flex items-center gap-1 rounded-md px-1.5 text-[13px] text-muted-foreground hover:text-fg"
					onClick={() => openShelf()}
					variant="plain"
				>
					{t("tray.showAll")} <ArrowUp size={14} />
				</Button>
			</div>
			<div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
				{entries.slice(0, 4).map((e) => {
					const ix = replica(e.space).repo.index();
					const line = preview(e, t, lang, belowOf(e.item.id, ix).length);
					return (
						<Button
							aria-label={t("tray.openEntry", { title: titleOf(e.item, t) })}
							className="flex min-w-0 flex-col items-stretch gap-1 rounded-xl border border-[color-mix(in_srgb,var(--t-inbox)_35%,var(--border))] bg-surface px-4 py-3 text-left hover:bg-hover"
							key={e.key}
							onClick={() => openShelf(e.key)}
							variant="plain"
						>
							<span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
								<ItemIcon item={e.item} ix={ix} size={13} />
								<RelTime ts={e.item.created} />
								{shown.length > 1 && <span className="truncate">· {spaceById(e.space)?.name}</span>}
							</span>
							<span className="truncate text-[15px] font-semibold">{titleOf(e.item, t)}</span>
							<span className="truncate text-xs text-muted-foreground">{line || "\u00a0"}</span>
						</Button>
					);
				})}
			</div>
		</section>
	);
}

/** What an entry says in one line: its text, else what it is (a file, notes below). */
function preview(e: InboxEntry, t: T, lang: Lang, notes: number): string {
	const item = e.item;
	const text = plainText(item.body || item.file?.text || "").slice(0, 200);
	if (text) return notes ? `${text} · ${t("triage.notes", { count: notes })}` : text;
	if (item.file) return [t("kind.file"), fmtBytes(lang, item.file.size)].join(" · ");
	return notes ? t("triage.notes", { count: notes }) : "";
}

/** Hovered, the corner shows the row's buttons instead of the age (on a touch screen always). */
function Row({
	entry,
	current,
	waiting,
	space,
	onPick,
}: {
	entry: InboxEntry;
	current: boolean;
	waiting: boolean;
	space?: string;
	onPick: () => void;
}) {
	const { t, lang } = useT();
	const repo = replica(entry.space).repo;
	const ix = repo.index();
	const item = repo.get(entry.item.id) ?? entry.item;
	const line = preview({ ...entry, item }, t, lang, belowOf(item.id, ix).length);
	return (
		<li
			className={cn(
				"group/row relative rounded-xl hover:bg-hover",
				current &&
					"bg-selected before:absolute before:inset-y-2.5 before:left-0 before:w-[3px] before:rounded-r before:bg-inbox",
			)}
			data-row={entry.key}
		>
			<Button
				aria-current={current}
				className="block w-full min-w-0 rounded-xl px-3 py-2.5 text-left"
				onClick={onPick}
				variant="plain"
			>
				<span className="flex min-h-6 items-center gap-1.5 text-[13px] text-muted-foreground">
					<ItemIcon item={item} ix={ix} size={14} />
					<span className="min-w-0 flex-1 truncate">{space}</span>
					{/* the buttons take the corner: the age gives way (always on a touch screen, where they always show) */}
					<span className="shrink-0 text-xs group-hover/row:invisible pointer-coarse:invisible">
						<RelTime ts={item.created} />
					</span>
				</span>
				<span className="mt-0.5 block truncate text-[15px] font-medium">{titleOf(item, t)}</span>
				{line && <span className="block truncate text-[13px] text-muted-foreground">{line}</span>}
			</Button>
			<span className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100">
				{waiting && (
					<Tip label={t("tray.backNow")}>
						<Button
							aria-label={t("tray.backNow")}
							className={iconTap}
							onClick={() => backNow(repo, entry.item.id)}
							variant="plain"
						>
							<Undo2 size={15} />
						</Button>
					</Tip>
				)}
				<OpenFull className="p-1 hover:bg-surface" entry={entry} />
			</span>
		</li>
	);
}

const iconTap = "tap shrink-0 rounded-md p-1 text-muted-foreground hover:bg-surface hover:text-fg";

/** The entry's whole page: an icon only, without a frame, as in the review's card. */
function OpenFull({ entry, className }: { entry: InboxEntry; className?: string }) {
	const { t } = useT();
	return (
		<Tip label={t("tray.openFull")}>
			<a
				aria-label={t("tray.openFull")}
				className={cn(
					"tap shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-hover hover:text-fg",
					className,
				)}
				href={spaceHref(entry.space, itemPath(entry.item.id))}
			>
				<Maximize2 size={15} />
			</a>
		</Tip>
	);
}

/** What lands in a workspace's inbox: its rule (a draft until "Save") and the way back to the default. */
function InboxRule({ name, onClose }: { name?: string; onClose: () => void }) {
	const { t } = useT();
	const repo = useRepo();
	const where = inboxWhere(repo.index());
	const [draft, setDraft] = useState<QueryDef["where"] | null>(null);
	const restore = () => (setDraft(null), resetInbox(repo.writer), notify(t("inbox.restored")));
	return (
		<Dialog
			onClose={onClose}
			title={name ? t("inbox.whatLandsIn", { name }) : t("inbox.whatLands")}
			wide
		>
			<div className="space-y-3">
				<div className="flex items-start gap-2">
					<p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("inbox.ruleHint")}</p>
					<Button onClick={restore} variant="ghost">
						<RotateCcw size={14} /> {t("inbox.restoreDefault")}
					</Button>
				</div>
				<QueryEditor
					autoFocus
					def={{ where: draft ?? where }}
					onChange={(d) => setDraft(d.where ?? null)}
				/>
				{draft && !sameValue(draft, where) && (
					<DraftBar
						className="sticky top-0 z-10 mb-3 rounded-xl bg-surface px-3 py-2"
						onDiscard={() => setDraft(null)}
						onSave={() => (
							repo.change(SETTINGS_ID, (d) => setSettings(d, { inbox: draft })),
							setDraft(null),
							notify(t("view.saved"))
						)}
					/>
				)}
			</div>
		</Dialog>
	);
}
