// The quick note: the tray's button opens one new note as a card above the tray (on a phone as a
// sheet), written with the page's editor and sorted at once with the inbox's choices. Nothing else
// of the inbox shows, so nothing distracts. The note joins the inbox once something is in it: closed
// (Esc, ⌘↵, a click beside) it stays there; left empty, it goes without ever showing.
import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Layers, Plus } from "lucide-react";
import { replica, shownSpaces, spaceById, useAccounts } from "../accounts";
import { openItem, useRepo } from "../hooks";
import { tr, useT } from "../i18n";
import { isBlank } from "../actions";
import { createStore } from "../lib/store";
import { cn } from "../lib/utils";
import { Button, MenuItem, Popover } from "./primitives";
import { NoteCard } from "./NoteCard";
import { SortChoices } from "./SortChoices";
import { SpaceScope, moveTo } from "./Spaces";
import { usePickers, useTriageActions } from "./TriageActions";
import { dismissShelf, entryKey, setDraft } from "./inbox";
import { notify } from "./feedback";
import { KEYS, readJSON, writeJSON } from "./storage";

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
const newNote = (space: string) => setQuick(space, replica(space).repo.create({ title: "", type: null, parents: [] }));

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
      else notify.action(tr("capture.notifyInbox"), tr("capture.open"), () => openItem(item.id, { space }));
    }
    if (!quick.get().id) setDraft();
  });
}

/**
 * The tray's button. It folds the card out and back in, so it looks like the inbox's button beside it:
 * no frame of its own, the chevron pointing where the card goes, held down while the card is out.
 */
export function QuickNoteButton() {
  const { t } = useT();
  const open = useQuickNote();
  return (
    <Button
      variant="plain"
      onClick={open ? closeQuickNote : openQuickNote}
      aria-expanded={open}
      className={cn("tap-y flex min-h-11 items-center gap-2.5 rounded-xl py-1.5 pl-2.5 pr-2 text-sm font-semibold hover:bg-hover", open && "bg-hover")}
    >
      <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md transition-colors", open ? "bg-fg text-bg" : "bg-primary text-primary-foreground")} aria-hidden>
        <Plus size={15} strokeWidth={2.5} className={cn("transition-transform duration-200", open && "rotate-45")} />
      </span>
      {t("quick.title")}
      <ChevronUp size={14} className={cn("text-muted-foreground transition-transform duration-200", open && "rotate-180")} aria-hidden />
    </Button>
  );
}

/** The card while open: above the tray on a desktop, as a sheet on a phone. */
export function QuickNote({ desktop }: { desktop: boolean }) {
  const { space, id } = quick.use();
  if (!space || !id) return null;
  return (
    <SpaceScope id={space}>
      <QuickCard key={id} id={id} space={space} desktop={desktop} />
    </SpaceScope>
  );
}

/** An open dialog or menu (a tooltip's popper does not count): Esc is theirs. */
const OVERLAY_OPEN = "[role=dialog][data-state=open], [data-radix-popper-content-wrapper]:not(:has([role=tooltip]))";

function QuickCard({ id, space, desktop }: { id: string; space: string; desktop: boolean }) {
  const { t } = useT();
  const repo = useRepo();
  const item = repo.get(id);
  const spaceOf = () => space;
  const act = useTriageActions(spaceOf);
  // sorted, the note is done: the card closes, the notice offers its undo
  const sorted = () => setQuick();
  const pick = usePickers(spaceOf, (list, place) => (act.place(list, place), sorted()), (list, type) => (act.giveType(list, type), sorted()));
  // Esc anywhere else, after the editor, which closes its own completions first
  const picking = useRef(false);
  picking.current = !!(pick.placing || pick.typing);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && !picking.current && !document.querySelector(OVERLAY_OPEN) && (e.preventDefault(), closeQuickNote());
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  if (!item) return null;
  const now = () => ((document.activeElement as HTMLElement | null)?.blur(), repo.get(id) ?? item);
  return (
    <div
      role="dialog"
      aria-label={t("quick.title")}
      data-quick-note
      // a link inside leads away (the open-full corner, a link in the text): the note stays in the inbox
      onClickCapture={(e) => (e.target as HTMLElement).closest("a[href]") && setQuick()}
      onKeyDownCapture={(e) => {
        if (pick.placing || pick.typing) return;
        // Esc in the title: before the title field takes it back to what it was
        const close = (e.key === "Enter" && (e.metaKey || e.ctrlKey)) || (e.key === "Escape" && (e.target as HTMLElement).matches("textarea") && !document.querySelector(OVERLAY_OPEN));
        if (close) (e.preventDefault(), e.stopPropagation(), closeQuickNote());
      }}
      className={cn("flex flex-col border border-line bg-surface shadow-[0_18px_50px_-12px_rgb(0_0_0/0.45)]", desktop ? "h-[min(620px,calc(100dvh-150px))] rounded-2xl p-5" : "h-full rounded-t-2xl px-4 pb-4 pt-2")}
    >
      {!desktop && <div className="mx-auto mb-2 h-1 w-10 shrink-0 rounded-full bg-line" aria-hidden />}
      <NoteCard item={item} meta={<SpaceChoice space={space} id={id} />} autoFocus className="min-h-0 flex-1" />
      <SortChoices
        item={item}
        onPick={() => pick.setPlacing([now()])}
        onTypes={() => pick.setTyping([now()])}
        onLater={() => (act.later([now()]), sorted())}
        onPin={() => (act.pin([now()]), sorted())}
        keys={false}
        className="mt-4"
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
        <Button variant="plain" {...p} className="tap-y inline-flex items-center gap-1 rounded-md px-1 hover:bg-hover hover:text-fg" aria-label={t("capture.spaceLabel", { name: name ?? "" })}>
          <Layers size={12} />
          {name}
          <ChevronDown size={12} />
        </Button>
      )}
    >
      {(close) =>
        spaces.map((s) => (
          <MenuItem key={s.id} active={s.id === space} onClick={() => (close(), void choose(s.id))}>
            {s.name}
          </MenuItem>
        ))
      }
    </Popover>
  );
}
