// The tray's panel ("Eingang"): looking in, not sorting. Every entry of the workspaces seen, newest
// first, with a line of its text, its workspace and age; one opens here to read and add to it and
// stays in the inbox – sorting is the review's (views/Review.tsx), reached from the tray's own
// button. Its whole page is one click away (the icon at the end of a row, on hover). Below, folded,
// what waits until tomorrow ("Morgen wieder"): the rest of what is not sorted, one click from back.
// Above the tray on a desktop, as a sheet on a phone. What lands in the inbox: behind "…".
// On Heute on a desktop it is part of the page (`pinned`): always open, it does not close. Without
// room for it there, Heute shows the newest entries as cards (ShelfCards), each opens the panel.
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, ChevronDown, ChevronRight, Maximize2, RotateCcw, SlidersHorizontal, Undo2 } from "lucide-react";
import { type Item, SETTINGS_ID, setMeta, setSettings } from "@obtion/core/model";
import type { QueryDef } from "@obtion/core/query";
import { inboxWhere } from "@obtion/core/inbox";
import { resetInbox } from "@obtion/core/setup";
import { plainText } from "@obtion/core/search";
import { type Lang, type T, fmtBytes } from "@obtion/core/i18n";
import { useRepo, itemPath, spaceHref } from "../hooks";
import { useBlobUrl } from "../files";
import { Textarea } from "../components/ui/textarea";
import { replica, spaceById, useAccounts } from "../accounts";
import { useT, titleOf } from "../i18n";
import { Button, Dialog, MenuItem, MoreMenu, DraftBar, Tip } from "./primitives";
import { ItemIcon, RelTime, BelowList } from "./item-look";
import { cn } from "../lib/utils";
import { Editor } from "./Editor";
import { TitleField } from "./TitleField";
import { QueryEditor } from "./QueryEditor";
import { SpaceFilter, SpaceScope } from "./Spaces";
import { notify } from "./feedback";
import { type InboxEntry, closeShelf, dismissShelf, openShelf, useInboxItems, useLaterItems, useShelf } from "./inbox";
import { sameValue } from "@obtion/core/equal";
import { filePreview } from "./text";

/** Where an entry opens in the review. */
const reviewHref = (key: string) => `#/review?at=${encodeURIComponent(key)}`;

export function ShelfPanel({ desktop, pinned }: { desktop: boolean; pinned?: boolean }) {
  const { t } = useT();
  const { at } = useShelf();
  const entries = useInboxItems();
  const later = useLaterItems();
  const inInbox = at ? entries.find((e) => e.key === at) : undefined;
  const entry = inInbox ?? (at ? later.find((e) => e.key === at) : undefined);
  // a key from before (the entry was sorted elsewhere meanwhile): the list
  useEffect(() => void (at && !entry && openShelf()), [at, !!entry]);
  // Escape: from an entry back to the list, from the list closed – unless a dialog or menu above it takes it
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("[role=dialog][data-state=open], [data-radix-popper-content-wrapper]:not(:has([role=tooltip]))")) return;
      if (entry) openShelf();
      else if (!pinned) dismissShelf();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [!!entry]);
  return (
    <div
      // pinned it is part of the tray's region, else a dialog over the page
      role={pinned ? undefined : "dialog"}
      aria-label={pinned ? undefined : t("tray.title")}
      data-shelf-panel={pinned ? "pinned" : "open"}
      // a link inside leads away: the panel closes behind it
      onClickCapture={(e) => (e.target as HTMLElement).closest("a[href]") && closeShelf()}
      className={cn(
        "flex flex-col overflow-hidden border border-line bg-surface",
        pinned
          ? "h-full rounded-2xl shadow-[0_6px_24px_-12px_rgb(0_0_0/0.25)]"
          : cn("shadow-[0_18px_50px_-12px_rgb(0_0_0/0.45)]", desktop ? "max-h-[min(640px,calc(100dvh-160px))] rounded-2xl" : entry ? "h-full rounded-t-2xl" : "max-h-[min(70dvh,560px)] rounded-2xl"),
      )}
    >
      {!desktop && <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line" aria-hidden />}
      {entry ? <EntryView entry={entry} waiting={!inInbox} desktop={desktop} pinned={pinned} /> : <List entries={entries} later={later} pinned={pinned} />}
    </div>
  );
}

/**
 * The list: newest first; ↑↓ choose, ↵ opens, Esc closes (pinned: it stays, and takes the focus only
 * when clicked). Below, folded, the entries back tomorrow; unfolded the arrows go through them too.
 */
function List({ entries, later, pinned }: { entries: InboxEntry[]; later: InboxEntry[]; pinned?: boolean }) {
  const { t } = useT();
  const { shown } = useAccounts();
  // the chosen row (-1: none): by the arrows or the pointer; the pointer leaving the list takes it away
  const [sel, setSel] = useState(-1);
  const [laterOpen, setLaterOpen] = useState(false);
  const rows = laterOpen ? [...entries, ...later] : entries;
  const row = (e: InboxEntry, n: number) => <Row key={e.key} entry={e} n={n} on={n === sel} waiting={n >= entries.length} space={spaceById(e.space)?.name} onHover={() => setSel(n)} />;
  const [rule, setRule] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => void (!pinned && box.current?.focus()), []);
  // only the arrows scroll the chosen row into view: on hover a half-shown row would scroll, another
  // come under the pointer and be chosen in turn – the list flickered
  const byKey = useRef(false);
  useEffect(() => {
    if (byKey.current) box.current?.querySelector(`[data-shelf="${sel}"]`)?.scrollIntoView({ block: "nearest" });
    byKey.current = false;
  }, [sel]);
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-line py-2.5 pl-5 pr-2">
        <h2 className="text-[15px] font-semibold">
          {t("tray.title")} <span className="tabular-nums text-warn">{entries.length}</span>
        </h2>
        <span className="flex-1" />
        <MoreMenu>
          {(close) =>
            shown.map((s) => (
              <MenuItem key={s.id} icon={<SlidersHorizontal size={14} />} onClick={() => (close(), setRule(s.id))}>
                {shown.length > 1 ? t("inbox.whatLandsIn", { name: s.name }) : t("inbox.whatLands")}
              </MenuItem>
            ))
          }
        </MoreMenu>
      </div>
      {/* several workspaces: which of them, as in the sidebar's selector */}
      <div className="shrink-0 px-5 pt-3 empty:hidden [&>div]:mb-1">
        <SpaceFilter />
      </div>
      <div
        ref={box}
        tabIndex={-1}
        role="listbox"
        aria-label={t("triage.list")}
        className="min-h-0 flex-1 overflow-y-auto p-1.5 outline-none"
        onMouseLeave={() => setSel(-1)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") ((byKey.current = true), setSel((s) => Math.min(rows.length - 1, s + 1)));
          else if (e.key === "ArrowUp") ((byKey.current = true), setSel((s) => Math.max(0, s - 1)));
          // Enter on a button or link inside (a row, its tools, "Morgen wieder") is its own
          else if (e.key === "Enter" && rows[sel] && !(e.target as HTMLElement).closest("button, a")) openShelf(rows[sel]!.key);
          else return;
          e.preventDefault();
        }}
      >
        {entries.length ? entries.map((e, n) => row(e, n)) : <p className="px-4 py-8 text-center text-[15px] text-muted-foreground">{t("inbox.empty")}</p>}
        {later.length > 0 && (
          <section aria-label={t("review.later")} className="mt-1 border-t border-line pt-1">
            <Button
              variant="plain"
              aria-expanded={laterOpen}
              onClick={() => (setLaterOpen((o) => !o), setSel((s) => Math.min(s, Math.max(0, entries.length - 1))))}
              className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-[13px] text-muted-foreground hover:bg-hover hover:text-fg"
            >
              {laterOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {t("review.later")} <span className="tabular-nums">· {later.length}</span>
            </Button>
            {laterOpen && later.map((e, n) => row(e, entries.length + n))}
          </section>
        )}
      </div>
      {rule && shown.some((s) => s.id === rule) && (
        <SpaceScope id={rule}>
          <InboxRule name={shown.length > 1 ? spaceById(rule)?.name : undefined} onClose={() => setRule(null)} />
        </SpaceScope>
      )}
    </>
  );
}

/** The newest entries side by side, as on Heute: a card opens the panel at it, "Alle ansehen" at the list. */
export function ShelfCards({ entries }: { entries: InboxEntry[] }) {
  const { t, lang } = useT();
  const { shown } = useAccounts();
  return (
    <section data-shelf-cards className="mt-9">
      <div className="mb-2.5 flex min-h-8 items-center gap-2">
        <h2 className="text-[15px] font-semibold leading-[22px]">
          {t("tray.title")} <span className="tabular-nums text-warn">{entries.length}</span>
        </h2>
        <span className="flex-1" />
        <Button variant="plain" onClick={() => openShelf()} className="tap-y inline-flex items-center gap-1 rounded-md px-1.5 text-[13px] text-muted-foreground hover:text-fg">
          {t("tray.showAll")} <ArrowUp size={14} />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        {entries.slice(0, 4).map((e) => {
          const ix = replica(e.space).repo.index();
          const line = preview(e, t, lang, ix.childrenOf(e.item.id).length);
          return (
            <Button
              key={e.key}
              variant="plain"
              onClick={() => openShelf(e.key)}
              aria-label={t("tray.openEntry", { title: titleOf(e.item, t) })}
              className="flex min-w-0 flex-col items-stretch gap-1 rounded-xl border border-[color-mix(in_srgb,var(--t-inbox)_35%,var(--border))] bg-surface px-4 py-3 text-left hover:bg-hover"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <ItemIcon item={e.item} size={13} ix={ix} />
                <RelTime ts={e.item.created} />
                {shown.length > 1 && <span className="truncate">· {spaceById(e.space)?.name}</span>}
              </span>
              <span className="truncate text-[15px] font-semibold">{titleOf(e.item, t)}</span>
              <span className="truncate text-xs text-muted-foreground">{line || "\u00a0"}</span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}

/** What an entry says in one line: its text, else what it is (a file, notes below). */
function preview(e: InboxEntry, t: T, lang: Lang, notes: number): string {
  const i = e.item;
  const text = plainText(i.body || i.file?.text || "").slice(0, 200);
  if (text) return notes ? `${text} · ${t("triage.notes", { count: notes })}` : text;
  if (i.file) return [t("kind.file"), fmtBytes(lang, i.file.size)].join(" · ");
  return notes ? t("triage.notes", { count: notes }) : "";
}

/**
 * One entry: above its workspace (with what it is) and its age in the corner, then its title and a
 * line of its text. Hovered or chosen by the arrows, the corner shows its buttons instead of the
 * age: the whole page at the end, before it "back into the inbox now" for one back tomorrow.
 */
function Row({ entry, n, on, waiting, space, onHover }: { entry: InboxEntry; n: number; on: boolean; waiting: boolean; space?: string; onHover: () => void }) {
  const { t, lang } = useT();
  const repo = replica(entry.space).repo;
  const ix = repo.index();
  const line = preview(entry, t, lang, ix.childrenOf(entry.item.id).length);
  return (
    <div data-shelf={n} role="option" aria-selected={on} onMouseMove={onHover} className={cn("group/row relative rounded-xl", on && "bg-hover")}>
      <Button variant="plain" onClick={() => openShelf(entry.key)} className="block w-full min-w-0 rounded-xl px-3 py-2.5 text-left">
        <span className="flex min-h-6 items-center gap-1.5 text-[13px] text-muted-foreground">
          <ItemIcon item={entry.item} size={14} ix={ix} />
          <span className="min-w-0 flex-1 truncate">{space}</span>
          {/* the buttons take the corner: the age gives way (always on a touch screen, where they always show) */}
          <span className={cn("shrink-0 text-xs pointer-coarse:invisible", on ? "invisible" : "group-hover/row:invisible")}>
            <RelTime ts={entry.item.created} />
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[15px] font-medium">{titleOf(entry.item, t)}</span>
        {line && <span className="block truncate text-[13px] text-muted-foreground">{line}</span>}
      </Button>
      <span className={cn("absolute right-2 top-2 flex items-center gap-0.5 focus-within:opacity-100 pointer-coarse:opacity-100", on ? "opacity-100" : "opacity-0 group-hover/row:opacity-100")}>
        {waiting && (
          <Tip label={t("tray.backNow")}>
            <Button variant="plain" onClick={() => repo.change(entry.item.id, (d) => setMeta(d, { later: null }))} className={iconTap} aria-label={t("tray.backNow")}>
              <Undo2 size={15} />
            </Button>
          </Tip>
        )}
        <OpenFull entry={entry} className="p-1 hover:bg-surface" />
      </span>
    </div>
  );
}

const iconTap = "tap shrink-0 rounded-md p-1 text-muted-foreground hover:bg-surface hover:text-fg";

/** The entry's whole page: an icon only, without a frame, as in the review's card. */
function OpenFull({ entry, className }: { entry: InboxEntry; className?: string }) {
  const { t } = useT();
  return (
    <Tip label={t("tray.openFull")}>
      <a href={spaceHref(entry.space, itemPath(entry.item.id))} className={cn("tap shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-hover hover:text-fg", className)} aria-label={t("tray.openFull")}>
        <Maximize2 size={15} />
      </a>
    </Tip>
  );
}

/**
 * One entry, to read and add to: its title and text editable, the notes below it. It stays in the
 * inbox – the banner says so, with the way to sort it now in the review.
 */
function EntryView({ entry, waiting, desktop, pinned }: { entry: InboxEntry; waiting: boolean; desktop: boolean; pinned?: boolean }) {
  const { t } = useT();
  return (
    <SpaceScope id={entry.space}>
      <div className="flex shrink-0 items-center gap-1 border-b border-line py-2 pl-2 pr-2">
        <Button variant="plain" onClick={() => openShelf()} className="tap inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[15px] text-muted-foreground hover:bg-hover hover:text-fg">
          <ArrowLeft size={16} /> {t("tray.title")}
        </Button>
        {desktop && <span className="min-w-0 truncate text-[15px]">/ {titleOf(entry.item, t)}</span>}
        <span className="flex-1" />
        <OpenFull entry={entry} />
        {!pinned && !desktop && <Button onClick={dismissShelf} className="font-semibold">{t("tray.done")}</Button>}
      </div>
      <EntryBody entry={entry} waiting={waiting} />
    </SpaceScope>
  );
}

function EntryBody({ entry, waiting }: { entry: InboxEntry; waiting: boolean }) {
  const { t } = useT();
  const repo = useRepo();
  const ix = repo.index();
  const item = repo.get(entry.item.id) ?? entry.item;
  const { shown } = useAccounts();
  const kids = ix.items(ix.childrenOf(item.id));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4 max-lg:px-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-inbox/40 bg-inbox/10 px-3.5 py-2.5 text-[13px]">
        <span className="size-2 shrink-0 rounded-full bg-inbox" aria-hidden />
        <span className="min-w-0 flex-1 basis-48">
          <b className="font-semibold text-warn">{t(waiting ? "tray.laterTitle" : "tray.staysTitle")}</b> <span className="text-muted-foreground">{t(waiting ? "tray.laterHint" : "tray.staysHint")}</span>
        </span>
        {waiting ? (
          // back into the inbox now: then it is an entry like the others (this banner turns into the one below)
          <Button variant="plain" onClick={() => repo.change(item.id, (d) => setMeta(d, { later: null }))} className="shrink-0 text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-fg max-lg:basis-full max-lg:pl-5">
            {t("tray.backNow")}
          </Button>
        ) : (
          <a href={reviewHref(entry.key)} className="shrink-0 text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-fg max-lg:basis-full max-lg:pl-5">
            {t("tray.sortNow")}
          </a>
        )}
      </div>
      <p className="mt-4 flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-fg">
          <ItemIcon item={item} size={13} /> {item.kind === "datei" ? t("kind.file") : t("kind.note")}
        </span>
        {shown.length > 1 && <span>{spaceById(entry.space)?.name}</span>}
        <span>
          {t("tray.putDown")} <RelTime ts={item.created} />
        </span>
      </p>
      <div className="mt-2 text-[26px] font-bold leading-8 tracking-[-0.015em] [&_textarea]:text-[26px] [&_textarea]:font-bold">
        <TitleField item={item} autoFocus={false} placeholder={item.file?.name} />
      </div>
      {item.file ? (
        <FileBody key={item.id} item={item} />
      ) : (
        <div className="mt-2 text-[15px]">
          <Editor doc={repo.getDoc(item.id)} nodeId={item.id} minHeight="min-h-24" />
        </div>
      )}
      <BelowList items={kids} className="mt-6" />
    </div>
  );
}

/** A file: what it shows (a picture, else the text found in it) and its description, as on its page. */
function FileBody({ item }: { item: Item }) {
  const { t } = useT();
  const repo = useRepo();
  const f = item.file!;
  const img = useBlobUrl(f.filetype === "bild" ? (f.display ?? f.hash) : f.thumb, true);
  // saved on leaving the field, and when the panel goes back or closes while it is being edited
  const draft = useRef<string | null>(null);
  const save = () => {
    if (draft.current !== null && draft.current !== (repo.get(item.id)?.body ?? "")) repo.setBody(item.id, draft.current);
    draft.current = null;
  };
  useEffect(() => save, []);
  return (
    <>
      {img ? (
        <img src={img} alt={item.body || item.title} className="mt-3 max-h-[40vh] w-auto rounded-lg border border-line" />
      ) : f.text ? (
        <p className="mt-3 line-clamp-6 text-[15px] leading-[1.65] text-muted-foreground">{filePreview(f.text)}</p>
      ) : null}
      <Textarea
      variant="inline"
        defaultValue={item.body}
        key={item.id}
        onChange={(e) => (draft.current = e.target.value)}
        onBlur={save}
        placeholder={t("file.descriptionPlaceholder")}
        aria-label={t("file.description")}
        rows={2}
        className="field mt-3 w-full resize-y bg-transparent text-[15px] leading-[1.65] outline-none placeholder:text-faint"
      />
    </>
  );
}

/** What lands in a workspace's inbox: its rule (a draft until "Speichern") and the way back to the default. */
function InboxRule({ name, onClose }: { name?: string; onClose: () => void }) {
  const { t } = useT();
  const repo = useRepo();
  const where = inboxWhere(repo.index());
  const [draft, setDraft] = useState<QueryDef["where"] | null>(null);
  const restore = () => (setDraft(null), resetInbox(repo.writer), notify(t("inbox.restored")));
  return (
    <Dialog title={name ? t("inbox.whatLandsIn", { name }) : t("inbox.whatLands")} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("inbox.ruleHint")}</p>
          <Button variant="ghost" onClick={restore}>
            <RotateCcw size={14} /> {t("inbox.restoreDefault")}
          </Button>
        </div>
        <QueryEditor autoFocus def={{ where: draft ?? where }} onChange={(d) => setDraft(d.where ?? null)} />
        {draft && !sameValue(draft, where) && (
          <DraftBar className="sticky top-0 z-10 mb-3 rounded-xl bg-surface px-3 py-2" onDiscard={() => setDraft(null)} onSave={() => (repo.change(SETTINGS_ID, (d) => setSettings(d, { inbox: draft })), setDraft(null), notify(t("view.saved")))} />
        )}
      </div>
    </Dialog>
  );
}
