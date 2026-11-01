// The review (the act "einsortieren"): the inbox one entry at a time, as a stack – the tray's
// panel, sorting (ui/Tray.tsx; its list is ui/Shelf.tsx), over the page that is open, nearly to the
// top of the window; on a phone a sheet over the whole screen. The entry on top fills what the
// panel leaves (a long one scrolls inside), so what can become of it stays in place below – a
// place, a type, back tomorrow, the sidebar, deleted – and on a desktop beside it, below the
// progress across the whole width, one list: what is still waiting, and below what this review
// sorted (each with its undo). A sorted entry slides down into that part, an undone one back up.
// The stack is a pile of notes put down as they came: the next entries lie below the card as
// sheets, their top edges showing above it, each a little narrower.
// What was sorted stays for the rest of the day when the panel is closed, until the review is finished.
// A click into the entry (or "Bearbeiten") edits it in place, a typo fixed on the way; the keys rest
// meanwhile, and "Fertig" or any choice below ends it.
//
// A suggestion (the agent's or the app's own) is not shown yet; it would be the first answer
// among the suggestions in `Choices`.
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { Check, Clock, FolderInput, Layers, Maximize2, Pencil, Pin, RotateCcw, Shapes, Trash2, Undo2, X } from "lucide-react";
import { type Item, todayISO } from "@obtion/core/model";
import { plainText } from "@obtion/core/search";
import { useRepo, useItemHref, openItem } from "../hooks";
import { replica, spaceById, useAccounts } from "../accounts";
import { useT, titleOf } from "../i18n";
import { recentPlaces } from "../actions";
import { useBlobUrl } from "../files";
import { Button, Empty, Kbd, IconButton } from "../ui/primitives";
import { ItemIcon, RelTime, Tag, TypeGlyph, itemLook, kindLabel } from "../ui/item-look";
import { cn } from "../lib/utils";
import { Markdown } from "../ui/Markdown";
import { Editor } from "../ui/Editor";
import { TitleField } from "../ui/TitleField";
import { SpaceScope } from "../ui/Spaces";
import { placeSuggestions } from "../ui/suggest";
import { type InboxEntry, closeShelf, dismissShelf, reviewMinutes, useInboxItems, useShelf } from "../ui/inbox";
import { type Undo, captureTypes, revert, usePickers, useTriageActions } from "../ui/TriageActions";

/** One sorted entry: where it went, and the way back. */
interface Sorted {
  key: string;
  title: string;
  what: string;
  undo: Undo;
}

/** Editing the entry shown: where it was clicked (the caret goes there; `title`: its place in the title), none from the button. */
type Edit = { x: number; y: number; title?: number } | null;

/** The review of today on this device: kept when leaving it ("Später weiter"), not over a reload. */
let session: { day: string; order: string[]; sorted: Sorted[]; at?: string } | null = null;

/** The pile below the entry on top: sheets stepped up behind it, each a little narrower, the next one first. */
const PILE_ORIGIN = "50% 0%";
const SHEETS = ["translateY(-12px) scale(.95)", "translateY(-23px) scale(.9)"];

/**
 * The panel, sorting: a dialog over the page, as tall as the window leaves above the tray. Esc
 * closes it (an edit first ends), a click beside it too, a link inside leads away and closes it.
 */
export function ReviewPanel({ desktop }: { desktop: boolean }) {
  const { t } = useT();
  const { at } = useShelf();
  const self = useRef<HTMLDivElement>(null);
  // the keys are the panel's from the start, not the button's that opened it
  useEffect(() => self.current?.focus(), []);
  // the title of the page below, back as the panel closes
  useEffect(() => {
    const was = document.title;
    document.title = t("review.title");
    return () => void (document.title = was);
  }, []);
  return (
    <div
      ref={self}
      tabIndex={-1}
      role="dialog"
      aria-label={t("review.title")}
      data-shelf-panel="sort"
      onClickCapture={(e) => (e.target as HTMLElement).closest("a[href]") && closeShelf()}
      className={cn(
        "flex flex-col overflow-hidden border border-line bg-surface shadow-[0_18px_50px_-12px_rgb(0_0_0/0.45)] outline-none",
        desktop ? "h-[min(900px,calc(100dvh-150px))] rounded-2xl" : "h-full rounded-t-2xl",
      )}
    >
      {!desktop && <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line" aria-hidden />}
      <Review at={at} desktop={desktop} />
    </div>
  );
}

/** Not to the page below while sorting: a key that is a field's, a menu's or a dialog's above the panel. */
function othersKey(el: Element) {
  if (el.closest("input, textarea, select, [contenteditable=true], .cm-editor")) return true;
  const d = el.closest("[role=dialog], [role=menu], [role=listbox]");
  return !!d && !d.hasAttribute("data-shelf-panel");
}

/** `at`: the entry to begin with ("<workspace>/<id>", from the list or an old link). */
function Review({ at, desktop }: { at?: string; desktop: boolean }) {
  const { t } = useT();
  const entries = useInboxItems();
  const { shown } = useAccounts();
  if (session?.day !== todayISO()) session = null;
  const order = useRef<string[]>(session?.order ?? []);
  // what came in meanwhile joins the end of the stack
  for (const e of entries) if (!order.current.includes(e.key)) order.current.push(e.key);
  const [sorted, setSorted] = useState<Sorted[]>(() => session?.sorted ?? []);
  const [cur, setCur] = useState<string | undefined>(at ?? session?.at);
  // another entry asked for while open (from the list, "Jetzt schon einsortieren")
  useEffect(() => void (at && setCur(at)), [at]);
  const closed = useRef(false);
  const card = useRef<HTMLDivElement>(null);
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const left = order.current.filter((k) => byKey.has(k) && !sorted.some((s) => s.key === k));
  // the entry shown: the chosen one while it waits, else the next after its place
  const pickAt = (k?: string) => (k && left.includes(k) ? k : (order.current.slice(order.current.indexOf(k ?? "") + 1).find((x) => left.includes(x)) ?? left.at(-1)));
  const key = pickAt(cur);
  const entry = key ? byKey.get(key) : undefined;
  // editing belongs to the entry shown: another one (sorted, stepped to, undone) starts unedited
  const [editing, setEditing] = useState<{ key?: string; at: Edit } | null>(null);
  if (editing && editing.key !== key) setEditing(null);
  const stopEditing = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    setEditing(null);
  };
  useEffect(() => void (closed.current || (session = { day: todayISO(), order: order.current, sorted, at: key })), [sorted, key]);

  const act = useTriageActions(() => entry!.space, { quiet: true });
  const record = (e: InboxEntry, what: string, undo?: Undo | null) => {
    if (!undo) return;
    const title = replica(e.space).repo.get(e.item.id)?.title ?? e.item.title; // perhaps just edited
    setSorted((s) => [...s, { key: e.key, title: titleOf({ title, file: e.item.file }, t), what, undo }]);
    setCur(e.key);
  };
  const placeIn = (list: Item[], p: string) => entry && record(entry, `→ ${replica(entry.space).repo.index().get(p)?.title ?? ""}`, act.place(list, p));
  const typeAs = (list: Item[], type: string) => entry && record(entry, replica(entry.space).repo.index().typeName(type) ?? "", act.giveType(list, type));
  const pick = usePickers(() => entry!.space, placeIn, typeAs);
  const later = () => entry && record(entry, t("review.done.later"), act.later([entry.item]));
  const pin = () => entry && record(entry, t("review.done.pinned"), act.pin([entry.item]));
  const trash = () => entry && void act.trash([entry.item]).then((u) => record(entry, t("review.done.trashed"), u));
  const undo = (s = sorted.at(-1)) => {
    if (!s) return;
    revert(s.undo);
    setSorted((list) => list.filter((x) => x !== s));
    setCur(s.key);
  };
  const step = (d: 1 | -1) => {
    const i = key ? left.indexOf(key) : -1;
    const next = left[i + d];
    if (next) setCur(next);
  };
  const finish = () => {
    (closed.current = true), (session = null);
    dismissShelf();
  };

  // on the window before anything else: the page below the panel does not get the keys meanwhile
  const keys = useRef<(e: KeyboardEvent) => void>(null);
  keys.current = (e) => {
    const el = e.target as HTMLElement;
    // while editing the keys are the text's (Esc: below, after the editor)
    if (editing || pick.placing || pick.typing || othersKey(el) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    // Enter on a button or link is its own; Tab moves the focus
    if ((k === "Enter" && el.closest("button, a")) || k === "Tab") return;
    // a menu or popover open above (the editor's, a tooltip aside): its Esc
    if (k === "Escape" && document.querySelector("[role=dialog][data-state=open], [data-radix-popper-content-wrapper]:not(:has([role=tooltip]))")) return;
    e.stopPropagation();
    const first = entry && offeredTypes(entry)[0];
    if (k === "Escape") dismissShelf();
    else if (k === "u" || k === "z") undo();
    else if (!entry) return;
    else if (k === "e") pick.setPlacing([entry.item]);
    else if (k === "c" && first && entry.item.kind === "info") typeAs([entry.item], first);
    else if (k === "y" && entry.item.kind === "info") pick.setTyping([entry.item]);
    else if (k === "s") later();
    else if (k === "a") pin();
    else if (k === "x" || k === "Delete") trash();
    // arrows up and down scroll a long entry in its card
    else if (k === "ArrowDown" || k === "ArrowUp") card.current?.scrollBy({ top: k === "ArrowDown" ? 80 : -80 });
    else if (k === "j" || k === "ArrowRight") step(1);
    else if (k === "k" || k === "ArrowLeft") step(-1);
    else if (k === "Enter" || k === "o") (closeShelf(), openItem(entry.item.id, { space: entry.space }));
    else return;
    e.preventDefault();
  };
  // Esc while editing, once the editor had it (unless it used it: its completions close first) ends it
  const escape = useRef<(e: KeyboardEvent) => void>(null);
  escape.current = (e) => editing && e.key === "Escape" && !e.defaultPrevented && !pick.placing && !pick.typing && (e.preventDefault(), stopEditing());
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current?.(e);
    const esc = (e: KeyboardEvent) => escape.current?.(e);
    addEventListener("keydown", on, true);
    addEventListener("keydown", esc);
    return () => (removeEventListener("keydown", on, true), removeEventListener("keydown", esc));
  }, []);

  const total = sorted.length + left.length;
  const several = shown.length > 1;
  const touch = useRef<number | null>(null);
  const head = (
    <ReviewHead
      total={total}
      at={entry ? sorted.length + 1 : total}
      sorted={sorted.length}
      minutes={reviewMinutes(left.length)}
    />
  );
  const body = entry ? (
    <SpaceScope id={entry.space}>
      <EntryCard key={entry.key} entry={entry} space={several ? spaceById(entry.space)?.name : undefined} more={left.length - 1} scroller={card} editing={editing} onEdit={(at) => setEditing({ key, at })} onDone={stopEditing} />
      <Choices entry={entry} onPlace={(p) => placeIn([entry.item], p)} onPick={() => (stopEditing(), pick.setPlacing([entry.item]))} onType={(type) => typeAs([entry.item], type)} onTypes={() => (stopEditing(), pick.setTyping([entry.item]))} onLater={later} onPin={pin} onTrash={trash} onUndo={sorted.length ? () => undo() : undefined} keys={desktop} quiet={!!editing} />
    </SpaceScope>
  ) : (
    <Finished count={sorted.length} onDone={finish} />
  );

  if (!desktop)
    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 pb-4 pt-2"
        onTouchStart={(e) => (touch.current = e.touches[0]!.clientX)}
        onTouchEnd={(e) => {
          const dx = (e.changedTouches[0]?.clientX ?? 0) - (touch.current ?? 0);
          if (!editing && Math.abs(dx) > 70) step(dx < 0 ? 1 : -1);
          touch.current = null;
        }}
      >
        {head}
        <div className="mt-4 flex min-h-0 flex-1 flex-col">{body}</div>
        {/* the last one sorted, with its way back: the phone's "Erledigt", below so nothing above moves */}
        {sorted.length > 0 && <LastSorted s={sorted.at(-1)!} onUndo={() => undo()} />}
        {pick.node}
      </div>
    );
  return (
    // the head with its progress across the whole width, below it the entry and the list beside
    <div className="flex min-h-0 flex-1 flex-col p-6">
      {head}
      <div className="mt-5 flex min-h-0 flex-1 gap-6">
        <div className="flex min-w-0 flex-1 flex-col">{body}</div>
        <ReviewList left={left} current={key} byKey={byKey} sorted={sorted} onPick={setCur} onUndo={undo} />
      </div>
      {pick.node}
    </div>
  );
}

/** The head: what it is, how far ("2 von 6"), closing. */
function ReviewHead({ total, at, sorted, minutes }: { total: number; at: number; sorted: number; minutes: number }) {
  const { t } = useT();
  return (
    <header className="shrink-0">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-inbox/35 bg-inbox/12 text-inbox max-lg:hidden">
          <Layers size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold leading-6">{t("review.title")}</h2>
          <p className="truncate text-[13px] tabular-nums text-muted-foreground">
            {total ? t("review.position", { at, count: total }) : t("review.empty")}
            {total > sorted && <> · {t("review.minutesLeft", { count: minutes })}</>}
          </p>
        </div>
        <IconButton icon={X} iconSize={16} onClick={dismissShelf} label={t("review.close")} title={t("review.close")} className="shrink-0" />
      </div>
      {total > 0 && <Steps total={total} done={sorted} />}
    </header>
  );
}

/** Progress as steps (one per entry, a bar when there are many): sorted green, the current amber. */
function Steps({ total, done }: { total: number; done: number }) {
  const { t } = useT();
  const label = t("review.position", { at: Math.min(done + 1, total), count: total });
  if (total > 16)
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

/**
 * The entry in full: what it is, where from and how old, the title, the text, the notes below.
 * As tall as the panel leaves, the same for every entry, so the choices below never move; a long entry scrolls inside, a fade at the
 * bottom says there is more. A click into it edits title and text right there (a file only its
 * title); a quiet "Bearbeiten" in the corner below right does the same and becomes "Fertig". A click
 * outside the card ends it too.
 */
function EntryCard({ entry, space, more, scroller, editing, onEdit, onDone }: { entry: InboxEntry; space?: string; more: number; scroller: React.RefObject<HTMLDivElement | null>; editing: { at: Edit } | null; onEdit: (at: Edit) => void; onDone: () => void }) {
  const { t } = useT();
  const hrefOf = useItemHref();
  const repo = useRepo();
  const ix = repo.index();
  const item = repo.get(entry.item.id) ?? entry.item;
  // a loose note is a note here (it is in the inbox, that goes without saying)
  const kind = kindLabel(itemLook(item, ix), t, { inboxAsNote: true });
  const kids = ix.items(ix.childrenOf(item.id));
  const img = useBlobUrl(item.file?.filetype === "bild" ? (item.file.display ?? item.file.hash) : item.file?.thumb, true);
  const [rest, setRest] = useState(false);
  const self = useRef<HTMLElement>(null);
  const at = editing?.at;
  // a click outside the card ends editing (not one in what the editor opened: a menu, a picture)
  useEffect(() => {
    if (!editing) return;
    const on = (e: PointerEvent) => {
      const el = e.target as Element;
      if (!self.current?.contains(el) && !el.closest?.(".cm-menu, .cm-tooltip, [role=dialog]:not([data-shelf-panel]), [data-radix-popper-content-wrapper]")) onDone();
    };
    document.addEventListener("pointerdown", on, true);
    return () => document.removeEventListener("pointerdown", on, true);
  }, [!!editing]);
  const text = !item.file;
  // the title clicked (or a file, which has no text here): the caret where clicked, else at its end
  useEffect(() => {
    if (!editing || (text && at?.title === undefined)) return;
    const el = scroller.current?.querySelector("textarea");
    const n = Math.min(at?.title ?? Infinity, el?.value.length ?? 0);
    el?.focus();
    el?.setSelectionRange(n, n);
  }, [!!editing]);
  // the text clicked: the caret where it was clicked, else at its end
  const placeCaret = (v: EditorView | null) => {
    if (!v || at?.title !== undefined) return;
    v.focus();
    // after the editor's first measure: before it, its heights are guesses
    requestAnimationFrame(() => v.dom.isConnected && v.dispatch({ selection: { anchor: (at && v.posAtCoords(at, false)) ?? v.state.doc.length } }));
  };
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setRest(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    el.addEventListener("scroll", measure, { passive: true });
    return () => (ro.disconnect(), el.removeEventListener("scroll", measure));
  }, []);
  return (
    // room above the card for the edges of the pile
    <div className="min-h-[180px] flex-1 pt-6">
      <div className="relative h-full">
      {/* the pile: the next entries below this one, sheets of the same size (the farther one first, so behind) */}
      {SHEETS.slice(0, Math.min(more, SHEETS.length))
        .map((pose, n) => <div key={n} aria-hidden className={cn("absolute inset-0 rounded-2xl border border-line shadow-[0_4px_14px_-6px_rgb(0_0_0/0.35)]", n ? "bg-hover" : "bg-surface-2")} style={{ transform: pose, transformOrigin: PILE_ORIGIN }} />)
        .reverse()}
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
            {text && (
              <div className="mt-3 max-w-[68ch] text-[15px] leading-[1.65]">
                <Editor doc={repo.getDoc(item.id)} nodeId={item.id} minHeight="min-h-24" onView={placeCaret} />
              </div>
            )}
          </>
        ) : (
          <h2 className="mt-4 text-[28px] font-bold leading-[34px] tracking-[-0.015em] max-lg:text-2xl">{titleOf(item, t)}</h2>
        )}
        {editing && text ? null : item.body.trim() ? (
          <div className="mt-4 max-w-[68ch] text-[15px] leading-[1.65]">
            <Markdown src={item.body} />
          </div>
        ) : item.file?.text ? (
          <p className="mt-4 max-w-[68ch] text-[15px] leading-[1.65] text-muted-foreground">{plainText(item.file.text).slice(0, 1200)}</p>
        ) : null}
        {img && <img src={img} alt={item.title} className="mt-4 max-h-[50vh] w-auto rounded-lg border border-line" />}
        {item.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {item.tags.map((x) => (
              <Tag key={x} tag={x} />
            ))}
          </div>
        )}
        {kids.length > 0 && (
          <div className="mt-5 border-t border-line pt-4">
            <p className="mb-1.5 text-xs font-semibold text-muted-foreground">{t("below.title")}</p>
            <ul className="space-y-1 text-sm">
              {kids.map((c) => (
                <li key={c.id} className="flex items-center gap-2">
                  <ItemIcon item={c} size={14} /> <a href={hrefOf(c.id)} className="truncate hover:underline">{titleOf(c, t)}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
        </div>
        {rest && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface to-transparent" aria-hidden />}
        </div>
        {/* "Bearbeiten", while editing "Fertig" in the colour of the card's frame; in the corner
            below as far from the edges as "Öffnen" above (its box: the padding less its -1.5 margins) */}
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
 * What can become of it. Five buttons, always the same and in the same place: put it somewhere, turn
 * it into a type (only a loose note), back tomorrow, pin it to the sidebar, delete it. Below in one line
 * the quick ways: the first type ("c") and places it mentions or used last; the rest is in the
 * pickers. On a desktop the five in one row, delete only its icon at the end; keys quietly in the
 * buttons (left out where the row is narrow), hidden while the entry is edited (their room kept,
 * so the buttons stay where they are).
 */
function Choices({ entry, onPlace, onPick, onType, onTypes, onLater, onPin, onTrash, onUndo, keys, quiet }: { entry: InboxEntry; onPlace: (p: string) => void; onPick: () => void; onType: (type: string) => void; onTypes: () => void; onLater: () => void; onPin: () => void; onTrash: () => void; onUndo?: () => void; keys: boolean; quiet: boolean }) {
  const { t } = useT();
  const repo = useRepo();
  const ix = repo.index();
  const item = entry.item;
  const info = item.kind === "info";
  const places = placeSuggestions(item, repo).map((x) => x.id);
  for (const id of recentPlaces(repo)) if (!places.includes(id) && id !== item.id && !item.parents[id] && !ix.wouldCycle(item.id, id)) places.push(id);
  const type = info ? offeredTypes(entry)[0] : undefined;
  const hint = (k: string, narrow?: boolean) => keys && <span className={cn(narrow ? "hidden @[600px]:inline-flex" : "inline-flex", quiet && "invisible")}><Kbd>{k}</Kbd></span>;
  const tile = (icon: ReactNode, label: string, key: string, onClick: () => void, opts: { primary?: boolean; danger?: boolean; disabled?: boolean } = {}) => (
    <Button
      variant="plain"
      onClick={onClick}
      disabled={opts.disabled}
      // delete on a desktop: its icon only, the name and key on hover
      title={opts.danger && keys ? `${label} (${key})` : undefined}
      className={cn(
        "tap flex h-9 min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 text-[13px] font-medium disabled:opacity-40",
        opts.primary ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/90 max-lg:col-span-2" : "border-line bg-surface hover:bg-hover",
        opts.danger && "text-danger lg:w-9 lg:flex-none lg:justify-center lg:px-0",
      )}
    >
      {icon}
      <span className={cn("min-w-0 flex-1 truncate px-1 text-center", opts.danger && "lg:sr-only")}>{label}</span>
      {!opts.danger && hint(key, true)}
    </Button>
  );
  const chip = "tap inline-flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[13px] hover:bg-hover";
  return (
    <div className="mt-6 shrink-0 space-y-3">
      <div className="@container flex gap-2 max-lg:grid max-lg:grid-cols-2">
        {tile(<FolderInput size={15} />, t("review.placeAction"), "e", onPick, { primary: true })}
        {tile(<Shapes size={15} />, t("review.convertAction"), "y", onTypes, { disabled: !info })}
        {tile(<Clock size={15} />, t("review.laterAction"), "s", onLater)}
        {tile(<Pin size={15} />, t("review.pin"), "a", onPin)}
        {tile(<Trash2 size={15} />, t("triage.delete"), "x", onTrash, { danger: true })}
      </div>
      <div className="flex min-h-8 items-center gap-2">
        <span className="shrink-0 text-[13px] text-muted-foreground">{t("review.suggested")}</span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {type && (
            <Button variant="plain" onClick={() => onType(type)} className={chip}>
              <TypeGlyph schema={ix.types.get(type)?.schema} size={13} />
              <span className="truncate">{t("review.asType", { type: ix.typeName(type) ?? "" })}</span>
              {hint("c")}
            </Button>
          )}
          {places.slice(0, 3).map((id) => (
            <Button key={id} variant="plain" onClick={() => onPlace(id)} className={chip} title={t("review.placeIn", { place: ix.get(id)?.title ?? "" })}>
              <FolderInput size={13} className="shrink-0 text-muted-foreground" />
              <span className="truncate">{ix.get(id)?.title}</span>
            </Button>
          ))}
          {!places.length && !type && <span className="text-[13px] text-muted-foreground">–</span>}
        </div>
        <Button onClick={onUndo} disabled={!onUndo} className="shrink-0">
          <Undo2 size={15} /> {t("review.back")} {hint("u")}
        </Button>
      </div>
    </div>
  );
}

/** The types offered to turn an entry into: its workspace's first ones, not the one it has ("c" takes the first). */
const offeredTypes = (e: InboxEntry) => captureTypes(e.space).filter((x) => x !== e.item.type).slice(0, 3);

/** A row of the list moves to its new place (sorted down, undone back up) in this long. */
const SLIDE = { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" };

/**
 * The list beside the entry: what is still waiting (the current one marked; a click goes there),
 * below "Einsortiert", what this review sorted, the last one on top, each with its undo. One list:
 * a sorted entry slides from its place down into the lower part, an undone one back up to its
 * place; the others make room as it passes.
 */
function ReviewList({ left, current, byKey, sorted, onPick, onUndo }: { left: string[]; current?: string; byKey: Map<string, InboxEntry>; sorted: Sorted[]; onPick: (k: string) => void; onUndo: (s: Sorted) => void }) {
  const { t } = useT();
  const box = useRef<HTMLUListElement>(null);
  // where each row was after the last render: from there it slides to where it is now
  const tops = useRef<Map<string, number> | null>(null);
  useLayoutEffect(() => {
    const ul = box.current;
    if (!ul) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const was = tops.current;
    const now = new Map<string, number>();
    for (const el of ul.querySelectorAll<HTMLElement>("[data-row]")) {
      const k = el.dataset.row!;
      now.set(k, el.offsetTop);
      if (!was || still) continue;
      const from = was.get(k);
      if (from === undefined) el.animate([{ opacity: 0 }, { opacity: 1 }], SLIDE);
      else if (from !== el.offsetTop) el.animate([{ transform: `translateY(${from - el.offsetTop}px)` }, { transform: "none" }], SLIDE);
    }
    tops.current = now;
  });
  // the current one in sight
  useEffect(() => void box.current?.querySelector("[aria-current=true]")?.scrollIntoView({ block: "nearest" }), [current]);
  const head = (key: string, label: string, count: number, gap?: boolean) => (
    <li key={key} data-row={key} className={cn("flex items-baseline gap-1.5 px-2.5 pb-1 text-xs font-semibold text-muted-foreground", gap ? "mt-3 border-t border-line pt-3" : "pt-1")}>
      {label} <span className="font-normal tabular-nums">{count}</span>
    </li>
  );
  const row = "relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left";
  return (
    <aside className="flex w-[280px] shrink-0 flex-col" aria-label={t("triage.list")}>
      <ul ref={box} className="relative min-h-0 flex-1 overflow-y-auto rounded-xl border border-line p-1.5" aria-live="polite">
        {left.length > 0 && head("h:left", t("review.left"), left.length)}
        {left.map((k) => {
          const e = byKey.get(k)!;
          return (
            <li key={k} data-row={k}>
              <Button variant="plain" onClick={() => onPick(k)} aria-current={k === current} className={cn(row, "hover:bg-hover", k === current && "bg-selected before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r before:bg-inbox")}>
                <ItemIcon item={e.item} size={14} ix={replica(e.space).repo.index()} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{titleOf(e.item, t)}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    <RelTime ts={e.item.created} />
                  </span>
                </span>
              </Button>
            </li>
          );
        })}
        {sorted.length > 0 && head("h:sorted", t("review.sorted"), sorted.length, left.length > 0)}
        {[...sorted].reverse().map((s) => (
          <li key={s.key} data-row={s.key} className={cn(row, "group/sorted")}>
            <Check size={14} className="shrink-0 text-ok" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-muted-foreground">{s.title}</span>
              <span className="block truncate text-xs text-muted-foreground">{s.what}</span>
            </span>
            <IconButton size="sm" icon={RotateCcw} iconSize={14} onClick={() => onUndo(s)} title={t("triage.undo")} label={t("review.undoNamed", { title: s.title })} className="shrink-0 opacity-60 group-hover/sorted:opacity-100 focus-visible:opacity-100" />
          </li>
        ))}
      </ul>
    </aside>
  );
}

/** The phone's "Erledigt": the last one sorted in one line, with its undo. */
function LastSorted({ s, onUndo }: { s: Sorted; onUndo: () => void }) {
  const { t } = useT();
  return (
    <div className="mt-4 flex items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--ok)_35%,transparent)] bg-[color-mix(in_srgb,var(--ok)_8%,transparent)] px-3 py-2 text-[13px]" aria-live="polite">
      <Check size={15} className="shrink-0 text-ok" />
      <span className="min-w-0 flex-1 truncate">
        {s.title} <span className="text-muted-foreground">· {s.what}</span>
      </span>
      <Button variant="plain" onClick={onUndo} className="tap shrink-0 font-medium text-link hover:underline">
        {t("triage.undo")}
      </Button>
    </div>
  );
}

/** Nothing left: done, and closing the panel. */
function Finished({ count, onDone }: { count: number; onDone: () => void }) {
  const { t } = useT();
  return (
    <div className="flex flex-1 flex-col justify-center rounded-2xl border border-line bg-surface">
      <Empty icon={<Check size={22} className="text-ok" />} title={count ? t("review.finished", { count }) : t("inbox.empty")}>
        <Button variant="primary" onClick={onDone} className="mt-2">
          {t("review.finish")}
        </Button>
      </Empty>
    </div>
  );
}

