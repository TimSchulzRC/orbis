// Parts every page shares, note and file pages alike (design rules § 3.1).

import { dateOf } from "@obtion/core/date";
import type { Index } from "@obtion/core/graph";
import { fmtDate, type T } from "@obtion/core/i18n";
import { type Item, META_TYPE } from "@obtion/core/model";
import { hasPlace, isInInbox } from "@obtion/core/placement";
import { ChevronRight, Link2, Pin, PinOff, Plus, RotateCcw, Star, X } from "lucide-react";
import { useState } from "react";
import { Tip } from "../components/ui/tooltip";
import { itemHref, useIndex, usePhone } from "../hooks";
import { titleOf, useT } from "../i18n";
import { cn } from "../lib/utils";
import { repo } from "../repo";
import { ItemIcon, ItemLink, RelTime } from "./item-look";
import { ItemPicker } from "./Picker";
import { Button, IconButton, MenuItem, MoreMenu, Popover, REVEAL } from "./primitives";

/**
 * Row tools in a popover: on hover, or focused by keyboard. Not on plain focus: opening the popover
 * focuses its first button, which would show the tools of the first row.
 */
const REVEAL_IN_MENU =
	"opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100";

export function Crumbs({
	item,
	tools,
	onPlace,
}: {
	item: Item;
	tools: React.ReactNode;
	onPlace: () => void;
}) {
	const ix = useIndex();
	const { t } = useT();
	const narrow = usePhone();
	const path = ix.homePath(item.id);
	const others = ix.parentsOf(item.id).length - 1;
	const link = "max-w-[16rem] truncate hover:text-fg hover:underline";
	let lead: React.ReactNode = null;
	if (path.length) {
		const shown = narrow && path.length > 1 ? path.slice(-1) : path;
		lead = (
			<>
				{narrow && path.length > 1 && (
					<>
						<span aria-hidden>…</span>
						<ChevronRight aria-hidden className="shrink-0 text-faint" size={12} />
					</>
				)}
				{shown.map((id, i) => (
					<span className="flex min-w-0 items-center gap-1" key={id}>
						{i > 0 && <ChevronRight aria-hidden className="shrink-0 text-faint" size={12} />}
						<a className={link} href={itemHref(id)}>
							{ix.get(id)?.title || t("untitled")}
						</a>
					</span>
				))}
				{others > 0 && <PlacesMenu count={others} item={item} onPlace={onPlace} />}
			</>
		);
	} else if (isInInbox(item, ix)) {
		lead = (
			<>
				<a className={link} href="#/inbox">
					{t("kind.inbox")}
				</a>
				<Button className="tap-y ml-1 text-link hover:underline" onClick={onPlace} variant="plain">
					{t("triage.place")}
				</Button>
			</>
		);
	} else if (item.pinned) {
		lead = (
			<span className="flex items-center gap-1">
				<Pin aria-hidden className="text-faint" size={12} /> {t("place.pinned")}
			</span>
		);
	} else if (item.type && ix.types.has(item.type)) {
		lead = (
			<a className={link} href={itemHref(item.type)}>
				{ix.typePlural(item.type)}
			</a>
		);
	}
	return (
		<div className="page-bar flex min-h-7 items-center gap-1 text-[13px] text-muted-foreground max-md:min-h-8">
			<nav aria-label={t("item.path")} className="flex min-w-0 items-center gap-1">
				{lead}
			</nav>
			<div className="ml-auto flex shrink-0 items-center">{tools}</div>
		</div>
	);
}

/** "+N" in the path: every place of the entry, the home first, each with its path. */
function PlacesMenu({ item, count, onPlace }: { item: Item; count: number; onPlace: () => void }) {
	const ix = useIndex();
	const { t } = useT();
	const home = ix.home(item.id);
	const parents = [...ix.parentsOf(item.id)].sort((a, b) => (a === home ? -1 : b === home ? 1 : 0));
	return (
		<Popover
			trigger={(p) => (
				<Button
					variant="plain"
					{...p}
					className="tap-y ml-1 shrink-0 whitespace-nowrap rounded-full border border-line px-1.5 text-xs hover:text-fg aria-expanded:border-faint aria-expanded:text-fg"
					title={t("refs.places")}
				>
					+{count}
				</Button>
			)}
		>
			{(close) => (
				<div className="w-80 max-w-[calc(100vw-2rem)]">
					<p className="px-2.5 pb-1 pt-1.5 text-xs font-semibold text-muted-foreground">
						{t("refs.places")} <span className="font-normal tabular-nums">{parents.length}</span>
					</p>
					{parents.map((p) => {
						const place = ix.get(p);
						if (!place) return null;
						const above = ix.homePath(p).map((id) => titleOf(ix.get(id)!, t));
						return (
							<div
								className="group flex min-h-9 items-center gap-2 rounded-lg px-2.5 hover:bg-hover"
								key={p}
							>
								<ItemIcon className="shrink-0" item={place} size={14} />
								<a className="flex min-w-0 flex-1 flex-col py-1" href={itemHref(p)} onClick={close}>
									<span className="truncate text-sm text-fg">{titleOf(place, t)}</span>
									{above.length > 0 && (
										<span className="truncate text-xs text-muted-foreground">
											{above.join(" › ")}
										</span>
									)}
								</a>
								{p === home && (
									<span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
										<Star aria-hidden size={11} /> {t("place.home")}
									</span>
								)}
								<MoreMenu className={cn("text-faint", REVEAL_IN_MENU)} iconSize={13} size="xs">
									{(closeMenu) => (
										<>
											{p !== home && (
												<MenuItem onClick={() => (closeMenu(), repo.setHome(item.id, p))}>
													{t("place.makeHome")}
												</MenuItem>
											)}
											<MenuItem
												onClick={() => (closeMenu(), close(), repo.removeParent(item.id, p))}
											>
												{t("place.removeHere")}
											</MenuItem>
										</>
									)}
								</MoreMenu>
							</div>
						);
					})}
					<div className="mt-1 border-t border-line pt-1">
						<MenuItem icon={<Plus size={14} />} onClick={() => (close(), onPlace())}>
							{t("place.addAnother")}
						</MenuItem>
					</div>
				</div>
			)}
		</Popover>
	);
}

export function TrashBanner({ onRestore }: { onRestore: () => void }) {
	const { t } = useT();
	return (
		<div className="mb-4 flex items-center gap-3 rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-3 py-2 text-sm text-danger">
			{t("item.inTrash")}
			<Button className="ml-auto" onClick={onRestore}>
				<RotateCcw size={14} /> {t("item.restore")}
			</Button>
		</div>
	);
}

interface LinkGroup {
	key: string;
	label: string;
	items: { item: Item; note?: React.ReactNode; tools?: React.ReactNode }[];
}

/** Everything linked with the page, both ways (design rules § 2.7): what points here, and where it points. */
function linkGroups(
	item: Item,
	ix: Index,
	t: T,
	usedIn: { item: Item; note?: string }[],
): LinkGroup[] {
	const groups: LinkGroup[] = [];
	const linkingIds = new Set(
		ix
			.backlinks(item.id)
			.filter((b) => b.kind !== "rel")
			.map((b) => b.from),
	);
	const from = [...linkingIds]
		.map((id) => ix.get(id)!)
		.filter(
			(x) =>
				x &&
				x.kind === "note" &&
				!x.deleted &&
				x.type !== META_TYPE &&
				!usedIn.some((u) => u.item.id === x.id),
		);
	const where = (x: Item) => {
		const homePath = ix.homePath(x.id);
		return homePath.length ? (
			<span className="truncate">{ix.get(homePath.at(-1)!)?.title}</span>
		) : undefined;
	};
	if (usedIn.length)
		groups.push({
			key: "used",
			label: t("file.usedIn"),
			items: usedIn.map((x) => ({ item: x.item, note: x.note })),
		});
	if (from.length)
		groups.push({
			key: "linked",
			label: t("item.linkedFrom"),
			items: from.map((x) => ({
				item: x,
				note: isInInbox(x, ix) ? undefined : where(x),
				tools: <PlaceHere page={item} target={x} />,
			})),
		});
	const textLinks = ix.textLinks(item);
	const fromText = textLinks.filter((l) => !l.embed).map((l) => l.to);
	const embedded = textLinks.filter((l) => l.embed).map((l) => l.to);
	const toIds = [...new Set([...fromText, ...embedded, ...item.refs])].filter(
		(x) => ix.get(x) && !ix.get(x)!.deleted && x !== item.id,
	);
	if (toIds.length)
		groups.push({
			key: "to",
			label: t("links.to"),
			items: toIds.map((x) => ({
				item: ix.get(x)!,
				note: fromText.includes(x)
					? t("item.inText")
					: embedded.includes(x)
						? t("refs.embedded")
						: undefined,
				tools: (
					<>
						<PlaceHere page={item} target={ix.get(x)!} />
						{fromText.includes(x) || embedded.includes(x) ? (
							// a link in the text shows in the head too once pinned
							item.refs.includes(x) ? (
								<IconButton
									className={cn("text-faint", REVEAL_IN_MENU)}
									icon={PinOff}
									iconSize={12}
									label={t("links.unpin")}
									onClick={() => repo.setMember(item.id, "refs", x, false)}
									size="xs"
								/>
							) : (
								<IconButton
									className={cn("text-faint", REVEAL_IN_MENU)}
									icon={Pin}
									iconSize={12}
									label={t("links.pin")}
									onClick={() => repo.pinRef(item.id, x)}
									size="xs"
								/>
							)
						) : (
							<IconButton
								className={cn("text-faint", REVEAL_IN_MENU)}
								icon={X}
								iconSize={12}
								label={t("item.removeRef")}
								onClick={() => repo.setMember(item.id, "refs", x, false)}
								size="xs"
							/>
						)}
					</>
				),
			})),
		});
	return groups;
}

/** The link button in the page head: the number of all links, both ways; a click lists them. None, no button. */
export function LinksMenu({
	item,
	usedIn = [],
}: {
	item: Item;
	usedIn?: { item: Item; note?: string }[];
}) {
	const ix = useIndex();
	const { t } = useT();
	const groups = linkGroups(item, ix, t, usedIn);
	const count = groups.reduce((n, g) => n + g.items.length, 0);
	if (!count) return null;
	return (
		<Popover
			align="right"
			trigger={(p) => (
				<Tip label={t("links.title")}>
					<Button
						variant="plain"
						{...p}
						aria-label={t("links.count", { count })}
						className="tap inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-[13px] tabular-nums text-muted-foreground transition-colors hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg"
					>
						<Link2 size={16} /> {count}
					</Button>
				</Tip>
			)}
		>
			{(close) => (
				<div className="w-80 max-w-[calc(100vw-2rem)]">
					{groups.map((g, i) => (
						<div className={cn(i > 0 && "mt-1 border-t border-line pt-1")} key={g.key}>
							<p className="px-2.5 pb-1 pt-1.5 text-xs font-semibold text-muted-foreground">
								{g.label} <span className="font-normal tabular-nums">{g.items.length}</span>
							</p>
							{g.items.map(({ item: x, note, tools }) => (
								<div
									className="group flex min-h-9 items-center gap-2 rounded-lg px-2.5 hover:bg-hover"
									key={x.id}
								>
									<ItemIcon className="shrink-0" item={x} size={14} />
									<a
										className="min-w-0 flex-1 truncate py-1 text-sm text-fg"
										href={itemHref(x.id)}
										onClick={close}
									>
										{titleOf(x, t)}
									</a>
									<span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
										{note}
										{tools}
									</span>
								</div>
							))}
						</div>
					))}
				</div>
			)}
		</Popover>
	);
}

function PlaceHere({ target, page }: { target: Item; page: Item }) {
	const ix = useIndex();
	const { t } = useT();
	if (
		!isInInbox(target, ix) ||
		hasPlace(target, ix) ||
		target.type === META_TYPE ||
		ix.wouldCycle(target.id, page.id)
	)
		return null;
	return (
		<Button
			className="tap-y rounded-md px-1.5 py-0.5 text-xs text-link hover:bg-hover"
			onClick={(e) => (e.preventDefault(), repo.addParent(target.id, page.id))}
			variant="plain"
		>
			{t("links.placeHere")}
		</Button>
	);
}

/** The refs shown in the head: set by hand, or links from the text that were pinned. */
export function pinnedRefs(item: Item, ix: Index): Item[] {
	return item.refs
		.map((id) => ix.get(id))
		.filter((x): x is Item => !!x && !x.deleted && x.id !== item.id);
}

/** "+" for another ref, with the item picker. `text` names it ("+ Ref"), for where no chip says what it adds. */
export function AddRef({ item, text }: { item: Item; text?: boolean }) {
	const { t } = useT();
	const [picking, setPicking] = useState(false);
	if (item.deleted) return null;
	return (
		<>
			<Tip label={t("item.addRef")}>
				<Button
					aria-label={t("item.addRef")}
					className={cn(
						"tap inline-flex items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-fg",
						text ? "h-6 gap-0.5 px-1 text-xs" : "justify-center p-1",
					)}
					onClick={() => setPicking(true)}
					variant="plain"
				>
					<Plus className="shrink-0" size={text ? 12 : 14} />
					{text && <span className="px-1">{t("links.ref")}</span>}
				</Button>
			</Tip>
			{picking && (
				<ItemPicker
					exclude={(x) => x.id === item.id || item.refs.includes(x.id)}
					onClose={() => setPicking(false)}
					onPick={(x) => (repo.setMember(item.id, "refs", x, true), setPicking(false))}
					title={t("item.addRef")}
				/>
			)}
		</>
	);
}

/**
 * The pinned refs as chips in a row of their own under type and tags, then "+" for another one.
 * Without pinned refs there is no row; "+ Ref" sits after the tags then (see AddRef).
 */
export function LinksRow({ item }: { item: Item }) {
	const ix = useIndex();
	const { t } = useT();
	const [drag, setDrag] = useState<string | null>(null);
	// where the dragged chip would land: in front of this ref, or `null` for the end
	const [at, setAt] = useState<string | null | undefined>(undefined);
	const refs = pinnedRefs(item, ix);
	if (!refs.length) return null;
	const inText = new Set(ix.textLinks(item).map((l) => l.to));
	const ids = refs.map((x) => x.id);
	const end = () => (setDrag(null), setAt(undefined));
	// the left half of a chip means in front of it, the right half after it
	const aim = (e: React.DragEvent<HTMLElement>, id: string) => {
		if (!drag) return;
		e.preventDefault();
		const box = e.currentTarget.getBoundingClientRect();
		const before = e.clientX < box.left + box.width / 2 ? id : (ids[ids.indexOf(id) + 1] ?? null);
		// in front of itself or of the next one leaves it where it is: no line
		setAt(before === drag || before === (ids[ids.indexOf(drag) + 1] ?? null) ? undefined : before);
	};
	// Alt+← / Alt+→ on a chip moves it by one
	const step = (id: string, direction: -1 | 1) => {
		const n = ids.indexOf(id);
		if (direction < 0 && n > 0) repo.moveRef(item.id, id, ids[n - 1]!);
		if (direction > 0 && n < ids.length - 1) repo.moveRef(item.id, id, ids[n + 2] ?? null);
		// moving the chip in the page takes the focus with it
		requestAnimationFrame(() =>
			document.querySelector<HTMLElement>(`[data-ref="${id}"] a`)?.focus(),
		);
	};
	const line = "pointer-events-none absolute -top-0.5 -bottom-0.5 w-0.5 rounded-full bg-link";
	return (
		<div
			className="mt-2 flex flex-wrap items-center gap-1.5"
			onDragLeave={(e) =>
				!e.currentTarget.contains(e.relatedTarget as Node | null) && setAt(undefined)
			}
			onDragOver={(e) => drag && e.preventDefault()}
			onDrop={(e) => (
				e.preventDefault(), drag && at !== undefined && repo.moveRef(item.id, drag, at), end()
			)}
		>
			{refs.map((x, n) => (
				<span
					className={cn(
						"group relative inline-flex max-w-full cursor-grab select-none items-center gap-1 rounded-md bg-surface-2 py-0.5 pl-1.5 pr-0.5 text-[13px] active:cursor-grabbing",
						drag === x.id && "opacity-50",
					)}
					data-ref={x.id}
					draggable
					key={x.id}
					onDragEnd={end}
					onDragOver={(e) => aim(e, x.id)}
					onDragStart={(e) => {
						// the chip is dragged, not its link: no URL to drop elsewhere, the chip itself under the pointer
						e.dataTransfer.clearData();
						e.dataTransfer.setData("obtion/ref", x.id);
						e.dataTransfer.effectAllowed = "move";
						const box = e.currentTarget.getBoundingClientRect();
						e.dataTransfer.setDragImage(e.currentTarget, e.clientX - box.left, e.clientY - box.top);
						setDrag(x.id);
					}}
					onKeyDown={(e) => {
						if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
						e.preventDefault();
						step(x.id, e.key === "ArrowLeft" ? -1 : 1);
					}}
				>
					{/* the line where the chip would land, in the middle of the gap */}
					{at === x.id && <span aria-hidden className={cn(line, "-left-1")} data-drop-line />}
					{at === null && n === ids.length - 1 && (
						<span aria-hidden className={cn(line, "-right-1")} data-drop-line />
					)}
					<ItemLink className="min-w-0" draggable={false} item={x} />
					{inText.has(x.id) ? (
						// pinned from the text: the pin says why it is here, hovered it turns into the ×
						<Button
							aria-label={t("links.unpin")}
							className="tap inline-flex items-center justify-center rounded p-0.5 text-muted-foreground transition-colors hover:bg-hover hover:text-fg"
							onClick={() => repo.setMember(item.id, "refs", x.id, false)}
							title={t("links.unpin")}
							variant="plain"
						>
							<Pin
								aria-hidden
								className="group-hover:hidden group-focus-within:hidden pointer-coarse:hidden"
								size={11}
							/>
							<X
								aria-hidden
								className="hidden group-hover:block group-focus-within:block pointer-coarse:block"
								size={11}
							/>
						</Button>
					) : (
						<IconButton
							className={cn("text-muted-foreground", REVEAL.any)}
							icon={X}
							iconSize={11}
							label={t("item.removeRef")}
							onClick={() => repo.setMember(item.id, "refs", x.id, false)}
							size="xs"
						/>
					)}
				</span>
			))}
			<AddRef item={item} />
		</div>
	);
}

export function PageFooter({ item, className }: { item: Item; className?: string }) {
	const { t, lang } = useT();
	return (
		<p className={cn("mt-4 text-xs text-muted-foreground", className)}>
			{t("item.edited")} <RelTime ts={item.updated} /> ·{" "}
			{t("page.createdOn", {
				date: fmtDate(lang, dateOf(item.created), {
					day: "numeric",
					month: "long",
					year: "numeric",
				}),
			})}
		</p>
	);
}
