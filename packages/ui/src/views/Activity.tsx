// Activity: a log of every change with who made it (a person, an agent working for one, an
// import), bulk operations like deleting a type included. One page for the workspaces seen,
// chosen like in the inbox.
import { useEffect, useState } from "react";
import { spaceCall, useAccounts } from "../accounts";
import { SpaceFilter, SpaceScope, useReplicas } from "../ui/Spaces";
import type { ActivityEvent, FieldChange } from "@obtion/core/protocol";
import { type Item, META_TYPE, optionNames, type Value } from "@obtion/core/model";
import type { Index } from "@obtion/core/graph";
import { useRepo, itemHref, useDocumentTitle } from "../hooks";
import { useT, titleOf } from "../i18n";
import type { T } from "@obtion/core/i18n";
import { Button, Empty, Seg } from "../ui/primitives";
import { ItemIcon, RelTime } from "../ui/item-look";
import { cn } from "../lib/utils";
import { byMe, who } from "../ui/actor";

function propName(ix: Index, item: Item | undefined, id: string) {
  const s = ix.schemaOf(item);
  return s?.properties.find((p) => p.id === id) ?? s?.removedProperties.find((p) => p.id === id);
}

function describe(c: FieldChange, item: Item | undefined, ix: Index, t: T): string {
  const title = (id: string) => ix.get(id)?.title ?? ix.all.get(id)?.title ?? "?";
  const list = (x: unknown) => ((x as string[]) ?? []).map(title).join(", ");
  const added = (c.to as string[]) ?? [];
  const removed = (c.from as string[]) ?? [];
  if (c.field.startsWith("p:")) {
    const p = propName(ix, item, c.field.slice(2));
    const v = (x: unknown) => {
      if (x === undefined || x === null || x === "") return "–";
      if (p?.options) return optionNames(p, x as Value).join(", ");
      return String(x);
    };
    return `${p?.name ?? c.field.slice(2)}: ${v(c.from)} → ${v(c.to)}`;
  }
  if (c.field.startsWith("x:")) return `${c.field.slice(2)}: ${c.from ?? "–"} → ${c.to ?? "–"}`;
  if (c.field.startsWith("r:")) {
    const p = propName(ix, item, c.field.slice(2));
    return [added.length && `${p?.name ?? "?"} +${list(added)}`, removed.length && `${p?.name ?? "?"} −${list(removed)}`].filter(Boolean).join(", ");
  }
  switch (c.field) {
    case "body":
      return t("activity.editedText");
    case "update":
      return t("activity.update", { text: String(c.to).slice(0, 140) });
    case "tags":
      return [added.length && t("activity.tagged", { tags: added.map((x) => "#" + x).join(" ") }), removed.length && t("activity.untagged", { tags: removed.map((x) => "#" + x).join(" ") })].filter(Boolean).join(", ");
    case "refs":
      return [added.length && `${t("item.refs")} +${list(added)}`, removed.length && `${t("item.refs")} −${list(removed)}`].filter(Boolean).join(", ");
    case "parents":
      return [added.length && t("activity.placed", { list: list(added) }), removed.length && t("activity.unplaced", { list: list(removed) })].filter(Boolean).join(", ");
    case "type":
      return c.to ? t("activity.typed", { name: ix.typeName(String(c.to)) ?? "?" }) : t("activity.untyped");
    case "home":
      return t("activity.home", { title: c.to ? title(String(c.to)) : "–" });
    case "title":
      return c.from ? t("activity.renamed", { from: String(c.from) }) : t("activity.named");
    case "views":
      return t("activity.views");
    case "schema":
      return t("activity.schema");
    case "file":
      return t("activity.fileReplaced");
    case "suggestion":
      return c.to ? t("activity.suggested") : t("activity.suggestionDone");
    case "op":
      return c.to === "undone" ? t("activity.undone") : "";
    default:
      return c.field;
  }
}

/** What happened to one item: verb, item, changes. */
function Entry({ e, compact, noVerb }: { e: ActivityEvent; compact?: boolean; noVerb?: boolean }) {
  const r = useRepo();
  const { t } = useT();
  const ix = r.index();
  const item = r.get(e.doc);
  const changes = e.changes.map((c) => describe(c, item, ix, t)).filter(Boolean);
  const verb = t("activity.kind." + e.kind);
  const op = item?.kind === "op" ? item : undefined;
  return (
    <>
      <div className="leading-snug">
        {/* in an undo the head says what happened ("hat rückgängig gemacht"): one verb, not two */}
        {!op && !noVerb && <span className="text-muted-foreground">{e.doc ? verb : ""}</span>}{" "}
        {op ? (
          <span className="font-medium">{op.title}</span>
        ) : e.doc && item && (item.kind === "info" || item.kind === "datei") ? (
          <a href={itemHref(item.id)} className="inline-flex items-center gap-1 font-medium hover:underline">
            <ItemIcon item={item} size={13} />
            {/* a type is named as one: its title alone reads like an entry */}
            {item.type === META_TYPE && <span className="font-normal text-muted-foreground">{t("activity.aType")}</span>}
            {titleOf(item, t)}
          </a>
        ) : (
          <span className="font-medium">{systemText(e.title, t)}</span>
        )}
      </div>
      {changes.length > 0 && <div className={cn("text-muted-foreground", compact ? "line-clamp-2 text-xs" : "text-sm")}>{changes.join(" · ")}</div>}
    </>
  );
}

function Avatar({ origin }: { origin: string }) {
  const { t } = useT();
  const w = who(origin, t);
  return (
    <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full", w.agent ? "text-ok" : "text-muted-foreground")} style={{ background: w.agent ? "color-mix(in srgb, var(--ok) 14%, transparent)" : "var(--surface-2)" }}>
      <w.icon size={13} />
    </span>
  );
}

/** Server messages are stored in English (data); shown in the app's language when we know them. */
const SYSTEM_TEXTS: [RegExp, string][] = [
  [/^Imported (\d+) notes from Obsidian$/, "activity.sys.obsidian"],
  [/^Imported (\d+) projects and tasks from Notion$/, "activity.sys.notion"],
  [/^Migrated (\d+) items to the new model$/, "activity.sys.migrated"],
];
function systemText(text: string, t: T): string {
  for (const [re, key] of SYSTEM_TEXTS) {
    const m = re.exec(text);
    if (m) return t(key, { count: Number(m[1]) });
  }
  return text;
}

/** Everything one step did (one user action or tool call), as one entry of the log; `space`: its workspace's name, with several. */
function StepGroup({ events, space }: { events: ActivityEvent[]; space?: string }) {
  const { t } = useT();
  const head = events[0]!;
  const w = who(head.origin, t);
  return (
    <>
      <Avatar origin={head.origin} />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{w.label}</span>
        {head.undoes && <span className="text-muted-foreground"> {t(head.redo ? "activity.redoStep" : "activity.undoStep")}</span>}
        <ul className={cn("space-y-1", events.length > 1 && "mt-0.5")}>
          {events.map((e) => (
            <li key={e.id}>
              <Entry e={e} noVerb={!!head.undoes} />
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

/** An event with the workspace it happened in. */
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

/** What is fetched of one workspace's log: the newest first, page by page. */
interface Fetched {
  events: ActivityEvent[];
  more: boolean;
  error: boolean;
}

/** The log of the workspaces seen, newest first. */
export function Activity() {
  const { t } = useT();
  const { account, spaces, shown } = useAccounts();
  const me = account?.user;
  useDocumentTitle(t("nav.activity"));
  const ids = shown.map((s) => s.id);
  const repos = useReplicas(ids);
  const [fetched, setFetched] = useState<Record<string, Fetched>>({});
  const [filter, setFilter] = useState<"all" | "agent" | "you">("all");
  const load = (space: string, before?: number) =>
    spaceCall<ActivityEvent[]>(space, `/api/activity?limit=60${before ? `&before=${before}` : ""}`).then(
      (list) => setFetched((f) => ({ ...f, [space]: { events: before ? [...(f[space]?.events ?? []), ...list] : list, more: list.length === 60, error: false } })),
      () => setFetched((f) => ({ ...f, [space]: { events: f[space]?.events ?? [], more: false, error: true } })),
    );
  const online = repos.map((r) => r.status.online).join();
  useEffect(() => {
    for (const id of ids) void load(id);
  }, [ids.join(), online]);
  // per workspace the fetched rows, then the live events that came since
  const logs = ids.map((id, n) => {
    const f = fetched[id];
    const events = [...(f?.events ?? []), ...repos[n]!.events].filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i);
    return { id, f, events };
  });
  // a workspace with more to fetch is complete only down to its oldest row: older rows of the others wait
  const cutoff = Math.max(0, ...logs.filter((l) => l.f?.more).map((l) => Math.min(...l.f!.events.map((e) => e.ts))));
  const all: Placed[] = logs
    .flatMap((l) => l.events.map((e) => ({ ...e, space: l.id })))
    .filter((e) => e.ts >= cutoff)
    .filter((e) => {
      if (filter === "all") return true;
      const w = who(e.origin, t);
      return filter === "agent" ? w.agent : byMe(w, me);
    })
    .sort((a, b) => b.ts - a.ts || b.id - a.id);
  const nameOf = (id: string) => (spaces.length > 1 ? spaces.find((s) => s.id === id)?.name : undefined);
  const nothing = logs.every((l) => l.f?.error && !l.events.length);
  return (
    <div className="page-read">
      <h1 className="page-title">{t("nav.activity")}</h1>
      <p className="mb-5 text-sm text-muted-foreground">{t("activity.intro")}</p>
      <SpaceFilter />
      <div className="mb-5">
        <Seg label={t("activity.filterLabel")} value={filter} onChange={setFilter} options={(["all", "agent", "you"] as const).map((f) => ({ value: f, label: t("activity.filter." + f) }))} />
      </div>
      {nothing ? (
        <Empty title={t("activity.offlineTitle")}>{t("activity.offline")}</Empty>
      ) : (
        <ul className="space-y-4">
          {groupBySteps(all).map((g) => (
            <li key={`${g[0]!.space}:${g[0]!.id}`} className="flex gap-2.5 text-[15px]">
              <SpaceScope id={g[0]!.space}>
                <StepGroup events={g} space={nameOf(g[0]!.space)} />
              </SpaceScope>
            </li>
          ))}
        </ul>
      )}
      {logs.some((l) => l.f?.more) && (
        <Button variant="plain" onClick={() => logs.forEach((l) => l.f?.more && void load(l.id, Math.min(...l.f.events.map((e) => e.id))))} className="mt-6 text-sm text-muted-foreground hover:text-fg">
          {t("activity.more")}
        </Button>
      )}
    </div>
  );
}
