// The tray's panel ("Eingang"): looking in, not sorting. Every entry of the workspaces seen, newest
// first, with a line of its text, its workspace and age; one opens here to read and add to it and
// stays in the inbox – sorting is the review's (views/Review.tsx), here only a quiet link leads
// there. Above the tray on a desktop, as a sheet on a phone. What lands in the inbox: behind "…".
// On Heute on a desktop it is part of the page (`pinned`): always open, it does not close. Without
// room for it there, Heute shows the newest entries as cards (ShelfCards), each opens the panel.
import { Button as ShadcnButton } from "../components/ui/button";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUp, Maximize2, MoreHorizontal, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { type Item, SETTINGS_ID, setSettings } from "@obtion/core/model";
import type { QueryDef } from "@obtion/core/query";
import { inboxWhere } from "@obtion/core/inbox";
import { resetInbox } from "@obtion/core/setup";
import { plainText } from "@obtion/core/search";
import { fmtBytes } from "@obtion/core/i18n";
import { useRepo, itemHref, spaceHref } from "../hooks";
import { useBlobUrl } from "../files";
import { Textarea } from "../components/ui/textarea";
import { replica, spaceById, useAccounts } from "../accounts";
import { useT } from "../i18n";
import { Button, Dialog, IconButton, ItemIcon, Kbd, MenuItem, Popover, RelTime, cx } from "./bits";
import { Editor } from "./Editor";
import { TitleField } from "./TitleField";
import { QueryEditor } from "./QueryEditor";
import { SpaceFilter, SpaceScope } from "./Spaces";
import { notify } from "./feedback";
import { type InboxEntry, closeShelf, openShelf, reviewMinutes, useInboxItems, useShelf } from "./inbox";
import { DraftBar } from "../views/Lists";

/** Where an entry opens in the review. */
const reviewHref = (key: string) => `#/review?at=${encodeURIComponent(key)}`;

export function ShelfPanel({ desktop, pinned }: { desktop: boolean; pinned?: boolean }) {
  const { t } = useT();
  const { at } = useShelf();
  const entries = useInboxItems();
  const entry = at ? entries.find((e) => e.key === at) : undefined;
  // a key from before (the entry was sorted elsewhere meanwhile): the list
  useEffect(() => void (at && !entry && openShelf()), [at, !!entry]);
  // Escape: from an entry back to the list, from the list closed – unless a dialog or menu above it takes it
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("[role=dialog][data-state=open], [data-radix-popper-content-wrapper]")) return;
      if (entry) openShelf();
      else if (!pinned) closeShelf();
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
      className={cx(
        "flex flex-col overflow-hidden border border-line bg-surface",
        pinned
          ? "h-full rounded-2xl shadow-[0_6px_24px_-12px_rgb(0_0_0/0.25)]"
          : cx("shadow-[0_18px_50px_-12px_rgb(0_0_0/0.45)]", desktop ? "max-h-[min(640px,calc(100dvh-160px))] rounded-2xl" : entry ? "h-full rounded-t-2xl" : "max-h-[min(70dvh,560px)] rounded-2xl"),
      )}
    >
      {!desktop && <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line" aria-hidden />}
      {entry ? <EntryView entry={entry} desktop={desktop} pinned={pinned} /> : <List entries={entries} desktop={desktop} pinned={pinned} />}
    </div>
  );
}

/** The list: newest first; ↑↓ choose, ↵ opens, Esc closes (pinned: it stays, and takes the focus only when clicked). */
function List({ entries, desktop, pinned }: { entries: InboxEntry[]; desktop: boolean; pinned?: boolean }) {
  const { t } = useT();
  const { shown } = useAccounts();
  const [sel, setSel] = useState(0);
  const [rule, setRule] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => void (!pinned && box.current?.focus()), []);
  useEffect(() => void box.current?.querySelector(`[data-shelf="${sel}"]`)?.scrollIntoView({ block: "nearest" }), [sel]);
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-line py-2.5 pl-5 pr-2">
        <h2 className="text-[15px] font-semibold">
          {t("tray.title")} <span className="tabular-nums text-warn">{entries.length}</span>
        </h2>
        {desktop && <span className="text-[13px] text-muted-foreground">· {t("tray.newestFirst")}</span>}
        <span className="flex-1" />
        {entries.length > 0 && (
          <a href="#/review" className="tap-y inline-flex items-center gap-1 rounded-md px-1.5 text-[13px] text-muted-foreground hover:text-fg">
            {t("tray.toReview")} {desktop && <>· {t("tray.minutes", { count: reviewMinutes(entries.length) })}</>} <ArrowRight size={14} />
          </a>
        )}
        <Popover align="right" trigger={(p) => <IconButton {...p} label={t("more")} icon={MoreHorizontal} />}>
          {(close) =>
            shown.map((s) => (
              <MenuItem key={s.id} icon={<SlidersHorizontal size={14} />} onClick={() => (close(), setRule(s.id))}>
                {shown.length > 1 ? t("inbox.whatLandsIn", { name: s.name }) : t("inbox.whatLands")}
              </MenuItem>
            ))
          }
        </Popover>
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
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setSel((s) => Math.min(entries.length - 1, s + 1));
          else if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
          else if (e.key === "Enter" && entries[sel]) openShelf(entries[sel]!.key);
          else return;
          e.preventDefault();
        }}
      >
        {entries.length ? (
          entries.map((e, n) => <Row key={e.key} entry={e} n={n} on={n === sel} space={shown.length > 1 ? spaceById(e.space)?.name : undefined} onHover={() => setSel(n)} />)
        ) : (
          <p className="px-4 py-8 text-center text-[15px] text-muted-foreground">{t("inbox.empty")}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-line px-5 py-2.5 text-[13px] text-muted-foreground">
        <span className="min-w-0 flex-1">{t("tray.lookHint")}</span>
        {desktop && (
          <span className="flex shrink-0 items-center gap-1 text-xs">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> {t("tray.keys.choose")} <Kbd>↵</Kbd> {t("triage.keys.open")} {!pinned && <Kbd>Esc</Kbd>}
          </span>
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
        <span className="text-[13px] text-muted-foreground">· {t("tray.newestFirst")}</span>
        <span className="flex-1" />
        <ShadcnButton variant="plain" size="none" onClick={() => openShelf()} className="tap-y inline-flex items-center gap-1 rounded-md px-1.5 text-[13px] text-muted-foreground hover:text-fg">
          {t("tray.showAll")} <ArrowUp size={14} />
        </ShadcnButton>
      </div>
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        {entries.slice(0, 4).map((e) => {
          const ix = replica(e.space).repo.index();
          const line = preview(e, t, lang, ix.childrenOf(e.item.id).length);
          return (
            <ShadcnButton
              key={e.key}
              variant="plain"
              size="none"
              onClick={() => openShelf(e.key)}
              aria-label={t("tray.openEntry", { title: e.item.title || e.item.file?.name || t("untitled") })}
              className="flex min-w-0 flex-col items-stretch gap-1 rounded-xl border border-[color-mix(in_srgb,var(--t-inbox)_35%,var(--border))] bg-surface px-4 py-3 text-left hover:bg-hover"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <ItemIcon item={e.item} size={13} ix={ix} />
                <RelTime ts={e.item.created} />
                {shown.length > 1 && <span className="truncate">· {spaceById(e.space)?.name}</span>}
              </span>
              <span className="truncate text-[15px] font-semibold">{e.item.title || e.item.file?.name || t("untitled")}</span>
              <span className="truncate text-xs text-muted-foreground">{line || "\u00a0"}</span>
            </ShadcnButton>
          );
        })}
      </div>
    </section>
  );
}

/** What an entry says in one line: its text, else what it is (a file, notes below). */
function preview(e: InboxEntry, t: (k: string, v?: Record<string, unknown>) => string, lang: string, notes: number): string {
  const i = e.item;
  const text = plainText(i.body || i.file?.text || "").slice(0, 200);
  if (text) return notes ? `${text} · ${t("triage.notes", { count: notes })}` : text;
  if (i.file) return [t("kind.file"), fmtBytes(lang as "de" | "en", i.file.size)].join(" · ");
  return notes ? t("triage.notes", { count: notes }) : "";
}

function Row({ entry, n, on, space, onHover }: { entry: InboxEntry; n: number; on: boolean; space?: string; onHover: () => void }) {
  const { t, lang } = useT();
  const ix = replica(entry.space).repo.index();
  const line = preview(entry, t, lang, ix.childrenOf(entry.item.id).length);
  return (
    <ShadcnButton
      variant="plain"
      size="none"
      data-shelf={n}
      role="option"
      aria-selected={on}
      onClick={() => openShelf(entry.key)}
      onMouseMove={onHover}
      className={cx("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left", on && "bg-hover")}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line text-muted-foreground">
        <ItemIcon item={entry.item} size={16} ix={ix} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px]">{entry.item.title || entry.item.file?.name || t("untitled")}</span>
        {line && <span className="block truncate text-[13px] text-muted-foreground">{line}</span>}
      </span>
      <span className="flex shrink-0 flex-col items-end text-xs text-muted-foreground">
        <RelTime ts={entry.item.created} />
        {space && <span>{space}</span>}
      </span>
    </ShadcnButton>
  );
}

/**
 * One entry, to read and add to: its title and text editable, the notes below it. It stays in the
 * inbox – the banner says so, with the way to sort it now in the review.
 */
function EntryView({ entry, desktop, pinned }: { entry: InboxEntry; desktop: boolean; pinned?: boolean }) {
  const { t } = useT();
  return (
    <SpaceScope id={entry.space}>
      <div className="flex shrink-0 items-center gap-1 border-b border-line py-2 pl-2 pr-2">
        <ShadcnButton variant="plain" size="none" onClick={() => openShelf()} className="tap inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[15px] text-muted-foreground hover:bg-hover hover:text-fg">
          <ArrowLeft size={16} /> {t("tray.title")}
        </ShadcnButton>
        {desktop && <span className="min-w-0 truncate text-[15px]">/ {entry.item.title || entry.item.file?.name || t("untitled")}</span>}
        <span className="flex-1" />
        <a href={spaceHref(entry.space, `/i/${encodeURIComponent(entry.item.id)}`)} className="tap inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[13px] hover:bg-hover">
          <Maximize2 size={14} /> {t("tray.openFull")}
        </a>
        {pinned ? null : desktop ? <IconButton icon={X} label={t("close")} onClick={closeShelf} /> : <Button onClick={closeShelf} className="font-semibold">{t("tray.done")}</Button>}
      </div>
      <EntryBody entry={entry} />
    </SpaceScope>
  );
}

function EntryBody({ entry }: { entry: InboxEntry }) {
  const { t } = useT();
  const repo = useRepo();
  const ix = repo.index();
  const item = repo.get(entry.item.id) ?? entry.item;
  const { shown } = useAccounts();
  const kids = ix.childrenOf(item.id).map((id) => ix.get(id)!).filter(Boolean);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4 max-lg:px-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[color-mix(in_srgb,var(--t-inbox)_40%,transparent)] bg-[color-mix(in_srgb,var(--t-inbox)_10%,transparent)] px-3.5 py-2.5 text-[13px]">
        <span className="size-2 shrink-0 rounded-full bg-[var(--t-inbox)]" aria-hidden />
        <span className="min-w-0 flex-1 basis-48">
          <b className="font-semibold text-warn">{t("tray.staysTitle")}</b> <span className="text-muted-foreground">{t("tray.staysHint")}</span>
        </span>
        <a href={reviewHref(entry.key)} className="shrink-0 text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-fg max-lg:basis-full max-lg:pl-5">
          {t("tray.sortNow")}
        </a>
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
      {kids.length > 0 && (
        <div className="mt-6">
          <p className="mb-1.5 text-xs font-semibold text-muted-foreground">{t("below.title")}</p>
          <ul className="space-y-1 text-sm">
            {kids.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <ItemIcon item={c} size={14} /> <a href={itemHref(c.id)} className="truncate hover:underline">{c.title || t("untitled")}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
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
        <p className="mt-3 line-clamp-6 text-[15px] leading-[1.65] text-muted-foreground">{plainText(f.text).slice(0, 800)}</p>
      ) : null}
      <Textarea
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
        {draft && JSON.stringify(draft) !== JSON.stringify(where) && (
          <DraftBar onDiscard={() => setDraft(null)} onSave={() => (repo.change(SETTINGS_ID, (d) => setSettings(d, { inbox: draft })), setDraft(null), notify(t("view.saved")))} />
        )}
      </div>
    </Dialog>
  );
}
