// The quick note: the tray's field takes the title where it was clicked; Enter grows the note out of
// the field into a card (on a phone the "+" opens it as a sheet), written with the page's editor and
// sorted at once with the inbox's choices. Nothing else of the inbox shows, so nothing distracts. The
// note lies in the inbox from then on: closed with Esc or a click beside, it stays there as the draft
// the field reopens; left empty, it goes.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ChevronDown, Layers, PenLine } from "lucide-react";
import type { Item } from "@obtion/core/model";
import { isInInbox } from "@obtion/core/placement";
import { replica, shownSpaces, spaceById, useAccounts } from "../accounts";
import { openItem, useRepo } from "../hooks";
import { titleOf, tr, useT } from "../i18n";
import { isBlank } from "../actions";
import { createStore } from "../lib/store";
import { cn } from "../lib/utils";
import { Button, Kbd, MenuItem, Popover } from "./primitives";
import { type Edit, NoteCard } from "./NoteCard";
import { SortChoices } from "./SortChoices";
import { SpaceScope, moveTo } from "./Spaces";
import { usePickers, useTriageActions } from "./TriageActions";
import { dismissShelf } from "./inbox";
import { notify } from "./feedback";
import { KEYS, readJSON, writeJSON } from "./storage";

/** The workspace a new note goes to: the one shown, else the last chosen of those shown. */
export function captureSpace(): string | undefined {
  const shown = shownSpaces();
  if (shown.length === 1) return shown[0]!.id;
  const last = readJSON(KEYS.captureSpace, "");
  return (shown.find((s) => s.id === last) ?? shown[0])?.id;
}

/** `id`: the draft in workspace `space`, kept while closed. `at`: where the card puts the caret when it opens. */
const quick = createStore<{ open: boolean; space?: string; id?: string; at?: Edit }>({ open: false });
export const useQuickNote = quick.use;

/** The draft while it still lies in the inbox (sorted elsewhere or deleted, the next note starts anew). */
function draftOf(space?: string, id?: string): Item | undefined {
  if (!space || !id) return;
  const repo = replica(space).repo;
  const item = repo.get(id);
  return item && !item.deleted && isInInbox(item, repo.index()) ? item : undefined;
}

/** A new note in the workspace notes go to, or nothing without one. */
function create(title: string): { space: string; id: string } | undefined {
  const space = captureSpace();
  return space ? { space, id: replica(space).repo.create({ title, type: null, parents: [] }) } : undefined;
}

/** Opens the draft, else a new note: `title` typed into the field already, the caret then in the text. */
export function openQuickNote(title = "") {
  const s = quick.get();
  dismissShelf();
  if (draftOf(s.space, s.id)) return quick.set({ ...s, open: true, at: undefined });
  const made = create(title);
  if (made) quick.set({ open: true, ...made, at: title ? null : { title: 0 } });
}

/** A title typed into the field and left (Esc, a click elsewhere): it stays as the draft. */
function keepTyped(title: string) {
  const made = create(title);
  if (made) quick.set({ open: false, ...made });
}

/**
 * Closes the card. `keep`: the note stays the draft (Esc, a click beside), else the next one starts
 * anew. The title commits on blur, and the item follows its text a moment later: only then is an
 * empty note discarded.
 */
function stop(keep: boolean, then?: (item: Item) => void) {
  (document.activeElement as HTMLElement | null)?.blur();
  const { space, id } = quick.get();
  quick.set(keep ? { open: false, space, id } : { open: false });
  if (!space || !id) return;
  setTimeout(() => {
    const repo = replica(space).repo;
    const item = repo.get(id);
    if (!item || item.deleted) return;
    if (!isBlank(item, repo.index())) return then?.(item);
    repo.remove(id);
    if (quick.get().id === id) quick.set({ open: quick.get().open });
  });
}
export const closeQuickNote = () => stop(true);

const filed = (item: Item, space?: string) => notify.action(tr("capture.notifyInbox"), tr("capture.open"), () => openItem(item.id, { space }));

/** "Fertig": the note lies in the inbox, with a way to open it. */
const finish = () => {
  const space = quick.get().space;
  stop(false, (item) => filed(item, space));
};

/** ⌘↵ in the field: the title alone, straight into the inbox. */
function fileTyped(title: string) {
  const made = create(title);
  const item = made && replica(made.space).repo.get(made.id);
  if (item) filed(item, made.space);
}

/** The tray's field: opens the card, and names the draft waiting in it. */
export function QuickNoteField({ className }: { className?: string }) {
  const { open, space, id } = useQuickNote();
  return (
    <Scoped space={space}>
      <Field open={open} id={id} className={className} />
    </Scoped>
  );
}

function Field({ open, id, className }: { open: boolean; id?: string; className?: string }) {
  const { t } = useT();
  const repo = useRepo(); // follows the draft as it is written
  const item = id ? repo.get(id) : undefined;
  const draft = !open && item && !item.deleted && isInInbox(item, repo.index()) && !isBlank(item, repo.index()) ? item : undefined;
  const look = "tap-y flex h-11 w-full min-w-0 items-center gap-2 rounded-2xl border px-3.5 text-left text-[15px]";
  // no draft: the field takes the title right here, the card comes with Enter
  if (!open && !draft) return <TitleInField className={cn(look, className)} />;
  return (
    <Button
      variant="plain"
      data-quick-field
      onClick={() => (open ? closeQuickNote() : openQuickNote())}
      aria-expanded={open}
      className={cn(look, open ? "border-focus text-fg" : "border-line text-muted-foreground hover:bg-hover", className)}
    >
      <PenLine size={15} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{open ? t("quick.writing") : t("quick.draft", { title: titleOf(draft!, t) })}</span>
    </Button>
  );
}

/** One line, as high as the tray: Enter on into the text in the card, ⌘↵ files the title alone, Esc or leaving keeps it as the draft. */
function TitleInField({ className }: { className: string }) {
  const { t } = useT();
  const [title, setTitle] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const typed = title.trim();
  return (
    <label data-quick-field className={cn(className, "cursor-text border-line text-muted-foreground focus-within:border-focus focus-within:text-fg hover:bg-hover focus-within:hover:bg-transparent")}>
      <PenLine size={15} className="shrink-0" />
      <input
        ref={input}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return void (e.preventDefault(), typed && (setTitle(""), fileTyped(typed)));
          if (e.key === "Enter") return void (e.preventDefault(), setTitle(""), openQuickNote(typed));
          if (e.key === "Escape") return void (e.preventDefault(), input.current?.blur());
        }}
        // left with a title (Esc, a click elsewhere): kept as the draft the field then names
        onBlur={() => typed && !quick.get().open && (setTitle(""), keepTyped(typed))}
        placeholder={t("tray.placeholder")}
        aria-label={t("quick.title")}
        className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted-foreground"
      />
      {typed && (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" aria-hidden>
          <Kbd>↵</Kbd> {t("quick.hintText")} <Kbd>⌘↵</Kbd> {t("quick.hintFile")}
        </span>
      )}
    </label>
  );
}

const Scoped = ({ space, children }: { space?: string; children: ReactNode }) => (space ? <SpaceScope id={space}>{children}</SpaceScope> : <>{children}</>);

/** The card while open: above the tray's field on a desktop, as a sheet on a phone. */
export function QuickNote({ desktop }: { desktop: boolean }) {
  const { open, space, id } = useQuickNote();
  if (!open || !space || !id) return null;
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
  // as the field asked (its title already typed: in the text), else a new note in its title, a draft where the text ends
  const [editing] = useState<{ at: Edit }>(() => ({ at: quick.get().at !== undefined ? quick.get().at! : item && isBlank(item, repo.index()) ? { title: 0 } : null }));
  const spaceOf = () => space;
  const act = useTriageActions(spaceOf);
  // sorted, the note is done: the card closes, the notice offers its undo
  const sorted = () => quick.set({ open: false });
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
      onClickCapture={(e) => (e.target as HTMLElement).closest("a[href]") && quick.set({ open: false })}
      onKeyDownCapture={(e) => {
        if (pick.placing || pick.typing) return;
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return void (e.preventDefault(), e.stopPropagation(), finish());
        // in the title, before the field takes Esc back to what it was
        if (e.key === "Escape" && (e.target as HTMLElement).matches("textarea") && !document.querySelector(OVERLAY_OPEN)) (e.preventDefault(), e.stopPropagation(), closeQuickNote());
      }}
      // on a desktop it grows out of the field it covers
      className={cn("flex flex-col border border-line bg-surface shadow-[0_18px_50px_-12px_rgb(0_0_0/0.45)]", desktop ? "quick-grow h-[min(620px,calc(100dvh-110px))] rounded-2xl p-5" : "h-full rounded-t-2xl px-4 pb-4 pt-2")}
    >
      {!desktop && <div className="mx-auto mb-2 h-1 w-10 shrink-0 rounded-full bg-line" aria-hidden />}
      <NoteCard item={item} meta={<SpaceChoice space={space} id={id} />} editing={editing} onDone={finish} doneKey={desktop ? "⌘↵" : undefined} className="min-h-0 flex-1" />
      <SortChoices
        item={item}
        onPick={() => pick.setPlacing([now()])}
        onTypes={() => pick.setTyping([now()])}
        onLater={() => (act.later([now()]), sorted())}
        onPin={() => (act.pin([now()]), sorted())}
        keys={false}
        quiet
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
      return quick.set({ open: true, space: to, id: replica(to).repo.create({ title: "", type: null, parents: [] }) });
    }
    (document.activeElement as HTMLElement | null)?.blur();
    const moved = await moveTo(id, space, to);
    if (moved) quick.set({ open: quick.get().open, space: to, id: moved });
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
