// "Heute", the start page, across every workspace seen. Empty sections are left out.
import { Sun } from "lucide-react";
import { type Item, SETTINGS_ID, todayISO } from "@obtion/core/model";
import { fmtDate } from "@obtion/core/i18n";
import { activeProjects, dueBy, recentlyChanged } from "@obtion/core/today";
import { useDesktop, useIndex, useItemHref, useDocumentTitle } from "../hooks";
import { useAccounts } from "../accounts";
import { useT, titleOf } from "../i18n";
import { Card, SectionTitle } from "../ui/primitives";
import { DueLabel, ItemIcon, RelTime, itemLook, kindLabel, pal } from "../ui/item-look";
import { cn } from "../lib/utils";
import { RowStatus } from "../ui/Row";
import { SpaceScope, useReplicas } from "../ui/Spaces";
import { openShelf, useInboxItems, useShelfPinned } from "../ui/inbox";
import { ShelfCards } from "../ui/Shelf";
import { cmpKey } from "@obtion/core/sortkey";

/** Entries each section shows at most. */
const RECENT = 4;
const PROJECTS = 5;

/** Which greeting fits the hour: night counts as evening. */
function dayPart(hour: number): "morning" | "day" | "evening" {
  if (hour < 5) return "evening";
  if (hour < 11) return "morning";
  return hour < 18 ? "day" : "evening";
}

interface Of<T> {
  space: string;
  value: T;
}

export function Today() {
  const { t, lang } = useT();
  const desktop = useDesktop();
  const { shown, account } = useAccounts();
  const repos = useReplicas(shown.map((s) => s.id));
  const entries = useInboxItems();
  const inbox = entries.length;
  const pinned = useShelfPinned();
  const today = todayISO();
  useDocumentTitle(t("nav.today"));
  // each workspace's part, then one list of all
  const perSpace = shown.map((s, n) => ({ space: s.id, ix: repos[n]!.get(SETTINGS_ID) ? repos[n]!.index() : undefined }));
  const all = <T,>(list: (ix: NonNullable<(typeof perSpace)[number]["ix"]>) => T[]): Of<T>[] => perSpace.flatMap((p) => (p.ix ? list(p.ix).map((value) => ({ space: p.space, value })) : []));
  const due = all((ix) => dueBy(ix, today)).sort((a, b) => cmpKey(a.value.due, b.value.due));
  const projects = all((ix) => activeProjects(ix)).sort((a, b) => b.value.touched - a.value.touched);
  const recent = all((ix) => recentlyChanged(ix, RECENT)).sort((a, b) => b.value.updated - a.value.updated).slice(0, RECENT);
  const several = shown.length > 1;
  const nameOf = (space: string) => (several ? shown.find((s) => s.id === space)?.name : undefined);

  const part = dayPart(new Date().getHours());
  const name = account?.user.name.trim().split(/\s+/)[0];
  // the inbox count, amber as the tray, opens the tray's panel – pinned open below it is there already,
  // the count is no link then: the sentence around it comes in two parts
  const [before, after] = t("today.inbox", { count: inbox, n: "\u0000" }).split("\u0000");
  return (
    // on a desktop the open panel follows right below
    <div className="page-wide" style={desktop ? { paddingBottom: 24 } : undefined}>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Sun size={15} /> {fmtDate(lang, today, { weekday: "long", day: "numeric", month: "long" })}
      </p>
      <h1 className="mt-2 text-[34px] font-bold leading-[40px] tracking-[-0.02em] max-lg:text-[28px] max-lg:leading-[34px]">{name ? t(`today.greet.${part}`, { name }) : t(`today.greet.${part}Plain`)}</h1>
      <p className="mt-2 text-[15px] leading-6 text-muted-foreground">
        {t("today.due", { count: due.length })} {projects.length > 0 && t("today.projects", { count: projects.length })}{" "}
        {inbox ? (
          <>
            {before}
            {pinned ? (
              <span className="font-medium text-warn">{t("today.entries", { count: inbox })}</span>
            ) : (
              <a href="#/inbox" onClick={(e) => (e.preventDefault(), openShelf())} className="font-medium text-warn hover:underline">
                {t("today.entries", { count: inbox })}
              </a>
            )}
            {after}
          </>
        ) : (
          t("today.inboxEmpty")
        )}
      </p>
      {/* the panel not pinned below (too little room): the newest entries, a way into it */}
      {desktop && !pinned && inbox > 0 && <ShelfCards entries={entries} />}

      <div className={cn("mt-9 grid items-start gap-x-8 gap-y-9", due.length > 0 && projects.length > 0 && "lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]")}>
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
              {projects.slice(0, PROJECTS).map(({ space, value }) => (
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
            <div className="grid grid-cols-4 gap-3">
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
    </div>
  );
}

const row = "flex min-h-12 items-center gap-3 border-b border-line px-4 py-2 last:border-b-0";

function DueRow({ item, due, space }: { item: Item; due: string; space?: string }) {
  const { t } = useT();
  const hrefOf = useItemHref();
  const ix = useIndex();
  const project = ix.get(ix.project(item.id));
  const where = [project?.title, space].filter(Boolean).join(" · ");
  return (
    <div className={row}>
      <RowStatus item={item} />
      <a href={hrefOf(item.id)} className="flex min-w-0 flex-1 flex-col hover:underline lg:flex-row lg:items-baseline lg:gap-3">
        <span className="truncate text-[15px]">{titleOf(item, t)}</span>
        {where && <span className="truncate text-xs text-muted-foreground lg:ml-auto">{where}</span>}
      </a>
      <DueLabel due={due} />
    </div>
  );
}

/** The progress ring shows only when there are entries to count. */
function ProjectRow({ item, touched, space }: { item: Item; touched: number; space?: string }) {
  const { t, lang } = useT();
  const hrefOf = useItemHref();
  const ix = useIndex();
  const progress = ix.progressOf(item);
  const counted = progress && progress.total > 0 ? progress : undefined;
  const color = pal(ix.schemaOf(item)?.color);
  return (
    <a href={hrefOf(item.id)} className={cn(row, "hover:bg-hover")}>
      {counted ? <Ring share={counted.done / counted.total} color={color} /> : <span className="flex size-8 shrink-0 items-center justify-center"><ItemIcon item={item} /></span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium">{titleOf(item, t)}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {counted && <>{t("today.open", { count: counted.total - counted.done })} · </>}
          {t("today.touched")} <RelTime ts={touched} />
          {space && <> · {space}</>}
        </span>
      </span>
      {counted && <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">{new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 }).format(counted.done / counted.total)}</span>}
    </a>
  );
}

function Ring({ share, color }: { share: number; color: string }) {
  const radius = 13;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" className="shrink-0 -rotate-90" aria-hidden>
      <circle cx="16" cy="16" r={radius} fill="none" stroke="var(--border)" strokeWidth="3" />
      <circle cx="16" cy="16" r={radius} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${share * circumference} ${circumference}`} />
    </svg>
  );
}

/** "Task · Website-Relaunch". */
function useWhat(item: Item) {
  const { t } = useT();
  const ix = useIndex();
  const kind = kindLabel(itemLook(item, ix), t);
  const home = ix.get(ix.home(item.id));
  return [kind, home?.title].filter(Boolean).join(" · ");
}

function RecentTile({ item }: { item: Item }) {
  const { t } = useT();
  const hrefOf = useItemHref();
  return (
    <a href={hrefOf(item.id)} className="flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3 hover:bg-hover">
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <ItemIcon item={item} size={13} /> <span className="truncate">{useWhat(item)}</span>
      </span>
      <span className="truncate text-[15px] font-semibold">{titleOf(item, t)}</span>
      <span className="text-xs text-muted-foreground">
        <RelTime ts={item.updated} />
      </span>
    </a>
  );
}

function RecentRow({ item }: { item: Item }) {
  const { t } = useT();
  const hrefOf = useItemHref();
  return (
    <a href={hrefOf(item.id)} className={cn(row, "hover:bg-hover")}>
      <ItemIcon item={item} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px]">{titleOf(item, t)}</span>
        <span className="block truncate text-xs text-muted-foreground">{useWhat(item)}</span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        <RelTime ts={item.updated} />
      </span>
    </a>
  );
}
