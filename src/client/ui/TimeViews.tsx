// Calendar and timeline: entries at their date or range. Dragging moves the date (and in the
// timeline the start or the end); entries without a date are listed below.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { type Item, type PropDef, titleKey, todayISO } from "../../shared/model";
import { type EvalCtx, type Group, type QueryDef, fieldOf, groupItems, typesIn } from "../../shared/query";
import { dueProp } from "../../shared/traits";
import { repo } from "../repo";
import { go, itemHref, useMediaQuery } from "../hooks";
import { useT } from "../i18n";
import { ItemIcon, ItemLink, Seg, cx } from "./bits";
import { type Look, GroupChip, HiddenGroups, hiddenPatch, splitHidden } from "./Table";

// ---------- dates (ISO strings, computed in UTC so no time zone moves a day) ----------

const DAY = 86400000;
const ms = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);
export const diffDays = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY);
const weekday = (d: string) => new Date(ms(d)).getUTCDay(); // 0 = Sunday
const firstDay = (lang: string) => (lang === "en" ? 0 : 1);
const startOfWeek = (d: string, lang: string) => addDays(d, -((weekday(d) - firstDay(lang) + 7) % 7));
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ---------- which date, read and written ----------

interface Span {
  start: string;
  end: string;
}

/** The date a view places entries by: chosen, else the first date property (a due date before others). */
export function dateKey(def: QueryDef, items: Item[], ctx: EvalCtx, chosen?: string): string | undefined {
  if (chosen) return chosen;
  const types = [...new Set([...typesIn(def.where), ...items.slice(0, 100).map((i) => i.type ?? "")])].map((id) => ctx.ix.types.get(id)?.schema).filter(Boolean);
  for (const s of types) {
    const p = s!.properties.find((x) => x.kind === "date" && x.range) ?? dueProp(s) ?? s!.properties.find((x) => x.kind === "date");
    if (p) return p.name;
  }
  return undefined;
}

function spanOf(item: Item, key: string, ctx: EvalCtx): Span | undefined {
  const hit = fieldOf(item, key, ctx.ix);
  if (!hit || hit.kind !== "date" || typeof hit.value !== "string" || !hit.value) return undefined;
  const [a = "", b = ""] = hit.value.split("/");
  const start = isDay(a) ? a : isDay(b) ? b : undefined;
  const end = isDay(b) ? b : start;
  if (!start || !end) return undefined;
  return ms(end) < ms(start) ? { start: end, end: start } : { start, end };
}

/** The property behind a date key on this entry, if it can be written (not "Erstellt", not "Geändert"). */
function writable(item: Item, key: string, ctx: EvalCtx): PropDef | undefined {
  const schema = ctx.ix.schemaOf(item);
  if (key === "due") return dueProp(schema);
  if (key === "created" || key === "updated" || key === "done") return undefined;
  return schema?.properties.find((p) => p.kind === "date" && titleKey(p.name) === titleKey(key));
}

function writeSpan(item: Item, key: string, span: Span, ctx: EvalCtx) {
  const p = writable(item, key, ctx);
  if (!p) return;
  repo.setProp(item.id, p.id, p.range ? `${span.start}/${span.end}` : span.start);
}

// ---------- calendar ----------

/** A month: entries on their day, ranges as bars across the days; drag an entry to another day. */
export function CalendarView({ items, def, ctx, look }: { items: Item[]; def: QueryDef; ctx: EvalCtx; look?: Look }) {
  const { t, lang } = useT();
  const key = dateKey(def, items, ctx, look?.tab?.date);
  const today = todayISO();
  const [month, setMonth] = useState(() => today.slice(0, 7) + "-01");
  const [drag, setDrag] = useState<{ id: string; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const placed = key ? items.map((i) => ({ item: i, span: spanOf(i, key, ctx) })).filter((x): x is { item: Item; span: Span } => !!x.span) : [];
  const undated = items.filter((i) => !placed.some((p) => p.item.id === i.id));
  const first = startOfWeek(month, lang);
  const nextMonth = iso(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1));
  const weeks: string[] = [];
  for (let w = first; ms(w) < ms(nextMonth); w = addDays(w, 7)) weeks.push(w);
  const shift = (n: number) => setMonth(iso(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + n, 1)));
  const dayNames = Array.from({ length: 7 }, (_, n) => new Intl.DateTimeFormat(lang, { weekday: "short", timeZone: "UTC" }).format(new Date(ms(addDays(first, n)))));
  const drop = (day: string) => {
    if (!drag || !key) return;
    const p = placed.find((x) => x.item.id === drag.id);
    if (!p) return;
    const d = diffDays(drag.from, day);
    if (d) writeSpan(p.item, key, { start: addDays(p.span.start, d), end: addDays(p.span.end, d) }, ctx);
  };
  if (!key) return <p className="px-2 py-1.5 text-sm text-muted">{t("view.noDate")}</p>;
  const MAX = 3;
  return (
    <div className="text-sm">
      <div className="mb-2 flex items-center gap-1">
        <h3 className="mr-2 text-base font-semibold capitalize">{new Intl.DateTimeFormat(lang, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(ms(month)))}</h3>
        <button onClick={() => shift(-1)} className="tap rounded-md p-1 text-muted hover:bg-hover hover:text-fg" aria-label={t("cal.prev")}>
          <ChevronLeft size={16} />
        </button>
        <button onClick={() => setMonth(today.slice(0, 7) + "-01")} className="tap rounded-md px-2 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg">
          {t("time.today")}
        </button>
        <button onClick={() => shift(1)} className="tap rounded-md p-1 text-muted hover:bg-hover hover:text-fg" aria-label={t("cal.next")}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[640px] overflow-hidden rounded-xl border border-line">
          <div className="grid grid-cols-7 border-b border-line bg-surface-2/50 text-xs text-muted">
            {dayNames.map((d) => (
              <div key={d} className="px-2 py-1">
                {d}
              </div>
            ))}
          </div>
          {weeks.map((w) => {
            const days = Array.from({ length: 7 }, (_, n) => addDays(w, n));
            const end = days[6]!;
            // entries in this week, longest first, each in the first free lane
            const here = placed.filter((p) => ms(p.span.start) <= ms(end) && ms(p.span.end) >= ms(w)).sort((a, b) => diffDays(b.span.start, b.span.end) - diffDays(a.span.start, a.span.end) || a.span.start.localeCompare(b.span.start));
            const lanes: string[][] = [];
            const pos = here.map((p) => {
              const s = Math.max(0, diffDays(w, p.span.start));
              const e = Math.min(6, diffDays(w, p.span.end));
              let lane = lanes.findIndex((l) => l.slice(s, e + 1).every((x) => !x));
              if (lane < 0) lanes.push(Array(7).fill("")), (lane = lanes.length - 1);
              for (let n = s; n <= e; n++) lanes[lane]![n] = p.item.id;
              return { ...p, s, e, lane };
            });
            return (
              <div key={w} className="relative grid min-h-24 grid-cols-7 border-b border-line last:border-b-0" style={{ gridTemplateRows: `1.75rem repeat(${Math.min(lanes.length, MAX) + 1}, minmax(1.5rem, auto))` }}>
                {days.map((d, n) => (
                  <div
                    key={d}
                    onDragOver={(e) => drag && (e.preventDefault(), setOver(d))}
                    onDragLeave={() => setOver(null)}
                    onDrop={(e) => (e.preventDefault(), drop(d), setDrag(null), setOver(null))}
                    className={cx("border-l border-line first:border-l-0", d.slice(0, 7) !== month.slice(0, 7) && "bg-surface-2/40", over === d && "bg-hover")}
                    style={{ gridColumn: n + 1, gridRow: `1 / span ${Math.min(lanes.length, MAX) + 2}` }}
                  >
                    <span className={cx("m-1 inline-flex size-6 items-center justify-center rounded-full text-xs tabular-nums", d === today ? "bg-ink font-medium text-ink-text" : d.slice(0, 7) === month.slice(0, 7) ? "text-muted" : "text-muted")}>{+d.slice(8, 10)}</span>
                  </div>
                ))}
                {pos
                  .filter((p) => p.lane < MAX)
                  .map((p) => (
                    <a
                      key={p.item.id}
                      href={itemHref(p.item.id)}
                      draggable={!!writable(p.item, key, ctx)}
                      onDragStart={(e) => (e.dataTransfer.setData("obtion/item", p.item.id), setDrag({ id: p.item.id, from: days[p.s]! }))}
                      onDragEnd={() => setDrag(null)}
                      title={p.item.title}
                      className={cx(
                        "z-[1] mx-1 my-px flex min-w-0 items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-xs",
                        p.span.start === p.span.end ? "border-line bg-surface shadow-sm hover:bg-hover" : SPAN,
                        ms(p.span.start) < ms(w) && "ml-0 rounded-l-none border-l-0",
                        ms(p.span.end) > ms(end) && "mr-0 rounded-r-none border-r-0",
                      )}
                      style={{ gridColumn: `${p.s + 1} / ${p.e + 2}`, gridRow: p.lane + 2 }}
                    >
                      <ItemIcon item={p.item} size={12} className="shrink-0" />
                      <span className="truncate">{p.item.title || t("untitled")}</span>
                    </a>
                  ))}
                {days.map((d, n) => {
                  const more = pos.filter((p) => p.lane >= MAX && p.s <= n && p.e >= n).length;
                  return more ? (
                    <span key={"m" + d} className="z-[1] mx-1.5 text-xs text-muted" style={{ gridColumn: n + 1, gridRow: MAX + 2 }}>
                      {t("cal.more", { count: more })}
                    </span>
                  ) : null;
                })}
              </div>
            );
          })}
        </div>
      </div>
      <Undated items={undated} label={t("view.undated", { count: undated.length })} />
    </div>
  );
}

/** Entries without a date: below the view, folded. */
function Undated({ items, label }: { items: Item[]; label: string }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="mt-3 text-sm">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="tap-y flex items-center gap-1.5 text-muted hover:text-fg">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {label}
      </button>
      {open && (
        <ul className="mt-1 space-y-1 pl-5">
          {items.map((i) => (
            <li key={i.id}>
              <ItemLink item={i} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- timeline ----------

/** A range as a bar: a quiet tint of the focus colour. */
const SPAN = "border-[color-mix(in_srgb,var(--focus)_40%,transparent)] bg-[color-mix(in_srgb,var(--focus)_14%,var(--surface))] hover:bg-[color-mix(in_srgb,var(--focus)_22%,var(--surface))]";

type Scale = "week" | "month";
const PX: Record<Scale, number> = { week: 28, month: 7 }; // pixels per day

/**
 * Bars over weeks or months: from start to end; dragging the bar moves both, its edges change
 * start or end. Groupable like the table; entries without a range are listed below.
 */
export function TimelineView({ items, def, ctx, look }: { items: Item[]; def: QueryDef; ctx: EvalCtx; look?: Look }) {
  const { t, lang } = useT();
  const key = dateKey(def, items, ctx, look?.tab?.date);
  const today = todayISO();
  const [scale, setScaleState] = useState<Scale>(() => (localStorage.getItem("obtion.timeline.scale") as Scale) || "week");
  const setScale = (s: Scale) => (localStorage.setItem("obtion.timeline.scale", s), setScaleState(s));
  const px = PX[scale];
  // while dragging: the changed span of one entry, written on release
  const [live, setLive] = useState<{ id: string; span: Span } | null>(null);
  const placed = new Map<string, Span>();
  if (key) for (const i of items) {
    const s = spanOf(i, key, ctx);
    if (s) placed.set(i.id, s);
  }
  const undated = items.filter((i) => !placed.has(i.id));
  const spans = [...placed.values()];
  // the shown range: all bars and today, with some room; at least three months
  const min = spans.reduce((m, s) => (ms(s.start) < ms(m) ? s.start : m), today);
  const max = spans.reduce((m, s) => (ms(s.end) > ms(m) ? s.end : m), today);
  const from = startOfWeek(addDays(min, -14), lang);
  const to = addDays(max, Math.max(30, 90 - diffDays(min, max)));
  const days = diffDays(from, to) + 1;
  const width = days * px;
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollX, setScrollX] = useState(0);
  const narrow = useMediaQuery("(max-width: 640px)");
  useEffect(() => {
    // start with today in view, a bit from the left
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, diffDays(from, today) * px - 160);
  }, [scale, key]);
  if (!key) return <p className="px-2 py-1.5 text-sm text-muted">{t("view.noDate")}</p>;
  const by = def.group;
  const tab = look?.tab;
  const dated = items.filter((i) => placed.has(i.id));
  const [groups, hiddenGroups] = by ? splitHidden(groupItems(dated, by, ctx).filter((g) => g.items.length), tab) : [[{ key: "", items: dated } as Group], []];
  const byLabel = by ? (["status", "statusGroup", "type", "path"].includes(by) ? t("group." + by) : by) : "";
  // the scale: month names (and week starts in the week scale)
  const ticks: { day: string; label: string; major: boolean }[] = [];
  for (let d = from; ms(d) <= ms(to); d = addDays(d, 1)) {
    if (d.endsWith("-01")) ticks.push({ day: d, label: new Intl.DateTimeFormat(lang, { month: scale === "week" ? "long" : "short", year: d.slice(5, 7) === "01" || scale === "week" ? "numeric" : undefined, timeZone: "UTC" }).format(new Date(ms(d))), major: true });
    // week starts, not right next to a month name
    else if (scale === "week" && weekday(d) === firstDay(lang) && +d.slice(8, 10) > 4) ticks.push({ day: d, label: String(+d.slice(8, 10)), major: false });
  }
  const drag = (item: Item, mode: "move" | "start" | "end", e: React.PointerEvent) => {
    if (!writable(item, key, ctx)) return;
    e.preventDefault();
    e.stopPropagation();
    const span0 = placed.get(item.id)!;
    const x0 = e.clientX;
    let span = span0;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const d = Math.round((ev.clientX - x0) / px);
      if (d) moved = true;
      span =
        mode === "move"
          ? { start: addDays(span0.start, d), end: addDays(span0.end, d) }
          : mode === "start"
            ? { start: ms(addDays(span0.start, d)) > ms(span0.end) ? span0.end : addDays(span0.start, d), end: span0.end }
            : { start: span0.start, end: ms(addDays(span0.end, d)) < ms(span0.start) ? span0.start : addDays(span0.end, d) };
      setLive({ id: item.id, span });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLive(null);
      if (!moved) return mode === "move" && go(itemHref(item.id).slice(1));
      if (span.start !== span0.start || span.end !== span0.end) writeSpan(item, key, span, ctx);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const LEFT = narrow ? 130 : 220; // the names column; on a phone it leaves room for the bars
  const row = (i: Item) => {
    const s = live?.id === i.id ? live.span : placed.get(i.id)!;
    const x = diffDays(from, s.start) * px;
    const w = (diffDays(s.start, s.end) + 1) * px;
    const canEdit = !!writable(i, key, ctx);
    return (
      <div key={i.id} data-id={i.id} className="group/row flex h-9 items-center border-b border-line hover:bg-hover">
        <div className="sticky left-0 z-[2] flex h-full shrink-0 items-center gap-2 border-r border-line bg-bg px-2 group-hover/row:bg-hover" style={{ width: LEFT }}>
          <ItemIcon item={i} size={14} className="shrink-0" />
          <a href={itemHref(i.id)} className="truncate hover:underline">
            {i.title || t("untitled")}
          </a>
        </div>
        <div className="relative h-full" style={{ width }}>
          <div
            onPointerDown={(e) => drag(i, "move", e)}
            title={`${i.title} · ${s.start === s.end ? s.start : `${s.start} – ${s.end}`}`}
            className={cx("absolute top-1.5 flex h-6 items-center overflow-hidden whitespace-nowrap rounded-md border px-2 text-xs touch-none", SPAN, canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer")}
            style={{ left: x, width: Math.max(w, px) }}
          >
            {canEdit && <span onPointerDown={(e) => drag(i, "start", e)} className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" aria-hidden />}
            {/* a long bar keeps its name in view while scrolling */}
            <span className="truncate" style={{ paddingLeft: Math.max(0, Math.min(scrollX - x, w - 120)) }}>
              {i.title || t("untitled")}
            </span>
            {canEdit && <span onPointerDown={(e) => drag(i, "end", e)} className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" aria-hidden />}
          </div>
        </div>
      </div>
    );
  };
  return (
    <div className="text-sm">
      <div className="mb-2 flex items-center gap-2">
        <Seg label={t("timeline.scale")} value={scale} onChange={setScale} options={[{ value: "week", label: t("timeline.weeks") }, { value: "month", label: t("timeline.months") }]} />
        <button onClick={() => scroller.current && (scroller.current.scrollLeft = Math.max(0, diffDays(from, today) * px - 160))} className="tap rounded-md px-2 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg">
          {t("time.today")}
        </button>
      </div>
      <div ref={scroller} onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)} className="relative overflow-x-auto rounded-xl border border-line">
        <div style={{ width: width + LEFT }} className="relative">
          {/* scale */}
          <div className="sticky top-0 z-[3] flex h-8 border-b border-line bg-surface-2/60 text-xs text-muted">
            <div className="sticky left-0 z-[2] shrink-0 border-r border-line bg-surface-2" style={{ width: LEFT }} />
            <div className="relative" style={{ width }}>
              {ticks.map((k) => (
                <span key={k.day} className={cx("absolute top-0 h-full whitespace-nowrap border-l pl-1 pt-1.5", k.major ? "border-line font-medium text-muted" : "border-line/50")} style={{ left: diffDays(from, k.day) * px }}>
                  {k.label}
                </span>
              ))}
            </div>
          </div>
          {/* today */}
          <div className="pointer-events-none absolute bottom-0 top-0 z-[1] w-px bg-[var(--danger)] opacity-60" style={{ left: LEFT + diffDays(from, today) * px + px / 2 }} aria-hidden />
          {groups.map((g) => (
            <div key={g.key || "_"}>
              {by && (
                <div className="sticky left-0 flex h-9 w-fit items-center gap-2 px-2">
                  <GroupChip g={g} by={by} byLabel={byLabel} />
                  <span className="text-xs tabular-nums text-muted">{g.items.length}</span>
                </div>
              )}
              {g.items.map(row)}
            </div>
          ))}
        </div>
      </div>
      {by && <HiddenGroups groups={hiddenGroups} by={by} byLabel={byLabel} onShow={look?.onLook ? (g) => look.onLook!(hiddenPatch(tab, g, false)) : undefined} />}
      <Undated items={undated} label={t("view.undatedRange", { count: undated.length })} />
    </div>
  );
}
