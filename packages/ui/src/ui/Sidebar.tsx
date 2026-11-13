// Fold state is remembered per device. In the tree, dragging replaces the parent you come from;
// with Alt held a place is added. Dropping on a row's upper or lower edge reorders. A link to an
// item dragged in from the page gets a place where it is dropped: below a row, or pinned. Dropped into
// another workspace's block, an item moves there. Dragging a workspace's name to the nearest gap
// reorders the blocks; the order is the account's, on every device.

import { type Item, META_TYPE, SETTINGS_ID, setSchemaField, setSettings } from "@obtion/core/model";
import { sidebarChildren, sidebarRoots } from "@obtion/core/placement";
import { restoreDefaultTypes } from "@obtion/core/setup";
import { cmpKey, keyBetween, keysFor } from "@obtion/core/sortkey";
import { filesBelow } from "@obtion/core/zip";
import {
	ArrowDown,
	ArrowLeft,
	ArrowUp,
	ChevronDown,
	ChevronRight,
	History,
	Link2,
	Paperclip,
	Plus,
	RotateCcw,
	Search,
	Settings,
	Sun,
	Trash2,
	Waypoints,
} from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { moveSpace, type Space, useAccounts } from "../accounts";
import { createAndOpen } from "../actions";
import { Tip } from "../components/ui/tooltip";
import {
	itemPath,
	leavePage,
	navigate,
	parseHash,
	spaceHref,
	useLocalStorage,
	useRepo,
	useRoute,
	useSpaceId,
} from "../hooks";
import { getLang, useT } from "../i18n";
import { dropZone, startPointerDrag } from "../lib/drag";
import { shortcut } from "../lib/platform";
import { cn, moveInArray } from "../lib/utils";
import { DeleteDialog, deleteOrAsk } from "../views/ItemPage";
import { DownloadFilesItem } from "./DownloadFiles";
import { HistoryButtons } from "./HistoryButtons";
import { ItemIcon, TypeGlyph } from "./item-look";
import { Button, IconButton, Kbd, MenuItem, MoreMenu, REVEAL, useContextMenu } from "./primitives";
import { moveTo, NewSpaceDialog, SpaceScope, SpaceSelector } from "./Spaces";
import { StatusButton } from "./StatusButton";
import { openSettings, openSpaceSettings } from "./settings-open";
import { KEYS } from "./storage";
import { notify } from "./toasts";
import { editType, openNewType } from "./type-edit";

/**
 * What is being dragged in the sidebar: an item (from below `from`, null: pinned; `type`: a pinned
 * type page, which only changes its place among the pinned) or a row of "Types", and from which
 * workspace. `link`: an item dragged in from the page; it keeps the places it has and gets one more.
 */
let dragging: {
	id: string;
	from: string | null;
	space: string;
	type?: boolean;
	link?: boolean;
} | null = null;
/**
 * Carries only the title as text. The URL the browser adds for a link is dropped, or the drag
 * would be taken as a link to open elsewhere (a new tab, a split view).
 */
const startDrag = (e: React.DragEvent, d: NonNullable<typeof dragging>, text: string) => {
	dragging = d;
	e.dataTransfer.clearData();
	e.dataTransfer.setData("text/plain", text);
};
/** The item a link leads to and the workspace it names: "#/w/<workspace>/i/<id>/<title>". */
function linkedItem(a: HTMLAnchorElement): { id: string; space?: string } | null {
	// also a full address of this app, as pasted into a text
	if (a.origin !== location.origin || a.pathname !== location.pathname) return null;
	const { space, rest } = parseHash(a.hash);
	const id = /^\/i\/([^/?]+)/.exec(rest)?.[1];
	return id ? { id: decodeURIComponent(id), space } : null;
}
/**
 * Whatever is dragged on the page and leads to one item (a link, or something dragged with one
 * link in it: a card, a chip) can be dropped into the tree of its workspace. A dragged link carries
 * only its text: with its URL the browser would take the drag as a link to open elsewhere.
 */
function useLinkDrags(space: string, here: boolean, on: boolean) {
	const repo = useRepo();
	useEffect(() => {
		if (!on) return;
		const start = (e: DragEvent) => {
			const el = e.target;
			if (!(el instanceof Element) || e.defaultPrevented || el.closest("[data-space-block]"))
				return;
			const link = el.closest<HTMLAnchorElement>("a[href]");
			const inside = link ? [link] : [...el.querySelectorAll<HTMLAnchorElement>("a[href]")];
			// links that lead elsewhere (a URL property on a card) do not count
			const found = inside.map(linkedItem).filter((f) => !!f);
			const to = found[0];
			if (!to || found.some((f) => f.id !== to.id || f.space !== to.space)) return;
			if (to.space ? to.space !== space : !here) return;
			const item = repo.get(to.id);
			if (!item || item.deleted) return;
			dragging = { id: to.id, from: null, space, type: item.type === META_TYPE, link: true };
			if (!link || !e.dataTransfer) return;
			e.dataTransfer.clearData();
			e.dataTransfer.setData("text/plain", link.textContent?.trim() || item.title);
		};
		const end = () => (dragging = null);
		document.addEventListener("dragstart", start);
		document.addEventListener("dragend", end);
		return () => {
			document.removeEventListener("dragstart", start);
			document.removeEventListener("dragend", end);
		};
	}, [repo, space, here, on]);
}
/** The workspace whose block is being dragged to another place among the blocks. */
let draggingSpace: string | null = null;
/**
 * Where the block of workspace `dragged` goes: the gap between the blocks in `area` nearest to the
 * pointer (`index`: before that block; the number of blocks: at the end), and how far down in
 * `area` that gap is. Above the first block is the first gap, any empty space below the last one
 * the last. The gap just below the dragged block is none: its place is the one above it.
 */
function spaceGapAt(area: HTMLElement, clientY: number, dragged: string) {
	const box = area.getBoundingClientRect();
	const els = [...area.querySelectorAll<HTMLElement>("[data-space-block]")];
	const blocks = els.map((b) => b.getBoundingClientRect());
	const below = els.findIndex((b) => b.dataset.spaceBlock === dragged) + 1;
	// on the line above each block (between two); after the last, just below it
	const gaps = [...blocks.map((b) => b.top - 12), blocks.at(-1)!.bottom + 6];
	let index = -1;
	for (let i = 0; i < gaps.length; i++)
		if (
			i !== below &&
			(index < 0 || Math.abs(gaps[i]! - clientY) < Math.abs(gaps[index]! - clientY))
		)
			index = i;
	return { index, y: gaps[index]! - box.top + area.scrollTop };
}
/** Width of the sidebar in px: by default, and how narrow or wide dragging its edge can make it. */
export const SIDEBAR_WIDTH = { initial: 256, min: 200, max: 480 };
const clampWidth = (w: number) =>
	Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, Math.round(w)));

/**
 * The sidebar's right edge: dragged, it sets the width, remembered per device. Arrow keys change it
 * in steps, a double click goes back to the default.
 */
function ResizeHandle({
	width,
	onWidth,
	onDone,
}: {
	width: number;
	onWidth: (w: number) => void;
	onDone: (w: number) => void;
}) {
	const { t } = useT();
	return (
		<hr
			aria-label={t("nav.resize")}
			aria-orientation="vertical"
			aria-valuemax={SIDEBAR_WIDTH.max}
			aria-valuemin={SIDEBAR_WIDTH.min}
			aria-valuenow={width}
			className="absolute inset-y-0 -right-1 z-20 h-auto w-2 cursor-col-resize touch-none border-0 outline-none hover:bg-focus/40 focus-visible:bg-focus/40"
			onDoubleClick={() => onDone(SIDEBAR_WIDTH.initial)}
			onKeyDown={(e) => {
				const step = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
				if (!step) return;
				e.preventDefault();
				onDone(clampWidth(width + step));
			}}
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				const x0 = e.clientX;
				let w = width;
				document.body.style.cursor = "col-resize";
				startPointerDrag(
					(ev) => {
						w = clampWidth(width + ev.clientX - x0);
						onWidth(w);
					},
					() => {
						document.body.style.cursor = "";
						onDone(w);
					},
				);
			}}
			tabIndex={0}
		/>
	);
}

/** Can it go into another workspace? Items can (a move), type pages and rows of "Types" not. */
const movable = (d: typeof dragging) => !!d && d.from !== "types" && !d.type && !d.link;
/** Icons of tree rows: larger in the phone menu. */
const rowIconSize = (touch?: boolean) => (touch ? 17 : 15);
export function Sidebar({ onSearch }: { onSearch: () => void }) {
	const { t, lang } = useT();
	const route = useRoute();
	const { shown } = useAccounts();
	const [creating, setCreating] = useState(false);
	const [storedWidth, setStoredWidth] = useLocalStorage<number>(
		KEYS.sidebarWidth,
		SIDEBAR_WIDTH.initial,
	);
	// while dragging: only on screen, stored when let go
	const [liveWidth, setLiveWidth] = useState<number | null>(null);
	const width = liveWidth ?? clampWidth(storedWidth);
	const [spaceGap, setSpaceGap] = useState<{ index: number; y: number } | null>(null);
	// a drag let go outside the sidebar (or broken off) leaves no line behind
	useEffect(() => {
		const end = () => setSpaceGap(null);
		addEventListener("dragend", end);
		return () => removeEventListener("dragend", end);
	}, []);
	const iconCls = (active: boolean) =>
		cn(
			"tap inline-flex size-8 shrink-0 items-center justify-center rounded-md",
			active ? "bg-hover text-fg" : "text-muted-foreground hover:bg-hover hover:text-fg",
		);
	const navCls = (active: boolean) =>
		cn(
			"flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm",
			active
				? "bg-hover font-medium text-fg"
				: "text-muted-foreground hover:bg-hover hover:text-fg",
		);

	return (
		<aside
			className="relative flex shrink-0 flex-col border-r border-line bg-surface-2/50 pt-safe"
			style={{ width }}
		>
			<div className="flex items-center px-2 pb-px pt-2">
				<SpaceSelector className="flex-1" onNew={() => setCreating(true)} />
				<HistoryButtons forward />
			</div>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: dropping a dragged workspace between the others; the workspace menu moves them by keyboard */}
			<div
				className="relative min-h-0 flex-1 overflow-y-auto pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				onDragLeave={(e) =>
					!e.currentTarget.contains(e.relatedTarget as Node | null) && setSpaceGap(null)
				}
				// a workspace's block dragged by its name: anywhere here, the nearest gap between the blocks
				onDragOver={(e) => {
					if (!draggingSpace) return;
					e.preventDefault();
					setSpaceGap(spaceGapAt(e.currentTarget, e.clientY, draggingSpace));
				}}
				onDrop={(e) => {
					const id = draggingSpace;
					if (!id) return;
					e.preventDefault();
					draggingSpace = null;
					const gap = spaceGapAt(e.currentTarget, e.clientY, id);
					setSpaceGap(null);
					const from = shown.findIndex((s) => s.id === id);
					// its own place (the gap just above it): nothing changes
					if (gap.index === from) return;
					const last = gap.index >= shown.length;
					void moveSpace(id, shown[last ? shown.length - 1 : gap.index]!.id, !last).catch(() =>
						notify(t("account.offline")),
					);
				}}
			>
				{spaceGap && (
					<span
						className="pointer-events-none absolute inset-x-3 z-10 h-0.5 rounded bg-focus"
						style={{ top: spaceGap.y - 1 }}
					/>
				)}
				<nav aria-label={t("nav.main")} className="flex flex-col gap-px px-2">
					<Button className={cn(navCls(false), "group/search")} onClick={onSearch} variant="plain">
						<Search size={16} /> <span className="flex-1 text-left">{t("nav.search")}</span>
						<span className="opacity-0 transition-opacity group-hover/search:opacity-100">
							<Kbd>{shortcut("K", lang)}</Kbd>
						</span>
					</Button>
					<a className={navCls(route.path === "/")} href="#/">
						<Sun size={16} /> {t("nav.today")}
					</a>
				</nav>
				{shown.map((s) => (
					<SpaceScope id={s.id} key={s.id}>
						<div className="mx-4 mt-3 border-t border-line" />
						<SpaceTree space={s} />
					</SpaceScope>
				))}
				{creating && <NewSpaceDialog onClose={() => setCreating(false)} />}
			</div>
			{/* below, as icons: the settings and the pages about all workspaces seen (activity, trash) –
          on those pages the way back instead; at the right how sync and version stand */}
			<div className="flex items-center gap-1 border-t border-line p-2">
				{route.parts[0] === "activity" || route.parts[0] === "trash" ? (
					<Button
						className={cn(navCls(false), "min-w-0 flex-1")}
						onClick={leavePage}
						variant="plain"
					>
						<ArrowLeft size={16} /> {t("nav.back")}
					</Button>
				) : (
					<>
						<Tip label={t("nav.settings")}>
							<Button
								aria-label={t("nav.settings")}
								className={iconCls(false)}
								onClick={openSettings}
								variant="plain"
							>
								<Settings size={17} />
							</Button>
						</Tip>
						<Tip label={t("nav.activity")}>
							<a aria-label={t("nav.activity")} className={iconCls(false)} href="#/activity">
								<History size={17} />
							</a>
						</Tip>
						<Tip label={t("nav.trash")}>
							<a aria-label={t("nav.trash")} className={iconCls(false)} href="#/trash">
								<Trash2 size={17} />
							</a>
						</Tip>
					</>
				)}
				<StatusButton className="ml-auto" />
			</div>
			<ResizeHandle
				onDone={(w) => {
					setStoredWidth(w);
					setLiveWidth(null);
				}}
				onWidth={setLiveWidth}
				width={width}
			/>
		</aside>
	);
}

/** `touch` (phone menu): taller rows, no drag and drop, no hover buttons. */
export function SpaceTree({ space, touch }: { space: Space; touch?: boolean }) {
	const { t } = useT();
	const repo = useRepo();
	const { active, shown } = useAccounts();
	const here = active?.id === space.id;
	const [open, setOpen] = useLocalStorage<boolean>(KEYS.sidebarSpace(space.id), true);
	const [typesOpen, setTypesOpen] = useLocalStorage<boolean>(
		KEYS.sidebarTypes(space.id),
		shown.length === 1,
	);
	const [over, setOver] = useState(false);
	const menu = useContextMenu();
	const typesMenu = useContextMenu();
	useLinkDrags(space.id, here, !touch);
	const ix = repo.index();
	const roots = sidebarRoots(ix);
	// missing or deleted default types come back; the others stay as they are
	const restoreTypes = () => {
		const changed = restoreDefaultTypes(repo.writer, getLang(), repo.origin);
		notify(t("types.restored", { count: changed.length }));
	};
	const ready = !!repo.get(SETTINGS_ID);
	const row = cn(
		"flex items-center gap-2 rounded-lg pr-2",
		touch ? "py-2 text-[15px]" : "py-1 text-sm",
	);
	// up and down among the blocks seen (the hidden ones keep their place in the order)
	const at = shown.findIndex((s) => s.id === space.id);
	const reorder = (to: string | undefined, before: boolean) =>
		to && moveSpace(space.id, to, before).catch(() => notify(t("account.offline")));
	const go = (path: string) => navigate(path, { space: space.id });
	return (
		<section aria-label={space.name} className="mt-3" data-space-block={space.id}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: pointer shortcuts (drag, right-click); the row's buttons and "…" menu serve the keyboard */}
			<div
				className={cn(
					"group/space flex h-7 items-center gap-0.5 rounded-lg",
					touch ? "px-3" : "mx-2 px-2",
					over && "bg-hover ring-1 ring-focus",
				)}
				draggable={!touch && shown.length > 1}
				onContextMenu={touch ? undefined : menu.onContextMenu}
				onDragEnd={() => (draggingSpace = null)}
				onDragLeave={() => setOver(false)}
				onDragOver={(e) => {
					if (!movable(dragging) || dragging!.space === space.id) return;
					e.preventDefault();
					setOver(true);
				}}
				onDragStart={(e) => {
					dragging = null;
					draggingSpace = space.id;
					e.dataTransfer.clearData();
					e.dataTransfer.setData("text/plain", space.name);
					e.dataTransfer.effectAllowed = "move";
				}}
				onDrop={(e) => {
					e.preventDefault();
					setOver(false);
					const dragged = dragging;
					dragging = null;
					if (movable(dragged) && dragged!.space !== space.id)
						void moveTo(dragged!.id, dragged!.space, space.id);
				}}
			>
				<Button
					aria-expanded={open}
					className="-ml-1 flex min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground hover:text-fg"
					onClick={() => setOpen(!open)}
					variant="plain"
				>
					<ChevronRight
						className={cn("shrink-0 text-faint transition-transform", open && "rotate-90")}
						size={13}
					/>
					<span className="truncate">{space.name}</span>
				</Button>
				{ready && (
					<IconButton
						className={
							touch ? "p-1.5" : "opacity-0 focus:opacity-100 group-hover/space:opacity-100"
						}
						icon={Plus}
						iconSize={14}
						label={t("nav.newPinned")}
						onClick={() =>
							createAndOpen(
								{ pinned: keyBetween(roots.at(-1)?.pinned ?? null, null) },
								repo,
								space.id,
							)
						}
						size="xs"
					/>
				)}
				<MoreMenu
					// into the page, not back over the sidebar
					align="left"
					className={
						touch
							? "p-1.5"
							: "opacity-0 focus:opacity-100 group-hover/space:opacity-100 pointer-coarse:opacity-100"
					}
					iconSize={14}
					label={t("space.menu", { name: space.name })}
					menu={touch ? undefined : menu}
					size="xs"
				>
					{(close) => (
						<>
							<MenuItem
								icon={<Settings size={14} />}
								onClick={() => {
									close();
									openSpaceSettings(space.id);
								}}
							>
								{t("space.settings")}
							</MenuItem>
							<MenuItem
								icon={<Waypoints size={14} />}
								onClick={() => {
									close();
									go("/graph");
								}}
							>
								{t("nav.graph")}
							</MenuItem>
							{shown.length > 1 && (
								<>
									<div className="my-1 border-t border-line" />
									{at > 0 && (
										<MenuItem
											icon={<ArrowUp size={14} />}
											onClick={() => {
												close();
												reorder(shown[at - 1]?.id, true);
											}}
										>
											{t("space.moveUp")}
										</MenuItem>
									)}
									{at < shown.length - 1 && (
										<MenuItem
											icon={<ArrowDown size={14} />}
											onClick={() => {
												close();
												reorder(shown[at + 1]?.id, false);
											}}
										>
											{t("space.moveDown")}
										</MenuItem>
									)}
								</>
							)}
						</>
					)}
				</MoreMenu>
			</div>
			{/* set up as soon as it is in step with the server */}
			{open && !ready && (
				<p className={cn(row, "pl-[30px] text-muted-foreground", !touch && "mx-2")}>
					{t("app.syncing")}
				</p>
			)}
			{open && ready && (
				<div className={cn(!touch && "px-2")}>
					<PinnedTree here={here} touch={touch} />
					{/* a label over the types, not a row like the pinned: smaller, no hover; its "…" makes
              a new type or brings the default ones back */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: right-click opens the menu that the "…" button beside it opens too */}
					<div
						className="group/types mt-2 flex items-center pr-1"
						onContextMenu={touch ? undefined : typesMenu.onContextMenu}
					>
						<Button
							aria-expanded={typesOpen}
							className={cn(
								"flex min-w-0 flex-1 items-center gap-1 pl-2.5 font-medium text-muted-foreground hover:text-fg",
								touch ? "py-1.5 text-[13px]" : "py-1 text-xs",
							)}
							onClick={() => setTypesOpen(!typesOpen)}
							variant="plain"
						>
							<ChevronRight
								className={cn("shrink-0 text-faint transition-transform", typesOpen && "rotate-90")}
								size={12}
							/>
							{t("nav.types")}
						</Button>
						<MoreMenu
							align="left"
							className={
								touch
									? "p-1.5"
									: "opacity-0 focus:opacity-100 group-hover/types:opacity-100 pointer-coarse:opacity-100"
							}
							iconSize={14}
							label={t("types.menu")}
							menu={touch ? undefined : typesMenu}
							size="xs"
						>
							{(close) => (
								<>
									<MenuItem
										icon={<Plus size={14} />}
										onClick={() => {
											close();
											openNewType(space.id);
										}}
									>
										{t("types.new")}
									</MenuItem>
									<MenuItem
										icon={<RotateCcw size={14} />}
										onClick={() => {
											close();
											restoreTypes();
										}}
									>
										{t("types.restore")}
									</MenuItem>
								</>
							)}
						</MoreMenu>
					</div>
					{typesOpen && <TypeNav here={here} touch={touch} />}
				</div>
			)}
		</section>
	);
}

/** The path to the open page unfolds by itself; nothing closes by itself. `here`: the open workspace. */
function PinnedTree({ touch, here }: { touch?: boolean; here: boolean }) {
	const repo = useRepo();
	const space = useSpaceId()!;
	const ix = repo.index();
	const route = useRoute();
	const [open, setOpen] = useLocalStorage<Record<string, boolean>>(KEYS.sidebarTree, {});
	const activeId = here && route.parts[0] === "i" ? route.parts[1] : undefined;
	// unfolds when the open page changes, with the tree as it is then
	const unfold = useEffectEvent((activeId: string) => {
		const chain = [...ix.homePath(activeId), activeId];
		const root = chain.findIndex((id) => !!ix.get(id)?.pinned);
		if (root < 0) return;
		const keys = chain
			.slice(root, -1)
			.map((id, i) => `${i === 0 ? "" : chain[root + i - 1]}>${id}`);
		if (keys.some((k) => !open[k]))
			setOpen({ ...open, ...Object.fromEntries(keys.map((k) => [k, true])) });
	});
	useEffect(() => {
		if (activeId) unfold(activeId);
	}, [activeId]);
	const roots = sidebarRoots(ix);
	const isOpen = (key: string, depth: number) => open[key] ?? depth === 0;
	const toggle = (key: string, depth: number) => setOpen({ ...open, [key]: !isOpen(key, depth) });
	// done entries stay out of the tree – except the open page and the way to it
	const keep = activeId ? [...ix.homePath(activeId), activeId] : [];
	const tree = { isOpen, toggle, activeId, keep, touch };
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop target for dragging pages to the top level; pinning works from each page's menu
		<div
			className="min-h-1"
			onDragOver={(e) =>
				dragging &&
				dragging.from !== "types" &&
				(dragging.space === space || movable(dragging)) &&
				e.preventDefault()
			}
			onDrop={(e) => {
				// dropped on empty space: pinned at the end (moving away from the parent it came from)
				const dragged = dragging;
				if (!dragged || dragged.from === "types" || e.defaultPrevented) return;
				dragging = null;
				if (dragged.space !== space)
					return void (movable(dragged) && moveTo(dragged.id, dragged.space, space));
				if (dragged.from && !e.altKey) repo.removeParent(dragged.id, dragged.from);
				repo.setSort(dragged.id, null, keyBetween(roots.at(-1)?.pinned ?? null, null));
			}}
		>
			{roots.map((root, i) => (
				<TreeNode
					depth={0}
					index={i}
					item={root}
					key={root.id}
					parent={null}
					siblings={roots}
					{...tree}
				/>
			))}
		</div>
	);
}

/** The page of every type of a workspace and the files, in an order of their own (synced); a new type comes last. New types are made from the "…" next to "Types". */
function TypeNav({ touch, here }: { touch?: boolean; here: boolean }) {
	const { t } = useT();
	const repo = useRepo();
	const space = useSpaceId()!;
	const ix = repo.index();
	const route = useRoute();
	const [drop, setDrop] = useState<{ id: string; before: boolean } | null>(null);
	const filesPos = ix.all.get(SETTINGS_ID)?.settings?.filesPos;
	const rows = [
		...ix.typesInOrder().map((type) => ({
			id: type.id,
			key: type.schema.pos,
			label: ix.typePlural(type.id),
			href: spaceHref(space, itemPath(type.id)),
			icon: <TypeGlyph schema={type.schema} size={rowIconSize(touch)} />,
		})),
		{
			id: "files",
			key: filesPos,
			label: t("nav.files"),
			href: spaceHref(space, "/files"),
			icon: <Paperclip className="shrink-0" size={rowIconSize(touch)} />,
		},
	].sort((a, b) => cmpKey(a.key ?? "~", b.key ?? "~"));
	const active = (id: string) =>
		here &&
		(id === "files"
			? route.path.startsWith("/files")
			: route.parts[0] === "i" && route.parts[1] === id);
	// a new order: every row gets a fresh key, written only where it changed
	const move = (id: string, to: string, before: boolean) => {
		const order = moveInArray(
			rows,
			rows.findIndex((row) => row.id === id),
			rows.findIndex((row) => row.id === to) + (before ? 0 : 1),
		);
		keysFor(order.length).forEach((pos, i) => {
			const row = order[i]!;
			if (row.key === pos) return;
			if (row.id === "files") repo.change(SETTINGS_ID, (d) => setSettings(d, { filesPos: pos }));
			else repo.change(row.id, (d) => setSchemaField(d, "pos", pos));
		});
	};
	const ours = () => dragging?.from === "types" && dragging.space === space;
	return (
		<nav aria-label={t("nav.types")} className="flex flex-col gap-px">
			{rows.map((row) => (
				<TypeRow
					active={active(row.id)}
					drop={drop?.id === row.id ? (drop.before ? "before" : "after") : null}
					key={row.id}
					onDragLeave={() => setDrop(null)}
					onDragOver={(e) => {
						if (!ours() || dragging!.id === row.id) return;
						e.preventDefault();
						const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
						setDrop({ id: row.id, before: e.clientY < box.top + box.height / 2 });
					}}
					onDragStart={(e) => startDrag(e, { id: row.id, from: "types", space }, row.label)}
					onDrop={(e) => {
						e.preventDefault();
						if (ours() && drop) move(dragging!.id, row.id, drop.before);
						dragging = null;
						setDrop(null);
					}}
					row={row}
					touch={touch}
				/>
			))}
		</nav>
	);
}

/**
 * A type (or the files) under a workspace: dragged to reorder; a type's gear opens "Edit type" in
 * one click. The link covers the whole row (::after), only the gear lies above it.
 */
function TypeRow({
	row: r,
	touch,
	active,
	drop,
	...drag
}: {
	row: { id: string; label: string; href: string; icon: React.ReactNode };
	touch?: boolean;
	active: boolean;
	drop: "before" | "after" | null;
	onDragStart: (e: React.DragEvent) => void;
	onDragOver: (e: React.DragEvent) => void;
	onDragLeave: () => void;
	onDrop: (e: React.DragEvent) => void;
}) {
	const { t } = useT();
	const space = useSpaceId()!;
	const isType = r.id !== "files";
	return (
		<div
			draggable={!touch}
			{...drag}
			className={cn(
				"group/row relative flex items-center gap-2 rounded-lg pl-[30px] pr-1",
				touch ? "py-2 text-[15px]" : "py-1 text-sm",
				active
					? "bg-hover font-medium text-fg"
					: "text-muted-foreground hover:bg-hover hover:text-fg",
			)}
		>
			{drop && (
				<span
					className={cn(
						"absolute inset-x-1 h-0.5 rounded bg-focus",
						drop === "before" ? "-top-px" : "-bottom-px",
					)}
				/>
			)}
			{r.icon}
			<a
				aria-current={active ? "page" : undefined}
				className="min-w-0 flex-1 truncate after:absolute after:inset-0 after:rounded-lg"
				draggable={false}
				href={r.href}
			>
				{r.label}
			</a>
			{!touch && isType && (
				<IconButton
					className={cn("relative z-10 hover:bg-surface-2", REVEAL.row)}
					icon={Settings}
					iconSize={14}
					label={t("type.edit")}
					onClick={() => editType(r.id, space)}
					size="xs"
					tabIndex={-1}
				/>
			)}
		</div>
	);
}

/**
 * A child that repeats its parent's title ("Relaunch Frankreich" below "Relaunch") shows
 * only what it adds: "… Frankreich". Anything else keeps its title and is cut at the end (the
 * full title is the tooltip) – never stumps like "… im Alltag".
 */
function distinctLabel(title: string, parentTitle?: string): string {
	const prefix = parentTitle?.trim();
	if (!prefix || title.length <= prefix.length) return title;
	if (title.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return title;
	const rest = title.slice(prefix.length);
	if (!/^[\s:·–-]/.test(rest)) return title; // "RelaunchX" is no repetition
	const words = rest.replace(/^[\s:·–-]+/, "");
	return words.replace(/[^\p{L}\p{N}]/gu, "").length >= 2 ? `… ${words}` : title;
}

function TreeNode({
	item,
	parent,
	siblings,
	index,
	depth,
	isOpen: opened,
	toggle,
	activeId,
	keep,
	touch,
}: {
	item: Item;
	parent: string | null;
	siblings: Item[];
	index: number;
	depth: number;
	isOpen: (k: string, depth: number) => boolean;
	toggle: (k: string, depth: number) => void;
	activeId?: string;
	keep: string[];
	touch?: boolean;
}) {
	const { t } = useT();
	const repo = useRepo();
	const space = useSpaceId()!;
	const ix = repo.index();
	const isType = item.type === META_TYPE;
	const key = `${parent ?? ""}>${item.id}`;
	const kids = sidebarChildren(item.id, ix, keep);
	const isOpen = opened(key, depth);
	const home = ix.home(item.id);
	// a second place of the same item: below a non-home parent, or at the top while it also has a parent
	const secondary = parent !== null ? home !== parent : !!home;
	const [drop, setDrop] = useState<"before" | "inside" | "after" | null>(null);
	const [deleting, setDeleting] = useState(false);
	const menu = useContextMenu();
	// the open page goes back when it goes to the trash; anything else stays where it is
	const toTrash = () => {
		const title = item.title || t("untitled");
		if (deleteOrAsk(repo, item.id, () => setDeleting(true), activeId === item.id))
			notify.undo(t("item.trashed", { title }), () => repo.restore(item.id));
	};

	const sortOf = (x: Item) => (parent ? (x.parents[parent]?.sort ?? "") : (x.pinned ?? ""));
	const onDrop = (e: React.DragEvent) => {
		e.preventDefault();
		const dragged = dragging;
		dragging = null;
		setDrop(null);
		if (!dragged || dragged.id === item.id) return;
		if (dragged.space !== space)
			return void (
				movable(dragged) &&
				!isType &&
				moveTo(dragged.id, dragged.space, space, item.id)
			);
		if ((dragged.type || isType) && drop === "inside") return;
		if (drop === "inside") {
			if (e.altKey || dragged.link) repo.addParent(dragged.id, item.id);
			else if (dragged.from) repo.moveParent(dragged.id, dragged.from, item.id);
			else if (repo.addParent(dragged.id, item.id)) repo.pin(dragged.id, false); // from the top: no longer pinned
			if (!isOpen) toggle(key, depth);
			return;
		}
		// reorder among the siblings of this row
		const before = drop === "before";
		const neighbour = siblings[before ? index - 1 : index + 1];
		const neighbourSort = neighbour ? sortOf(neighbour) : null;
		const sort = before
			? keyBetween(neighbourSort, sortOf(item))
			: keyBetween(sortOf(item), neighbourSort);
		if (parent) {
			// a link dragged in does not say where it came from: is the item below this parent already?
			const there = dragged.link ? !!ix.get(dragged.id)?.parents[parent] : dragged.from === parent;
			if (!there) {
				if (
					e.altKey || dragged.link
						? !repo.addParent(dragged.id, parent, sort)
						: !repo.moveParent(dragged.id, dragged.from, parent, sort)
				)
					return;
			} else repo.setSort(dragged.id, parent, sort);
		} else {
			// to the top level: pinned at this position
			if (dragged.from && !e.altKey) repo.removeParent(dragged.id, dragged.from);
			repo.setSort(dragged.id, null, sort);
		}
	};

	return (
		<div>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: dragging and the right-click menu; the link and the "…" button carry the same for keys */}
			<div
				className={cn(
					"group/row relative flex items-center gap-1 rounded-lg pr-1",
					touch ? "py-2 text-[15px]" : "py-1 text-sm",
					activeId === item.id
						? "bg-hover font-medium text-fg"
						: "text-muted-foreground hover:bg-hover hover:text-fg",
					drop === "inside" && "ring-2 ring-focus",
				)}
				draggable={!touch}
				onContextMenu={touch ? undefined : menu.onContextMenu}
				onDragLeave={() => setDrop(null)}
				onDragOver={(e) => {
					const dragged = dragging;
					if (!dragged || dragged.id === item.id || dragged.from === "types") return;
					const other = dragged.space !== space;
					// from another workspace only into this item (a move), never into a type page; a type
					// page only changes its place among the pinned
					if (other ? !movable(dragged) || isType : dragged.type && parent !== null) return;
					e.preventDefault();
					e.stopPropagation();
					const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
					const y = e.clientY - box.top;
					const edge = y < box.height / 2 ? "before" : "after";
					setDrop(other ? "inside" : dragged.type || isType ? edge : dropZone(y, box.height));
				}}
				onDragStart={(e) => {
					startDrag(e, { id: item.id, from: parent, space, type: isType }, item.title);
					e.dataTransfer.effectAllowed = "copyMove";
				}}
				onDrop={onDrop}
				style={{ paddingLeft: 4 + depth * 12 }}
			>
				{drop === "before" && (
					<span className="absolute inset-x-1 -top-px h-0.5 rounded bg-focus" />
				)}
				{drop === "after" && (
					<span className="absolute inset-x-1 -bottom-px h-0.5 rounded bg-focus" />
				)}
				<Button
					aria-expanded={isOpen}
					aria-label={isOpen ? t("tree.collapse") : t("tree.expand")}
					className={cn(
						"relative z-10 flex shrink-0 items-center justify-center rounded text-muted-foreground",
						touch ? "tap -my-1.5 size-8" : "size-5",
						kids.length ? "hover:bg-surface-2" : "invisible",
					)}
					onClick={() => kids.length && toggle(key, depth)}
					tabIndex={-1}
					variant="plain"
				>
					{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
				</Button>
				{isType ? (
					<TypeGlyph schema={item.schema} size={rowIconSize(touch)} />
				) : (
					<ItemIcon item={item} size={rowIconSize(touch)} />
				)}
				{/* the row is dragged, not the link in it; the link covers the whole row (::after), only
            the buttons lie above it */}
				<a
					aria-current={activeId === item.id ? "page" : undefined}
					className="min-w-0 flex-1 truncate after:absolute after:inset-0 after:rounded-lg"
					draggable={false}
					href={spaceHref(space, itemPath(item.id))}
					title={
						secondary
							? `${item.title}\n${t("tree.secondary", { home: ix.get(home)?.title ?? "" })}`
							: item.title
					}
				>
					{isType
						? ix.typePlural(item.id)
						: distinctLabel(item.title, parent ? ix.get(parent)?.title : undefined) ||
							t("untitled")}
				</a>
				{secondary && (
					<span className="pointer-events-none text-muted-foreground">
						<Link2 size={12} />
					</span>
				)}
				{/* on a phone there is no hover: no invisible buttons to hit by accident */}
				{!touch && !isType && (
					<Button
						aria-label={t("tree.newBelow")}
						className="relative z-10 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-surface-2 hover:text-fg group-hover/row:opacity-100 focus:opacity-100"
						onClick={() => {
							if (!isOpen) toggle(key, depth);
							createAndOpen({ parents: [item.id] }, repo, space);
						}}
						tabIndex={-1}
						title={t("tree.newBelow")}
						variant="plain"
					>
						<Plus size={13} />
					</Button>
				)}
				{!touch && (
					<MoreMenu
						className={cn("relative z-10 hover:bg-surface-2", REVEAL.row)}
						iconSize={14}
						menu={menu}
						size="xs"
						tabIndex={-1}
					>
						{(close) => (
							<>
								{isType && (
									<MenuItem
										onClick={() => {
											close();
											editType(item.id, space);
										}}
									>
										{t("type.edit")}
									</MenuItem>
								)}
								<MenuItem
									onClick={() => {
										close();
										repo.pin(item.id, !item.pinned);
									}}
								>
									{item.pinned ? t("item.unpin") : t("item.pin")}
								</MenuItem>
								{parent && secondary && (
									<MenuItem
										onClick={() => {
											close();
											repo.setHome(item.id, parent);
										}}
									>
										{t("place.makeHome")}
									</MenuItem>
								)}
								<DownloadFilesItem
									close={close}
									files={filesBelow(item.id, ix)}
									title={item.title || t("untitled")}
								/>
								{/* types are deleted on their page, with the preview of what becomes of the values */}
								{!isType && (
									<MenuItem
										danger
										onClick={() => {
											close();
											toTrash();
										}}
									>
										{t("item.delete")}
									</MenuItem>
								)}
							</>
						)}
					</MoreMenu>
				)}
			</div>
			{deleting && (
				<DeleteDialog item={item} leave={activeId === item.id} onClose={() => setDeleting(false)} />
			)}
			{isOpen &&
				kids.map((k, i) => (
					<TreeNode
						activeId={activeId}
						depth={depth + 1}
						index={i}
						isOpen={opened}
						item={k}
						keep={keep}
						key={k.id}
						parent={item.id}
						siblings={kids}
						toggle={toggle}
						touch={touch}
					/>
				))}
		</div>
	);
}
