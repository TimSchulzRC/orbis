// The quick note: the tray's button opens one new note as a card above the tray (on a phone as a
// sheet), written with the page's editor and sorted at once with the inbox's choices. Nothing else
// of the inbox shows, so nothing distracts. The note joins the inbox once something is in it: closed
// (Esc, ⌘↵, a click beside) it stays there; left empty, it goes without ever showing.

import type { Item } from "@obtion/core/model";
import { ChevronDown, Layers, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { replica, shownSpaces, spaceById, useAccounts } from "../accounts";
import { isBlank } from "../actions";
import { openItem, useRepo } from "../hooks";
import { tr, useT } from "../i18n";
import { createStore } from "../lib/store";
import { cn } from "../lib/utils";
import { notify } from "./feedback";
import { dismissShelf, entryKey, setDraft } from "./inbox";
import { NoteCard } from "./NoteCard";
import { Button, MenuItem, Popover } from "./primitives";
import { SortChoices } from "./SortChoices";
import { moveTo, SpaceScope } from "./Spaces";
import { KEYS, readJSON, writeJSON } from "./storage";
import { usePickers, useTriageActions } from "./TriageActions";

/** The workspace a new note goes to: the one shown, else the last chosen of those shown. */
export function captureSpace(): string | undefined {
	const shown = shownSpaces();
	if (shown.length === 1) return shown[0]!.id;
	const last = readJSON(KEYS.captureSpace, "");
	return (shown.find((s) => s.id === last) ?? shown[0])?.id;
}

/** The note being written, in workspace `space`, while the card is open. */
const quick = createStore<{ space?: string; id?: string }>({});
export const useQuickNote = () => !!quick.use().id;
/** Opens the card on note `id` (none: closes it); `keep` holds the old note back from the inbox until it is settled. */
function setQuick(space?: string, id?: string, keep = false) {
	quick.set({ space, id });
	if (!keep) setDraft(space && id ? entryKey(space, id) : undefined);
}
const newNote = (space: string) =>
	setQuick(space, replica(space).repo.create({ title: "", type: null, parents: [] }));

export function openQuickNote() {
	const space = captureSpace();
	if (quick.get().id || !space) return;
	dismissShelf();
	newNote(space);
}

/**
 * Closes the card; the note lies in the inbox, with a way to open it. The title commits on blur, and
 * the item follows its text a moment later: only then is an empty note discarded.
 */
export function closeQuickNote() {
	(document.activeElement as HTMLElement | null)?.blur();
	const { space, id } = quick.get();
	setQuick(undefined, undefined, true);
	if (!space || !id) return;
	setTimeout(() => {
		const repo = replica(space).repo;
		const item = repo.get(id);
		if (item && !item.deleted) {
			if (isBlank(item, repo.index())) repo.remove(id);
			else
				notify.action(tr("capture.notifyInbox"), tr("capture.open"), () =>
					openItem(item.id, { space }),
				);
		}
		if (!quick.get().id) setDraft();
	});
}

/**
 * The tray's button. It folds the card out and back in, so it looks like the inbox's button beside it:
 * no frame of its own, the plus where the inbox has its chevron, held down and turned to an X while
 * the card is out.
 */
export function QuickNoteButton() {
	const { t } = useT();
	const open = useQuickNote();
	return (
		<Button
			aria-expanded={open}
			className={cn(
				"tap-y flex min-h-11 items-center gap-2.5 rounded-xl py-1.5 pl-3 pr-2 text-sm font-semibold hover:bg-hover",
				open && "bg-hover",
			)}
			onClick={open ? closeQuickNote : openQuickNote}
			variant="plain"
		>
			{t("quick.title")}
			<Plus
				aria-hidden
				className={cn(
					"shrink-0 text-muted-foreground transition-transform duration-200",
					open && "rotate-45",
				)}
				size={16}
			/>
		</Button>
	);
}

/** The card while open: above the tray on a desktop, as a sheet on a phone. */
export function QuickNote({ desktop }: { desktop: boolean }) {
	const { space, id } = quick.use();
	if (!space || !id) return null;
	return (
		<SpaceScope id={space}>
			<QuickCard desktop={desktop} id={id} key={id} space={space} />
		</SpaceScope>
	);
}

/** An open dialog or menu (a tooltip's popper does not count): Esc is theirs. */
const OVERLAY_OPEN =
	"[role=dialog][data-state=open], [data-radix-popper-content-wrapper]:not(:has([role=tooltip]))";

function QuickCard({ id, space, desktop }: { id: string; space: string; desktop: boolean }) {
	const { t } = useT();
	const repo = useRepo();
	const item = repo.get(id);
	const spaceOf = () => space;
	const act = useTriageActions(spaceOf);
	// sorted, the note is done: the card closes, the notice offers its undo
	const sorted = () => setQuick();
	const pick = usePickers(
		spaceOf,
		(list, place) => {
			act.place(list, place);
			sorted();
		},
		(list, type) => {
			act.giveType(list, type);
			sorted();
		},
	);
	// Esc anywhere else, after the editor, which closes its own completions first
	const picking = useRef(false);
	picking.current = !!(pick.placing || pick.typing);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (
				e.key !== "Escape" ||
				e.defaultPrevented ||
				picking.current ||
				document.querySelector(OVERLAY_OPEN)
			)
				return;
			e.preventDefault();
			closeQuickNote();
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, []);
	if (!item) return null;
	// an empty note is not sorted: it goes, as when closed
	const sort = (fn: (it: Item) => void) => () => {
		(document.activeElement as HTMLElement | null)?.blur();
		const it = repo.get(id) ?? item;
		if (isBlank(it, repo.index())) {
			repo.remove(id);
			sorted();
		} else fn(it);
	};
	return (
		<div
			aria-label={t("quick.title")}
			className={cn(
				"flex flex-col border border-line bg-surface shadow-[0_18px_50px_-12px_rgb(0_0_0/0.45)]",
				desktop
					? "h-[min(620px,calc(100dvh-150px))] rounded-2xl p-5"
					: "h-full rounded-t-2xl px-4 pb-4 pt-2",
			)}
			data-quick-note
			// a link inside leads away (the open-full corner, a link in the text): the note stays in the inbox
			onClickCapture={(e) => (e.target as HTMLElement).closest("a[href]") && setQuick()}
			onKeyDownCapture={(e) => {
				if (pick.placing || pick.typing) return;
				// Esc in the title: before the title field takes it back to what it was
				const close =
					(e.key === "Enter" && (e.metaKey || e.ctrlKey)) ||
					(e.key === "Escape" &&
						(e.target as HTMLElement).matches("textarea") &&
						!document.querySelector(OVERLAY_OPEN));
				if (close) {
					e.preventDefault();
					e.stopPropagation();
					closeQuickNote();
				}
			}}
			role="dialog"
		>
			{!desktop && (
				<div aria-hidden className="mx-auto mb-2 h-1 w-10 shrink-0 rounded-full bg-line" />
			)}
			<NoteCard
				autoFocus
				className="min-h-0 flex-1"
				item={item}
				live
				meta={<SpaceChoice id={id} space={space} />}
			/>
			<SortChoices
				className="mt-4"
				item={item}
				keys={false}
				onLater={sort((it) => {
					act.later([it]);
					sorted();
				})}
				onPick={sort((it) => pick.setPlacing([it]))}
				onPin={sort((it) => {
					act.pin([it]);
					sorted();
				})}
				onTypes={sort((it) => pick.setTyping([it]))}
			/>
			{pick.node}
		</div>
	);
}

/** With several workspaces: which one the note goes to. Already written in, it moves there. */
function SpaceChoice({ space, id }: { space: string; id: string }) {
	const { t } = useT();
	const { spaces } = useAccounts();
	const name = spaceById(space)?.name;
	if (spaces.length < 2) return null;
	const choose = async (to: string) => {
		if (to === space) return;
		writeJSON(KEYS.captureSpace, to);
		const from = replica(space).repo;
		const item = from.get(id);
		if (!item || isBlank(item, from.index())) {
			if (item) from.remove(id);
			return newNote(to);
		}
		(document.activeElement as HTMLElement | null)?.blur();
		const moved = await moveTo(id, space, to);
		if (moved && quick.get().id === id) setQuick(to, moved);
	};
	return (
		<Popover
			trigger={(p) => (
				<Button
					variant="plain"
					{...p}
					aria-label={t("capture.spaceLabel", { name: name ?? "" })}
					className="tap-y inline-flex items-center gap-1 rounded-md px-1 hover:bg-hover hover:text-fg"
				>
					<Layers size={12} />
					{name}
					<ChevronDown size={12} />
				</Button>
			)}
		>
			{(close) =>
				spaces.map((s) => (
					<MenuItem
						active={s.id === space}
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
