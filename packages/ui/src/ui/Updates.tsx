// Updates of a page: the newest as one line in the page's head, all of them in a panel at the right.
// On wide screens the panel sits beside the page (the page moves aside, both stay usable); on
// narrower ones it opens over the page, on phones from the bottom.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Bot, ChevronRight, Plus, Send, X } from "lucide-react";
import type { Item } from "@obtion/core/model";
import { fmtDate, fmtRelative, fmtTime } from "@obtion/core/i18n";
import type { T } from "@obtion/core/i18n";
import { addDays, todayISO } from "@obtion/core/date";
import { statusProp } from "@obtion/core/traits";
import { byAgent, byDay, unread, updateFeed, type FeedEntry } from "@obtion/core/updates";
import { Dialog, DialogTitle, SheetContent } from "../components/ui/dialog";
import { Textarea } from "../components/ui/textarea";
import { NativeSelect } from "../components/ui/native-select";
import { repo } from "../repo";
import { itemHref, useIndex, useMediaQuery, usePhone } from "../hooks";
import { useT } from "../i18n";
import { Button, IconButton, Kbd, Seg } from "./primitives";
import { ItemIcon } from "./item-look";
import { agentLabel, agentName } from "./AgentNotice";
import { KEYS, readJSON, writeJSON } from "./storage";
import { modName } from "../lib/platform";
import { cn } from "../lib/utils";

/** Entries shown in the panel at first, and added with "Ältere zeigen". */
const PAGE = 30;

/** From this width the panel docks beside the page instead of covering it. */
const DOCKED = "(min-width: 1280px)";

type Filter = "all" | "here" | "agents";

/** What is being written, kept while the panel is closed so a click beside it loses nothing. */
type Draft = { text: string; status: string };

/** Meta parts in a row, "·" between them, never at the start of a wrapped line. */
const META = "flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground [&>*+*]:before:mr-1.5 [&>*+*]:before:content-['·']";

/** Who wrote an update: "Du", an import, or the agent's name. */
function authorLabel(by: string, t: T): string {
  if (by === "you") return t("updates.you");
  if (by.startsWith("import:")) return t("updates.import");
  return agentLabel(agentName(by) ?? by, t);
}

/** The status an update set, in the type of the page it was written on. */
function useStatusName() {
  const ix = useIndex();
  return ({ u, from }: FeedEntry) => (u.status ? statusProp(ix.schemaOf(from))?.options?.find((o) => o.id === u.status)?.name : undefined);
}

/** Where an update was written (when not on this page) and the status it set. */
function Origin({ e, item, onLeave, className }: { e: FeedEntry; item: Item; onLeave?: () => void; className?: string }) {
  const { t } = useT();
  const status = useStatusName()(e);
  const other = e.from.id !== item.id;
  if (!other && !status) return null;
  const page = (
    <>
      <ItemIcon item={e.from} size={11} /> <span className="truncate">{e.from.title}</span>
    </>
  );
  return (
    // the outer span carries the "·" of META; a flex box would put its gap between "·" and the text
    <span className={cn("min-w-0 max-w-full", className)}>
      <span className="inline-flex min-w-0 max-w-full items-center gap-1">
        {other &&
          (onLeave ? (
            <a href={itemHref(e.from.id)} onClick={onLeave} className="inline-flex min-w-0 max-w-[14rem] items-center gap-1 hover:text-fg hover:underline">
              {page}
            </a>
          ) : (
            <span className="inline-flex min-w-0 max-w-[14rem] items-center gap-1">{page}</span>
          ))}
        {status && <span className="truncate">{other ? `→ ${status}` : t("updates.statusTo", { name: status })}</span>}
      </span>
    </span>
  );
}

/** Drafts per page while the app runs: leaving the page (the docked panel stays usable) loses none. */
const drafts = new Map<string, Draft>();
const EMPTY: Draft = { text: "", status: "" };
/** The docked panel stays open from page to page until it is closed. */
let dockedOpen = false;

/** One opening of the panel: what was new then and what has been on screen since. */
type Session = { openedAt: number; fresh: Set<string>; onScreen: Set<string> };

/** Zone 1 of a page whose type has updates: the newest one, and the panel with all of them. */
export function PageUpdates({ item }: { item: Item }) {
  const { t, lang } = useT();
  const ix = useIndex();
  const docked = useMediaQuery(DOCKED);
  const feed = useMemo(() => updateFeed(ix, item.id), [ix, item.id]);
  // when each page of the feed was last looked at (on this device): read once per change
  const [looked, setLooked] = useState(0);
  const seen = useMemo(() => new Map([...new Set(feed.map((e) => e.from.id))].map((id) => [id, readJSON<number>(KEYS.updatesSeen(id), 0)])), [feed, looked]);
  const news = unread(feed, (id) => seen.get(id) ?? 0);

  const [open, setOpen] = useState<false | "read" | "write">(false);
  const [round, setRound] = useState(0);
  const [draft, setDraftState] = useState<Draft>(() => drafts.get(item.id) ?? EMPTY);
  const setDraft = (d: Draft) => {
    setDraftState(d);
    if (d.text || d.status) drafts.set(item.id, d);
    else drafts.delete(item.id);
  };
  const session = useRef<Session | null>(null);
  const feedNow = useRef(feed);
  feedNow.current = feed;
  const trigger = useRef<HTMLButtonElement>(null);
  const textId = useId();

  const show = (mode: "read" | "write") => {
    if (session.current) return;
    session.current = { openedAt: Date.now(), fresh: new Set(news.map((e) => e.u.id)), onScreen: new Set() };
    setRound((n) => n + 1);
    setOpen(mode);
  };
  // a page counts as read when every update that was new from it has been on screen
  const commit = () => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    for (const id of new Set(feedNow.current.map((e) => e.from.id))) {
      const missed = feedNow.current.some((e) => e.from.id === id && s.fresh.has(e.u.id) && !s.onScreen.has(e.u.id));
      if (!missed) writeJSON(KEYS.updatesSeen(id), s.openedAt);
    }
  };
  const close = () => {
    commit();
    dockedOpen = false;
    setLooked((n) => n + 1);
    setOpen(false);
  };
  // leaving the page with the panel open: what was read counts; docked, the next page opens it again
  useEffect(() => {
    if (dockedOpen && matchMedia(DOCKED).matches) show("read");
    return commit;
  }, []);
  useEffect(() => {
    if (open) dockedOpen = docked;
  }, [open, docked]);

  // docked: the page makes room for the panel
  const room = !!open && docked;
  useEffect(() => {
    document.documentElement.toggleAttribute("data-side-panel", room);
    return () => document.documentElement.removeAttribute("data-side-panel");
  }, [room]);

  const latest = feed[0];
  // while the panel is open, the panel shows what is new
  const marked = open ? 0 : news.length;
  const latestIsNew = !open && latest && news.some((e) => e.u.id === latest.u.id);
  return (
    <>
      {latest ? (
        <Button
          ref={trigger}
          variant="plain"
          onClick={() => show("read")}
          aria-haspopup="dialog"
          aria-expanded={!!open}
          aria-label={[`${t("updates.latest")}, ${fmtRelative(lang, latest.u.at)}, ${authorLabel(latest.u.by, t)}`, marked ? t("updates.newCount", { count: marked }) : "", t("updates.openAll", { count: feed.length })].filter(Boolean).join(". ")}
          aria-describedby={textId}
          className="group -mx-2.5 mt-3 flex w-[calc(100%+20px)] items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-hover focus-visible:bg-hover aria-expanded:bg-hover"
        >
          {latestIsNew && <span className="mt-[5px] size-2 shrink-0 rounded-full bg-ok" aria-hidden />}
          <span className="min-w-0 flex-1">
            <span className={META}>
              <span className="font-medium text-fg">{t("updates.latest")}</span>
              <time dateTime={new Date(latest.u.at).toISOString()}>{fmtRelative(lang, latest.u.at)}</time>
              <span>{authorLabel(latest.u.by, t)}</span>
              <Origin e={latest} item={item} className="max-md:hidden" />
            </span>
            {/* on phones the origin gets a row of its own, so no "·" starts a wrapped line */}
            <Origin e={latest} item={item} className="mt-0.5 block text-xs text-muted-foreground md:hidden" />
            <span id={textId} className="mt-0.5 line-clamp-2 text-sm text-fg [overflow-wrap:anywhere]">
              {latest.u.text}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-0.5 self-center whitespace-nowrap text-xs text-muted-foreground group-hover:text-fg">
            {marked > 0 ? <span className="font-medium text-ok">{t("updates.newCount", { count: marked })}</span> : feed.length > 1 && <span>{t("updates.all", { count: feed.length })}</span>}
            <ChevronRight size={14} aria-hidden />
          </span>
        </Button>
      ) : (
        <Button ref={trigger} variant="plain" onClick={() => show("write")} aria-haspopup="dialog" aria-expanded={!!open} className="tap-y -ml-1.5 mt-3 flex h-7 items-center gap-1 rounded-md px-1.5 text-[13px] text-muted-foreground hover:bg-hover hover:text-fg">
          <Plus size={14} aria-hidden /> {t("updates.first")}
        </Button>
      )}
      {round > 0 && (
        <UpdatesSheet
          key={round}
          open={!!open}
          docked={docked}
          item={item}
          feed={feed}
          session={session.current}
          write={open === "write"}
          draft={draft}
          onDraft={setDraft}
          onClose={close}
          onClosed={() => trigger.current?.focus({ preventScroll: true })}
        />
      )}
    </>
  );
}

function UpdatesSheet({ open, docked, item, feed, session, write, draft, onDraft, onClose, onClosed }: { open: boolean; docked: boolean; item: Item; feed: FeedEntry[]; session: Session | null; write: boolean; draft: Draft; onDraft: (d: Draft) => void; onClose: () => void; onClosed: () => void }) {
  const { t, lang } = useT();
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  const [said, setSaid] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // the portal mounts a moment after the panel opens: watch the list once it is there
  const [listBox, setListBox] = useState<HTMLDivElement | null>(null);
  const listRef = useCallback((el: HTMLDivElement | null) => {
    scroller.current = el;
    setListBox(el);
  }, []);
  // the marks of this opening; kept while the panel slides out
  const [fresh] = useState(() => session?.fresh ?? new Set<string>());
  const list = feed.filter((e) => (filter === "here" ? e.from.id === item.id : filter === "agents" ? byAgent(e.u.by) : true));
  const visible = list.slice(0, shown);
  const visibleKey = visible.map((e) => e.u.id).join();

  // what scrolls into view counts as read, not what was merely rendered further down
  useEffect(() => {
    const root = listBox;
    if (!open || !session || !root) return;
    const watch = new IntersectionObserver(
      (seen) => {
        for (const e of seen) if (e.isIntersecting) session.onScreen.add((e.target as HTMLElement).dataset.update!);
      },
      { root, threshold: 0.5 },
    );
    for (const el of root.querySelectorAll("[data-update]")) watch.observe(el);
    return () => watch.disconnect();
  }, [open, session, visibleKey, listBox]);

  const today = todayISO();
  const dayLabel = (day: string) =>
    day === today
      ? t("time.today")
      : day === addDays(today, -1)
        ? t("updates.yesterday")
        : fmtDate(lang, day, { weekday: "long", day: "numeric", month: "long", year: day.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric" });
  const emptyText = !feed.length ? t("updates.empty") : filter === "here" ? t("updates.emptyHere") : t("updates.emptyAgents");
  const posted = () => {
    // the new update is the user's: show it, at the top
    if (filter === "agents") setFilter("all");
    scroller.current?.scrollTo({ top: 0 });
    // a live region only speaks when its text changes
    setSaid("");
    setTimeout(() => setSaid(t("updates.posted")), 50);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} modal={!docked}>
      <SheetContent
        ref={panel}
        modal={!docked}
        aria-describedby={undefined}
        tabIndex={-1}
        onOpenAutoFocus={(e) => {
          // reading: focus the panel, not the text box (no keyboard popping up on phones)
          if (write) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
        onCloseAutoFocus={(e) => (e.preventDefault(), onClosed())}
        // docked, the page beside it stays in use: a click there does not close the panel, nor does
        // Escape pressed in the page (an editor menu, a selection)
        onInteractOutside={(e) => docked && e.preventDefault()}
        onEscapeKeyDown={(e) => docked && !panel.current?.contains(document.activeElement) && e.preventDefault()}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line md:hidden" aria-hidden />
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 max-md:pt-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <DialogTitle className="text-base font-semibold">{t("updates.title")}</DialogTitle>
              {feed.length > 0 && <span className="text-[13px] tabular-nums text-muted-foreground">{feed.length}</span>}
            </div>
            <p className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <ItemIcon item={item} size={11} /> <span className="truncate">{item.title || t("untitled")}</span>
            </p>
          </div>
          <IconButton onClick={onClose} label={t("close")} icon={X} />
        </div>
        <div className="border-b border-line p-4">
          <Composer item={item} draft={draft} onDraft={onDraft} autoFocus={write} onPosted={posted} />
        </div>
        <p className="sr-only" aria-live="polite">
          {said}
        </p>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3">
          {feed.length > 1 && (
            <div className="mb-3">
              <Seg
                value={filter}
                options={[
                  { value: "all", label: t("updates.filter.all") },
                  { value: "here", label: t("updates.filter.here") },
                  { value: "agents", label: t("updates.filter.agents") },
                ]}
                onChange={(f) => (setFilter(f), setShown(PAGE))}
                label={t("updates.filter.label")}
              />
            </div>
          )}
          {!list.length && <p className="pt-2 text-sm text-muted-foreground">{emptyText}</p>}
          {byDay(visible).map(([day, group]) => (
            <section key={day} className="mt-3 first:mt-0" aria-label={dayLabel(day)}>
              <h3 className="sticky top-0 z-10 -mx-4 bg-surface/95 px-4 py-1 text-xs font-medium text-muted-foreground backdrop-blur">{dayLabel(day)}</h3>
              <ol className="ml-1 mt-1 space-y-4 border-l border-line pb-1 pl-5">
                {group.map((e) => {
                  const isNew = fresh.has(e.u.id);
                  return (
                    <li key={e.u.id} data-update={e.u.id} className="relative">
                      <span className={cn("absolute -left-[25px] top-1.5 size-2.5 rounded-full border-2 border-surface", isNew ? "bg-ok" : "bg-faint")} aria-hidden />
                      <div className={META}>
                        <time dateTime={new Date(e.u.at).toISOString()}>{fmtTime(lang, e.u.at)}</time>
                        <span title={e.u.by}>
                          <span className="inline-flex items-center gap-1">
                            {byAgent(e.u.by) && <Bot size={12} aria-hidden />}
                            {authorLabel(e.u.by, t)}
                          </span>
                        </span>
                        <Origin e={e} item={item} onLeave={onClose} />
                      </div>
                      {/* the green dot says it; a word on every new entry would be loud */}
                      {isNew && <span className="sr-only">{t("updates.new")}</span>}
                      <div className="mt-0.5 whitespace-pre-wrap text-[15px] [overflow-wrap:anywhere]">{e.u.text}</div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
          {list.length > shown && (
            <Button variant="plain" onClick={() => setShown(shown + PAGE)} className="tap-y mt-4 text-[13px] text-muted-foreground hover:text-fg">
              {t("updates.older", { count: list.length - shown })}
            </Button>
          )}
        </div>
      </SheetContent>
    </Dialog>
  );
}

/**
 * Write an update, optionally changing the page's status with it. Enter breaks the line, ⌘/Strg+Enter
 * posts. One line until it is used, so reading the updates below has the room.
 */
function Composer({ item, draft, onDraft, autoFocus, onPosted }: { item: Item; draft: Draft; onDraft: (d: Draft) => void; autoFocus: boolean; onPosted: () => void }) {
  const { t, lang } = useT();
  const ix = useIndex();
  const statusProperty = statusProp(ix.schemaOf(item));
  const choices = statusProperty?.options?.filter((o) => o.id !== item.props[statusProperty.id]) ?? [];
  const box = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const phone = usePhone();
  // opens up once used and stays so while the panel is open: folding on blur would move what is
  // below it under the pointer, between press and release
  const [used, setUsed] = useState(autoFocus);
  const expanded = used || !!draft.text;
  const submit = () => {
    if (!draft.text.trim()) return;
    // the status chosen earlier may be the page's status by now
    const status = statusProperty && choices.some((o) => o.id === draft.status) ? draft.status : "";
    repo.addUpdate(item.id, draft.text.trim(), status ? { prop: statusProperty!.id, option: status } : undefined);
    onDraft({ text: "", status: "" });
    onPosted();
    box.current?.focus();
  };
  return (
    <div
      className="rounded-xl border border-line bg-bg px-3 py-2 focus-within:border-focus"
      onFocus={() => setUsed(true)}
    >
      <Textarea
        ref={box}
        variant="inline"
        autoFocus={autoFocus}
        value={draft.text}
        onChange={(e) => onDraft({ ...draft, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) (e.preventDefault(), submit());
        }}
        rows={expanded ? 3 : 1}
        placeholder={t(expanded ? "updates.placeholder" : "updates.placeholderShort")}
        className={cn("w-full resize-none bg-transparent py-0.5 text-[15px] leading-6 max-md:text-base outline-none placeholder:text-muted-foreground", expanded ? "max-h-60 min-h-[78px]" : "h-7 overflow-hidden whitespace-nowrap")}
        aria-label={t("updates.writeOn", { title: item.title || t("untitled") })}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        aria-describedby={phone ? undefined : hintId}
      />
      {!phone && (
        <span id={hintId} className="sr-only">
          {t("updates.postHint", { key: modName(lang) })}
        </span>
      )}
      {expanded && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {statusProperty && (
            <NativeSelect value={draft.status} onChange={(e) => onDraft({ ...draft, status: e.target.value })} size="sm" className="h-8 rounded-lg border-line bg-surface pl-2.5 pr-8 text-xs text-muted-foreground" aria-label={t("updates.status")}>
              <option value="">{t("updates.keepStatus")}</option>
              {choices.map((o) => (
                <option key={o.id} value={o.id}>
                  → {o.name}
                </option>
              ))}
            </NativeSelect>
          )}
          <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground max-md:hidden" aria-hidden>
            <Kbd>{modName(lang)}</Kbd> <Kbd>Enter</Kbd>
          </span>
          <Button variant="primary" onClick={submit} disabled={!draft.text.trim()} className="max-md:ml-auto disabled:border disabled:border-line disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100">
            <Send size={14} aria-hidden /> {t("updates.post")}
          </Button>
        </div>
      )}
    </div>
  );
}
