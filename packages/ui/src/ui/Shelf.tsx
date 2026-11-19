// The inbox panel's list (left of the entry on a desktop, the panel itself on a phone): what waits,
// all of it or only the to-dos (ticked off right there, a new one typed in at the top), what was
// done with its undo (kept until cleared), and folded below what comes back tomorrow ("Back
// tomorrow"). Also the rule of what lands in the inbox by itself.

import { sameValue } from "@orbis/core/equal";
import { fmtBytes, type Lang, type T } from "@orbis/core/i18n";
import { inboxSince, inboxWhere } from "@orbis/core/inbox";
import { SETTINGS_ID, setMeta, setSettings } from "@orbis/core/model";
import { belowOf } from "@orbis/core/placement";
import type { QueryDef } from "@orbis/core/query";
import { plainText } from "@orbis/core/search";
import { resetInbox } from "@orbis/core/setup";
import { defaultOption, dueOf, firstOfGroup, statusOf, statusProp } from "@orbis/core/traits";
import type { Repo } from "@orbis/sync";
import {
	Check,
	ChevronDown,
	ChevronRight,
	ListX,
	Maximize2,
	Plus,
	RotateCcw,
	SlidersHorizontal,
	Undo2,
} from "lucide-react";
import { useState } from "react";
import { replica, spaceById, useAccounts } from "../accounts";
import { Input } from "../components/ui/input";
import { Tip } from "../components/ui/tooltip";
import { itemPath, spaceHref, useRepo } from "../hooks";
import { titleOf, useT } from "../i18n";
import { cn } from "../lib/utils";
import { notify } from "./feedback";
import { type InboxEntry, newNote } from "./inbox";
import { DueLabel, ItemIcon, RelTime, StatusGlyph, statusColor } from "./item-look";
import { Button, Dialog, DraftBar, IconButton, MenuItem, MoreMenu } from "./primitives";
import { QueryEditor } from "./QueryEditor";
import { setStatus } from "./Row";
import { SpaceFilter, SpaceScope } from "./Spaces";

/** What the list shows: every entry, or only those with a status (to-dos). */
export type InboxView = "all" | "todos";

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

/**
 * `current`: the entry shown beside (none on a phone's list). `onClear`: empties "Done"; the
 * entries stay where they were sorted to. `canTodo`: a workspace shown has a type with a status.
 * `count`: all entries waiting, `todos`: the to-dos among them. `ticked`: to-dos ticked off here, shown until the panel closes. `onAddTodo`: a new to-do
 * with this title, false if none could be made.
 */
export function InboxList({
	waiting,
	later,
	sorted,
	ticked,
	current,
	canTodo,
	count,
	todos,
	view,
	onView,
	onPick,
	onTick,
	onAddTodo,
	onUndo,
	onClear,
}: {
	waiting: InboxEntry[];
	later: InboxEntry[];
	sorted: SortedRow[];
	ticked: InboxEntry[];
	current?: string;
	canTodo: boolean;
	count: number;
	todos: number;
	view: InboxView;
	onView: (v: InboxView) => void;
	onPick: (key: string) => void;
	onTick: (e: InboxEntry, done: boolean) => void;
	onAddTodo: (title: string) => boolean;
	onUndo: (key: string) => void;
	onClear: () => void;
}) {
	const { t } = useT();
	const { shown } = useAccounts();
	const todoList = view === "todos";
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
				{canTodo ? (
					<ViewTabs count={count} onView={onView} todos={todos} view={view} />
				) : (
					<h2 className="text-[15px] font-semibold">
						{t("tray.title")} <span className="tabular-nums text-warn">{count}</span>
					</h2>
				)}
				<span className="flex-1" />
				<MoreMenu>
					{(close) =>
						shown.map((s) => (
							<MenuItem
								icon={<SlidersHorizontal size={14} />}
								key={s.id}
								onClick={() => {
									close();
									setRule(s.id);
								}}
							>
								{shown.length > 1 ? t("inbox.whatLandsIn", { name: s.name }) : t("inbox.whatLands")}
							</MenuItem>
						))
					}
				</MoreMenu>
				<IconButton
					className="shrink-0"
					icon={Plus}
					iconSize={16}
					label={t("quick.title")}
					onClick={() => newNote()}
					title={t("quick.title")}
				/>
			</div>
			{/* several workspaces: which of them, as in the sidebar's selector */}
			<div className="shrink-0 px-5 pt-3 empty:hidden [&>fieldset]:mb-1">
				<SpaceFilter />
			</div>
			<section aria-label={t("triage.list")} className="min-h-0 flex-1 overflow-y-auto p-1.5">
				{todoList && <NewTodo onAdd={onAddTodo} />}
				{waiting.length || (todoList && ticked.length) ? (
					<ul>
						{waiting.map((e) =>
							todoList ? (
								<TodoRow
									current={e.key === current}
									entry={e}
									key={e.key}
									onPick={() => onPick(e.key)}
									onTick={onTick}
								/>
							) : (
								<Row
									current={e.key === current}
									entry={e}
									key={e.key}
									onPick={() => onPick(e.key)}
									space={space(e)}
									waiting={false}
								/>
							),
						)}
						{todoList &&
							ticked.map((e) => (
								<TodoRow
									current={false}
									entry={e}
									key={e.key}
									onPick={() => onPick(e.key)}
									onTick={onTick}
								/>
							))}
					</ul>
				) : (
					<p className="px-4 py-8 text-center text-[15px] text-muted-foreground">
						{todoList ? t("inbox.noTodos") : t("inbox.empty")}
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
								onClick={() => {
									onClear();
									setAllSorted(false);
								}}
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
			</section>
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

/**
 * The head as two tabs: the whole inbox, or only its to-dos, each with how many. Apart from the
 * workspaces' chips below, which choose from where.
 */
function ViewTabs({
	view,
	count,
	todos,
	onView,
}: {
	view: InboxView;
	count: number;
	todos: number;
	onView: (v: InboxView) => void;
}) {
	const { t } = useT();
	const tab = (v: InboxView, label: string, n: number, tone: string) => (
		<Button
			aria-selected={view === v}
			className={cn(
				"tap-y whitespace-nowrap rounded-md px-1.5 py-0.5 text-[15px] font-semibold",
				view === v ? "text-fg" : "text-muted-foreground hover:bg-hover hover:text-fg",
			)}
			onClick={() => onView(v)}
			role="tab"
			variant="plain"
		>
			{label} <span className={cn("tabular-nums", view === v && tone)}>{n}</span>
		</Button>
	);
	return (
		<>
			<h2 className="sr-only">{t("tray.title")}</h2>
			<div aria-label={t("inbox.show")} className="-ml-1.5 flex min-w-0 gap-1" role="tablist">
				{tab("all", t("tray.title"), count, "text-warn")}
				{tab("todos", t("inbox.todos"), todos, "text-fg")}
			</div>
		</>
	);
}

/** Types a new to-do into the inbox: Enter adds it, the field stays for the next. */
function NewTodo({ onAdd }: { onAdd: (title: string) => boolean }) {
	const { t } = useT();
	const [title, setTitle] = useState("");
	return (
		<form
			className="mb-1 flex items-center gap-2 rounded-xl border border-line px-3 py-2 focus-within:border-focus"
			onSubmit={(e) => {
				e.preventDefault();
				if (onAdd(title)) setTitle("");
			}}
		>
			<Plus aria-hidden className="shrink-0 text-muted-foreground" size={16} />
			<Input
				aria-label={t("inbox.newTodo")}
				className="text-[15px]"
				onChange={(e) => setTitle(e.target.value)}
				placeholder={t("inbox.newTodo")}
				value={title}
				variant="bare"
			/>
		</form>
	);
}

/**
 * A to-do: its status to tick off (or, ticked here, to open again), its title, where it is sorted
 * to, when it is due and how long it has lain in the inbox.
 */
function TodoRow({
	entry,
	current,
	onPick,
	onTick,
}: {
	entry: InboxEntry;
	current: boolean;
	onPick: () => void;
	onTick: (e: InboxEntry, done: boolean) => void;
}) {
	const { t } = useT();
	const repo = replica(entry.space).repo;
	const ix = repo.index();
	const item = repo.get(entry.item.id) ?? entry.item;
	const schema = ix.schemaOf(item);
	const status = statusOf(item, schema);
	const done = status?.group === "done";
	const prop = statusProp(schema);
	const title = titleOf(item, t);
	const home = ix.get(ix.home(item.id));
	const due = dueOf(item, schema);
	const toggle = async () => {
		if (!prop) return;
		const to = done
			? (defaultOption(prop) ?? firstOfGroup(schema, "todo")?.id)
			: firstOfGroup(schema, "done")?.id;
		if (to && (await setStatus(item, to, repo))) onTick(entry, !done);
	};
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
				aria-label={done ? t("inbox.reopen", { title }) : t("inbox.tick", { title })}
				className="tap absolute left-2 top-2 rounded-full p-1 hover:bg-surface"
				onClick={() => void toggle()}
				style={status ? { color: statusColor(status.option, done) } : undefined}
				variant="plain"
			>
				{status && <StatusGlyph option={status.option} size={17} />}
			</Button>
			<Button
				aria-current={current}
				className="block w-full min-w-0 rounded-xl py-2.5 pl-10 pr-3 text-left"
				onClick={onPick}
				variant="plain"
			>
				<span
					className={cn(
						"block truncate text-[15px] font-medium",
						done && "text-muted-foreground line-through",
					)}
				>
					{title}
				</span>
				<span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
					{home && <span className="min-w-0 truncate">{titleOf(home, t)}</span>}
					{due && <DueLabel done={done} due={due} />}
					<span className="ml-auto shrink-0 text-xs">
						<RelTime ts={inboxSince(item)} />
					</span>
				</span>
			</Button>
		</li>
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
						<RelTime ts={inboxSince(item)} />
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
	const restore = () => {
		setDraft(null);
		resetInbox(repo.writer);
		notify(t("inbox.restored"));
	};
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
						onSave={() => {
							repo.change(SETTINGS_ID, (d) => setSettings(d, { inbox: draft }));
							setDraft(null);
							notify(t("view.saved"));
						}}
					/>
				)}
			</div>
		</Dialog>
	);
}
