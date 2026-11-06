// "Änderungen" in the updates panel: every change to this one page from the server's activity log
// (its text, properties, updates, when it was made), by day like the updates beside it. The rows say
// what changed, not which page: that is the page beside the panel.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Bot } from "lucide-react";
import type { ActivityEvent } from "@obtion/core/protocol";
import type { Item } from "@obtion/core/model";
import { dateOf } from "@obtion/core/date";
import { fmtTime } from "@obtion/core/i18n";
import type { T } from "@obtion/core/i18n";
import { parseOrigin } from "@obtion/core/origin";
import { spaceCall, useAccounts } from "../accounts";
import { useRepo } from "../hooks";
import { useT } from "../i18n";
import { byMe, who } from "./actor";
import { agentLabel } from "./AgentNotice";
import { BodyDiff, DayList, describe, META } from "./changes";
import { Button } from "./primitives";

/** Rows fetched at a time. */
const PAGE = 50;

/** `failed`: the request that failed, to ask again (from the top, or below an id). */
type Got = { key: string; events: ActivityEvent[]; more: boolean; error: boolean; busy: boolean; failed?: { before?: number } };

/** The newest rows of the last pages seen: switching back shows them at once. */
const firstPages = new Map<string, ActivityEvent[]>();
const KEEP = 20;

function remember(key: string, list: ActivityEvent[]) {
  firstPages.delete(key);
  firstPages.set(key, list);
  if (firstPages.size > KEEP) firstPages.delete(firstPages.keys().next().value!);
}

const start = (key: string): Got => {
  const cached = firstPages.get(key);
  return { key, events: cached ?? [], more: cached?.length === PAGE, error: false, busy: !cached };
};

/** Named as in the updates beside it: "Du", the agent's name, else the person. */
function actorName(origin: string, me: Parameters<typeof byMe>[1], t: T): { name: string; agent: boolean } {
  const a = who(origin, t);
  if (a.agent) return { name: agentLabel(parseOrigin(origin).name, t), agent: true };
  return { name: byMe(a, me) ? t("updates.you") : a.label, agent: false };
}

/** Consecutive events of one step (one action, one tool call) on one day are one row. */
function bySteps(events: ActivityEvent[]): ActivityEvent[][] {
  const out: ActivityEvent[][] = [];
  for (const e of events) {
    const last = out.at(-1)?.[0];
    if (e.step && last?.step === e.step && dateOf(last.ts) === dateOf(e.ts)) out.at(-1)!.push(e);
    else out.push([e]);
  }
  return out;
}

/** `space`: the workspace on the server. `onUpdate`: show an update in the updates view. */
export function PageChanges({ item, space, onUpdate }: { item: Item; space: string; onUpdate: (id: string) => void }) {
  const { t, lang } = useT();
  const r = useRepo();
  const me = useAccounts().account?.user;
  const ix = r.index();
  // whose log: another account on this device never sees the rows kept for this one
  const key = `${me?.id}/${space}/${item.id}`;
  const [got, setGot] = useState<Got>(() => start(key));
  // only the latest request counts: an answer for the page before, or an older one, is dropped
  const asked = useRef(0);

  const load = (before?: number) => {
    const n = ++asked.current;
    setGot((g) => ({ ...(g.key === key ? g : start(key)), busy: true, error: false }));
    spaceCall<ActivityEvent[]>(space, `/api/activity?doc=${encodeURIComponent(item.id)}&limit=${PAGE}${before ? `&before=${before}` : ""}`).then(
      (list) => {
        if (n !== asked.current) return;
        if (!before) remember(key, list);
        setGot((g) => {
          const kept = g.key === key ? g.events : [];
          if (before) return { key, events: [...kept, ...list], more: list.length === PAGE, error: false, busy: false };
          // fetched from the top again (back online): the rows already there stay only when the new
          // ones reach them; otherwise there could be a gap between, so they start over
          const reach = !kept.length || list.length < PAGE || list.some((e) => e.id === kept[0]!.id);
          if (!reach) return { key, events: list, more: true, error: false, busy: false };
          const ids = new Set(list.map((e) => e.id));
          const older = kept.filter((e) => !ids.has(e.id));
          return { key, events: [...list, ...older], more: older.length ? g.more : list.length === PAGE, error: false, busy: false };
        });
      },
      () => n === asked.current && setGot((g) => ({ ...(g.key === key ? g : start(key)), error: true, busy: false, failed: { before } })),
    );
  };
  // again when the page changes, and when back online (going offline changes nothing there)
  useEffect(() => {
    if (r.status.online || got.key !== key || !got.events.length) load();
  }, [key, r.status.online]);

  // the fetched rows and the live ones that came since, of this page only
  const fetched = got.key === key ? got.events : [];
  const events = useMemo(() => {
    const byId = new Map<number, ActivityEvent>();
    // the server folds edits into one entry: of two copies, the later one counts; at the same
    // time, the server's answer
    for (const e of [...fetched, ...r.events]) if (e.doc === item.id && e.ts > (byId.get(e.id)?.ts ?? -1)) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => b.ts - a.ts || b.id - a.id);
  }, [fetched, r.events, item.id]);
  const steps = useMemo(() => bySteps(events), [events]);

  // what an error means: offline, or the server did not answer as it should
  const failed = t(r.status.online ? "updates.failed" : "updates.offline");
  const retry = () => (
    <Button variant="plain" className="tap-y underline hover:text-fg" onClick={() => load(got.failed?.before)}>
      {t("updates.retry")}
    </Button>
  );

  if (!events.length)
    return (
      <div className="pt-1 text-sm text-muted-foreground">
        <p role="status">{got.busy || got.key !== key ? t("history.loading") : got.error ? failed : t("updates.noChanges")}</p>
        {got.error && !got.busy && <div className="mt-2">{retry()}</div>}
      </div>
    );

  const oldest = fetched.length ? Math.min(...fetched.map((e) => e.id)) : undefined;
  // the update an entry wrote: by its id; older entries have only the text, which must be unique
  const updateOf = (c: { id?: string; to?: unknown }) => {
    if (c.id) return item.updates.some((u) => u.id === c.id) ? c.id : undefined;
    const same = item.updates.filter((u) => u.text === c.to);
    return same.length === 1 ? same[0]!.id : undefined;
  };

  return (
    <div>
      <DayList
        rows={steps}
        day={(step) => dateOf(step[0]!.ts)}
        render={(step) => {
          const head = step[0]!;
          const actor = actorName(head.origin, me, t);
          const lines = step.flatMap((e) => {
            if (e.kind !== "updated") return [<li key={e.id}>{t("updates.kind." + e.kind)}</li>];
            return e.changes.flatMap((c, n) => {
              const k = `${e.id}:${n}`;
              // an update is in the other view in full: here its start, and the way there
              if (c.field === "update" && c.to === undefined)
                return [
                  <li key={k} className="line-clamp-2 [overflow-wrap:anywhere]">
                    {t("updates.deletedOne")} <del className="text-muted-foreground">{String(c.from)}</del>
                  </li>,
                ];
              if (c.field === "update") {
                const id = updateOf(c);
                // one paragraph of at most two lines, the text cut where it must be
                const text = String(c.to);
                const line = (
                  <span className="line-clamp-2 [overflow-wrap:anywhere]">
                    {t("updates.wrote")} <span className="text-muted-foreground">{text}</span>
                  </span>
                );
                return [
                  <li key={k} className="min-w-0">
                    {id ? (
                      <Button
                        variant="plain"
                        onClick={() => onUpdate(id)}
                        aria-label={`${t("updates.wrote")} ${text.length > 80 ? `${text.slice(0, 80)}…` : text} – ${t("updates.showUpdate")}`}
                        className="tap-y group -mx-1.5 flex w-[calc(100%+0.75rem)] items-start gap-1 rounded-md px-1.5 text-left font-normal hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="min-w-0 flex-1">{line}</span>
                        <ArrowRight size={14} className="mt-1 shrink-0 text-muted-foreground group-hover:text-fg" aria-hidden />
                      </Button>
                    ) : (
                      line
                    )}
                  </li>,
                ];
              }
              const text = describe(c, item, ix, t);
              if (!text) return [];
              return [
                <li key={k} className="[overflow-wrap:anywhere]">
                  {text}
                  {c.field === "body" && c.diff && <BodyDiff e={e} space={space} prose />}
                </li>,
              ];
            });
          });
          return {
            // a step keeps its row (and an open comparison) when more of it comes in
            key: head.step ? `${head.step}/${dateOf(head.ts)}` : head.id,
            body: (
              <>
                <div className={META}>
                  <time dateTime={new Date(head.ts).toISOString()}>{fmtTime(lang, head.ts)}</time>
                  <span>
                    <span className="inline-flex items-center gap-1">
                      {actor.agent && <Bot size={12} aria-hidden />}
                      {actor.name}
                    </span>
                  </span>
                  {head.undoes && <span>{t(head.redo ? "updates.redone" : "updates.undone")}</span>}
                </div>
                {lines.length > 0 && <ul className="mt-0.5 space-y-0.5 text-[15px]">{lines}</ul>}
              </>
            ),
          };
        }}
      />
      <div className="mt-4 flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
        <p role="status">{got.error ? `${failed} ${t("updates.partly")}` : got.busy ? t("history.loading") : ""}</p>
        {got.error && !got.busy && retry()}
        {got.more && !got.error && !got.busy && oldest !== undefined && (
          <Button variant="plain" onClick={() => load(oldest)} className="tap-y hover:text-fg">
            {t("updates.olderChanges")}
          </Button>
        )}
      </div>
    </div>
  );
}
