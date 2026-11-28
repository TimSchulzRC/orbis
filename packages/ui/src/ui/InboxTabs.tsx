// The inbox's own tabs beside "Inbox": each lists what lies in the inbox and matches its filter, one
// line per entry to tick off (setup brings "To-dos", the tasks). A tab is data in the workspace's
// settings, like the inbox rule; the app gives no type a role here. Its filter, sorting, grouping and
// the properties a line shows are the user's to change. A line opens in place with its properties
// and what can be done with it; the page is for writing. Ticked here, it stays below, struck through,
// until the panel closes. A new entry gets what the filter asks for (a type, tags, a place).

import { sameValue } from "@orbis/core/equal";
import type { Index } from "@orbis/core/graph";
import { inboxSince } from "@orbis/core/inbox";
import { type Item, setMeta, type TypeItem, titleKey } from "@orbis/core/model";
import { canCheckOff } from "@orbis/core/placement";
import {
	type Cond,
	fieldOf,
	groupId,
	groupItems,
	pathBase,
	runQuery,
	tabDef,
} from "@orbis/core/query";
import { defaultOption, dueOf, firstOfGroup, statusOf, statusProp } from "@orbis/core/traits";
import {
	AlertTriangle,
	Check,
	ChevronLeft,
	ChevronRight,
	Clock,
	FolderInput,
	ListFilter,
	LogOut,
	Maximize2,
	Plus,
	SlidersHorizontal,
	Trash2,
	Undo2,
} from "lucide-react";
import { useState } from "react";
import { replica, useAccounts } from "../accounts";
import { Input } from "../components/ui/input";
import { itemPath, spaceHref, useIndex, useRepo } from "../hooks";
import { titleOf, useT } from "../i18n";
import { cn } from "../lib/utils";
import { CellValue } from "./cells";
import { notify } from "./feedback";
import { InlineText } from "./fields";
import { fieldLabel, viewGroups } from "./groups";
import {
	addTab,
	editTab,
	type InboxEntry,
	type InboxTab,
	moveTab,
	newInit,
	newInTab,
	removeTab,
	type TabPart,
} from "./inbox";
import { DueLabel, ItemIcon, RelTime, StatusGlyph, statusColor, TypeGlyph } from "./item-look";
import { PropertyBlock } from "./Properties";
import { Button, Dialog, DraftBar, IconButton, MenuItem, Popover } from "./primitives";
import { QueryEditor } from "./QueryEditor";
import { pathLabel, setStatus } from "./Row";
import { SpaceScope } from "./Spaces";
import { usePickers, useTriageActions } from "./TriageActions";
import { useViewFields, ViewSettings } from "./Views";

/**
 * "Inbox" and the inbox's own tabs, each with how many. A click on the shown tab, or a right click
 * on any, opens its menu; "+" adds one. `active`: the shown tab's key, null for "Inbox".
 */
export function InboxTabsBar({
	tabs,
	counts,
	inboxCount,
	active,
	onPick,
}: {
	tabs: InboxTab[];
	counts: number[];
	inboxCount: number;
	active: string | null;
	onPick: (key: string | null) => void;
}) {
	const { t } = useT();
	const [menu, setMenu] = useState<string | null>(null);
	const [filtering, setFiltering] = useState<string | null>(null);
	const filterTab = tabs.find((x) => x.key === filtering);
	return (
		<>
			<h2 className="sr-only">{t("tray.title")}</h2>
			<div
				aria-label={t("inbox.show")}
				className="-ml-1.5 flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
				role="tablist"
			>
				<TabButton
					count={inboxCount}
					label={t("tray.title")}
					on={active === null}
					onClick={() => onPick(null)}
					tone="text-warn"
				/>
				{/* keyed by the tab's id: renamed, it keeps its menu open */}
				{tabs.map((tab, n) => (
					<Popover
						key={tab.parts[0]!.tab.id}
						onOpenChange={(o) => setMenu(o ? tab.parts[0]!.tab.id : null)}
						open={menu === tab.parts[0]!.tab.id}
						trigger={(p) => (
							<TabButton
								count={counts[n] ?? 0}
								expanded={active === tab.key ? p["aria-expanded"] : undefined}
								label={tab.name}
								on={active === tab.key}
								onClick={() => (active === tab.key ? p.onClick() : onPick(tab.key))}
								onContextMenu={(e) => {
									e.preventDefault();
									setMenu(tab.parts[0]!.tab.id);
								}}
							/>
						)}
					>
						{(close) => (
							<TabMenu
								first={n === 0}
								last={n === tabs.length - 1}
								onFilter={() => {
									close();
									setFiltering(tab.key);
								}}
								onRemoved={() => {
									close();
									if (active === tab.key) onPick(null);
								}}
								onRenamed={(key) => active === tab.key && onPick(key)}
								tab={tab}
							/>
						)}
					</Popover>
				))}
			</div>
			<AddTab
				onAdded={(key, custom) => {
					onPick(key);
					if (custom) setFiltering(key);
				}}
				tabs={tabs}
			/>
			{filterTab && <TabFilter onClose={() => setFiltering(null)} tab={filterTab} />}
		</>
	);
}

function TabButton({
	label,
	count,
	on,
	tone = "text-fg",
	expanded,
	onClick,
	onContextMenu,
}: {
	label: string;
	count: number;
	on: boolean;
	tone?: string;
	expanded?: boolean;
	onClick: () => void;
	onContextMenu?: (e: React.MouseEvent) => void;
}) {
	return (
		<Button
			aria-expanded={expanded}
			aria-haspopup={expanded === undefined ? undefined : "menu"}
			aria-selected={on}
			className={cn(
				"tap-y shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[15px] font-semibold",
				on ? "text-fg" : "text-muted-foreground hover:bg-hover hover:text-fg",
			)}
			onClick={onClick}
			onContextMenu={onContextMenu}
			role="tab"
			variant="plain"
		>
			{label} <span className={cn("tabular-nums", on && tone)}>{count}</span>
		</Button>
	);
}

/** A tab's menu: its name, its filter, how it shows its entries, its place, and away with it. */
function TabMenu({
	tab,
	first,
	last,
	onFilter,
	onRenamed,
	onRemoved,
}: {
	tab: InboxTab;
	first: boolean;
	last: boolean;
	onFilter: () => void;
	onRenamed: (key: string) => void;
	onRemoved: () => void;
}) {
	const { t, lang } = useT();
	const [settings, setSettings] = useState(false);
	if (settings)
		return (
			<SpaceScope id={tab.parts[0]!.space}>
				<TabSettings onBack={() => setSettings(false)} tab={tab} />
			</SpaceScope>
		);
	return (
		<div className="w-60">
			<div className="px-1.5 pb-1 pt-0.5">
				<InlineText
					className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
					label={t("view.rename")}
					onCommit={(v) => {
						const name = v.trim();
						if (!name || name === tab.name) return;
						editTab(tab, { name }, lang);
						onRenamed(titleKey(name));
					}}
					value={tab.name}
				/>
			</div>
			<MenuItem icon={<ListFilter size={14} />} onClick={onFilter}>
				{t("inbox.tabFilter")}
			</MenuItem>
			<MenuItem icon={<SlidersHorizontal size={14} />} onClick={() => setSettings(true)}>
				{t("view.settings")}
			</MenuItem>
			{!first && (
				<MenuItem icon={<ChevronLeft size={14} />} onClick={() => moveTab(tab, -1)}>
					{t("view.moveLeft")}
				</MenuItem>
			)}
			{!last && (
				<MenuItem icon={<ChevronRight size={14} />} onClick={() => moveTab(tab, 1)}>
					{t("view.moveRight")}
				</MenuItem>
			)}
			<MenuItem
				danger
				icon={<Trash2 size={14} />}
				onClick={() => {
					const back = removeTab(tab);
					onRemoved();
					notify.undo(t("view.removed", { name: tab.name }), back);
				}}
			>
				{t("view.remove")}
			</MenuItem>
		</div>
	);
}

/** Sorting, grouping and the properties a line shows, as a type's views have them. */
function TabSettings({ tab, onBack }: { tab: InboxTab; onBack: () => void }) {
	const { lang } = useT();
	const ix = useIndex();
	const view = tab.parts[0]!.tab;
	const def = tabDef({ inbox: true }, view);
	const items = runQuery(def, { ix }).items;
	const fields = useViewFields(def.where, items);
	return (
		<div>
			<Button
				className="mb-1 flex w-full items-center gap-1 rounded-lg px-1.5 py-1 text-left text-xs font-medium text-muted-foreground hover:text-fg"
				onClick={onBack}
				variant="plain"
			>
				<ChevronLeft size={13} /> {tab.name}
			</Button>
			<ViewSettings
				fields={fields}
				groups={viewGroups(items, def, { ix })}
				kinds={["list"]}
				lines
				onLook={(patch) => editTab(tab, patch, lang)}
				tab={view}
			/>
		</div>
	);
}

/** The tab's filter, a draft until "Save". */
function TabFilter({ tab, onClose }: { tab: InboxTab; onClose: () => void }) {
	return (
		<SpaceScope id={tab.parts[0]!.space}>
			<TabFilterDialog onClose={onClose} tab={tab} />
		</SpaceScope>
	);
}

function TabFilterDialog({ tab, onClose }: { tab: InboxTab; onClose: () => void }) {
	const { t, lang } = useT();
	const where = tab.parts[0]!.tab.where;
	const [draft, setDraft] = useState<Cond | null>(null);
	return (
		<Dialog onClose={onClose} title={t("inbox.tabFilterTitle", { name: tab.name })} wide>
			<div className="space-y-3">
				<p className="text-xs text-muted-foreground">{t("inbox.tabFilterHint")}</p>
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
							editTab(tab, { where: draft }, lang);
							setDraft(null);
							notify(t("view.saved"));
						}}
					/>
				)}
			</div>
		</Dialog>
	);
}

/** A name not taken yet: "New view", else "New view 2" … */
function freeName(name: string, tabs: InboxTab[]) {
	const taken = (x: string) => tabs.some((tab) => tab.key === titleKey(x));
	let n = 1;
	let out = name;
	while (taken(out)) out = `${name} ${++n}`;
	return out;
}

/** A new tab: one per type of the workspaces shown, or one with a filter of its own. */
function AddTab({
	tabs,
	onAdded,
}: {
	tabs: InboxTab[];
	onAdded: (key: string, custom: boolean) => void;
}) {
	const { t } = useT();
	const { shown } = useAccounts();
	const spaces = shown.map((s) => s.id);
	// the types of the workspaces shown, by name, each with its list name ("Tasks")
	const types = new Map<string, { type: TypeItem; name: string }>();
	for (const s of spaces) {
		const ix = replica(s).repo.index();
		for (const type of ix.typesByName())
			if (!types.has(titleKey(type.schema.name)))
				types.set(titleKey(type.schema.name), { type, name: ix.typePlural(type.id) });
	}
	return (
		<Popover
			align="right"
			trigger={(p) => (
				<IconButton
					{...p}
					className="shrink-0"
					icon={Plus}
					iconSize={15}
					label={t("inbox.addTab")}
					size="sm"
					title={t("inbox.addTab")}
				/>
			)}
		>
			{(close) => (
				<div className="max-h-[min(24rem,60dvh)] w-60 overflow-y-auto">
					<p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
						{t("inbox.addTabOf")}
					</p>
					{[...types.values()].map(({ type, name }) => {
						return (
							<MenuItem
								icon={<TypeGlyph schema={type.schema} size={14} />}
								key={type.id}
								onClick={() => {
									close();
									const existing = tabs.find((x) => x.key === titleKey(name));
									if (existing) return onAdded(existing.key, false);
									const key = addTab(spaces, name, (ix) => {
										const id = ix.typeByName(type.schema.name);
										return id ? { type: id } : null;
									});
									if (key) onAdded(key, false);
								}}
							>
								{name}
							</MenuItem>
						);
					})}
					<div className="my-1 border-t border-line" />
					<MenuItem
						icon={<ListFilter size={14} />}
						onClick={() => {
							close();
							const key = addTab(spaces, freeName(t("inbox.newTabName"), tabs), () => undefined);
							if (key) onAdded(key, true);
						}}
					>
						{t("inbox.addCustomTab")}
					</MenuItem>
				</div>
			)}
		</Popover>
	);
}

/** The status a tick sets: the first done option; ticked again, the type's default unless that is done, else the first open one. */
function tickTarget(item: Item, ix: Index) {
	const schema = ix.schemaOf(item);
	const status = statusOf(item, schema);
	const prop = statusProp(schema);
	const doneOption = firstOfGroup(schema, "done");
	if (!status || !prop || !doneOption) return;
	const done = status.group === "done";
	const options = prop.options ?? [];
	const open =
		options.find((o) => o.id === defaultOption(prop) && o.group !== "done") ??
		options.find((o) => o.group !== "done");
	return { done, to: done ? open?.id : doneOption.id };
}

interface Section {
	key: string;
	heading?: string;
	entries: InboxEntry[];
}

/** The tab's groups across its workspaces: a group of the same name is one. */
function sections(parts: TabPart[], skip: Set<string>, t: ReturnType<typeof useT>["t"]): Section[] {
	const out: Section[] = [];
	for (const { space, view, items } of parts) {
		const repo = replica(space).repo;
		const ctx = { ix: repo.index() };
		const def = tabDef({ inbox: true }, view);
		const by = view.group;
		const hidden = new Set(view.hiddenGroups ?? []);
		const groups = groupItems(
			items.filter((i) => !skip.has(`${space}/${i.id}`)),
			by,
			ctx,
			pathBase(def, ctx),
		);
		for (const g of groups) {
			if (hidden.has(groupId(g)) || !g.items.length) continue;
			const heading = !by
				? undefined
				: by === "path"
					? g.path?.length
						? pathLabel(g.path, repo)
						: t("group.thisLevel")
					: g.label ||
						(g.statusGroup
							? t(`group.${g.statusGroup}`)
							: t("group.without", { name: fieldLabel(by, t) }));
			const key = heading ?? "";
			let section = out.find((x) => x.key === key);
			if (!section) {
				section = { key, heading, entries: [] };
				out.push(section);
			}
			for (const item of g.items) section.entries.push({ key: `${space}/${item.id}`, space, item });
		}
	}
	return out;
}

/**
 * The tab's list. `result`: its entries (tabEntries). `ticked`: ticked off here, shown below until
 * the panel closes. `keys`: the panel hands its keys over while the tab shows; true if taken.
 */
export function TabView({
	tab,
	result,
	ticked,
	onTick,
	keys,
}: {
	tab: InboxTab;
	result: { parts: TabPart[]; entries: InboxEntry[]; missing: string[] };
	ticked: InboxEntry[];
	onTick: (e: InboxEntry, done: boolean) => void;
	keys: React.RefObject<((e: KeyboardEvent) => boolean) | null>;
}) {
	const { t } = useT();
	const { parts, entries, missing } = result;
	const [open, setOpen] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	// new ones stay on top while the panel is open, where they were typed in
	const [fresh, setFresh] = useState<string[]>([]);
	const byKey = new Map(entries.map((e) => [e.key, e]));
	const freshHere = fresh.flatMap((k) => byKey.get(k) ?? []);
	const groups = sections(parts, new Set(fresh), t);
	const tickedHere = ticked.filter((e) => !byKey.has(e.key));
	const all = [...freshHere, ...groups.flatMap((g) => g.entries), ...tickedHere];
	const spaceOf = new Map(all.map((e) => [e.item.id, e.space]));
	const act = useTriageActions((i) => spaceOf.get(i.id) ?? all[0]!.space);
	const pick = usePickers(
		(i) => spaceOf.get(i.id) ?? all[0]!.space,
		(list, place) => act.place(list, place),
		(list, type) => act.giveType(list, type),
	);
	const init = newInit(tab);
	const columnsOf = (space: string) => parts.find((p) => p.space === space)?.view.columns ?? [];
	const groupedByPlace = (space: string) =>
		parts.find((p) => p.space === space)?.view.group === "path";
	const current = (k: string | null) => (k ? all.find((e) => e.key === k) : undefined);
	const live = (e: InboxEntry) => replica(e.space).repo.get(e.item.id) ?? e.item;
	const tick = async (e: InboxEntry) => {
		const repo = replica(e.space).repo;
		const item = live(e);
		const target = tickTarget(item, repo.index());
		if (target?.to && (await setStatus(item, target.to, repo))) onTick(e, !target.done);
	};
	const actions = {
		place: (e: InboxEntry) => pick.setPlacing([live(e)]),
		out: (e: InboxEntry) => act.checkOff([live(e)]),
		later: (e: InboxEntry) =>
			live(e).later && live(e).later! > Date.now()
				? replica(e.space).repo.change(e.item.id, (d) => setMeta(d, { later: null }))
				: act.later([live(e)]),
		trash: (e: InboxEntry) => void act.trash([live(e)]),
	};
	keys.current = (ev) => {
		if (pick.placing || pick.typing) return false;
		const k = ev.key;
		const at = all.findIndex((e) => e.key === selected);
		const step = (d: 1 | -1) => {
			const next = all[at < 0 ? (d > 0 ? 0 : all.length - 1) : at + d];
			if (next) {
				setSelected(next.key);
				document.querySelector(`[data-row="${CSS.escape(next.key)}"]`)?.scrollIntoView({
					block: "nearest",
				});
			}
		};
		const e = current(selected);
		if (k === "Escape" && open) setOpen(null);
		else if (k === "ArrowDown" || k === "j") step(1);
		else if (k === "ArrowUp" || k === "k") step(-1);
		else if (!e) return false;
		else if (k === " ") void tick(e);
		else if (k === "Enter") setOpen(open === e.key ? null : e.key);
		else if (k === "e") actions.place(e);
		else if (k === "d") canCheckOff(live(e), replica(e.space).repo.index()) && actions.out(e);
		else if (k === "s") actions.later(e);
		else if (k === "x" || k === "Delete") actions.trash(e);
		else return false;
		return true;
	};
	const row = (e: InboxEntry) => (
		<TabRow
			actions={actions}
			columns={columnsOf(e.space)}
			entry={e}
			key={e.key}
			onOpen={() => {
				setSelected(e.key);
				setOpen(open === e.key ? null : e.key);
			}}
			onTick={() => void tick(e)}
			open={open === e.key}
			placeShown={!groupedByPlace(e.space)}
			selected={selected === e.key}
		/>
	);
	return (
		<section
			aria-label={tab.name}
			className="@container min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2 sm:px-3"
		>
			{missing.length > 0 && (
				<p className="mx-1 mb-2 flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-warn">
					<AlertTriangle size={13} /> {t("query.typeDeleted", { names: missing.join(", ") })}
				</p>
			)}
			{init && (
				<NewEntry
					name={tab.name}
					onAdd={(title) => {
						const k = newInTab(tab, title);
						if (k) setFresh((list) => [k, ...list]);
						return !!k;
					}}
				/>
			)}
			{!all.length ? (
				<p className="px-4 py-8 text-center text-[15px] text-muted-foreground">
					{t("inbox.tabEmpty")}
				</p>
			) : (
				<>
					{freshHere.length > 0 && <ul>{freshHere.map(row)}</ul>}
					{groups.map((g) => (
						<div className="mt-1" key={g.key}>
							{g.heading !== undefined && (
								<p className="truncate px-2 pb-1 pt-2 text-xs font-semibold text-muted-foreground">
									{g.heading} · {g.entries.length}
								</p>
							)}
							<ul>{g.entries.map(row)}</ul>
						</div>
					))}
					{tickedHere.length > 0 && (
						<section aria-label={t("review.sorted")} className="mt-2 border-t border-line pt-1">
							<p className="flex items-center gap-1.5 px-2 py-1 text-[13px] text-muted-foreground">
								<Check className="text-ok" size={14} /> {t("review.sorted")}
								<span className="tabular-nums">· {tickedHere.length}</span>
							</p>
							<ul>{tickedHere.map(row)}</ul>
						</section>
					)}
				</>
			)}
			{pick.node}
		</section>
	);
}

/** Types a new entry into the tab: Enter adds it, the field stays for the next. */
function NewEntry({ name, onAdd }: { name: string; onAdd: (title: string) => boolean }) {
	const { t } = useT();
	const [title, setTitle] = useState("");
	return (
		<form
			className="mx-1 mb-2 flex items-center gap-2 rounded-xl border border-line px-3 py-2 focus-within:border-focus"
			onSubmit={(e) => {
				e.preventDefault();
				if (onAdd(title)) setTitle("");
			}}
		>
			<Plus aria-hidden className="shrink-0 text-muted-foreground" size={16} />
			<Input
				aria-label={t("inbox.newIn", { name })}
				className="text-[15px]"
				onChange={(e) => setTitle(e.target.value)}
				placeholder={t("inbox.newIn", { name })}
				value={title}
				variant="bare"
			/>
		</form>
	);
}

type RowActions = Record<"place" | "out" | "later" | "trash", (e: InboxEntry) => void>;

/**
 * One line: the circle to tick it off (types with a done status), its title, where it is sorted to,
 * the properties the tab shows, when it is due and how long it has lain in the inbox. Wide, these
 * stand in columns; narrow, below the title. Clicked, it opens below.
 */
function TabRow({
	entry,
	columns,
	placeShown,
	open,
	selected,
	actions,
	onOpen,
	onTick,
}: {
	entry: InboxEntry;
	columns: string[];
	placeShown: boolean;
	open: boolean;
	selected: boolean;
	actions: RowActions;
	onOpen: () => void;
	onTick: () => void;
}) {
	const { t } = useT();
	const repo = replica(entry.space).repo;
	const ix = repo.index();
	const item = repo.get(entry.item.id) ?? entry.item;
	const schema = ix.schemaOf(item);
	const status = statusOf(item, schema);
	const done = status?.group === "done";
	const title = titleOf(item, t);
	const home = ix.get(ix.home(item.id));
	const due = dueOf(item, schema);
	const canTick = !!tickTarget(item, ix);
	const filled = (c: string) => {
		const v = fieldOf(item, c, ix)?.value;
		return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
	};
	const cell = "min-w-0 truncate @[640px]:shrink-0";
	return (
		<li className="rounded-lg" data-row={entry.key}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the click widens the title's button to the line; that button is the way for keys */}
			<div
				className={cn(
					"relative flex cursor-pointer items-start gap-1.5 rounded-lg px-1 hover:bg-hover",
					(selected || open) && "bg-selected",
					selected &&
						"before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-r before:bg-inbox",
				)}
				onClick={(e) => {
					if (!(e.target as HTMLElement).closest("a, button, input")) onOpen();
				}}
			>
				{canTick && status ? (
					<Button
						aria-label={done ? t("inbox.reopen", { title }) : t("inbox.tick", { title })}
						className="tap mt-1 shrink-0 rounded-full p-1 hover:bg-surface"
						onClick={onTick}
						style={{ color: statusColor(status.option, done) }}
						variant="plain"
					>
						<StatusGlyph option={status.option} size={17} />
					</Button>
				) : (
					<span className="mt-1 shrink-0 p-1">
						<ItemIcon item={item} ix={ix} size={16} />
					</span>
				)}
				<div className="flex min-w-0 flex-1 flex-col gap-0.5 py-2 @[640px]:flex-row @[640px]:items-center @[640px]:gap-3">
					<Button
						aria-expanded={open}
						className={cn(
							"min-w-0 text-left text-[15px] @[640px]:flex-1 @[640px]:truncate",
							done && "text-muted-foreground line-through",
						)}
						onClick={onOpen}
						variant="plain"
					>
						{title}
					</Button>
					<span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-muted-foreground @[640px]:flex-nowrap">
						{placeShown && (
							<span
								className={cn(
									cell,
									"flex items-center gap-1 @[640px]:w-40",
									!home && "@max-[640px]:hidden",
								)}
							>
								{home && (
									<>
										<ItemIcon item={home} ix={ix} size={13} />
										<span className="truncate">{titleOf(home, t)}</span>
									</>
								)}
							</span>
						)}
						{columns.map((c) => (
							<span
								className={cn(cell, "@[640px]:w-28", !filled(c) && "@max-[640px]:hidden")}
								key={c}
							>
								{filled(c) && <CellValue ctx={{ ix }} item={item} name={c} />}
							</span>
						))}
						<span className={cn(cell, "@[640px]:w-24", !due && "@max-[640px]:hidden")}>
							{due && <DueLabel done={done} due={due} />}
						</span>
						<span className={cn(cell, "text-xs @[640px]:w-24 @[640px]:text-right")}>
							<RelTime ts={inboxSince(item)} />
						</span>
					</span>
				</div>
			</div>
			{open && (
				<SpaceScope id={entry.space}>
					<RowDetail actions={actions} entry={entry} />
				</SpaceScope>
			)}
		</li>
	);
}

/** Opened in place: the title to change, the properties, and what to do with it. */
function RowDetail({ entry, actions }: { entry: InboxEntry; actions: RowActions }) {
	const { t } = useT();
	const repo = useRepo();
	const ix = repo.index();
	const item = repo.get(entry.item.id) ?? entry.item;
	const schema = ix.schemaOf(item);
	const canOut = canCheckOff(item, ix);
	const waiting = (item.later ?? 0) > Date.now();
	const action = (
		icon: React.ReactNode,
		label: string,
		onClick: () => void,
		opts: { disabled?: boolean; why?: string; danger?: boolean } = {},
	) => (
		<Button
			className={cn(
				"inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[13px] hover:bg-hover disabled:opacity-50",
				opts.danger && "text-danger",
			)}
			disabled={opts.disabled}
			onClick={onClick}
			title={opts.why}
			variant="plain"
		>
			{icon}
			{label}
		</Button>
	);
	return (
		<div className="mb-2 ml-1 mr-1 mt-0.5 space-y-3 rounded-xl border border-line bg-surface p-3 @[640px]:ml-9">
			{/* a field, so it reads as one: a long title scrolls in it */}
			<InlineText
				className="rounded-md border border-line bg-bg px-2 py-1 text-[15px]"
				label={t("inbox.titleLabel")}
				onCommit={(v) => v.trim() && repo.setTitle(item.id, v.trim())}
				value={item.title}
			/>
			{schema && <PropertyBlock item={item} schema={schema} />}
			<div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
				{action(<FolderInput size={14} />, t("review.placeAction"), () => actions.place(entry))}
				{action(<LogOut size={14} />, t("inbox.checkOff"), () => actions.out(entry), {
					disabled: !canOut,
					why: canOut ? undefined : t("review.doneFirst"),
				})}
				{action(
					waiting ? <Undo2 size={14} /> : <Clock size={14} />,
					waiting ? t("review.backAction") : t("review.laterAction"),
					() => actions.later(entry),
				)}
				<a
					className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[13px] hover:bg-hover"
					href={spaceHref(entry.space, itemPath(item.id))}
				>
					<Maximize2 size={14} /> {t("tray.openFull")}
				</a>
				<span className="flex-1" />
				{action(<Trash2 size={14} />, t("triage.delete"), () => actions.trash(entry), {
					danger: true,
				})}
			</div>
		</div>
	);
}
