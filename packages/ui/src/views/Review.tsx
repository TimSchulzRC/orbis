// The inbox panel: the list on the left, the chosen entry on the right to read, edit and sort; on a
// phone the list, and the entry as a sheet over it. Sorting moves on to the next entry and the sorted
// one down under "Einsortiert" in the list, with its undo. The entry's card keeps one height, so the
// choices below it never move.
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { ArrowLeft, Check, Clock, FolderInput, Maximize2, Pencil, Pin, Shapes, Trash2, Undo2, X } from "lucide-react";
import { belowOf } from "@obtion/core/placement";
import type { Item } from "@obtion/core/model";
import { plainText } from "@obtion/core/search";
import { useRepo, useItemHref, openItem } from "../hooks";
import { replica, spaceById, useAccounts } from "../accounts";
import { useT, titleOf } from "../i18n";
import { useBlobUrl } from "../files";
import { Button, Empty, Kbd, IconButton } from "../ui/primitives";
import { ItemIcon, RelTime, Tag, itemLook, kindLabel } from "../ui/item-look";
import { cn } from "../lib/utils";
import { Markdown } from "../ui/Markdown";
import { Editor } from "../ui/Editor";
import { TitleField } from "../ui/TitleField";
import { SpaceScope } from "../ui/Spaces";
import { InboxList, backNow } from "../ui/Shelf";
import { type InboxEntry, closeShelf, dismissShelf, openShelf, useInboxItems, useLaterItems, useShelf } from "../ui/inbox";
import { type Undo, revert, usePickers, useTriageActions } from "../ui/TriageActions";
import { KEYS, readJSON, writeJSON } from "../ui/storage";

interface Sorted {
  key: string;
  title: string;
  what: string;
  undo: Undo;
}

/** Where the entry was clicked to edit it (`title`: the caret offset in the title); null from the button. */
type Edit = { x: number; y: number; title?: number } | null;

/** The sorting on this device: kept while the panel is closed. What was sorted stays, also across a reload and into tomorrow, until "Fertig" or cleared by hand. */
let session: { order: string[]; at?: string } | null = null;
const storedSorted = () => readJSON<Sorted[]>(KEYS.inboxSorted, []);

/** Pixels the arrow keys scroll a long entry. */
const ARROW_SCROLL = 80;
/** Pixels a swipe on a phone must travel to step to the next entry. */
const SWIPE = 70;
/** Above this many entries the progress is a bar instead of steps. */
const MAX_STEPS = 16;
/** Characters of a file's text shown in place of a body. */
const FILE_TEXT_PREVIEW = 1200;
/** An open dialog or menu (a tooltip's popper does not count): Escape is theirs. */
const OVERLAY_OPEN = "[role=dialog][data-state=open], [data-radix-popper-content-wrapper]:not(:has([role=tooltip]))";

/** Pinned (on desktop Heute) it is part of the page: no close, and the keys only while the focus is in it. */
export function InboxPanel({ desktop, pinned }: { desktop: boolean; pinned?: boolean }) {
  const { t } = useT();
  const { at } = useShelf();
  const self = useRef<HTMLDivElement>(null);
  // take the keys from the button that opened the panel
  useEffect(() => void (!pinned && self.current?.focus()), []);
  useEffect(() => {
    if (pinned) return;
    const was = document.title;
    document.title = t("review.title");
    return () => void (document.title = was);
  }, [pinned]);
  // on a phone the list, an entry over it as a sheet
  const sheet = !desktop && !!at;
  return (
    <div
      ref={self}
      tabIndex={-1}
      // pinned it is part of the tray's region, else a dialog over the page
      role={pinned ? undefined : "dialog"}
      aria-label={pinned ? undefined : t("review.title")}
      data-shelf-panel={pinned ? "pinned" : "open"}
      // a link inside leads away: the panel closes behind it
      onClickCapture={(e) => (e.target as HTMLElement).closest("a[href]") && closeShelf()}
      className={cn(
        "flex flex-col overflow-hidden border border-line bg-surface outline-none",
        pinned
          ? "h-full rounded-2xl shadow-[0_6px_24px_-12px_rgb(0_0_0/0.25)]"
          : cn("shadow-[0_18px_50px_-12px_rgb(0_0_0/0.45)]", desktop ? "h-[min(900px,calc(100dvh-150px))] rounded-2xl" : sheet ? "h-full rounded-t-2xl" : "max-h-[min(70dvh,560px)] rounded-2xl"),
      )}
    >
      {!desktop && <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line" aria-hidden />}
      <Inbox at={at} desktop={desktop} pinned={!!pinned} panel={self} />
    </div>
  );
}

/** A key that belongs to a field, or to a menu or dialog above the panel. */
function othersKey(el: Element) {
  if (el.closest("input, textarea, select, [contenteditable=true], .cm-editor")) return true;
  const layer = el.closest("[role=dialog], [role=menu], [role=listbox]");
  return !!layer && !layer.hasAttribute("data-shelf-panel");
}

/** `at`: the entry asked for, "<workspace>/<id>" (a card on Heute, a row on a phone). */
function Inbox({ at, desktop, pinned, panel }: { at?: string; desktop: boolean; pinned: boolean; panel: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useT();
  const entries = useInboxItems();
  const later = useLaterItems();
  const { shown } = useAccounts();
  const order = useRef<string[]>(session?.order ?? []);
  // what arrives meanwhile joins the end
  for (const e of entries) if (!order.current.includes(e.key)) order.current.push(e.key);
  const [sorted, setSorted] = useState<Sorted[]>(storedSorted);
  const [chosen, setChosen] = useState<string | undefined>(at ?? session?.at);
  // another entry asked for while open
  useEffect(() => void (at && setChosen(at)), [at]);
  const card = useRef<HTMLDivElement>(null);
  const byKey = new Map([...entries, ...later].map((e) => [e.key, e]));
  // set aside till tomorrow and back in the inbox now: waiting again, no longer sorted
  const due = sorted.filter((s) => s.undo.steps.some((step) => step.later !== undefined) && entries.some((e) => e.key === s.key));
  useEffect(() => void (due.length && setSorted((list) => list.filter((s) => !due.includes(s)))), [due.length]);
  const done = (k: string) => sorted.some((s) => s.key === k && !due.includes(s));
  const left = order.current.filter((k) => entries.some((e) => e.key === k) && !done(k));
  // back tomorrow and not just sent there here (that one is under "Einsortiert")
  const waitingLater = later.filter((e) => !done(e.key));
  const isLater = (k?: string) => !!k && waitingLater.some((e) => e.key === k);
  // the chosen entry while it still waits (also one back tomorrow), else the next one after its place
  const pickAt = (wanted?: string) => (wanted && (left.includes(wanted) || isLater(wanted)) ? wanted : (order.current.slice(order.current.indexOf(wanted ?? "") + 1).find((k) => left.includes(k)) ?? left.at(-1)));
  const key = pickAt(chosen);
  const entry = key ? byKey.get(key) : undefined;
  const waiting = isLater(key);
  // a phone shows the entry only when one was asked for
  const listOnly = !desktop && !at;
  // editing belongs to the entry shown: another one (sorted, stepped to, undone) starts unedited
  const [editing, setEditing] = useState<{ key?: string; at: Edit } | null>(null);
  if (editing && editing.key !== key) setEditing(null);
  const stopEditing = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    setEditing(null);
  };
  useEffect(() => void (session = { order: order.current, at: key }), [key]);
  useEffect(() => writeJSON(KEYS.inboxSorted, sorted), [sorted]);

  const act = useTriageActions(() => entry!.space, { quiet: true });
  const record = (target: InboxEntry, what: string, undo?: Undo | null) => {
    if (!undo) return;
    const title = replica(target.space).repo.get(target.item.id)?.title ?? target.item.title; // may have just been edited
    setSorted((list) => [...list.filter((s) => s.key !== target.key), { key: target.key, title: titleOf({ title, file: target.item.file }, t), what, undo }]);
    setChosen(target.key);
  };
  const placeIn = (list: Item[], place: string) => entry && record(entry, `→ ${replica(entry.space).repo.index().get(place)?.title ?? ""}`, act.place(list, place));
  const typeAs = (list: Item[], type: string) => entry && record(entry, replica(entry.space).repo.index().typeName(type) ?? "", act.giveType(list, type));
  const pick = usePickers(() => entry!.space, placeIn, typeAs);
  const later_ = () => entry && (waiting ? backNow(replica(entry.space).repo, entry.item.id) : record(entry, t("review.done.later"), act.later([entry.item])));
  const pin = () => entry && record(entry, t("review.done.pinned"), act.pin([entry.item]));
  const trash = () => entry && void act.trash([entry.item]).then((back) => record(entry, t("review.done.trashed"), back));
  const undo = (target = sorted.at(-1)) => {
    if (!target) return;
    revert(target.undo);
    setSorted((list) => list.filter((s) => s !== target));
    setChosen(target.key);
  };
  const choose = (k: string) => (desktop ? setChosen(k) : (setChosen(k), openShelf(k)));
  const step = (direction: 1 | -1) => {
    const index = key ? left.indexOf(key) : -1;
    const next = left[index + direction];
    if (next) setChosen(next);
  };
  const finish = () => {
    session = null;
    writeJSON(KEYS.inboxSorted, []); // closing unmounts before the effect would store it
    setSorted([]);
    dismissShelf();
  };

  // on the window in the capture phase, so the page below the panel does not get the keys
  const keys = useRef<(e: KeyboardEvent) => void>(null);
  keys.current = (e) => {
    const el = e.target as HTMLElement;
    // pinned the panel is part of the page: its keys only while the focus is in it
    if (pinned && !panel.current?.contains(document.activeElement)) return;
    // while editing the keys are the text's (Esc: below, after the editor)
    if (editing || pick.placing || pick.typing || othersKey(el) || e.metaKey || e.ctrlKey || e.altKey) return;
    const pressed = e.key;
    // Enter on a button or link is its own; Tab moves the focus
    if ((pressed === "Enter" && el.closest("button, a")) || pressed === "Tab") return;
    // a menu or popover open above (a tooltip aside) gets its own Esc
    if (pressed === "Escape" && document.querySelector(OVERLAY_OPEN)) return;
    if (listOnly && pressed !== "Escape") return;
    e.stopPropagation();
    const info = entry?.item.kind === "info";
    if (pressed === "Escape") {
      if (!desktop && at) openShelf();
      else if (!pinned) dismissShelf();
      else return;
    } else if (pressed === "u" || pressed === "z") undo();
    else if (!entry) return;
    else if (pressed === "e") pick.setPlacing([entry.item]);
    else if (pressed === "y" && info) pick.setTyping([entry.item]);
    else if (pressed === "s") later_();
    else if (pressed === "a") pin();
    else if (pressed === "x" || pressed === "Delete") trash();
    else if (pressed === "ArrowDown" || pressed === "ArrowUp") card.current?.scrollBy({ top: pressed === "ArrowDown" ? ARROW_SCROLL : -ARROW_SCROLL });
    else if (pressed === "j" || pressed === "ArrowRight") step(1);
    else if (pressed === "k" || pressed === "ArrowLeft") step(-1);
    else if (pressed === "Enter" || pressed === "o") (closeShelf(), openItem(entry.item.id, { space: entry.space }));
    else return;
    e.preventDefault();
  };
  // Esc ends editing once the editor had it, unless it used it (its completions close first)
  const escape = useRef<(e: KeyboardEvent) => void>(null);
  escape.current = (e) => editing && e.key === "Escape" && !e.defaultPrevented && !pick.placing && !pick.typing && (e.preventDefault(), stopEditing());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current?.(e);
    const onEscape = (e: KeyboardEvent) => escape.current?.(e);
    addEventListener("keydown", onKey, true);
    addEventListener("keydown", onEscape);
    return () => (removeEventListener("keydown", onKey, true), removeEventListener("keydown", onEscape));
  }, []);

  const total = sorted.length + left.length;
  const several = shown.length > 1;
  const touchX = useRef<number | null>(null);
  const list = (
    <InboxList
      waiting={left.map((k) => byKey.get(k)!)}
      later={waitingLater}
      sorted={sorted}
      current={desktop ? key : undefined}
      onPick={choose}
      onUndo={(k) => undo(sorted.find((s) => s.key === k))}
      onClear={() => setSorted([])}
    />
  );
  const head = <ReviewHead total={total} at={entry && !waiting ? sorted.length + 1 : total} sorted={sorted.length} onBack={desktop ? undefined : () => openShelf()} onClose={pinned ? undefined : dismissShelf} />;
  const body = entry ? (
    <SpaceScope id={entry.space}>
      <EntryCard key={entry.key} entry={entry} space={several ? spaceById(entry.space)?.name : undefined} scroller={card} editing={editing} onEdit={(at) => setEditing({ key, at })} onDone={stopEditing} />
      <Choices entry={entry} waiting={waiting} onPick={() => (stopEditing(), pick.setPlacing([entry.item]))} onTypes={() => (stopEditing(), pick.setTyping([entry.item]))} onLater={later_} onPin={pin} onTrash={trash} keys={desktop} quiet={!!editing} />
    </SpaceScope>
  ) : (
    <Finished count={sorted.length} onDone={pinned ? undefined : finish} />
  );

  if (listOnly) return <div className="flex min-h-0 flex-1 flex-col">{list}{pick.node}</div>;
  if (!desktop)
    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 pb-4 pt-2"
        onTouchStart={(e) => (touchX.current = e.touches[0]!.clientX)}
        onTouchEnd={(e) => {
          const dx = (e.changedTouches[0]?.clientX ?? 0) - (touchX.current ?? 0);
          if (!editing && Math.abs(dx) > SWIPE) step(dx < 0 ? 1 : -1);
          touchX.current = null;
        }}
      >
        {head}
        <div className="mt-4 flex min-h-0 flex-1 flex-col">{body}</div>
        {/* below, so nothing above moves */}
        {sorted.length > 0 && <LastSorted last={sorted.at(-1)!} onUndo={() => undo()} />}
        {pick.node}
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[280px] shrink-0 flex-col border-r border-line">{list}</div>
      <div className="flex min-w-0 flex-1 flex-col p-6">
        {head}
        <div className="mt-5 flex min-h-0 flex-1 flex-col">{body}</div>
      </div>
      {pick.node}
    </div>
  );
}

function ReviewHead({ total, at, sorted, onBack, onClose }: { total: number; at: number; sorted: number; onBack?: () => void; onClose?: () => void }) {
  const { t } = useT();
  return (
    <header className="shrink-0">
      <div className="flex items-center gap-3">
        {onBack && <IconButton icon={ArrowLeft} iconSize={16} onClick={onBack} label={t("tray.title")} title={t("tray.title")} className="-ml-1.5 shrink-0" />}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold leading-6">{t("review.heading")}</h2>
          <p className="truncate text-[13px] tabular-nums text-muted-foreground">{total ? t("review.position", { at, count: total }) : t("review.empty")}</p>
        </div>
        {onClose && <IconButton icon={X} iconSize={16} onClick={onClose} label={t("review.close")} title={t("review.close")} className="shrink-0 self-start" />}
      </div>
      {total > 0 && <Steps total={total} done={sorted} />}
    </header>
  );
}

function Steps({ total, done }: { total: number; done: number }) {
  const { t } = useT();
  const label = t("review.position", { at: Math.min(done + 1, total), count: total });
  if (total > MAX_STEPS)
    return (
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-2 dark:bg-hover" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total} aria-label={label}>
        <div className="h-full rounded-full bg-[var(--ok)]" style={{ width: `${(done / total) * 100}%` }} />
      </div>
    );
  return (
    <div className="mt-4 flex gap-1" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total} aria-label={label}>
      {Array.from({ length: total }, (_, n) => (
        <span key={n} className={cn("h-1 flex-1 rounded-full", n < done ? "bg-[var(--ok)]" : n === done ? "bg-inbox" : "bg-line")} />
      ))}
    </div>
  );
}

/** As tall as the panel leaves, the same for every entry, so the choices below never move; a long entry scrolls inside. */
function EntryCard({ entry, space, scroller, editing, onEdit, onDone }: { entry: InboxEntry; space?: string; scroller: React.RefObject<HTMLDivElement | null>; editing: { at: Edit } | null; onEdit: (at: Edit) => void; onDone: () => void }) {
  const { t } = useT();
  const hrefOf = useItemHref();
  const repo = useRepo();
  const ix = repo.index();
  const item = repo.get(entry.item.id) ?? entry.item;
  // in the inbox, a loose note is just a note
  const kind = kindLabel(itemLook(item, ix), t, { inboxAsNote: true });
  const children = belowOf(item.id, ix);
  const image = useBlobUrl(item.file?.filetype === "bild" ? (item.file.display ?? item.file.hash) : item.file?.thumb, true);
  const [overflows, setOverflows] = useState(false);
  const self = useRef<HTMLElement>(null);
  const at = editing?.at;
  // a click outside the card ends editing, but not one in what the editor opened (a menu, a picture)
  useEffect(() => {
    if (!editing) return;
    const onPointer = (e: PointerEvent) => {
      const el = e.target as Element;
      if (!self.current?.contains(el) && !el.closest?.(".cm-menu, .cm-tooltip, [role=dialog]:not([data-shelf-panel]), [data-radix-popper-content-wrapper]")) onDone();
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [!!editing]);
  const hasText = !item.file;
  // the title clicked (or a file, which has no text here): the caret where clicked, else at its end
  useEffect(() => {
    if (!editing || (hasText && at?.title === undefined)) return;
    const el = scroller.current?.querySelector("textarea");
    const caret = Math.min(at?.title ?? Infinity, el?.value.length ?? 0);
    el?.focus();
    el?.setSelectionRange(caret, caret);
  }, [!!editing]);
  const placeCaret = (view: EditorView | null) => {
    if (!view || at?.title !== undefined) return;
    view.focus();
    // after the editor's first measure: before it, its heights are guesses
    requestAnimationFrame(() => view.dom.isConnected && view.dispatch({ selection: { anchor: (at && view.posAtCoords(at, false)) ?? view.state.doc.length } }));
  };
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    el.addEventListener("scroll", measure, { passive: true });
    return () => (observer.disconnect(), el.removeEventListener("scroll", measure));
  }, []);
  return (
    <div className="min-h-[180px] flex-1">
      <div className="relative h-full">
      <article
        ref={self}
        className={cn(
          "relative flex h-full flex-col overflow-hidden rounded-2xl border bg-surface shadow-sm",
          editing ? "border-focus/55 ring-4 ring-focus/12" : "cursor-text border-line",
        )}
        onClick={(e) => {
          const el = e.target as HTMLElement;
          if (editing || el.closest("a, button, img") || getSelection()?.toString()) return;
          const caret = document.caretPositionFromPoint?.(e.clientX, e.clientY)?.offset ?? document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startOffset; // Safari has only the latter
          onEdit({ x: e.clientX, y: e.clientY, title: el.closest("h2") ? (caret ?? Infinity) : undefined });
        }}
      >
        <div className="relative min-h-0 flex-1">
        <div ref={scroller} className="h-full overflow-y-auto px-8 pb-3 pt-7 max-lg:px-5 max-lg:pt-5">
        <div className="flex items-start gap-2 text-[13px] text-muted-foreground">
          <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-fg">
              <ItemIcon item={item} size={13} /> {kind}
            </span>
            {space && <span>{space}</span>}
            <span>
              {t("triage.captured")} <RelTime ts={item.created} />
            </span>
          </p>
          <a href={hrefOf(item.id)} className="tap -mr-1.5 -mt-1 shrink-0 rounded-md p-1.5 hover:bg-hover hover:text-fg" aria-label={t("review.open")} title={t("review.open")}>
            <Maximize2 size={15} />
          </a>
        </div>
        {editing ? (
          <>
            {/* as large as the title it replaces (over the page title's own size), so nothing below moves */}
            <div className="mt-4 [&_textarea]:text-[28px]! [&_textarea]:leading-[34px]! [&_textarea]:tracking-[-0.015em]! max-lg:[&_textarea]:text-2xl!">
              <TitleField item={item} autoFocus={false} placeholder={item.file?.name} />
            </div>
            {hasText && (
              <div className="mt-3 max-w-[68ch] text-[15px] leading-[1.65]">
                <Editor doc={repo.getDoc(item.id)} nodeId={item.id} minHeight="min-h-24" onView={placeCaret} />
              </div>
            )}
          </>
        ) : (
          <h2 className="mt-4 text-[28px] font-bold leading-[34px] tracking-[-0.015em] max-lg:text-2xl">{titleOf(item, t)}</h2>
        )}
        {editing && hasText ? null : item.body.trim() ? (
          <div className="mt-4 max-w-[68ch] text-[15px] leading-[1.65]">
            <Markdown src={item.body} />
          </div>
        ) : item.file?.text ? (
          <p className="mt-4 max-w-[68ch] text-[15px] leading-[1.65] text-muted-foreground">{plainText(item.file.text).slice(0, FILE_TEXT_PREVIEW)}</p>
        ) : null}
        {image && <img src={image} alt={item.title} className="mt-4 max-h-[50vh] w-auto rounded-lg border border-line" />}
        {item.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {item.tags.map((tag) => (
              <Tag key={tag} tag={tag} />
            ))}
          </div>
        )}
        {children.length > 0 && (
          <div className="mt-5 border-t border-line pt-4">
            <p className="mb-1.5 text-xs font-semibold text-muted-foreground">{t("below.title")}</p>
            <ul className="space-y-1 text-sm">
              {children.map((child) => (
                <li key={child.id} className="flex items-center gap-2">
                  <ItemIcon item={child} size={14} /> <a href={hrefOf(child.id)} className="truncate hover:underline">{titleOf(child, t)}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
        </div>
        {overflows && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface to-transparent" aria-hidden />}
        </div>
        {/* as far from the corner as "Öffnen" above (its box: the padding less its -1.5 margins) */}
        <div className="flex shrink-0 justify-end pb-6 pl-8 pr-6.5 pt-1 max-lg:pb-4 max-lg:pl-5 max-lg:pr-3.5">
          <Button
            variant="plain"
            onClick={() => (editing ? onDone() : onEdit(null))}
            className={cn(
              "tap inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium",
              editing
                ? "border-focus/40 bg-focus/10 text-focus hover:bg-focus/16"
                : "border-transparent text-muted-foreground hover:bg-hover hover:text-fg",
            )}
          >
            {editing ? <Check size={15} /> : <Pencil size={14} />} {t(editing ? "review.editDone" : "review.edit")}
          </Button>
        </div>
      </article>
      </div>
    </div>
  );
}

/**
 * The five buttons stay the same and in the same place for every entry. Key hints go invisible while
 * the entry is edited, keeping their room so the buttons do not move. One back tomorrow comes back now
 * instead of "Morgen".
 */
function Choices({ entry, waiting, onPick, onTypes, onLater, onPin, onTrash, keys, quiet }: { entry: InboxEntry; waiting: boolean; onPick: () => void; onTypes: () => void; onLater: () => void; onPin: () => void; onTrash: () => void; keys: boolean; quiet: boolean }) {
  const { t } = useT();
  const info = entry.item.kind === "info";
  const hint = (key: string) => keys && <span className={cn("hidden @[600px]:inline-flex", quiet && "invisible")}><Kbd>{key}</Kbd></span>;
  const tile = (icon: ReactNode, label: string, key: string, onClick: () => void, opts: { primary?: boolean; danger?: boolean; disabled?: boolean } = {}) => (
    <Button
      variant="plain"
      onClick={onClick}
      disabled={opts.disabled}
      // delete on a desktop is only its icon: the name and key on hover
      title={opts.danger && keys ? `${label} (${key})` : undefined}
      className={cn(
        "tap flex h-9 min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 text-[13px] font-medium disabled:opacity-40",
        opts.primary ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/90 max-lg:col-span-2" : "border-line bg-surface hover:bg-hover",
        opts.danger && "text-danger lg:w-9 lg:flex-none lg:justify-center lg:px-0",
      )}
    >
      {icon}
      <span className={cn("min-w-0 flex-1 truncate px-1 text-center", opts.danger && "lg:sr-only")}>{label}</span>
      {!opts.danger && hint(key)}
    </Button>
  );
  return (
    <div className="@container mt-6 flex shrink-0 gap-2 max-lg:grid max-lg:grid-cols-2">
      {tile(<FolderInput size={15} />, t("review.placeAction"), "e", onPick, { primary: true })}
      {tile(<Shapes size={15} />, t("review.convertAction"), "y", onTypes, { disabled: !info })}
      {waiting ? tile(<Undo2 size={15} />, t("review.backAction"), "s", onLater) : tile(<Clock size={15} />, t("review.laterAction"), "s", onLater)}
      {tile(<Pin size={15} />, t("review.pin"), "a", onPin)}
      {tile(<Trash2 size={15} />, t("triage.delete"), "x", onTrash, { danger: true })}
    </div>
  );
}

/** The phone's "Erledigt" in place of the list. */
function LastSorted({ last, onUndo }: { last: Sorted; onUndo: () => void }) {
  const { t } = useT();
  return (
    <div className="mt-4 flex items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--ok)_35%,transparent)] bg-[color-mix(in_srgb,var(--ok)_8%,transparent)] px-3 py-2 text-[13px]" aria-live="polite">
      <Check size={15} className="shrink-0 text-ok" />
      <span className="min-w-0 flex-1 truncate">
        {last.title} <span className="text-muted-foreground">· {last.what}</span>
      </span>
      <Button variant="plain" onClick={onUndo} className="tap shrink-0 font-medium text-link hover:underline">
        {t("triage.undo")}
      </Button>
    </div>
  );
}

function Finished({ count, onDone }: { count: number; onDone?: () => void }) {
  const { t } = useT();
  return (
    <div className="flex flex-1 flex-col justify-center rounded-2xl border border-line bg-surface">
      <Empty icon={<Check size={22} className="text-ok" />} title={count ? t("review.finished", { count }) : t("inbox.empty")}>
        {onDone && (
          <Button variant="primary" onClick={onDone} className="mt-2">
            {t("review.finish")}
          </Button>
        )}
      </Empty>
    </div>
  );
}
