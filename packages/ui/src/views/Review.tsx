import { Button as ShadcnButton } from "../components/ui/button";
// The review ("Durchsicht"): the inbox one entry at a time, as a stack. The entry on top, always
// as tall (a long one scrolls inside), so what can become of it stays in place below – a place, a
// type, back tomorrow, kept as it is, deleted – and on a desktop beside it what is still waiting
// and what this review sorted (each with its undo).
// What was sorted stays until the review is closed: "Später weiter" leaves it for later today.
//
// A suggestion (the agent's or the app's own) is not shown yet; it would be the first answer
// among the suggestions in `Choices`.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Check, Clock, FolderInput, Layers, List, Pause, RotateCcw, Shapes, StickyNote, Trash2, Undo2, X } from "lucide-react";
import type { Item } from "@obtion/core/model";
import { todayISO } from "@obtion/core/model";
import { plainText } from "@obtion/core/search";
import { useRepo, itemHref, spaceHref, go, useDesktop } from "../hooks";
import { replica, spaceById, useAccounts } from "../accounts";
import { useT } from "../i18n";
import { recentPlaces } from "../actions";
import { useBlobUrl } from "../files";
import { Button, Empty, ItemIcon, Kbd, RelTime, SectionTitle, Seg, Tag, TypeGlyph, cx, itemLook } from "../ui/bits";
import { Markdown } from "../ui/Markdown";
import { SpaceScope } from "../ui/Spaces";
import { placeSuggestions } from "../ui/suggest";
import { type InboxEntry, reviewMinutes, useInboxItems } from "../ui/inbox";
import { type Undo, captureTypes, revert, usePickers, useTriageActions } from "../ui/TriageActions";

/** One sorted entry: where it went, and the way back. */
interface Sorted {
  key: string;
  title: string;
  what: string;
  undo: Undo;
}

/** The review of today on this device: kept when leaving it ("Später weiter"), not over a reload. */
let session: { day: string; order: string[]; sorted: Sorted[]; at?: string } | null = null;

/** Where the review and the list switch to each other. */
export function StackListSwitch({ value }: { value: "stack" | "list" }) {
  const { t } = useT();
  return (
    <Seg
      value={value}
      label={t("review.view")}
      onChange={(v) => go(v === "stack" ? "/review" : "/inbox")}
      options={[
        { value: "stack", label: <span className="inline-flex items-center gap-1"><Layers size={13} /> {t("review.stack")}</span> },
        { value: "list", label: <span className="inline-flex items-center gap-1"><List size={13} /> {t("review.list")}</span> },
      ]}
    />
  );
}

/** `at`: the entry to begin with ("<workspace>/<id>", from the list or an old link). */
export function Review({ at }: { at?: string }) {
  const { t } = useT();
  const desktop = useDesktop();
  const entries = useInboxItems();
  const { shown } = useAccounts();
  if (session?.day !== todayISO()) session = null;
  const order = useRef<string[]>(session?.order ?? []);
  // what came in meanwhile joins the end of the stack
  for (const e of entries) if (!order.current.includes(e.key)) order.current.push(e.key);
  const [sorted, setSorted] = useState<Sorted[]>(() => session?.sorted ?? []);
  const [cur, setCur] = useState<string | undefined>(at ?? session?.at);
  const closed = useRef(false);
  const card = useRef<HTMLDivElement>(null);
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const left = order.current.filter((k) => byKey.has(k) && !sorted.some((s) => s.key === k));
  // the entry shown: the chosen one while it waits, else the next after its place
  const pickAt = (k?: string) => (k && left.includes(k) ? k : (order.current.slice(order.current.indexOf(k ?? "") + 1).find((x) => left.includes(x)) ?? left.at(-1)));
  const key = pickAt(cur);
  const entry = key ? byKey.get(key) : undefined;
  useEffect(() => void (closed.current || (session = { day: todayISO(), order: order.current, sorted, at: key })));
  useEffect(() => void (document.title = t("review.title")), []);

  const act = useTriageActions(() => entry!.space, { quiet: true });
  const record = (e: InboxEntry, what: string, undo?: Undo | null) => {
    if (!undo) return;
    setSorted((s) => [...s, { key: e.key, title: e.item.title || e.item.file?.name || t("untitled"), what, undo }]);
    setCur(e.key);
  };
  const placeIn = (list: Item[], p: string) => entry && record(entry, `→ ${replica(entry.space).repo.index().get(p)?.title ?? ""}`, act.place(list, p));
  const typeAs = (list: Item[], type: string) => entry && record(entry, replica(entry.space).repo.index().typeName(type) ?? "", act.giveType(list, type));
  const pick = usePickers(() => entry!.space, placeIn, typeAs);
  const later = () => entry && record(entry, t("review.done.later"), act.later([entry.item]));
  const keep = () => entry && record(entry, t("review.done.kept"), act.keep([entry.item]));
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
  const close = (keepForLater: boolean) => {
    if (!keepForLater) (closed.current = true), (session = null);
    go("/");
  };

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (pick.placing || pick.typing || el.closest("input, textarea, select, [contenteditable=true], .cm-editor, [role=dialog]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      // Enter on a button or link is its own
      if (k === "Enter" && el.closest("button, a")) return;
      const first = entry && offeredTypes(entry)[0];
      if (k === "u" || k === "z") undo();
      else if (!entry) return;
      else if (k === "e") pick.setPlacing([entry.item]);
      else if (k === "c" && first && entry.item.kind === "info") typeAs([entry.item], first);
      else if (k === "y" && entry.item.kind === "info") pick.setTyping([entry.item]);
      else if (k === "s") later();
      else if (k === "b") keep();
      else if (k === "x" || k === "Delete") trash();
      // arrows up and down scroll a long entry in its card
      else if (k === "ArrowDown" || k === "ArrowUp") card.current?.scrollBy({ top: k === "ArrowDown" ? 80 : -80 });
      else if (k === "j" || k === "ArrowRight") step(1);
      else if (k === "k" || k === "ArrowLeft") step(-1);
      else if (k === "Enter" || k === "o") location.hash = spaceHref(entry.space, `/i/${encodeURIComponent(entry.item.id)}`);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  const total = sorted.length + left.length;
  const several = shown.length > 1;
  const touch = useRef<number | null>(null);
  const head = (
    <ReviewHead
      total={total}
      at={entry ? sorted.length + 1 : total}
      sorted={sorted.length}
      minutes={reviewMinutes(left.length)}
      onLater={() => close(true)}
      onClose={() => close(false)}
    />
  );
  const body = entry ? (
    <SpaceScope id={entry.space}>
      <EntryCard key={entry.key} entry={entry} space={several ? spaceById(entry.space)?.name : undefined} more={left.length - 1} scroller={card} />
      <Choices entry={entry} onPlace={(p) => placeIn([entry.item], p)} onPick={() => pick.setPlacing([entry.item])} onType={(type) => typeAs([entry.item], type)} onTypes={() => pick.setTyping([entry.item])} onLater={later} onKeep={keep} onTrash={trash} onUndo={sorted.length ? () => undo() : undefined} keys={desktop} />
    </SpaceScope>
  ) : (
    <Finished count={sorted.length} onDone={() => close(false)} />
  );

  if (!desktop)
    return (
      <div
        className="flex min-h-full flex-col px-4 pb-6 pt-3"
        onTouchStart={(e) => (touch.current = e.touches[0]!.clientX)}
        onTouchEnd={(e) => {
          const dx = (e.changedTouches[0]?.clientX ?? 0) - (touch.current ?? 0);
          if (Math.abs(dx) > 70) step(dx < 0 ? 1 : -1);
          touch.current = null;
        }}
      >
        {head}
        <div className="mt-4">{body}</div>
        {/* the last one sorted, with its way back: the phone's "Erledigt", below so nothing above moves */}
        {sorted.length > 0 && <LastSorted s={sorted.at(-1)!} onUndo={() => undo()} />}
        {pick.node}
      </div>
    );
  return (
    <div className="mx-auto max-w-[1180px] px-8 pb-12 pt-7">
      {head}
      <div className="mt-6 grid grid-cols-[minmax(0,1fr)_300px] items-start gap-8">
        <div className="min-w-0">{body}</div>
        <aside className="flex flex-col gap-4" aria-label={t("review.title")}>
          <StackList keys={left} current={key} byKey={byKey} onPick={setCur} />
          <SortedList sorted={sorted} onUndo={undo} />
        </aside>
      </div>
      {pick.node}
    </div>
  );
}

/** The head: what it is, how far ("2 von 6"), the switch to the list, "Später weiter", close. */
function ReviewHead({ total, at, sorted, minutes, onLater, onClose }: { total: number; at: number; sorted: number; minutes: number; onLater: () => void; onClose: () => void }) {
  const { t } = useT();
  const desktop = useDesktop();
  const pause = (
    <Button variant="outline" onClick={onLater}>
      <Pause size={14} /> {t("review.pause")}
    </Button>
  );
  return (
    <header>
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--t-inbox)_35%,transparent)] bg-[color-mix(in_srgb,var(--t-inbox)_12%,transparent)] text-[var(--t-inbox)] max-lg:hidden">
          <Layers size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold leading-6">{t("review.title")}</h1>
          <p className="truncate text-[13px] tabular-nums text-muted-foreground">
            {total ? t("review.position", { at, count: total }) : t("review.empty")}
            {total > sorted && <> · {t("review.minutesLeft", { count: minutes })}</>}
          </p>
        </div>
        {desktop && (
          <>
            <StackListSwitch value="stack" />
            {pause}
          </>
        )}
        <ShadcnButton variant="plain" size="none" onClick={onClose} className="tap inline-flex items-center justify-center rounded-lg border border-line p-1.5 text-muted-foreground hover:bg-hover hover:text-fg" aria-label={t("review.close")} title={t("review.close")}>
          <X size={16} />
        </ShadcnButton>
      </div>
      {total > 0 && <Steps total={total} done={sorted} />}
      {!desktop && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <StackListSwitch value="stack" />
          {pause}
        </div>
      )}
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
        <span key={n} className={cx("h-1 flex-1 rounded-full", n < done ? "bg-[var(--ok)]" : n === done ? "bg-[var(--t-inbox)]" : "bg-line")} />
      ))}
    </div>
  );
}

/**
 * The entry in full: what it is, where from and how old, the title, the text, the notes below.
 * Always as tall, so the choices below never move; a long entry scrolls inside, a fade at the
 * bottom says there is more.
 */
function EntryCard({ entry, space, more, scroller }: { entry: InboxEntry; space?: string; more: number; scroller: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useT();
  const repo = useRepo();
  const ix = repo.index();
  const item = repo.get(entry.item.id) ?? entry.item;
  const look = itemLook(item, ix);
  // a loose note is a note here (it is in the inbox, that goes without saying)
  const kind = look.label === "inbox" ? t("kind.note") : ["file", "note", "overview"].includes(look.label) ? t("kind." + look.label) : look.label;
  const kids = ix.childrenOf(item.id).map((id) => ix.get(id)!).filter(Boolean);
  const img = useBlobUrl(item.file?.filetype === "bild" ? (item.file.display ?? item.file.hash) : item.file?.thumb, true);
  const [rest, setRest] = useState(false);
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
    <div className="relative">
      {/* the stack: the next entries lie below this one */}
      {more > 0 && <div className="absolute inset-x-4 -bottom-2 h-6 rounded-2xl border border-line bg-surface opacity-60" aria-hidden />}
      {more > 1 && <div className="absolute inset-x-8 -bottom-4 h-6 rounded-2xl border border-line bg-surface opacity-30" aria-hidden />}
      <article className="relative flex h-[clamp(240px,calc(100dvh-460px),440px)] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-sm max-lg:h-[clamp(200px,calc(100dvh-440px),440px)]">
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-8 py-7 max-lg:px-5 max-lg:py-5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-fg">
            <ItemIcon item={item} size={13} /> {kind}
          </span>
          {space && <span>{space}</span>}
          <span>
            {t("triage.captured")} <RelTime ts={item.created} />
          </span>
        </p>
        <h2 className="mt-4 text-[28px] font-bold leading-[34px] tracking-[-0.015em] max-lg:text-2xl">
          <a href={itemHref(item.id)} className="hover:underline">
            {item.title || item.file?.name || t("untitled")}
          </a>
        </h2>
        {item.body.trim() ? (
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
                  <ItemIcon item={c} size={14} /> <a href={itemHref(c.id)} className="truncate hover:underline">{c.title || t("untitled")}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
        </div>
        {rest && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 rounded-b-2xl bg-gradient-to-t from-surface to-transparent" aria-hidden />}
      </article>
    </div>
  );
}

/**
 * What can become of it. Five tiles, always the same and in the same place: put it somewhere, turn
 * it into a type (only a loose note), back tomorrow, keep it as it is, delete it. Below in one line
 * the quick ways: the first type ("c") and places it mentions or used last; the rest is in the
 * pickers. Keys quietly in the tiles on a desktop.
 */
function Choices({ entry, onPlace, onPick, onType, onTypes, onLater, onKeep, onTrash, onUndo, keys }: { entry: InboxEntry; onPlace: (p: string) => void; onPick: () => void; onType: (type: string) => void; onTypes: () => void; onLater: () => void; onKeep: () => void; onTrash: () => void; onUndo?: () => void; keys: boolean }) {
  const { t } = useT();
  const repo = useRepo();
  const ix = repo.index();
  const item = entry.item;
  const info = item.kind === "info";
  const places = placeSuggestions(item, repo).map((x) => x.id);
  for (const id of recentPlaces(repo)) if (!places.includes(id) && id !== item.id && !item.parents[id] && !ix.wouldCycle(item.id, id)) places.push(id);
  const type = info ? offeredTypes(entry)[0] : undefined;
  const tile = (icon: ReactNode, label: string, key: string, onClick: () => void, opts: { primary?: boolean; danger?: boolean; disabled?: boolean } = {}) => (
    <ShadcnButton
      variant="plain"
      size="none"
      onClick={onClick}
      disabled={opts.disabled}
      className={cx(
        "tap flex h-auto min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2.5 text-[13px] font-medium leading-tight whitespace-normal disabled:opacity-40 max-lg:px-0.5 max-lg:text-[11px]",
        opts.primary ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/90" : "border-line bg-surface hover:bg-hover",
        opts.danger && "text-danger",
      )}
    >
      {icon}
      <span className="flex items-center gap-1.5 text-center">
        {label} {keys && <Kbd>{key}</Kbd>}
      </span>
    </ShadcnButton>
  );
  const chip = "tap inline-flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[13px] hover:bg-hover";
  return (
    <div className="mt-6 space-y-3">
      <div className="grid grid-cols-5 gap-2 max-lg:gap-1.5">
        {tile(<FolderInput size={17} />, t("review.placeAction"), "e", onPick, { primary: true })}
        {tile(<Shapes size={17} />, t("review.convertAction"), "y", onTypes, { disabled: !info })}
        {tile(<Clock size={17} />, t("review.later"), "s", onLater)}
        {tile(<StickyNote size={17} />, t("review.keep"), "b", onKeep)}
        {tile(<Trash2 size={17} />, t("triage.delete"), "x", onTrash, { danger: true })}
      </div>
      <div className="flex min-h-8 items-center gap-2">
        <span className="shrink-0 text-[13px] text-muted-foreground">{t("review.suggested")}</span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {type && (
            <ShadcnButton variant="plain" size="none" onClick={() => onType(type)} className={chip}>
              <TypeGlyph schema={ix.types.get(type)?.schema} size={13} />
              <span className="truncate">{t("review.asType", { type: ix.typeName(type) ?? "" })}</span>
              {keys && <Kbd>c</Kbd>}
            </ShadcnButton>
          )}
          {places.slice(0, 3).map((id) => (
            <ShadcnButton key={id} variant="plain" size="none" onClick={() => onPlace(id)} className={chip} title={t("review.placeIn", { place: ix.get(id)?.title ?? "" })}>
              <FolderInput size={13} className="shrink-0 text-muted-foreground" />
              <span className="truncate">{ix.get(id)?.title}</span>
            </ShadcnButton>
          ))}
          {!places.length && !type && <span className="text-[13px] text-muted-foreground">–</span>}
        </div>
        <Button onClick={onUndo} disabled={!onUndo} className="shrink-0">
          <Undo2 size={15} /> {t("review.back")} {keys && <Kbd>u</Kbd>}
        </Button>
      </div>
    </div>
  );
}

/** The types offered to turn an entry into: its workspace's first ones, not the one it has ("c" takes the first). */
const offeredTypes = (e: InboxEntry) => captureTypes(e.space).filter((x) => x !== e.item.type).slice(0, 3);

/** "Erledigt": what this review sorted, the last one on top, each with its undo. */
function SortedList({ sorted, onUndo }: { sorted: Sorted[]; onUndo: (s: Sorted) => void }) {
  const { t } = useT();
  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-label={t("review.sorted")} aria-live="polite">
      <SectionTitle count={sorted.length} className="mb-1">{t("review.sorted")}</SectionTitle>
      {sorted.length ? (
        <ul className="flex flex-col">
          {[...sorted].reverse().map((s) => (
            <li key={s.key} className="flex items-start gap-2.5 py-1.5">
              <Check size={15} className="mt-0.5 shrink-0 text-ok" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{s.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{s.what}</span>
              </span>
              <ShadcnButton variant="plain" size="none" onClick={() => onUndo(s)} className="tap shrink-0 rounded-md p-1 text-muted-foreground hover:bg-hover hover:text-fg" aria-label={t("review.undoNamed", { title: s.title })} title={t("triage.undo")}>
                <RotateCcw size={14} />
              </ShadcnButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("review.sortedNone")}</p>
      )}
    </section>
  );
}

/** "Noch im Stapel": what is still waiting, the current one marked; a click goes there. */
function StackList({ keys, current, byKey, onPick }: { keys: string[]; current?: string; byKey: Map<string, InboxEntry>; onPick: (k: string) => void }) {
  const { t } = useT();
  if (!keys.length) return null;
  return (
    <section className="rounded-xl border border-line bg-surface p-2">
      <SectionTitle count={keys.length} className="mb-0 px-2 pt-1">{t("review.left")}</SectionTitle>
      <ul className="flex max-h-[50vh] flex-col overflow-y-auto">
        {keys.map((k) => {
          const e = byKey.get(k)!;
          return (
            <li key={k}>
              <ShadcnButton variant="plain" size="none" onClick={() => onPick(k)} aria-current={k === current} className={cx("relative flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover", k === current && "bg-selected before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r before:bg-[var(--t-inbox)]")}>
                <ItemIcon item={e.item} size={14} ix={replica(e.space).repo.index()} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{e.item.title || e.item.file?.name || t("untitled")}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    <RelTime ts={e.item.created} />
                  </span>
                </span>
              </ShadcnButton>
            </li>
          );
        })}
      </ul>
    </section>
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
      <ShadcnButton variant="plain" size="none" onClick={onUndo} className="tap shrink-0 font-medium text-[var(--link)] hover:underline">
        {t("triage.undo")}
      </ShadcnButton>
    </div>
  );
}

/** Nothing left: done, and the way back to the day. */
function Finished({ count, onDone }: { count: number; onDone: () => void }) {
  const { t } = useT();
  return (
    <div className="rounded-2xl border border-line bg-surface">
      <Empty icon={<Check size={22} className="text-ok" />} title={count ? t("review.finished", { count }) : t("inbox.empty")}>
        <Button variant="primary" onClick={onDone} className="mt-2">
          {t("review.toToday")}
        </Button>
      </Empty>
    </div>
  );
}

