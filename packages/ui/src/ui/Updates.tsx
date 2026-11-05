// Updates of a page: the newest as one line in the page's head, all of them in a panel from the right.
import { useMemo, useRef, useState } from "react";
import { Bot, ChevronRight, Plus, Send, X } from "lucide-react";
import type { Item } from "@obtion/core/model";
import { fmtDate, fmtTime } from "@obtion/core/i18n";
import type { T } from "@obtion/core/i18n";
import { addDays, todayISO } from "@obtion/core/date";
import { statusProp } from "@obtion/core/traits";
import { byAgent, byDay, unread, updateFeed, type FeedEntry } from "@obtion/core/updates";
import { Dialog, DialogTitle, SheetContent } from "../components/ui/dialog";
import { Textarea } from "../components/ui/textarea";
import { NativeSelect } from "../components/ui/native-select";
import { repo } from "../repo";
import { itemHref, useIndex } from "../hooks";
import { useT } from "../i18n";
import { Button, IconButton, Kbd, Seg } from "./primitives";
import { ItemIcon, RelTime } from "./item-look";
import { agentLabel, agentName } from "./AgentNotice";
import { KEYS, readJSON, writeJSON } from "./storage";
import { modName } from "../lib/platform";
import { cn } from "../lib/utils";

/** Entries shown in the panel at first, and added with "Ältere zeigen". */
const PAGE = 30;

type Filter = "all" | "here" | "agents";

/** What is being written, kept while the panel is closed so a click beside it loses nothing. */
type Draft = { text: string; status: string };

/** Meta parts in a row, "·" between them, never at the start of a wrapped line. */
const META = "flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground [&>*+*]:before:mr-1.5 [&>*+*]:before:content-['·']";

const seenAt = (pageId: string) => readJSON<number>(KEYS.updatesSeen(pageId), 0);

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
      <ItemIcon item={e.from} size={11} /> <span className="max-w-[14rem] truncate">{e.from.title}</span>
    </>
  );
  return (
    // the outer span carries the "·" of META; a flex box would put its gap between "·" and the text
    <span className={cn("min-w-0", className)}>
      <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      {other && (onLeave ? (
        <a href={itemHref(e.from.id)} onClick={onLeave} className="inline-flex min-w-0 items-center gap-1 hover:text-fg hover:underline">
          {page}
        </a>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1">{page}</span>
      ))}
      {status && <span className="whitespace-nowrap">{other ? `→ ${status}` : t("updates.statusTo", { name: status })}</span>}
      </span>
    </span>
  );
}

/** Zone 1 of a page whose type has updates: the newest one, and the panel with all of them. */
export function PageUpdates({ item }: { item: Item }) {
  const { t } = useT();
  const ix = useIndex();
  const feed = useMemo(() => updateFeed(ix, item.id), [ix, item.id]);
  const [open, setOpen] = useState<false | "read" | "write">(false);
  const [draft, setDraft] = useState<Draft>({ text: "", status: "" });
  // the ones that were new when the panel opened keep their mark while it is open
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [, rerender] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const news = unread(feed, seenAt);
  const show = (mode: "read" | "write") => {
    setFresh(new Set(news.map((e) => e.u.id)));
    const now = Date.now();
    for (const id of [item.id, ...ix.descendants(item.id)]) writeJSON(KEYS.updatesSeen(id), now);
    rerender((n) => n + 1);
    setOpen(mode);
  };
  const latest = feed[0];

  return (
    <>
      {latest ? (
        <Button
          ref={trigger}
          variant="plain"
          onClick={() => show("read")}
          aria-haspopup="dialog"
          className="group -mx-2.5 mt-3 flex w-[calc(100%+20px)] items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-hover"
        >
          <span className={cn("mt-[5px] size-2 shrink-0 rounded-full", news.length ? "bg-ok" : "bg-faint/50")} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className={META}>
              <span className="font-medium text-fg">{t("updates.latest")}</span>
              <RelTime ts={latest.u.at} />
              <span>{authorLabel(latest.u.by, t)}</span>
              <Origin e={latest} item={item} className="max-md:hidden" />
            </span>
            {/* on phones the origin gets a row of its own, so no "·" starts a wrapped line */}
            <Origin e={latest} item={item} className="mt-0.5 text-xs text-muted-foreground md:hidden" />
            <span className="mt-0.5 line-clamp-2 text-sm text-fg">{latest.u.text}</span>
          </span>
          <span className="flex shrink-0 items-center gap-0.5 self-center text-xs text-muted-foreground group-hover:text-fg">
            {news.length > 0 ? (
              <span className="font-medium text-ok">{t("updates.newCount", { count: news.length })}</span>
            ) : (
              feed.length > 1 && <span className="max-md:sr-only">{t("updates.all", { count: feed.length })}</span>
            )}
            <ChevronRight size={14} aria-hidden />
          </span>
        </Button>
      ) : (
        <Button ref={trigger} variant="plain" onClick={() => show("write")} aria-haspopup="dialog" className="tap-y -ml-1.5 mt-3 flex h-7 items-center gap-1 rounded-md px-1.5 text-[13px] text-muted-foreground hover:bg-hover hover:text-fg">
          <Plus size={14} aria-hidden /> {t("updates.first")}
        </Button>
      )}
      {open && (
        <UpdatesSheet
          item={item}
          feed={feed}
          fresh={fresh}
          write={open === "write"}
          draft={draft}
          onDraft={setDraft}
          onClose={() => setOpen(false)}
          onClosed={() => trigger.current?.focus({ preventScroll: true })}
        />
      )}
    </>
  );
}

function UpdatesSheet({ item, feed, fresh, write, draft, onDraft, onClose, onClosed }: { item: Item; feed: FeedEntry[]; fresh: Set<string>; write: boolean; draft: Draft; onDraft: (d: Draft) => void; onClose: () => void; onClosed: () => void }) {
  const { t, lang } = useT();
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  const list = feed.filter((e) => (filter === "here" ? e.from.id === item.id : filter === "agents" ? byAgent(e.u.by) : true));
  const today = todayISO();
  const dayLabel = (day: string) => (day === today ? t("time.today") : day === addDays(today, -1) ? t("updates.yesterday") : fmtDate(lang, day, { weekday: "long", day: "numeric", month: "long" }));
  const emptyText = !feed.length ? t("updates.empty") : filter === "here" ? t("updates.emptyHere") : t("updates.emptyAgents");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        aria-describedby={undefined}
        tabIndex={-1}
        onOpenAutoFocus={(e) => {
          // reading: focus the panel, not the text box (no keyboard popping up on phones)
          if (write) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
        onCloseAutoFocus={(e) => (e.preventDefault(), onClosed())}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
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
          <Composer item={item} draft={draft} onDraft={onDraft} autoFocus={write} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3">
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
          {byDay(list.slice(0, shown)).map(([day, group]) => (
            <section key={day} className="mt-3 first:mt-0">
              <h3 className="sticky top-0 z-10 -mx-4 bg-surface/95 px-4 py-1 text-xs font-medium text-muted-foreground backdrop-blur">{dayLabel(day)}</h3>
              <ol className="ml-1 mt-1 space-y-4 border-l border-line pb-1 pl-5">
                {group.map((e) => {
                  const isNew = fresh.has(e.u.id);
                  return (
                    <li key={e.u.id} className="relative">
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
                        {isNew && <span className="font-medium text-ok">{t("updates.new")}</span>}
                      </div>
                      <div className="mt-0.5 whitespace-pre-wrap text-[15px]">{e.u.text}</div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
          {list.length > shown && (
            <Button variant="plain" onClick={() => setShown(shown + PAGE)} className="tap-y mt-4 text-[13px] text-muted-foreground hover:text-fg">
              {t("updates.older")}
            </Button>
          )}
        </div>
      </SheetContent>
    </Dialog>
  );
}

/** Write an update, optionally changing the page's status with it. Enter breaks the line, ⌘/Strg+Enter posts. */
function Composer({ item, draft, onDraft, autoFocus }: { item: Item; draft: Draft; onDraft: (d: Draft) => void; autoFocus: boolean }) {
  const { t, lang } = useT();
  const ix = useIndex();
  const statusProperty = statusProp(ix.schemaOf(item));
  const box = useRef<HTMLTextAreaElement>(null);
  const submit = () => {
    if (!draft.text.trim()) return;
    repo.addUpdate(item.id, draft.text.trim(), draft.status && statusProperty ? { prop: statusProperty.id, option: draft.status } : undefined);
    onDraft({ text: "", status: "" });
    box.current?.focus();
  };
  return (
    <div className="rounded-xl border border-line bg-bg px-3 py-2.5 focus-within:border-focus">
      <Textarea
        ref={box}
        variant="inline"
        autoFocus={autoFocus}
        value={draft.text}
        onChange={(e) => onDraft({ ...draft, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) (e.preventDefault(), submit());
        }}
        rows={3}
        enterKeyHint="enter"
        placeholder={t("updates.placeholder")}
        className="max-h-60 min-h-[66px] w-full resize-none bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
        aria-label={t("updates.writeOn", { title: item.title || t("untitled") })}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {statusProperty && (
          <NativeSelect value={draft.status} onChange={(e) => onDraft({ ...draft, status: e.target.value })} size="sm" className="h-8 rounded-lg border-line bg-surface pl-2.5 pr-8 text-xs text-muted-foreground" aria-label={t("updates.status")}>
            <option value="">{t("updates.keepStatus")}</option>
            {statusProperty.options?.filter((o) => o.id !== item.props[statusProperty.id]).map((o) => (
              <option key={o.id} value={o.id}>
                → {o.name}
              </option>
            ))}
          </NativeSelect>
        )}
        <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground max-md:hidden" aria-hidden>
          <Kbd>{modName(lang)}</Kbd> <Kbd>Enter</Kbd>
        </span>
        <Button variant="primary" onClick={submit} disabled={!draft.text.trim()} className="max-md:ml-auto disabled:opacity-35">
          <Send size={14} aria-hidden /> {t("updates.post")}
        </Button>
      </div>
    </div>
  );
}
