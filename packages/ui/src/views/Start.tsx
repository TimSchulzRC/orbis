// Start (design rules § 4): the date, the day in one statement ("1 überfällig, 1 heute fällig"),
// a quiet line below, capture, then the start page as cards. The start page stays a text with
// query blocks (editable via "Start bearbeiten"); read, each "## heading" with its blocks is a
// card, and a line "---" splits it into a main and a side column.
import { useEffect, useMemo, useState } from "react";
import { MoreHorizontal, Pencil, Check, ChevronRight } from "lucide-react";
import { type Item, SETTINGS_ID, todayISO } from "@obtion/core/model";
import { defaultStartBody, isDefaultStartBody } from "@obtion/core/setup";
import { sidebarRoots } from "@obtion/core/placement";
import { keyBetween } from "@obtion/core/sortkey";
import { type Cond, type QueryDef, findBlocks, readBlock, runQuery } from "@obtion/core/query";
import { fmtDate } from "@obtion/core/i18n";
import { dueOf } from "@obtion/core/traits";
import type { Repo } from "@obtion/sync";
import { type DayBrief, dayBrief } from "@obtion/core/today";
import { createAndOpen } from "../actions";
import { useRepo, useIndex, useMediaQuery, useRoute, itemHref, spaceHref } from "../hooks";
import { spaceById, startSpace, useAccounts } from "../accounts";
import { SpaceFilter, SpaceScope, useReplicas } from "../ui/Spaces";
import { useT } from "../i18n";
import { Capture } from "../ui/Capture";
import { Editor } from "../ui/Editor";
import { Markdown } from "../ui/Markdown";
import { queryBlocks } from "../ui/QueryBlock";
import { Button, DueLabel, ItemIcon, MenuItem, Popover, IconButton, RelTime, cx } from "../ui/bits";
import { RowStatus, shortPath } from "../ui/Row";
import { ProjectTable } from "../ui/ProjectTable";

// ---------- head ----------

/**
 * "1 überfällig, 1 heute fällig" (the overdue part in red) or "Nichts fällig heute", over the
 * workspaces seen; below it the links that are not zero.
 */
function DayHead({ parts }: { parts: Part[] }) {
  const { t, lang } = useT();
  const briefs = parts.map((p) => ({ ...p, b: dayBrief(p.repo.index(), todayISO()) }));
  const sum = (f: (b: DayBrief) => number) => briefs.reduce((n, x) => n + f(x.b), 0);
  const overdue = sum((b) => b.overdue.length);
  const today = sum((b) => b.today.length);
  const inbox = sum((b) => b.inbox);
  const projects = briefs.find((x) => x.b.activeProjects);
  const upcoming = briefs.map((x) => x.b.upcoming).filter((u): u is NonNullable<typeof u> => !!u).sort((a, b) => (a.due < b.due ? -1 : 1))[0];
  const claim: React.ReactNode[] = [];
  if (overdue) claim.push(<span key="o" className="text-danger">{t("day.overdue", { count: overdue })}</span>);
  if (today) claim.push(<span key="t">{t("day.dueToday", { count: today })}</span>);
  const link = "text-fg underline decoration-line underline-offset-[3px] hover:decoration-current";
  const sub: React.ReactNode[] = [];
  if (inbox) sub.push(<a key="i" href="#/inbox" className={link}>{t("day.inbox", { count: inbox })}</a>);
  if (projects) sub.push(<a key="p" href={spaceHref(projects.space, "/i/sys%3Aproject")} className={link}>{t("day.activeProjects", { count: sum((b) => b.activeProjects) })}</a>);
  if (upcoming) sub.push(<span key="n">{t("day.nextDate", { date: fmtDate(lang, upcoming.due, { weekday: "short", day: "numeric", month: "short" }) })}</span>);
  // a fresh server: nothing pinned yet – the one sensible first step
  const first = parts[0];
  if (first && parts.every((p) => !sidebarRoots(p.repo.index()).length))
    sub.push(
      <button key="a" onClick={() => createAndOpen({ pinned: keyBetween(null, null) }, first.repo, first.space)} className={link}>
        {t("day.firstArea")}
      </button>,
    );
  return (
    <>
      <p className="text-[13px] text-muted">{new Date().toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", { weekday: "long", day: "numeric", month: "long" })}</p>
      <h1 className="mb-1.5 mt-1 text-[26px] font-semibold leading-8 tracking-[-0.015em] max-md:text-[22px] max-md:leading-7">
        {claim.length ? claim.map((c, i) => (i ? [", ", c] : c)) : t("day.nothing")}
      </h1>
      {sub.length > 0 && <p className="flex flex-wrap gap-x-3.5 gap-y-1 text-sm text-muted">{sub}</p>}
    </>
  );
}

// ---------- the start text as cards ----------

interface Section {
  title: string;
  text: string; // text outside the blocks
  blocks: QueryDef[];
}

/** Columns ("---" splits main and side) of sections ("## title" with what follows). */
function parseStart(body: string, ix: ReturnType<typeof useIndex>): { intro: string; cols: Section[][] } {
  const parts = body.split(/^\s*---\s*$/m).slice(0, 2);
  let intro = "";
  const cols = parts.map((part, ci) => {
    const out: Section[] = [];
    const chunks = part.split(/^## +/m);
    chunks.forEach((chunk, i) => {
      if (i === 0) {
        if (ci === 0) intro = chunk.trim();
        return;
      }
      const nl = chunk.indexOf("\n");
      const title = (nl < 0 ? chunk : chunk.slice(0, nl)).trim();
      const rest = nl < 0 ? "" : chunk.slice(nl + 1);
      const found = findBlocks(rest);
      let text = "";
      let pos = 0;
      for (const b of found) (text += rest.slice(pos, b.from)), (pos = b.to);
      text += rest.slice(pos);
      out.push({ title, text: text.trim(), blocks: found.map((b) => readBlock(b.src, ix).def) });
    });
    return out;
  });
  return { intro, cols };
}

const isOverdue = (c?: Cond): boolean => !!c && ("and" in c ? c.and.some(isOverdue) : "prop" in c && c.prop === "due" && c.op === "<" && c.value === "+0d");
const isInbox = (c?: Cond) => !!c && "inbox" in c;
const isProjects = (d: QueryDef) => !!d.columns?.includes("progress");

/** Remember per device whether a closed card is open. */
function useOpenCard(title: string, initial: boolean): [boolean, () => void] {
  const k = `obtion.start.open.${title}`;
  const [open, setOpen] = useState(() => (localStorage.getItem(k) === null ? initial : localStorage.getItem(k) === "1"));
  return [open, () => (localStorage.setItem(k, open ? "0" : "1"), setOpen(!open))];
}

/** A workspace seen on Start: its replica and its part of a card (the start text read with its index). */
interface Part {
  space: string;
  repo: Repo;
}

/** Order merged results like one query would: by its first sort key (dates and plain fields). */
function sortMerged(list: { item: Item; part: Part }[], def: QueryDef) {
  const by = def.sort?.[0];
  if (!by) return list;
  const value = (x: { item: Item; part: Part }) => (by.key === "due" ? (dueOf(x.item, x.part.repo.index().schemaOf(x.item)) ?? "\uffff") : String((x.item as unknown as Record<string, unknown>)[by.key] ?? ""));
  const num = (v: string) => (v !== "" && !isNaN(Number(v)) ? Number(v) : v);
  return [...list].sort((a, b) => {
    const x = num(value(a));
    const y = num(value(b));
    const c = x < y ? -1 : x > y ? 1 : 0;
    return by.desc ? -c : c;
  });
}

/**
 * One card (design rules § 4.2): head 48 (title, count, at most one button), a line, the content.
 * Its blocks run in every workspace seen (`parts`, each with the section read there) and show as one.
 */
function StartCard({ section, parts, first }: { section: Section; parts: (Part & { section?: Section })[]; first: boolean }) {
  const { t } = useT();
  const [all, setAll] = useState(false);
  const several = parts.length > 1;
  const collapsible = section.blocks.some((b) => b.collapsed);
  const [open, toggle] = useOpenCard(section.title, !collapsible);
  const runs = section.blocks.map((d, bi) => {
    const each = parts.map((p) => {
      const def = p.section?.blocks[bi];
      const res = def ? runQuery({ ...def, limit: undefined }, { ix: p.repo.index() }) : { items: [], total: 0 };
      return { part: p, items: res.items, total: res.total };
    });
    const merged = sortMerged(each.flatMap((e) => e.items.map((item) => ({ item, part: e.part }))), d);
    return { def: d, each, items: merged, total: each.reduce((n, e) => n + e.total, 0) };
  });
  const total = runs.reduce((n, r) => n + r.total, 0);
  const projects = runs.find((r) => isProjects(r.def));
  const inbox = runs.find((r) => isInbox(r.def.where));
  // nothing in it: the first card says that the day is free, the others are left out
  if (!total && !section.text) {
    if (!first) return null;
    return (
      <section className="rounded-xl border border-line bg-surface">
        <CardHead title={section.title} />
        <p className="px-3.5 py-3 text-sm text-muted">{t("start.nothingDue")}</p>
      </section>
    );
  }
  const projectSpace = projects?.each.find((e) => e.items.length)?.part.space;
  const right = inbox ? (
    <a href="#/inbox" className="inline-flex h-7 items-center rounded-lg border border-line bg-surface px-2 text-[13px] font-medium hover:bg-hover">
      {t("start.sort")}
    </a>
  ) : projects && projectSpace ? (
    <a href={spaceHref(projectSpace, "/i/sys%3Aproject")} className="inline-flex h-7 items-center rounded-lg px-2 text-[13px] text-muted hover:bg-hover hover:text-fg">
      {t("start.allProjects")}
    </a>
  ) : undefined;
  const count = projects ? projects.each.reduce((n, e) => n + e.items.filter((p) => !e.items.some((q) => e.part.repo.index().homePath(p.id).includes(q.id))).length, 0) : total;
  if (collapsible && !open)
    return (
      <section className="rounded-xl border border-line bg-surface">
        <CardHead title={section.title} count={count} toggle={toggle} open={false} />
      </section>
    );
  const name = (space: string) => (several ? spaceById(space)?.name : undefined);
  // groups (one per block): at most 8 rows together, then "Alle n"
  let left = all ? Infinity : 8;
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <CardHead title={section.title} count={count} right={right} toggle={collapsible ? toggle : undefined} open />
      {section.text && <Markdown src={section.text} className="px-3.5 py-2 text-sm" />}
      {runs.map((r, i) => {
        // projects: a table per workspace (their tree lives in one)
        if (isProjects(r.def))
          return r.each
            .filter((e) => e.items.length)
            .map((e) => (
              <SpaceScope key={`${i}-${e.part.space}`} id={e.part.space}>
                {several && <p className="border-t border-line px-3.5 pb-0.5 pt-2.5 text-xs font-semibold text-muted first:border-t-0">{name(e.part.space)}</p>}
                <ProjectTable items={e.items} />
              </SpaceScope>
            ));
        if (isInbox(r.def.where)) {
          const shown = r.items.slice(0, r.def.limit ?? 3);
          return (
            <div key={i}>
              {shown.map(({ item: x, part }) => (
                <a key={`${part.space}/${x.id}`} href={spaceHref(part.space, `/i/${encodeURIComponent(x.id)}`)} className="flex min-h-11 items-center gap-2.5 border-t border-line px-3.5 first:border-t-0 hover:bg-hover">
                  <ItemIcon item={x} size={15} className="shrink-0" ix={part.repo.index()} />
                  <span className="min-w-0 flex-1 truncate text-sm max-md:text-[15px]">{x.title || x.file?.name || t("untitled")}</span>
                  <span className="shrink-0 text-xs text-muted">
                    {several && <span className="font-medium">{name(part.space)} · </span>}
                    <RelTime ts={x.created} />
                  </span>
                </a>
              ))}
              {r.total > shown.length && (
                <a href="#/inbox" className="block border-t border-line px-3.5 py-2 text-[13px] text-muted hover:text-fg">
                  {t("start.more", { count: r.total - shown.length })}
                </a>
              )}
            </div>
          );
        }
        if (!r.items.length || left <= 0) return null;
        const rows = r.items.slice(0, Math.min(left, r.def.limit ?? Infinity));
        left -= rows.length;
        return (
          <div key={i} className="pb-1">
            {r.def.title && <p className={cx("px-3.5 pb-0.5 pt-2.5 text-xs font-semibold", isOverdue(r.def.where) ? "text-danger" : "text-muted")}>{r.def.title}</p>}
            {rows.map(({ item: x, part }) => (
              <SpaceScope key={`${part.space}/${x.id}`} id={part.space}>
                <FocusRow item={x} space={name(part.space)} />
              </SpaceScope>
            ))}
          </div>
        );
      })}
      {!projects && !inbox && total > 8 && (
        <button onClick={() => setAll(!all)} className="tap-y block w-full border-t border-line px-3.5 py-2 text-left text-[13px] text-muted hover:text-fg">
          {all ? t("notes.fewer") : t("notes.all", { count: total })}
        </button>
      )}
    </section>
  );
}

function CardHead({ title, count, right, toggle, open }: { title: string; count?: number; right?: React.ReactNode; toggle?: () => void; open?: boolean }) {
  const head = (
    <>
      {toggle && <ChevronRight size={14} className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")} aria-hidden />}
      <h2 className="truncate text-[15px] font-semibold">{title}</h2>
      {count !== undefined && count > 0 && <span className="text-[13px] tabular-nums text-muted">{count}</span>}
    </>
  );
  return (
    <div className={cx("flex h-12 items-center gap-2 px-3.5", open !== false && "border-b border-line")}>
      {toggle ? (
        <button onClick={toggle} aria-expanded={!!open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {head}
        </button>
      ) : (
        head
      )}
      {right && <div className="ml-auto flex shrink-0 items-center">{right}</div>}
    </div>
  );
}

/** A row in "Fokus": status, title, where it sits (its workspace, two places at most), the date. */
function FocusRow({ item, space }: { item: Item; space?: string }) {
  const repo = useRepo();
  const ix = repo.index();
  const { t } = useT();
  const path = ix.homePath(item.id);
  const where = [space, path.length ? shortPath(path, 2, repo) : ""].filter(Boolean).join(" · ");
  const due = dueOf(item, ix.schemaOf(item));
  return (
    <div data-id={item.id} className="flex min-h-11 items-center gap-2.5 px-3.5 py-1 hover:bg-hover max-md:min-h-[52px]">
      <RowStatus item={item} size={16} />
      <a href={itemHref(item.id)} className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm max-md:text-[15px]">{item.title || t("untitled")}</span>
        {where && <span className="truncate text-xs text-muted">{where}</span>}
      </a>
      <DueLabel due={due} />
    </div>
  );
}

// ---------- the page ----------

/**
 * Start over the workspaces seen. Its layout is the start text of one workspace, chosen on this
 * device (Settings; the account's first unless chosen, the first set up while that one is not);
 * each card's blocks run in every workspace seen. Before any workspace is set up, it sets one up.
 */
export function Start() {
  const { t, lang } = useT();
  const { spaces, shown } = useAccounts();
  const all = useReplicas(spaces.map((s) => s.id));
  const chosen = startSpace()!;
  const home = all[spaces.indexOf(chosen)]?.get(SETTINGS_ID) ? chosen : (spaces.find((_, n) => all[n]!.get(SETTINGS_ID)) ?? chosen);
  const homeRepo = all[spaces.indexOf(home)]!;
  const parts: Part[] = shown.map((s) => ({ space: s.id, repo: all[spaces.indexOf(s)]! })).filter((p) => p.repo.get(SETTINGS_ID));
  const editing = useRoute().query.get("edit") === "1";
  const edit = (on: boolean) => (location.hash = on ? "#/?edit=1" : "#/");
  const fresh = !homeRepo.get(SETTINGS_ID);
  const asked = homeRepo.status.loaded && (homeRepo.status.synced || (!homeRepo.status.online && homeRepo.docs.size === 0));
  useEffect(() => void (fresh && asked && location.replace(spaceHref(home.id, "/setup"))), [fresh && asked]);
  const doc = useMemo(() => homeRepo.getDoc(SETTINGS_ID), [homeRepo]);
  // the shipped start page, still unchanged, reads in the UI language (its text counts as a key
  // until it is edited); editing works on the stored text
  const stored = homeRepo.get(SETTINGS_ID)?.body ?? "";
  const body = isDefaultStartBody(stored) ? defaultStartBody(lang) : stored;
  const wide = useMediaQuery("(min-width: 768px)");
  const { intro, cols } = parseStart(body, homeRepo.index());
  const read = parts.map((p) => ({ ...p, cols: parseStart(body, p.repo.index()).cols }));
  const cards = cols.map((col, ci) => col.map((section, si) => ({ section, parts: read.map((p) => ({ space: p.space, repo: p.repo, section: p.cols[ci]?.[si] })) })));
  // on a phone one column: main first, then the side
  const columns = wide ? cards : [cards.flat()];
  return (
    <div className="page-wide">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <DayHead parts={parts} />
        </div>
        {editing ? (
          <Button variant="outline" onClick={() => edit(false)}>
            <Check size={14} /> {t("start.doneEditing")}
          </Button>
        ) : (
          <Popover align="right" trigger={(p) => <IconButton {...p} label={t("more")} icon={MoreHorizontal} />}>
            {(close) => (
              <MenuItem icon={<Pencil size={14} />} onClick={() => (close(), edit(true))}>
                {t("start.edit")}
              </MenuItem>
            )}
          </Popover>
        )}
      </div>
      <div className="mt-4">
        <SpaceFilter />
      </div>
      {/* on the phone the "+" button captures */}
      {wide && (
        <div className="mt-1">
          <Capture anywhere />
        </div>
      )}
      {editing ? (
        <div className="mt-6">
          {spaces.length > 1 && <p className="mb-3 text-sm text-muted">{t("start.editHint", { name: home.name })}</p>}
          <SpaceScope id={home.id}>
            <Editor doc={doc} extra={[queryBlocks(undefined)]} placeholder={t("start.placeholder")} />
          </SpaceScope>
        </div>
      ) : (
        <>
          {intro && <Markdown src={intro} className="mt-6 text-[15px]" />}
          <div className={cx("mt-8 grid items-start gap-6 max-md:mt-6", columns.length > 1 && "grid-cols-[minmax(0,3fr)_minmax(0,2fr)]")}>
            {columns.map((col, ci) => (
              <div key={ci} className="flex min-w-0 flex-col gap-6">
                {col.map((c, si) => (
                  <StartCard key={c.section.title + si} section={c.section} parts={c.parts} first={ci === 0 && si === 0} />
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
