// Activity: every change with its origin (which device, which agent, import). Bulk
// operations like deleting a type are listed here and can be undone.
import { useEffect, useState } from "react";
import { Sparkles, User, Download, Bot, Cog, Undo2, Redo2 } from "lucide-react";
import type { ActivityEvent, FieldChange } from "../../shared/protocol";
import { type Item, META_TYPE } from "../../shared/model";
import type { Index } from "../../shared/graph";
import { undoOp } from "../../shared/typeops";
import { useRepo, itemHref } from "../hooks";
import { repo } from "../repo";
import { useT } from "../i18n";
import type { T } from "../../shared/i18n";
import { Button, Empty, ItemIcon, RelTime, cx, Seg } from "../ui/bits";
import { agentLabel } from "../ui/AgentNotice";

function who(origin: string, t: T) {
  const first = origin.split(",")[0]!.trim();
  if (first.startsWith("agent:")) {
    const name = first.slice(6);
    return { label: agentLabel(name, t), icon: name === "chat" ? Sparkles : Bot, agent: true };
  }
  if (first.startsWith("import:")) return { label: t("activity.import", { name: first.slice(7) }), icon: Download, agent: false };
  if (first.startsWith("system:")) return { label: t("activity.system"), icon: Cog, agent: false };
  if (first.startsWith("web:")) {
    const dev = first.split("@")[1];
    return { label: dev ? t("activity.youOn", { device: dev.split("-")[0] }) : t("activity.you"), icon: User, agent: false };
  }
  return { label: first, icon: User, agent: false };
}

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
      if (p?.options) return (Array.isArray(x) ? x : [x]).map((id) => p.options!.find((o) => o.id === id)?.name ?? String(id)).join(", ");
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
        {!op && !noVerb && <span className="text-muted">{e.doc ? verb : ""}</span>}{" "}
        {op ? (
          <span className="font-medium">{op.title}</span>
        ) : e.doc && item && (item.kind === "info" || item.kind === "datei") ? (
          <a href={itemHref(item.id)} className="inline-flex items-center gap-1 font-medium hover:underline">
            <ItemIcon item={item} size={13} />
            {/* a type is named as one: its title alone reads like an entry */}
            {item.type === META_TYPE && <span className="font-normal text-muted">{t("activity.aType")}</span>}
            {item.title || t("untitled")}
          </a>
        ) : (
          <span className="font-medium">{systemText(e.title, t)}</span>
        )}
      </div>
      {changes.length > 0 && <div className={cx("text-muted", compact ? "line-clamp-2 text-xs" : "text-sm")}>{changes.join(" · ")}</div>}
    </>
  );
}

function Avatar({ origin }: { origin: string }) {
  const { t } = useT();
  const w = who(origin, t);
  return (
    <span className={cx("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full", w.agent ? "text-ok" : "text-muted")} style={{ background: w.agent ? "color-mix(in srgb, var(--ok) 14%, transparent)" : "var(--surface-2)" }}>
      <w.icon size={13} />
    </span>
  );
}

/** One event on its own (the history on an item page). */
/** Hub messages are stored in English (data); shown in the app's language when we know them. */
const SYSTEM_TEXTS: [RegExp, string][] = [
  [/^Imported (\d+) notes from Obsidian$/, "activity.sys.obsidian"],
  [/^Imported (\d+) projects and tasks from Notion$/, "activity.sys.notion"],
  [/^Migrated (\d+) items to the new model$/, "activity.sys.migrated"],
];
function systemText(text: string, t: (k: string, v?: Record<string, unknown>) => string): string {
  for (const [re, key] of SYSTEM_TEXTS) {
    const m = re.exec(text);
    if (m) return t(key, { count: Number(m[1]) });
  }
  return text;
}

export function ActivityItem({ e, compact }: { e: ActivityEvent; compact?: boolean }) {
  const r = useRepo();
  const { t } = useT();
  const w = who(e.origin, t);
  const item = r.get(e.doc);
  const op = item?.kind === "op" ? item : undefined;
  return (
    <li className={cx("flex gap-2.5", compact ? "text-sm" : "text-[15px]")}>
      <Avatar origin={e.origin} />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{w.label}</span>
        <Entry e={e} compact={compact} />
        <div className="flex items-center gap-2 text-xs text-muted">
          <RelTime ts={e.ts} />
          {!e.step && op && !op.op?.undone && e.kind === "created" && (
            <Button className="!px-1.5 !py-0.5 text-xs" onClick={() => undoOp(repo.writer, op)}>
              <Undo2 size={12} /> {t("activity.undo")}
            </Button>
          )}
          {!e.step && op?.op?.undone && e.kind === "created" && <span>· {t("activity.undone")}</span>}
        </div>
      </div>
    </li>
  );
}

/** Everything one step did (one user action or tool call), with one "Rückgängig" for all of it. */
function StepGroup({ events, onChanged }: { events: ActivityEvent[]; onChanged: () => void }) {
  const r = useRepo();
  const { t } = useT();
  const head = events[0]!;
  const w = who(head.origin, t);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const undone = events.some((e) => e.undone);
  // a delete whose entries are back already (restored from the trash): nothing left to take back
  const restored = !undone && events.every((e) => e.kind === "deleted") && events.every((e) => r.get(e.doc) && !r.get(e.doc)!.deleted);
  const run = async () => {
    setBusy(true);
    const res = await r.undo(head.step!, undone);
    setBusy(false);
    if (!res.ok) setNote(t("activity.undoFailed", { error: res.error }));
    else {
      setNote(res.kept ? t("activity.undoKept", { count: res.kept }) : null);
      onChanged();
    }
  };
  return (
    <li className="flex gap-2.5 text-[15px]">
      <Avatar origin={head.origin} />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{w.label}</span>
        {head.undoes && <span className="text-muted"> {t(head.redo ? "activity.redoStep" : "activity.undoStep")}</span>}
        <ul className={cx("space-y-1", events.length > 1 && "mt-0.5")}>
          {events.map((e) => (
            <li key={e.id}>
              <Entry e={e} noVerb={!!head.undoes} />
            </li>
          ))}
        </ul>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
          <RelTime ts={head.ts} />
          {head.step && !head.undoes && restored && <span>· {t("activity.restoredSince")}</span>}
          {head.step && !head.undoes && !restored && (
            <>
              {undone && <span>· {t("activity.stepUndone")}</span>}
              <Button className="!px-1.5 !py-0.5 text-xs" disabled={busy || !r.status.online} onClick={run}>
                {undone ? <Redo2 size={12} /> : <Undo2 size={12} />} {undone ? t("activity.redo") : t("activity.undo")}
              </Button>
            </>
          )}
          {note && <span className="text-muted">{note}</span>}
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
  const { t } = useT();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [filter, setFilter] = useState<"all" | "agent" | "you">("all");
  const [more, setMore] = useState(true);
  const [error, setError] = useState(false);
  const load = (before?: number) =>
    fetch(`/api/activity?limit=60${before ? `&before=${before}` : ""}`)
      .then((res) => res.json())
      .then((list: ActivityEvent[]) => {
        setEvents((ev) => (before ? [...ev, ...list] : list));
        setMore(list.length === 60);
        setError(false);
      })
      .catch(() => setError(true));
  useEffect(() => {
    load();
  }, [r.status.online]);
  // fetched rows know whether a step is undone; live events fill in what came since
  const merged = [...events, ...r.events].filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i).sort((a, b) => b.id - a.id);
  const shown = merged.filter((e) => filter === "all" || (filter === "agent" ? e.origin.includes("agent:") : e.origin.includes("web:")));
  return (
    <div className="page-read">
      <h1 className="page-title">{t("nav.activity")}</h1>
      <p className="mb-5 text-sm text-muted">{t("activity.intro")}</p>
      <div className="mb-5">
        <Seg label={t("activity.filterLabel")} value={filter} onChange={setFilter} options={(["all", "agent", "you"] as const).map((f) => ({ value: f, label: t("activity.filter." + f) }))} />
      </div>
      {error && !events.length ? (
        <Empty title={t("activity.offlineTitle")}>{t("activity.offline")}</Empty>
      ) : (
        <ul className="space-y-4">
          {groupBySteps(shown).map((g) => (
            <StepGroup key={g[0]!.id} events={g} onChanged={() => load()} />
          ))}
        </ul>
      )}
      {more && events.length > 0 && (
        <button onClick={() => load(events.at(-1)!.id)} className="mt-6 text-sm text-muted hover:text-fg">
          {t("activity.more")}
        </button>
      )}
    </div>
  );
}
