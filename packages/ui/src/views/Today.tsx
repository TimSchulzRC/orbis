// "Heute", the start page: a greeting and in one sentence what the day holds, then what is due
// (today and overdue), the projects in progress and what was changed last – of every workspace
// seen. What waits in the inbox: on a desktop the tray's panel as a column of the page (Shelf.tsx,
// no tray below here), on a phone in the tray below (Tray.tsx), here only counted.
// Sections with nothing in them are left out.
import { useEffect } from "react";
import { Sun } from "lucide-react";
import type { Item } from "@obtion/core/model";
import { SETTINGS_ID, todayISO } from "@obtion/core/model";
import { fmtDate } from "@obtion/core/i18n";
import { activeProjects, dueBy, recentlyChanged } from "@obtion/core/today";
import { itemHref, useDesktop, useIndex } from "../hooks";
import { useAccounts } from "../accounts";
import { useT } from "../i18n";
import { Card, DueLabel, ItemIcon, RelTime, SectionTitle, cx, itemLook, pal } from "../ui/bits";
import { RowStatus } from "../ui/Row";
import { SpaceScope, useReplicas } from "../ui/Spaces";
import { useInboxItems } from "../ui/inbox";
import { ShelfPanel } from "../ui/Shelf";

interface Of<T> {
  space: string;
  value: T;
}

export function Today() {
  const { t, lang } = useT();
  const desktop = useDesktop();
  const { shown, account } = useAccounts();
  const repos = useReplicas(shown.map((s) => s.id));
  const inbox = useInboxItems().length;
  const today = todayISO();
  useEffect(() => void (document.title = t("nav.today")), []);
  // each workspace's part, then one list of all
  const per = shown.map((s, n) => ({ space: s.id, ix: repos[n]!.get(SETTINGS_ID) ? repos[n]!.index() : undefined }));
  const all = <T,>(f: (ix: NonNullable<(typeof per)[number]["ix"]>) => T[]): Of<T>[] => per.flatMap((p) => (p.ix ? f(p.ix).map((value) => ({ space: p.space, value })) : []));
  const due = all((ix) => dueBy(ix, today)).sort((a, b) => (a.value.due < b.value.due ? -1 : a.value.due > b.value.due ? 1 : 0));
  const projects = all((ix) => activeProjects(ix)).sort((a, b) => b.value.touched - a.value.touched);
  const recent = all((ix) => recentlyChanged(ix, 4)).sort((a, b) => b.value.updated - a.value.updated).slice(0, 4);
  const several = shown.length > 1;
  const nameOf = (space: string) => (several ? shown.find((s) => s.id === space)?.name : undefined);

  const hour = new Date().getHours();
  const part = hour < 5 ? "evening" : hour < 11 ? "morning" : hour < 18 ? "day" : "evening";
  const name = account?.user.name.trim().split(/\s+/)[0];
  // the inbox count opens the tray's panel (beside, brings it into view), amber as the tray: the sentence around it comes in two parts
  const [before, after] = t("today.inbox", { count: inbox, n: "\u0000" }).split("\u0000");
  const page = (
    <>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Sun size={15} /> {fmtDate(lang, today, { weekday: "long", day: "numeric", month: "long" })}
      </p>
      <h1 className="mt-2 text-[34px] font-bold leading-[40px] tracking-[-0.02em] max-lg:text-[28px] max-lg:leading-[34px]">{name ? t(`today.greet.${part}`, { name }) : t(`today.greet.${part}Plain`)}</h1>
      <p className="mt-2 text-[15px] leading-6 text-muted-foreground">
        {t("today.due", { count: due.length })} {projects.length > 0 && t("today.projects", { count: projects.length })}{" "}
        {inbox ? (
          <>
            {before}
            <a href="#/inbox" className="font-medium text-warn hover:underline">
              {t("today.entries", { count: inbox })}
            </a>
            {after}
          </>
        ) : (
          t("today.inboxEmpty")
        )}
      </p>

      <div className={cx("mt-9 grid items-start gap-x-8 gap-y-9", due.length > 0 && projects.length > 0 && (desktop ? "@3xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]" : "lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"))}>
        {due.length > 0 && (
          <section>
            <SectionTitle count={due.length}>{t("today.dueTitle")}</SectionTitle>
            <Card className="overflow-hidden">
              {due.map(({ space, value }) => (
                <SpaceScope key={`${space}/${value.item.id}`} id={space}>
                  <DueRow item={value.item} due={value.due} space={nameOf(space)} />
                </SpaceScope>
              ))}
            </Card>
          </section>
        )}
        {projects.length > 0 && (
          <section>
            <SectionTitle count={projects.length}>{t("today.projectsTitle")}</SectionTitle>
            <Card className="overflow-hidden">
              {projects.slice(0, 5).map(({ space, value }) => (
                <SpaceScope key={`${space}/${value.item.id}`} id={space}>
                  <ProjectRow item={value.item} touched={value.touched} space={nameOf(space)} />
                </SpaceScope>
              ))}
            </Card>
          </section>
        )}
      </div>

      {recent.length > 0 && (
        <section className="mt-9">
          <SectionTitle>{t("today.recentTitle")}</SectionTitle>
          {desktop ? (
            <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
              {recent.map(({ space, value }) => (
                <SpaceScope key={`${space}/${value.id}`} id={space}>
                  <RecentTile item={value} />
                </SpaceScope>
              ))}
            </div>
          ) : (
            <Card className="overflow-hidden">
              {recent.map(({ space, value }) => (
                <SpaceScope key={`${space}/${value.id}`} id={space}>
                  <RecentRow item={value} />
                </SpaceScope>
              ))}
            </Card>
          )}
        </section>
      )}
    </>
  );
  if (!desktop) return <div className="page-wide">{page}</div>;
  // on a desktop: the page and beside it the tray's panel, which stays in view while scrolling
  return (
    <div className="page-wide grid grid-cols-[minmax(0,1fr)_400px] items-start gap-x-10" style={{ maxWidth: 1240 }}>
      <div className="@container min-w-0">{page}</div>
      <aside className="sticky top-7 h-[calc(100dvh-56px)] max-h-[860px] min-h-[420px]">
        <ShelfPanel desktop embedded />
      </aside>
    </div>
  );
}

const row = "flex min-h-12 items-center gap-3 border-b border-line px-4 py-2 last:border-b-0";

/** A due entry: tick it off, where it belongs, when it was due. */
function DueRow({ item, due, space }: { item: Item; due: string; space?: string }) {
  const { t } = useT();
  const ix = useIndex();
  const project = ix.get(ix.project(item.id));
  const where = [project?.title, space].filter(Boolean).join(" · ");
  return (
    <div className={row}>
      <RowStatus item={item} />
      <a href={itemHref(item.id)} className="flex min-w-0 flex-1 flex-col hover:underline lg:flex-row lg:items-baseline lg:gap-3">
        <span className="truncate text-[15px]">{item.title || t("untitled")}</span>
        {where && <span className="truncate text-xs text-muted-foreground lg:ml-auto">{where}</span>}
      </a>
      <DueLabel due={due} />
    </div>
  );
}

/** A project in progress: its progress as a ring (only with entries to count), what is open, when touched. */
function ProjectRow({ item, touched, space }: { item: Item; touched: number; space?: string }) {
  const { t, lang } = useT();
  const ix = useIndex();
  const prog = ix.progressOf(item);
  const color = pal(ix.schemaOf(item)?.color);
  return (
    <a href={itemHref(item.id)} className={cx(row, "hover:bg-hover")}>
      {prog && prog.total > 0 ? <Ring share={prog.done / prog.total} color={color} /> : <span className="flex size-8 shrink-0 items-center justify-center"><ItemIcon item={item} /></span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium">{item.title || t("untitled")}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {prog && prog.total > 0 && <>{t("today.open", { count: prog.total - prog.done })} · </>}
          {t("today.touched")} <RelTime ts={touched} />
          {space && <> · {space}</>}
        </span>
      </span>
      {prog && prog.total > 0 && <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">{new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 }).format(prog.done / prog.total)}</span>}
    </a>
  );
}

function Ring({ share, color }: { share: number; color: string }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" className="shrink-0 -rotate-90" aria-hidden>
      <circle cx="16" cy="16" r={r} fill="none" stroke="var(--border)" strokeWidth="3" />
      <circle cx="16" cy="16" r={r} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${share * c} ${c}`} />
    </svg>
  );
}

/** What it is and where: "Task · Website-Relaunch". */
function useWhat(item: Item) {
  const { t } = useT();
  const ix = useIndex();
  const look = itemLook(item, ix);
  const kind = ["file", "note", "overview", "inbox"].includes(look.label) ? t("kind." + look.label) : look.label;
  const home = ix.get(ix.home(item.id));
  return [kind, home?.title].filter(Boolean).join(" · ");
}

function RecentTile({ item }: { item: Item }) {
  const { t } = useT();
  return (
    <a href={itemHref(item.id)} className="flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3 hover:bg-hover">
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <ItemIcon item={item} size={13} /> <span className="truncate">{useWhat(item)}</span>
      </span>
      <span className="truncate text-[15px] font-semibold">{item.title || item.file?.name || t("untitled")}</span>
      <span className="text-xs text-muted-foreground">
        <RelTime ts={item.updated} />
      </span>
    </a>
  );
}

function RecentRow({ item }: { item: Item }) {
  const { t } = useT();
  return (
    <a href={itemHref(item.id)} className={cx(row, "hover:bg-hover")}>
      <ItemIcon item={item} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px]">{item.title || item.file?.name || t("untitled")}</span>
        <span className="block truncate text-xs text-muted-foreground">{useWhat(item)}</span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        <RelTime ts={item.updated} />
      </span>
    </a>
  );
}
