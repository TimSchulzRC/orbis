// Activity: a log of every change with who made it (a person, an agent working for one, an
// import), bulk operations like deleting a type included.
import { useEffect, useState } from "react";
import { spaceCall, useAccounts } from "../accounts";
import { SpaceEyebrow } from "../ui/Spaces";
import type { ActivityEvent, FieldChange } from "@obtion/core/protocol";
import { type Item, META_TYPE, optionNames, type Value } from "@obtion/core/model";
import type { Index } from "@obtion/core/graph";
import { useRepo, useSpaceId, itemHref, useDocumentTitle } from "../hooks";
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

/** Everything one step did (one user action or tool call), as one entry of the log. */
function StepGroup({ events }: { events: ActivityEvent[] }) {
  const { t } = useT();
  const head = events[0]!;
  const w = who(head.origin, t);
  return (
    <li className="flex gap-2.5 text-[15px]">
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
        </div>
      </div>
    </li>
  );
}

/** Consecutive events of the same step form one group. */
function groupBySteps(events: ActivityEvent[]): ActivityEvent[][] {
  const out: ActivityEvent[][] = [];
  for (const e of events) {
    const last = out.at(-1);
    if (e.step && last && last[0]!.step === e.step) last.push(e);
    else out.push([e]);
  }
  return out;
}

export function Activity() {
  const r = useRepo();
  const space = useSpaceId()!;
  const { t } = useT();
  const me = useAccounts().account?.user;
  useDocumentTitle(t("nav.activity"));
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [filter, setFilter] = useState<"all" | "agent" | "you">("all");
  const [more, setMore] = useState(true);
  const [error, setError] = useState(false);
  const load = (before?: number) =>
    spaceCall<ActivityEvent[]>(space, `/api/activity?limit=60${before ? `&before=${before}` : ""}`)
      .then((list) => {
        setEvents((ev) => (before ? [...ev, ...list] : list));
        setMore(list.length === 60);
        setError(false);
      })
      .catch(() => setError(true));
  useEffect(() => {
    load();
  }, [r.status.online]);
  // fetched rows, then the live events that came since
  const merged = [...events, ...r.events].filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i).sort((a, b) => b.id - a.id);
  const shown = merged.filter((e) => {
    if (filter === "all") return true;
    const w = who(e.origin, t);
    return filter === "agent" ? w.agent : byMe(w, me);
  });
  return (
    <div className="page-read">
      <SpaceEyebrow />
      <h1 className="page-title">{t("nav.activity")}</h1>
      <p className="mb-5 text-sm text-muted-foreground">{t("activity.intro")}</p>
      <div className="mb-5">
        <Seg label={t("activity.filterLabel")} value={filter} onChange={setFilter} options={(["all", "agent", "you"] as const).map((f) => ({ value: f, label: t("activity.filter." + f) }))} />
      </div>
      {error && !events.length ? (
        <Empty title={t("activity.offlineTitle")}>{t("activity.offline")}</Empty>
      ) : (
        <ul className="space-y-4">
          {groupBySteps(shown).map((g) => (
            <StepGroup key={g[0]!.id} events={g} />
          ))}
        </ul>
      )}
      {more && events.length > 0 && (
        <Button variant="plain" onClick={() => load(events.at(-1)!.id)} className="mt-6 text-sm text-muted-foreground hover:text-fg">
          {t("activity.more")}
        </Button>
      )}
    </div>
  );
}
