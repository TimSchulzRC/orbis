// Updates of a page: the newest as one line in the page's head, all of them in a panel from the right.
import { useRef, useState } from "react";
import { ChevronRight, Plus, Send, X } from "lucide-react";
import type { Item, UpdateEntry } from "@obtion/core/model";
import { fmtDate, fmtRelative } from "@obtion/core/i18n";
import type { T } from "@obtion/core/i18n";
import { dateOf, addDays, todayISO } from "@obtion/core/date";
import { statusProp } from "@obtion/core/traits";
import { Dialog, DialogTitle, SheetContent } from "../components/ui/dialog";
import { Textarea } from "../components/ui/textarea";
import { NativeSelect } from "../components/ui/native-select";
import { repo } from "../repo";
import { itemHref, useIndex, useLocalStorage } from "../hooks";
import { useT } from "../i18n";
import { Button, IconButton, Seg } from "./primitives";
import { ItemIcon } from "./item-look";
import { agentLabel, agentName } from "./AgentNotice";
import { KEYS } from "./storage";
import { cn } from "../lib/utils";

/** Entries shown in the panel at first, and added with "Ältere zeigen". */
const PAGE = 30;

type Entry = { u: UpdateEntry; from: Item };
type Filter = "all" | "here" | "agents";

const byAgent = (u: UpdateEntry) => u.by !== "you";

/** The page's updates and those of everything below it, newest first. */
function useEntries(item: Item): Entry[] {
  const ix = useIndex();
  return [item, ...[...ix.descendants(item.id)].map((id) => ix.get(id)!)]
    .flatMap((x) => x.updates.map((u) => ({ u, from: x })))
    .sort((a, b) => b.u.at - a.u.at);
}

/** The status an update set, looked up in the type of the page it was written on. */
function useStatusName() {
  const ix = useIndex();
  return ({ u, from }: Entry) => (u.status ? ix.schemaOf(from)?.properties.flatMap((p) => p.options ?? []).find((o) => o.id === u.status)?.name : undefined);
}

/** Who wrote an update: "Du", an import, or the agent's name. */
function authorLabel(by: string, t: T): string {
  if (by === "you") return t("updates.you");
  if (by.startsWith("import:")) return t("updates.import");
  return agentLabel(agentName(by) ?? by, t);
}

/** Zone 1 of a page whose type has updates: the newest one, and the panel with all of them. */
export function PageUpdates({ item }: { item: Item }) {
  const { t, lang } = useT();
  const entries = useEntries(item);
  const statusName = useStatusName();
  const [open, setOpen] = useState<false | "read" | "write">(false);
  // kept while the panel is closed, so a click beside it loses nothing
  const [draft, setDraft] = useState("");
  const [seen, setSeen] = useLocalStorage<number>(KEYS.updatesSeen(item.id), 0);
  const show = (mode: "read" | "write") => {
    setSeen(Date.now());
    setOpen(mode);
  };
  const latest = entries[0];
  const unread = entries.filter((e) => byAgent(e.u) && e.u.at > seen).length;

  return (
    <>
      {latest ? (
        <Button
          variant="plain"
          onClick={() => show("read")}
          aria-label={t("updates.openAll", { count: entries.length })}
          className="group -mx-2.5 mt-3 flex w-[calc(100%+20px)] items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-hover"
        >
          <span className={cn("mt-[5px] size-2 shrink-0 rounded-full", unread ? "bg-ok" : "bg-faint/60")} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-fg">{unread ? t("updates.newCount", { count: unread }) : t("updates.latest")}</span>
              <span>· {fmtRelative(lang, latest.u.at)}</span>
              <span title={latest.u.by}>· {authorLabel(latest.u.by, t)}</span>
              {latest.from.id !== item.id && (
                <span className="inline-flex min-w-0 items-center gap-1">
                  · {t("updates.on")} <ItemIcon item={latest.from} size={11} /> <span className="max-w-[14rem] truncate">{latest.from.title}</span>
                </span>
              )}
              {statusName(latest) && <span>· {t("updates.statusTo", { name: statusName(latest)! })}</span>}
            </span>
            <span className="mt-0.5 line-clamp-2 block text-sm text-fg">{latest.u.text}</span>
          </span>
          <span className="flex shrink-0 items-center gap-0.5 self-center text-xs text-muted-foreground group-hover:text-fg">
            {entries.length > 1 && t("updates.all", { count: entries.length })}
            <ChevronRight size={14} />
          </span>
        </Button>
      ) : (
        <Button variant="plain" onClick={() => show("write")} className="tap-y -ml-1.5 mt-3 flex h-7 items-center gap-1 rounded-md px-1.5 text-[13px] text-muted-foreground hover:bg-hover hover:text-fg">
          <Plus size={14} /> {t("updates.first")}
        </Button>
      )}
      {open && <UpdatesSheet item={item} entries={entries} write={open === "write"} draft={draft} onDraft={setDraft} seenBefore={seen} onClose={() => setOpen(false)} />}
    </>
  );
}

function UpdatesSheet({ item, entries, write, draft, onDraft, seenBefore, onClose }: { item: Item; entries: Entry[]; write: boolean; draft: string; onDraft: (s: string) => void; seenBefore: number; onClose: () => void }) {
  const { t, lang } = useT();
  const statusName = useStatusName();
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  const box = useRef<HTMLTextAreaElement>(null);
  // the "new" marks stay as they were when the panel opened
  const [seen] = useState(seenBefore);
  const fromBelow = entries.some((e) => e.from.id !== item.id);
  const agents = entries.some((e) => byAgent(e.u));
  const filters: { value: Filter; label: string }[] = [
    { value: "all", label: t("updates.filter.all") },
    ...(fromBelow ? [{ value: "here" as const, label: t("updates.filter.here") }] : []),
    ...(agents && entries.some((e) => !byAgent(e.u)) ? [{ value: "agents" as const, label: t("updates.filter.agents") }] : []),
  ];
  const list = entries.filter((e) => (filter === "here" ? e.from.id === item.id : filter === "agents" ? byAgent(e.u) : true));
  const visible = list.slice(0, shown);
  const today = todayISO();
  const dayLabel = (day: string) => (day === today ? t("time.today") : day === addDays(today, -1) ? t("updates.yesterday") : fmtDate(lang, day, { weekday: "long", day: "numeric", month: "long" }));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          // reading: focus the panel, not the text box (no keyboard popping up on phones)
          if (write) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
        tabIndex={-1}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <DialogTitle className="text-base font-semibold">{t("updates.title")}</DialogTitle>
          {entries.length > 0 && <span className="text-[13px] tabular-nums text-muted-foreground">{entries.length}</span>}
          <IconButton onClick={onClose} label={t("close")} icon={X} className="ml-auto" />
        </div>
        <div className="border-b border-line p-4">
          <Composer item={item} draft={draft} onDraft={onDraft} box={box} autoFocus={write} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3">
          {filters.length > 1 && (
            <div className="mb-3">
              <Seg value={filter} options={filters} onChange={(f) => (setFilter(f), setShown(PAGE))} label={t("updates.filter.label")} />
            </div>
          )}
          {!entries.length && <p className="pt-2 text-sm text-muted-foreground">{t("updates.empty")}</p>}
          {groupByDay(visible).map(([day, group]) => (
            <section key={day} className="mt-3 first:mt-0">
              <h3 className="sticky top-0 z-10 -mx-4 bg-surface/95 px-4 py-1 text-xs font-medium text-muted-foreground backdrop-blur">{dayLabel(day)}</h3>
              <ol className="ml-1 mt-1 space-y-4 border-l border-line pb-1 pl-5">
                {group.map((e) => {
                  const { u, from } = e;
                  const isNew = byAgent(u) && u.at > seen;
                  return (
                    <li key={u.id} className="relative">
                      <span className={cn("absolute -left-[25px] top-1.5 size-2.5 rounded-full border-2 border-surface", byAgent(u) ? "bg-ok" : "bg-faint")} />
                      <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                        <time dateTime={new Date(u.at).toISOString()} title={new Date(u.at).toLocaleString()}>
                          {new Date(u.at).toLocaleTimeString(lang === "de" ? "de-DE" : "en-US", { hour: "2-digit", minute: "2-digit" })}
                        </time>
                        <span title={u.by}>· {authorLabel(u.by, t)}</span>
                        {from.id !== item.id && (
                          <a href={itemHref(from.id)} onClick={onClose} className="inline-flex min-w-0 items-center gap-1 hover:text-fg hover:underline">
                            · {t("updates.on")} <ItemIcon item={from} size={11} /> <span className="max-w-[12rem] truncate">{from.title}</span>
                          </a>
                        )}
                        {statusName(e) && <span>· {t("updates.statusTo", { name: statusName(e)! })}</span>}
                        {isNew && <span className="rounded bg-ok/15 px-1 text-[11px] font-medium text-ok">{t("updates.new")}</span>}
                      </div>
                      <div className="mt-0.5 whitespace-pre-wrap text-[15px]">{u.text}</div>
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

function groupByDay(entries: Entry[]): [string, Entry[]][] {
  const days = new Map<string, Entry[]>();
  for (const e of entries) {
    const day = dateOf(e.u.at);
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  return [...days];
}

/** Write an update, optionally changing the page's status with it. Enter posts, Shift+Enter breaks the line. */
function Composer({ item, draft, onDraft, box, autoFocus }: { item: Item; draft: string; onDraft: (s: string) => void; box: React.RefObject<HTMLTextAreaElement | null>; autoFocus: boolean }) {
  const { t } = useT();
  const ix = useIndex();
  const statusProperty = statusProp(ix.schemaOf(item));
  const [status, setStatus] = useState("");
  const submit = () => {
    if (!draft.trim()) return;
    repo.addUpdate(item.id, draft.trim(), status && statusProperty ? { prop: statusProperty.id, option: status } : undefined);
    onDraft("");
    setStatus("");
    box.current?.focus();
  };
  return (
    <div className="rounded-xl border border-line bg-bg p-2.5 focus-within:border-focus">
      <Textarea
        ref={box}
        autoFocus={autoFocus}
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), submit());
        }}
        rows={draft ? 3 : 2}
        placeholder={t("updates.placeholder")}
        className="w-full resize-none bg-transparent px-1 text-[15px] outline-none placeholder:text-muted-foreground"
        aria-label={t("updates.write")}
      />
      <div className="mt-1.5 flex flex-wrap items-center justify-end gap-2">
        {statusProperty && draft && (
          <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)} className="mr-auto rounded-md border border-line bg-surface px-1.5 py-1 text-xs text-muted-foreground" aria-label={t("updates.status")}>
            <option value="">{t("updates.keepStatus")}</option>
            {statusProperty.options?.filter((o) => o.id !== item.props[statusProperty.id]).map((o) => (
              <option key={o.id} value={o.id}>
                → {o.name}
              </option>
            ))}
          </NativeSelect>
        )}
        <Button variant="primary" onClick={submit} disabled={!draft.trim()}>
          <Send size={14} /> {t("updates.post")}
        </Button>
      </div>
    </div>
  );
}
