// One log for all workspaces, with its own workspace choice independent of the sidebar's.
import { useEffect, useState } from "react";
import { spaceCall, useAccounts } from "../accounts";
import { SpaceFilter, SpaceScope, useReplicas } from "../ui/Spaces";
import type { ActivityEvent } from "@obtion/core/protocol";
import { META_TYPE } from "@obtion/core/model";
import { useRepo, useItemHref, useDocumentTitle } from "../hooks";
import { useT, titleOf } from "../i18n";
import { BodyDiff, describe } from "../ui/changes";
import { Button, Empty, Seg } from "../ui/primitives";
import { ItemIcon, RelTime } from "../ui/item-look";
import { cn } from "../lib/utils";
import { byMe, who } from "../ui/actor";

/** Rows fetched per page of the log. */
const PAGE = 60;

function Entry({ e, compact, noVerb, space }: { e: ActivityEvent; compact?: boolean; noVerb?: boolean; space?: string }) {
  const repo = useRepo();
  const itemHref = useItemHref();
  const { t } = useT();
  const ix = repo.index();
  const item = repo.get(e.doc);
  const changes = e.changes.map((c) => describe(c, item, ix, t)).filter(Boolean);
  const verb = t("activity.kind." + e.kind);
  const op = item?.kind === "op" ? item : undefined;
  return (
    <>
      <div className="leading-snug">
        {/* in an undo the head says what happened ("undid"): one verb, not two */}
        {!op && !noVerb && <span className="text-muted-foreground">{e.doc ? verb : ""}</span>}{" "}
        {op ? (
          <span className="font-medium">{op.title}</span>
        ) : item?.kind === "settings" ? (
          <span className="font-medium">{t("activity.workspaceSettings")}</span>
        ) : e.doc && item && (item.kind === "note" || item.kind === "file" || item.kind === "drawing") ? (
          <a href={itemHref(item.id)} className="inline-flex items-center gap-1 font-medium hover:underline">
            <ItemIcon item={item} size={13} />
            {/* a type is named as one: its title alone reads like an entry */}
            {item.type === META_TYPE && <span className="font-normal text-muted-foreground">{t("activity.aType")}</span>}
            {titleOf(item, t)}
          </a>
        ) : (
          <span className="font-medium">{e.title}</span>
        )}
      </div>
      {changes.length > 0 && <div className={cn("text-muted-foreground", compact ? "line-clamp-2 text-xs" : "text-sm")}>{changes.join(" · ")}</div>}
      {space && !compact && e.changes.some((c) => c.field === "body" && c.diff) && <BodyDiff e={e} space={space} />}
    </>
  );
}

function Avatar({ origin }: { origin: string }) {
  const { t } = useT();
  const actor = who(origin, t);
  return (
    <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full", actor.agent ? "text-ok" : "text-muted-foreground")} style={{ background: actor.agent ? "color-mix(in srgb, var(--ok) 14%, transparent)" : "var(--surface-2)" }}>
      <actor.icon size={13} />
    </span>
  );
}

/** A step is one user action or tool call. `space`: its workspace's name, with several. */
function StepGroup({ events, space, spaceId }: { events: ActivityEvent[]; space?: string; spaceId: string }) {
  const { t } = useT();
  const head = events[0]!;
  const actor = who(head.origin, t);
  return (
    <>
      <Avatar origin={head.origin} />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{actor.label}</span>
        {head.undoes && <span className="text-muted-foreground"> {t(head.redo ? "activity.redoStep" : "activity.undoStep")}</span>}
        <ul className={cn("space-y-1", events.length > 1 && "mt-0.5")}>
          {events.map((e) => (
            <li key={e.id}>
              <Entry e={e} noVerb={!!head.undoes} space={spaceId} />
            </li>
          ))}
        </ul>
        <div className="mt-0.5 text-xs text-muted-foreground">
          <RelTime ts={head.ts} />
          {space && ` · ${space}`}
        </div>
      </div>
    </>
  );
}

type Placed = ActivityEvent & { space: string };

/** Consecutive events of the same step (in the same workspace) form one group. */
function groupBySteps(events: Placed[]): Placed[][] {
  const out: Placed[][] = [];
  for (const e of events) {
    const last = out.at(-1)?.[0];
    if (e.step && last && last.step === e.step && last.space === e.space) out.at(-1)!.push(e);
    else out.push([e]);
  }
  return out;
}

interface Fetched {
  events: ActivityEvent[];
  more: boolean;
  error: boolean;
}

export function Activity() {
  const { t } = useT();
  const { account, spaces } = useAccounts();
  const me = account?.user;
  useDocumentTitle(t("nav.activity"));
  // null: all
  const [only, setOnly] = useState<string[] | null>(null);
  const ids = spaces.map((s) => s.id).filter((id) => !only || only.includes(id));
  const repos = useReplicas(ids);
  const [fetched, setFetched] = useState<Record<string, Fetched>>({});
  const [filter, setFilter] = useState<"all" | "agent" | "you">("all");
  const load = (space: string, before?: number) =>
    spaceCall<ActivityEvent[]>(space, `/api/activity?limit=${PAGE}${before ? `&before=${before}` : ""}`).then(
      (list) => setFetched((f) => ({ ...f, [space]: { events: before ? [...(f[space]?.events ?? []), ...list] : list, more: list.length === PAGE, error: false } })),
      // a page that failed is still to fetch: "more" stays and tries the same one again
      () => setFetched((f) => ({ ...f, [space]: { events: f[space]?.events ?? [], more: !!before, error: true } })),
    );
  const online = repos.map((r) => r.status.online).join();
  useEffect(() => {
    for (const id of ids) void load(id);
  }, [ids.join(), online]);
  // per workspace the fetched rows, then the live events that came since
  const logs = ids.map((id, n) => {
    const loaded = fetched[id];
    const events = [...(loaded?.events ?? []), ...repos[n]!.events].filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i);
    return { id, loaded, events };
  });
  // a workspace with more to fetch is complete only down to its oldest row: older rows of the others wait
  const cutoff = Math.max(0, ...logs.filter((l) => l.loaded?.more).map((l) => Math.min(...l.loaded!.events.map((e) => e.ts))));
  const all: Placed[] = logs
    .flatMap((l) => l.events.map((e) => ({ ...e, space: l.id })))
    .filter((e) => e.ts >= cutoff)
    .filter((e) => {
      if (filter === "all") return true;
      const actor = who(e.origin, t);
      return filter === "agent" ? actor.agent : byMe(actor, me);
    })
    .sort((a, b) => b.ts - a.ts || b.id - a.id);
  const nameOf = (id: string) => (spaces.length > 1 ? spaces.find((s) => s.id === id)?.name : undefined);
  const nothing = logs.every((l) => l.loaded?.error && !l.events.length);
  return (
    <div className="page-read">
      <h1 className="page-title">{t("nav.activity")}</h1>
      <p className="mb-5 text-sm text-muted-foreground">{t("activity.intro")}</p>
      {/* one row: which workspaces on the left, who on the right (on a phone below, at the left) */}
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <SpaceFilter className="m-0 min-w-0 px-0 md:m-0" value={only} onChange={setOnly} />
        <div className="sm:ml-auto">
          <Seg label={t("activity.filterLabel")} value={filter} onChange={setFilter} options={(["all", "agent", "you"] as const).map((f) => ({ value: f, label: t("activity.filter." + f) }))} />
        </div>
      </div>
      {nothing ? (
        <Empty title={t("activity.offlineTitle")}>{t("activity.offline")}</Empty>
      ) : (
        <ul className="space-y-4">
          {groupBySteps(all).map((g) => (
            <li key={`${g[0]!.space}:${g[0]!.id}`} className="flex gap-2.5 text-[15px]">
              <SpaceScope id={g[0]!.space}>
                <StepGroup events={g} space={nameOf(g[0]!.space)} spaceId={g[0]!.space} />
              </SpaceScope>
            </li>
          ))}
        </ul>
      )}
      {logs.some((l) => l.loaded?.more) && (
        <Button variant="plain" onClick={() => logs.forEach((l) => l.loaded?.more && void load(l.id, Math.min(...l.loaded.events.map((e) => e.id))))} className="mt-6 text-sm text-muted-foreground hover:text-fg">
          {t("activity.more")}
        </Button>
      )}
    </div>
  );
}
