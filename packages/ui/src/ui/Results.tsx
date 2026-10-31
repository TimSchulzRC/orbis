// Showing query results: list, table, board, tree, gallery and triage ("sortieren").
// Used by collections, query blocks in texts and the sections of a page.
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { type Item, type ViewKind, todayISO } from "@obtion/core/model";
import { type QueryDef, type EvalCtx, fieldOf, groupItems, pathBase, runQuery } from "@obtion/core/query";
import { fmtDate, fmtNumber } from "@obtion/core/i18n";
import { useIndex, itemHref } from "../hooks";
import { useT, titleOf } from "../i18n";
import { StatusPill, Tag } from "./item-look";
import { ProgressCount } from "./progress";
import { ItemRow, pathLabel, treeOrder, Group } from "./Row";
import { Triage } from "./Triage";
import { CalendarView, TimelineView } from "./TimeViews";
import { ProjectTable } from "./ProjectTable";
import { BoardView } from "./Board";
import { GalleryView } from "./Gallery";
import { type Look, GroupedTable } from "./Table";
import { HiddenGroups, fieldLabel, hiddenPatch, splitHidden } from "./groups";
import { Card, Button } from "./primitives";

export function useQuery(def: QueryDef, thisId?: string) {
  const ix = useIndex();
  const ctx: EvalCtx = { ix, thisId };
  const res = runQuery(def, ctx);
  return { ...res, ctx };
}

const isInboxQuery = (def: QueryDef) => !!def.where && "inbox" in def.where;

/** Under a shortened inbox list: how much is waiting, and a clear way to work through it. */
function InboxNudge({ total }: { total: number }) {
  const { t } = useT();
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 pt-1 text-sm">
      <span className="tabular-nums text-muted-foreground">{t("inbox.waiting", { count: total })}</span>
      <a href="#/review" className="font-medium text-fg underline-offset-2 hover:underline">
        {t("inbox.sortNow")}
      </a>
    </div>
  );
}

function MissingTypes({ ids }: { ids: string[] }) {
  const { t } = useT();
  const ix = useIndex();
  if (!ids.length) return null;
  return (
    <p className="mb-2 flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-warn">
      <AlertTriangle size={13} /> {t("query.typeDeleted", { names: ids.map((id) => ix.all.get(id)?.schema?.name ?? id).join(", ") })}
    </p>
  );
}

export function Results({ def, thisId, display, empty, keyPrefix = "", look }: { def: QueryDef; thisId?: string; display?: ViewKind; empty?: React.ReactNode; keyPrefix?: string; look?: Look }) {
  const { t } = useT();
  const res = useQuery(def, thisId);
  const { total, missingTypes, ctx } = res;
  // long results render in pages, so a collection of hundreds stays responsive
  const [shown, setShown] = useState(100);
  const items = res.items.slice(0, ["triage", "calendar", "timeline"].includes(display ?? def.view ?? "") ? undefined : shown);
  const view = display ?? def.view ?? "list";
  return (
    <div>
      <MissingTypes ids={missingTypes} />
      {!items.length && !missingTypes.length && !(look?.add && (view === "table" || view === "board")) ? (
        (empty ?? <p className="px-2 py-1.5 text-sm text-muted-foreground">{t("query.empty")}</p>)
      ) : view === "table" ? (
        <GroupedTable items={items} def={def} ctx={ctx} look={look ?? { key: keyPrefix }} />
      ) : view === "board" ? (
        <BoardView items={items} def={def} ctx={ctx} look={look} />
      ) : view === "calendar" ? (
        <CalendarView items={items} def={def} ctx={ctx} look={look} />
      ) : view === "timeline" ? (
        <TimelineView items={items} def={def} ctx={ctx} look={look} />
      ) : view === "tree" ? (
        <TreeView items={items} />
      ) : view === "gallery" ? (
        <GalleryView items={items} ctx={ctx} />
      ) : view === "triage" ? (
        <Triage items={items} />
      ) : def.columns?.includes("progress") && !def.group ? (
        // projects with progress and next task: a table in a card
        <Card className="overflow-hidden">
          <ProjectTable items={items} />
        </Card>
      ) : (
        <ListView items={items} def={def} ctx={ctx} look={look} />
      )}
      {def.limit && total > res.items.length && (isInboxQuery(def) ? <InboxNudge total={total} /> : <p className="px-2 pt-1 text-xs text-muted-foreground">{t("query.more", { count: total - res.items.length })}</p>)}
      {res.items.length > items.length && (
        <Button variant="plain" onClick={() => setShown(shown + 200)} className="mt-2 w-full py-2 text-sm text-muted-foreground hover:text-fg">
          {t("query.more", { count: res.items.length - items.length })}
        </Button>
      )}
    </div>
  );
}

// ---------- list ----------

function ListView({ items, def, ctx, look }: { items: Item[]; def: QueryDef; ctx: EvalCtx; look?: Look }) {
  const { t } = useT();
  const base = pathBase(def, ctx);
  const [groups, hidden] = def.group ? splitHidden(groupItems(items, def.group, ctx, base), look?.tab) : [groupItems(items, def.group, ctx, base), []];
  const ix = ctx.ix;
  // "spalten:nächste" in a list: each entry shows its next task below the title
  const withNext = def.columns?.includes("next");
  const by = def.group ?? "";
  const byLabel = fieldLabel(by, t);
  return (
    <div className="-mx-2">
      {groups.map((g, gi) => (
        <Group key={g.key} first={gi === 0} heading={def.group ? (def.group === "path" ? (g.path?.length ? pathLabel(g.path) : t("group.thisLevel")) : g.label || (g.statusGroup ? t("group." + g.statusGroup) : t("group.without", { name: byLabel }))) : undefined} count={g.items.length}>
          {treeOrder(g.items).map(({ item: i, depth }) => {
            // sub-items whose parent is listed too follow it, indented. Every other entry says
            // where it lives: relative to the page, or (in global lists) its home path.
            const rel = base ? ix.relPath(base, i.id) : ix.homePath(i.id);
            const showPath = def.group !== "path" && !depth && rel && rel.length > 0 ? rel : undefined;
            const next = withNext ? ix.nextTask(i.id, todayISO()) : undefined;
            return <ItemRow key={i.id} item={i} sub={depth} path={showPath} note={next && t("row.next", { title: titleOf(next, t) })} />;
          })}
        </Group>
      ))}
      {def.group && <HiddenGroups groups={hidden} by={by} byLabel={byLabel} onShow={look?.onLook ? (g) => look.onLook!(hiddenPatch(look.tab, g, false)) : undefined} />}
    </div>
  );
}

// ---------- table ----------

export function defaultColumns(items: Item[], ctx: EvalCtx): string[] {
  const names: string[] = [];
  for (const i of items.slice(0, 50)) {
    for (const p of ctx.ix.schemaOf(i)?.properties ?? []) if (!names.includes(p.name)) names.push(p.name);
    for (const n of Object.keys(i.extra)) if (!names.includes(n)) names.push(n);
  }
  return names.slice(0, 6);
}

export function CellValue({ item, name, ctx }: { item: Item; name: string; ctx: EvalCtx }) {
  const { lang } = useT();
  if (name === "tags")
    return (
      <span className="flex flex-wrap gap-1">
        {item.tags.map((x) => (
          <Tag key={x} tag={x} />
        ))}
      </span>
    );
  const hit = fieldOf(item, name, ctx.ix);
  // computed progress reads as "2/7", like in rows and on the page (the query value stays a percentage)
  if (hit?.prop?.kind === "computed" && hit.prop.computed?.fn !== "count") {
    const pr = ctx.ix.progress(item.id, hit.prop.computed?.of);
    return <ProgressCount done={pr.done} total={pr.total} className={pr.total ? undefined : "text-muted-foreground"} />;
  }
  if (!hit || hit.value === undefined || hit.value === null || hit.value === "" || (Array.isArray(hit.value) && !hit.value.length)) return <span className="text-faint">–</span>;
  const v = hit.value;
  if (hit.kind === "item") {
    const target = ctx.ix.get(String(v));
    return target ? (
      <a href={itemHref(target.id)} className="hover:underline">
        {target.title || "–"}
      </a>
    ) : (
      <span className="text-faint">–</span>
    );
  }
  if (hit.kind === "select") {
    const ids = Array.isArray(v) ? (v as string[]) : [String(v)];
    return (
      <span className="flex flex-wrap gap-1">
        {ids.map((id) => {
          const o = hit.prop?.options?.find((x) => x.id === id);
          return o ? <StatusPill key={id} option={o} small /> : <span key={id}>{id}</span>;
        })}
      </span>
    );
  }
  if (hit.kind === "relation")
    return (
      <span className="flex flex-wrap gap-x-2">
        {(v as string[]).map((id) => {
          const x = ctx.ix.get(id);
          return x ? (
            <a key={id} href={itemHref(id)} className="hover:underline">
              {x.title}
            </a>
          ) : null;
        })}
      </span>
    );
  if (hit.kind === "date") return <span className="whitespace-nowrap">{String(v).split("/").map((d) => fmtDate(lang, d)).join(" – ")}</span>;
  if (hit.kind === "number") return <span className="tabular-nums">{typeof v === "number" ? fmtNumber(lang, v) : String(v)}</span>;
  if (hit.kind === "checkbox") return <span>{v ? "✓" : "–"}</span>;
  if (hit.kind === "url")
    return (
      <a href={String(v)} target="_blank" rel="noopener" className="text-link hover:underline">
        {String(v).replace(/^https?:\/\//, "")}
      </a>
    );
  // long text stays two lines in tables and boards; the full text is on the page
  return <span className="line-clamp-2">{String(v)}</span>;
}

// ---------- tree ----------

function TreeView({ items }: { items: Item[] }) {
  const ix = useIndex();
  const set = new Set(items.map((i) => i.id));
  const parentOf = (id: string) => {
    const home = ix.home(id);
    if (home && set.has(home)) return home;
    return ix.parentsOf(id).find((p) => set.has(p));
  };
  const kids = new Map<string, Item[]>();
  const roots: Item[] = [];
  for (const i of items) {
    const p = parentOf(i.id);
    if (p) (kids.get(p) ?? kids.set(p, []).get(p)!).push(i);
    else roots.push(i);
  }
  const render = (i: Item, depth: number, seen: Set<string>): React.ReactNode =>
    seen.has(i.id) ? null : (
      <div key={i.id}>
        <div style={{ paddingLeft: depth * 18 }}>
          <ItemRow item={i} />
        </div>
        {(kids.get(i.id) ?? []).map((k) => render(k, depth + 1, new Set([...seen, i.id])))}
      </div>
    );
  return <div className="-mx-2">{roots.map((r) => render(r, 0, new Set()))}</div>;
}
