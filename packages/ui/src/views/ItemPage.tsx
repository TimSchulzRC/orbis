// One page for every note. Types change the properties and which sections appear, never
// the layout.

import type { EditorView } from "@codemirror/view";
import type { Index } from "@orbis/core/graph";
import { type Item, META_TYPE } from "@orbis/core/model";
import { canCheckOff, isInInbox } from "@orbis/core/placement";
import { pluralOf } from "@orbis/core/plural";
import { hasUpdates, progressSpec } from "@orbis/core/traits";
import { movedItems } from "@orbis/core/transfer";
import { onlyBelow } from "@orbis/core/trash";
import { wouldBeInInbox } from "@orbis/core/typeops";
import { updateFeed } from "@orbis/core/updates";
import {
	AlertTriangle,
	ArrowRightLeft,
	Bot,
	Check,
	FilePlus,
	FolderInput,
	ImagePlus,
	Pin,
	PinOff,
	Trash2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAccounts } from "../accounts";
import { createAndOpen, isBlank, rememberPlace } from "../actions";
import { Input } from "../components/ui/input";
import { Tip } from "../components/ui/tooltip";
import { leavePage, setParams, showTitle, useDocumentTitle, useIndex, useRepo } from "../hooks";
import { getLang, titleOf, tr, useT } from "../i18n";
import { cn } from "../lib/utils";
import type { repo } from "../repo";
import { AgentRulesDialog } from "../ui/AgentRules";
import { insertFilesAtCursor } from "../ui/Editor";
import { INBOX_ICON, NOTE_ICON } from "../ui/icons";
import { ItemIcon, TypeChip, TypeGlyph } from "../ui/item-look";
import { NoteEditor } from "../ui/NoteEditor";
import {
	AddRef,
	Crumbs,
	LinksMenu,
	LinksRow,
	PageDates,
	pinnedRefs,
	TrashBanner,
} from "../ui/PageParts";
import { PlacePicker } from "../ui/Picker";
import { PropertyBlock } from "../ui/Properties";
import { Button, Dialog, MenuItem, MoreMenu, PagePlaceholder, Popover } from "../ui/primitives";
import { ProgressBand } from "../ui/progress";
import { Below } from "../ui/Sections";
import { moveTo } from "../ui/Spaces";
import { TitleField } from "../ui/TitleField";
import { PagePanel } from "../ui/Updates";
import { FilePage } from "./FilePage";
import { TypePage } from "./TypePage";

export function ItemPage({ id, isNew }: { id: string; isNew: boolean }) {
	const scoped = useRepo();
	const { t } = useT();
	const item = scoped.get(id);
	// the title after the id: at once when the page opens, while typing a moment later
	// (browsers limit how often an address may change)
	const hasPage = item && item.kind !== "settings" && item.kind !== "op";
	const title = !hasPage
		? undefined
		: item.type === META_TYPE
			? scoped.index().typePlural(id)
			: item.title;
	const shown = useRef<string | undefined>(undefined);
	useLayoutEffect(() => {
		if (title === undefined) return;
		if (shown.current !== id) {
			shown.current = id;
			showTitle(title);
			return;
		}
		const wait = setTimeout(() => showTitle(title), 400);
		return () => clearTimeout(wait);
	}, [id, title]);
	if (!item || item.kind === "settings")
		return (
			<PagePlaceholder>
				{scoped.status.synced ? t("item.missing") : t("item.loading")}
			</PagePlaceholder>
		);
	if (item.kind === "op") return <PagePlaceholder>{item.title}</PagePlaceholder>;
	if (item.kind === "file") return <FilePage item={item} key={id} />;
	if (item.type === META_TYPE) return <TypePage item={item} key={id} />;
	return <InfoView isNew={isNew} item={item} key={id} />;
}

const openItems = new Set<string>();

function InfoView({ item, isNew: created }: { item: Item; isNew: boolean }) {
	const repo = useRepo();
	// "?new=1" is for opening it once: gone from the address, so a reload or Back later does not take it as new
	const [isNew] = useState(created);
	useEffect(() => void setParams({ new: null }), []);
	const ix = useIndex();
	const { t } = useT();
	useDocumentTitle(titleOf(item, t));
	const schema = ix.schemaOf(item);
	const [view, setView] = useState<EditorView | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [placing, setPlacing] = useState(false);
	const [moving, setMoving] = useState(false);
	const others = useAccounts().spaces.length > 1;
	const [rulesOpen, setRulesOpen] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);

	// An item created with "New …" and left empty is discarded, not left as "Untitled".
	useEffect(() => {
		if (!isNew) return;
		openItems.add(item.id);
		return () => {
			openItems.delete(item.id);
			setTimeout(() => {
				if (openItems.has(item.id)) return;
				const current = repo.get(item.id);
				if (current && !current.deleted && isBlank(current, repo.index())) repo.remove(item.id);
			}, 50);
		};
	}, [repo, item.id, isNew]);

	const cycles = ix.cycleEdgesOf(item.id);
	const progress = progressSpec(schema) ? ix.progressOf(item) : undefined;

	// the top bar's place for the side panel's buttons, left of "…"
	const [panelSlot, setPanelSlot] = useState<HTMLElement | null>(null);
	const updatable = hasUpdates(schema) && !item.deleted;
	// with an update the card follows the properties and needs no line above it
	const updateCard = updatable && updateFeed(ix, item.id).length > 0;
	const tools = (
		<>
			<span className="contents" ref={setPanelSlot} />
			<MoreMenu>
				{(close) => (
					<>
						<MenuItem
							icon={<FolderInput size={14} />}
							onClick={() => {
								close();
								setPlacing(true);
							}}
						>
							{ix.parentsOf(item.id).length ? t("place.addAnother") : t("place.place")}
						</MenuItem>
						<MenuItem
							icon={<ImagePlus size={14} />}
							onClick={() => {
								close();
								fileInput.current?.click();
							}}
						>
							{t("editor.addFile")}
						</MenuItem>
						<MenuItem
							icon={item.pinned ? <PinOff size={14} /> : <Pin size={14} />}
							onClick={() => {
								close();
								repo.pin(item.id, !item.pinned);
							}}
						>
							{item.pinned ? t("item.unpin") : t("item.pin")}
						</MenuItem>
						{/* the inbox is where one works: put an entry there, or done with it there */}
						{!item.deleted &&
							(isInInbox(item, ix) ? (
								canCheckOff(item, ix) && (
									<MenuItem
										icon={<Check size={14} />}
										onClick={() => {
											close();
											repo.setInbox(item.id, false);
										}}
									>
										{t("item.outOfInbox")}
									</MenuItem>
								)
							) : (
								<MenuItem
									icon={<INBOX_ICON size={14} />}
									onClick={() => {
										close();
										repo.setInbox(item.id, true);
									}}
								>
									{t("item.toInbox")}
								</MenuItem>
							))}
						<MenuItem
							icon={<FilePlus size={14} />}
							onClick={() => {
								close();
								createAndOpen({ parents: [item.id] });
							}}
						>
							{t("item.newBelow")}
						</MenuItem>
						{others && !item.deleted && item.type !== META_TYPE && (
							<MenuItem
								icon={<ArrowRightLeft size={14} />}
								onClick={() => {
									close();
									setMoving(true);
								}}
							>
								{t("move.menu")}
							</MenuItem>
						)}
						{!item.deleted && (
							<MenuItem
								danger
								icon={<Trash2 size={14} />}
								onClick={() => {
									close();
									deleteOrAsk(repo, item.id, () => setDeleting(true));
								}}
							>
								{t("item.delete")}
							</MenuItem>
						)}
					</>
				)}
			</MoreMenu>
		</>
	);

	return (
		<div className="page-read">
			{item.deleted && <TrashBanner onRestore={() => repo.restore(item.id)} />}
			{/* 1 · head: path, title, type and status, progress, properties */}
			<Crumbs item={item} onPlace={() => setPlacing(true)} tools={tools} />
			<div className="mt-6 flex items-start gap-4 max-md:mt-3">
				<div className="min-w-0 flex-1 rounded-lg" data-page-title>
					<TitleField autoFocus={isNew && !item.title} item={item} />
				</div>
			</div>
			<PageDates className="mt-1" item={item} />
			{cycles.length > 0 && (
				<p className="mt-1 flex items-center gap-1.5 text-xs text-warn">
					<AlertTriangle size={12} />{" "}
					{t("item.cycle", { titles: cycles.map((c) => ix.get(c)?.title).join(", ") })}
				</p>
			)}
			<div className="mt-3 border-t border-line" />
			{/* what the page is as badges, the links, its dates, its progress, then the properties with their names */}
			<PropertyBlock
				head={{
					first: <TypeSwitch item={item} />,
					// "+ Ref" next to "+ Tags" until refs are pinned; then the "+" follows their chips
					afterTags: !pinnedRefs(item, ix).length && <AddRef item={item} text />,
					end: (
						<>
							<LinksMenu item={item} />
							{!item.deleted && (
								<Tip label={t("rules.title")}>
									<Button
										aria-label={t("rules.title")}
										className={cn(
											"tap inline-flex items-center justify-center rounded-lg p-1.5 transition-colors hover:bg-hover hover:text-fg",
											item.rules.trim() ? "text-fg" : "text-muted-foreground",
										)}
										onClick={() => setRulesOpen(true)}
										variant="plain"
									>
										<Bot size={16} />
									</Button>
								</Tip>
							)}
						</>
					),
					links: <LinksRow item={item} />,
					noEndLine: updateCard,
					progress: progress && (
						<ProgressBand
							desc={progressText(item, ix, progress.done, progress.total)}
							done={progress.done}
							total={progress.total}
						/>
					),
				}}
				item={item}
				schema={schema}
			/>
			{/* the newest update, and the side panel with all of them and the page's history */}
			<PagePanel bar={panelSlot} item={item} updates={updatable} />

			{/* 2 · text */}
			<PageText
				hasMore={ix.childrenOf(item.id).length > 0}
				isNew={isNew}
				item={item}
				onView={setView}
			/>
			<Input
				className="hidden"
				multiple
				onChange={(e) => view && insertFilesAtCursor(view, [...(e.target.files ?? [])])}
				ref={fileInput}
				type="file"
				variant="bare"
			/>

			{/* a line between the text one writes and what the page adds below it;
          mt-7, not mt-6: the editor has 4px padding on top only, so the text sits in the middle */}
			<div className="mt-7 border-t border-line" />
			<div className="[&>:first-child]:mt-6">
				{/* 3 · below: everything under the page, the same for every type (the links are in the head) */}
				<Below item={item} />
			</div>

			{placing && (
				<PlacePicker
					list={[item]}
					onClose={() => setPlacing(false)}
					onPick={(pid) => {
						repo.addParent(item.id, pid);
						rememberPlace(pid);
						setPlacing(false);
					}}
					title={t("place.add")}
				/>
			)}
			{deleting && <DeleteDialog item={item} onClose={() => setDeleting(false)} />}
			{rulesOpen && <AgentRulesDialog item={item} onClose={() => setRulesOpen(false)} />}
			{moving && <MoveDialog item={item} onClose={() => setMoving(false)} />}
		</div>
	);
}

/** "2 of 9 tasks done, all levels". */
function progressText(item: Item, ix: Index, done: number, total: number): string {
	const of = progressSpec(ix.schemaOf(item))?.of;
	const name = of ? (ix.typeName(of) ?? "") : "";
	return tr(of ? "progress.allLevelsOf" : "progress.allLevels", {
		done,
		total,
		name: name && pluralOf(name, getLang()),
	});
}

/** Zone 2: the page's text. */
function PageText({
	item,
	isNew,
	onView,
	hasMore,
}: {
	item: Item;
	isNew: boolean;
	onView: (v: EditorView | null) => void;
	hasMore: boolean;
}) {
	return (
		<div className="mt-6">
			<NoteEditor
				autoFocus={isNew && !!item.title}
				item={item}
				// room to start writing only while the text is empty and nothing else follows
				minHeight={item.body.trim() || hasMore ? "min-h-6" : "min-h-[30vh]"}
				onView={onView}
			/>
		</div>
	);
}

function TypeSwitch({ item }: { item: Item }) {
	const repo = useRepo();
	const ix = useIndex();
	const { t } = useT();
	const schema = ix.schemaOf(item);
	const inbox = isInInbox(item, ix);
	const types = ix.typesByName();
	const deletedType = item.type && !schema ? ix.all.get(item.type)?.schema?.name : undefined;
	return (
		<Popover
			trigger={(p) =>
				schema ? (
					<span {...p} className="inline-flex">
						<TypeChip onClick={p.onClick} schema={schema} />
					</span>
				) : (
					// no type: a plain line, not a chip – "Note" is no type
					<Button
						variant="plain"
						{...p}
						className={cn(
							"tap-y inline-flex items-center gap-1 rounded px-0.5 text-[13px] hover:underline",
							inbox ? "text-warn" : "text-muted-foreground",
						)}
						title={t("item.giveType")}
					>
						{inbox ? <INBOX_ICON size={12} /> : <NOTE_ICON size={12} />}
						{inbox ? t("kind.inbox") : t("kind.note")}
						{deletedType && (
							<span className="text-muted-foreground">
								· {t("type.deletedName", { name: deletedType })}
							</span>
						)}
					</Button>
				)
			}
		>
			{(close) => (
				<>
					<p className="px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground">{t("item.giveType")}</p>
					<MenuItem
						active={!item.type}
						icon={<NOTE_ICON size={14} style={{ color: "var(--t-note)" }} />}
						onClick={() => {
							repo.setType(item.id, null);
							close();
						}}
					>
						{t("kind.note")}
					</MenuItem>
					{types.map((type) => (
						<MenuItem
							active={type.id === item.type}
							icon={<TypeGlyph schema={type.schema} size={14} />}
							key={type.id}
							onClick={() => {
								repo.setType(item.id, type.id);
								close();
							}}
						>
							{type.schema.name}
						</MenuItem>
					))}
				</>
			)}
		</Popover>
	);
}

function removeAndLeave(inRepo: typeof repo, id: string, withChildren: boolean, leave = true) {
	inRepo.remove(id, withChildren ? "trash" : "inbox");
	if (leave) leavePage();
}

/**
 * With children that only hang here, the dialog asks first. `leave`: the item is the open page,
 * which then goes back. True when it went to the trash right away.
 */
export function deleteOrAsk(
	inRepo: typeof repo,
	id: string,
	ask: () => void,
	leave = true,
): boolean {
	if (onlyBelow(inRepo.index(), id).length) {
		ask();
		return false;
	}
	removeAndLeave(inRepo, id, false, leave);
	return true;
}

/** Children that only hang here: delete them too, or let them lose this place. */
export function DeleteDialog({
	item,
	onClose,
	leave = true,
}: {
	item: Item;
	onClose: () => void;
	leave?: boolean;
}) {
	const scoped = useRepo();
	const ix = scoped.index();
	const { t } = useT();
	const only = onlyBelow(ix, item.id);
	const finish = (withChildren: boolean) => {
		removeAndLeave(scoped, item.id, withChildren, leave);
		onClose();
	};
	// Kept children lose this place; whether they land in the inbox is the inbox's own query.
	const untyped = wouldBeInInbox(ix, only, (i) => i, [{ ...item, deleted: true }]);
	return (
		<Dialog onClose={onClose} title={t("delete.title", { title: titleOf(item, t) })}>
			<p className="text-sm">{t("delete.children", { count: only.length })}</p>
			{untyped > 0 && (
				<p className="mt-1 text-sm text-muted-foreground">
					{t("delete.toInbox", { count: untyped })}
				</p>
			)}
			<ul className="mt-3 max-h-48 space-y-0.5 overflow-y-auto">
				{only.slice(0, 30).map((c) => (
					<li className="flex items-center gap-1.5 text-sm text-muted-foreground" key={c}>
						<ItemIcon item={ix.get(c)!} size={13} /> {titleOf(ix.get(c)!, t)}
					</li>
				))}
			</ul>
			<div className="mt-4 flex justify-end gap-2">
				<Button onClick={() => finish(false)} variant="outline">
					{t("delete.keep")}
				</Button>
				<Button onClick={() => finish(true)} variant="danger">
					{t("delete.all", { count: only.length + 1 })}
				</Button>
			</div>
		</Dialog>
	);
}

/** "In anderen Workspace verschieben": with what hangs only below it; here it goes to the trash. */
function MoveDialog({ item, onClose }: { item: Item; onClose: () => void }) {
	const repo = useRepo();
	const { t } = useT();
	const { spaces, active } = useAccounts();
	const count = movedItems(repo.index(), item.id).length - 1;
	return (
		<Dialog onClose={onClose} title={t("move.title", { title: titleOf(item, t) })}>
			<p className="text-sm text-muted-foreground">
				{count > 0 ? t("move.introBelow", { count }) : t("move.intro")}
			</p>
			<ul className="mt-3 space-y-1">
				{spaces
					.filter((s) => s.id !== active?.id)
					.map((s) => (
						<li key={s.id}>
							<Button
								className="tap-row flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-left text-sm hover:bg-hover"
								onClick={() => {
									onClose();
									void moveTo(item.id, active!.id, s.id);
								}}
								variant="plain"
							>
								<span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
							</Button>
						</li>
					))}
			</ul>
		</Dialog>
	);
}
