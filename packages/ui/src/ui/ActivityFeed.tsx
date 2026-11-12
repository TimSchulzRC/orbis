// The rows of the activity log, grouped by step: the activity page shows them for all pages, the
// "Verlauf" tab of the side panel for one page.
import type { ActivityEvent } from "@obtion/core/protocol";
import { META_TYPE, replaceBody, touch } from "@obtion/core/model";
import { useRepo, useItemHref } from "../hooks";
import { useT, titleOf } from "../i18n";
import { BodyDiff, describe } from "./changes";
import { ItemIcon, RelTime } from "./item-look";
import { notify } from "./toasts";
import { cn } from "../lib/utils";
import { who } from "./actor";

/**
 * One entry. `here`: the page the list is about; its own entries name no page, and a text change
 * there can be taken back to the text before it.
 */
function Entry({ e, noVerb, space, here }: { e: ActivityEvent; noVerb?: boolean; space?: string; here?: string }) {
  const repo = useRepo();
  const itemHref = useItemHref();
  const { t } = useT();
  const ix = repo.index();
  const item = repo.get(e.doc);
  const changes = e.changes.map((c) => describe(c, item, ix, t)).filter(Boolean);
  const verb = t("activity.kind." + e.kind);
  const op = item?.kind === "op" ? item : undefined;
  const own = !!here && e.doc === here;
  // as a change of its own step, so its toast can take it back again
  const restore = (text: string) => {
    const step = repo.ownStep(() => repo.change(e.doc, (d) => (replaceBody(d, text), touch(d))));
    if (step) notify.undo(t("history.restored"), () => void repo.undo(step));
  };
  return (
    <>
      <div className="leading-snug">
        {/* in an undo the head says what happened ("undid"): one verb, not two */}
        {!op && !noVerb && <span className="text-muted-foreground">{e.doc ? verb : ""}</span>}{" "}
        {own ? null : op ? (
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
      {changes.length > 0 && <div className="text-sm text-muted-foreground">{changes.join(" · ")}</div>}
      {space && e.changes.some((c) => c.field === "body" && c.diff) && <BodyDiff e={e} space={space} onRestore={own && item && !item.deleted ? restore : undefined} current={item?.body} />}
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

/** A step is one user action or tool call. `spaceName`: its workspace's name, with several. */
export function StepGroup({ events, spaceName, space, here }: { events: ActivityEvent[]; spaceName?: string; space?: string; here?: string }) {
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
              <Entry e={e} noVerb={!!head.undoes} space={space} here={here} />
            </li>
          ))}
        </ul>
        <div className="mt-0.5 text-xs text-muted-foreground">
          <RelTime ts={head.ts} />
          {spaceName && ` · ${spaceName}`}
        </div>
      </div>
    </>
  );
}

/**
 * The fetched entries and the live ones that came since, each once. The server folds edits into
 * one entry: of two copies the later one counts, at the same time the server's answer. An entry
 * folded down to no change at all (typed, then taken back) is left out.
 */
export function mergeEvents(fetched: ActivityEvent[], live: ActivityEvent[]): ActivityEvent[] {
  const byId = new Map<number, ActivityEvent>();
  for (const e of [...fetched, ...live]) if (e.ts > (byId.get(e.id)?.ts ?? -1)) byId.set(e.id, e);
  return [...byId.values()].filter((e) => e.kind !== "updated" || e.changes.length > 0);
}

/** Consecutive events of the same step (in the same workspace) form one group. */
export function groupBySteps<E extends ActivityEvent & { space?: string }>(events: E[]): E[][] {
  const out: E[][] = [];
  for (const e of events) {
    const last = out.at(-1)?.[0];
    if (e.step && last && last.step === e.step && last.space === e.space) out.at(-1)!.push(e);
    else out.push([e]);
  }
  return out;
}
