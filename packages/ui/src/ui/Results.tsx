import { Button as ShadcnButton } from "../components/ui/button";
// Showing query results: list, table, board, tree, gallery and triage ("sortieren").
// Used by collections, query blocks in texts and the sections of a page.
import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, EyeOff } from "lucide-react";
import { type Item, type StatusGroup, type ViewKind, todayISO } from "@obtion/core/model";
import { type QueryDef, type EvalCtx, type Group as QGroup, FIELDS, fieldOf, groupItems, pathBase, runQuery, typesIn } from "@obtion/core/query";
import { fmtDate, fmtNumber } from "@obtion/core/i18n";
import { firstOfGroup, statusOf, statusProp } from "@obtion/core/traits";
import { plainText } from "@obtion/core/search";
import { repo } from "../repo";
import { useIndex, useRepo, useSpaceId, itemHref, go } from "../hooks";
import { useT } from "../i18n";
import { files, useBlobUrl } from "../files";
import { ItemIcon, StatusPill, cx, Tag, ProgressCount } from "./bits";
import { ItemRow, pathLabel, setStatus, treeOrder, Group } from "./Row";
import { Triage } from "./Triage";
import { CalendarView, TimelineView } from "./TimeViews";
import { ProjectTable } from "./ProjectTable";
import { type Look, AreaChip, GroupedTable, GroupChip, HiddenGroups, PercentBar, hiddenPatch, splitHidden } from "./Table";

export const VIEWS: ViewKind[] = ["list", "table", "board", "calendar", "timeline", "tree", "gallery", "triage"];

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

export function MissingTypes({ ids }: { ids: string[] }) {
  const { t } = useT();
  const ix = useIndex();
  if (!ids.length) return null;
  return (
    <p className="mb-2 flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-warn">
      <AlertTriangle size={13} /> {t("query.typeDeleted", { names: ids.map((id) => ix.all.get(id)?.schema?.name ?? id).join(", ") })}
    </p>
  );
}

export function Results({ def, thisId, display, empty, compact, keyPrefix = "", look }: { def: QueryDef; thisId?: string; display?: ViewKind; empty?: React.ReactNode; compact?: boolean; keyPrefix?: string; look?: Look }) {
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
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <ProjectTable items={items} />
        </div>
      ) : (
        <ListView items={items} def={def} ctx={ctx} compact={compact} look={look} />
      )}
      {def.limit && total > res.items.length && (isInboxQuery(def) ? <InboxNudge total={total} /> : <p className="px-2 pt-1 text-xs text-muted-foreground">{t("query.more", { count: total - res.items.length })}</p>)}
      {res.items.length > items.length && (
        <ShadcnButton variant="plain" size="none" onClick={() => setShown(shown + 200)} className="mt-2 w-full py-2 text-sm text-muted-foreground hover:text-fg">
          {t("query.more", { count: res.items.length - items.length })}
        </ShadcnButton>
      )}
    </div>
  );
}

// ---------- list ----------

export function ListView({ items, def, ctx, compact, look }: { items: Item[]; def: QueryDef; ctx: EvalCtx; compact?: boolean; look?: Look }) {
  const { t } = useT();
  const base = pathBase(def, ctx);
  const [groups, hidden] = def.group ? splitHidden(groupItems(items, def.group, ctx, base), look?.tab) : [groupItems(items, def.group, ctx, base), []];
  const ix = ctx.ix;
  // "spalten:nächste" in a list: each entry shows its next task below the title
  const withNext = def.columns?.includes("next");
  const by = def.group ?? "";
  const byLabel = ["status", "statusGroup", "type", "path"].includes(by) ? t("group." + by) : (FIELDS as readonly string[]).includes(by) ? t("field." + by) : by;
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
            return <ItemRow key={i.id} item={i} sub={depth} path={showPath} compact={compact} note={next && t("row.next", { title: next.title || t("untitled") })} />;
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
  if (hit.kind === "status" || hit.kind === "select" || hit.kind === "multiselect") {
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

// ---------- board ----------

function BoardView({ items, def, ctx, look }: { items: Item[]; def: QueryDef; ctx: EvalCtx; look?: Look }) {
  const { t } = useT();
  const ix = ctx.ix;
  const by = def.group && def.group !== "path" ? def.group : "status";
  const tab = look?.tab;
  // every option is a column, also an empty one – a place to drag to ("Erledigt" before anything is done)
  const typeIds = [...new Set([...typesIn(def.where), ...items.map((i) => i.type ?? "")])].filter((id) => ix.types.has(id));
  const [columns, hiddenCols] = splitHidden(groupItems(items, by, ctx, undefined, tab?.hideEmpty ? undefined : { types: typeIds, where: def.where }).filter((g) => !tab?.hideEmpty || g.items.length), tab);
  const lanes = tab?.subgroup ? groupItems(items, tab.subgroup, ctx).filter((g) => g.items.length) : [{ key: "", items } as QGroup];
  const [over, setOver] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const repo = useRepo();
  const drop = (id: string, g: QGroup) => {
    const item = repo.get(id);
    if (!item) return;
    const schema = ix.schemaOf(item);
    if (by === "statusGroup") {
      const o = g.key ? firstOfGroup(schema, g.key as StatusGroup) : undefined;
      if (o) void setStatus(item, o.id, repo);
      return;
    }
    const prop = by === "status" ? statusProp(schema) : schema?.properties.find((p) => p.name.toLowerCase() === by.toLowerCase() && (p.kind === "select" || p.kind === "status"));
    const opt = prop?.options?.find((o) => o.name === g.label);
    if (prop && opt && prop.id === statusProp(schema)?.id) void setStatus(item, opt.id, repo);
    else if (prop && opt) repo.setProp(id, prop.id, opt.id);
    else if (prop && !g.key) repo.setProp(id, prop.id, null);
  };
  // more columns to the right: the edge fades, so it is clear the board scrolls
  const [more, setMore] = useState(false);
  const scroller = (el: HTMLDivElement | null) => {
    if (!el) return;
    const check = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    check();
    el.onscroll = check;
  };
  const byLabel = by === "status" || by === "statusGroup" || by === "type" ? t("group." + by) : by;
  const subLabel = tab?.subgroup ? (["status", "statusGroup", "type", "path"].includes(tab.subgroup) ? t("group." + tab.subgroup) : (FIELDS as readonly string[]).includes(tab.subgroup) ? t("field." + tab.subgroup) : tab.subgroup) : "";
  return (
    <div ref={scroller} className={cx("-mx-2 overflow-x-auto pb-2", more && "[mask-image:linear-gradient(to_right,black_88%,transparent)]")}>
      {lanes.map((lane) => {
        const inLane = new Set(lane.items.map((i) => i.id));
        const isFolded = folded.has(lane.key);
        return (
          <section key={lane.key || "_"} className={tab?.subgroup ? "mb-4" : undefined}>
            {tab?.subgroup && (
              <div className="sticky left-0 flex w-fit items-center gap-2 px-2 py-1.5">
                <ShadcnButton variant="plain" size="none" onClick={() => setFolded((f) => new Set(isFolded ? [...f].filter((k) => k !== lane.key) : [...f, lane.key]))} aria-expanded={!isFolded} aria-label={t(isFolded ? "table.unfold" : "table.fold")} className="tap -ml-1 rounded p-0.5 text-muted-foreground hover:bg-hover hover:text-fg">
                  {isFolded ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                </ShadcnButton>
                <GroupChip g={lane} by={tab.subgroup} byLabel={subLabel} />
                <span className="text-xs tabular-nums text-muted-foreground">{lane.items.length}</span>
              </div>
            )}
            {!isFolded && (
              <div className="flex gap-3 px-2">
                {columns.map((col) => {
                  const cards = col.items.filter((i) => inLane.has(i.id));
                  const k = lane.key + "|" + col.key;
                  return (
                    <div
                      key={col.key || "_"}
                      onDragOver={(e) => (e.preventDefault(), setOver(k))}
                      onDragLeave={() => setOver(null)}
                      onDrop={(e) => {
                        setOver(null);
                        drop(e.dataTransfer.getData("obtion/item"), col);
                      }}
                      className={cx("flex w-64 shrink-0 flex-col gap-1.5 rounded-xl bg-surface-2/60 p-2", !cards.length && !tab?.subgroup && "w-44", over === k && "ring-2 ring-[var(--focus)]")}
                    >
                      <p className="group/head flex items-center gap-2 px-1">
                        <GroupChip g={col} by={by} byLabel={byLabel} />
                        <span className="text-xs tabular-nums text-muted-foreground">{cards.length}</span>
                        {look?.onLook && (
                          <ShadcnButton variant="plain" size="none" onClick={() => look.onLook!(hiddenPatch(tab, col, true))} className="tap ml-auto rounded p-0.5 text-muted-foreground opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/head:opacity-100 pointer-coarse:opacity-100" aria-label={t("view.hideColumn")} title={t("view.hideColumn")}>
                            <EyeOff size={13} />
                          </ShadcnButton>
                        )}
                      </p>
                      {/* an empty column says where to drag – in rows (by project …) the empty cells stay quiet */}
                      {!cards.length && !tab?.subgroup && <p className="rounded-lg border border-dashed border-line px-2 py-3 text-center text-xs text-muted-foreground">{t("board.dropHere")}</p>}
                      {cards.map((i) => (
                        <BoardCard key={i.id} item={i} cols={def.columns ?? []} ctx={ctx} />
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
      <HiddenGroups groups={hiddenCols} by={by} byLabel={byLabel} onShow={look?.onLook ? (g) => look.onLook!(hiddenPatch(tab, g, false)) : undefined} />
    </div>
  );
}

/** A card: title, and the view's properties as small lines (empty ones left out). */
function BoardCard({ item: i, cols, ctx }: { item: Item; cols: string[]; ctx: EvalCtx }) {
  const { t } = useT();
  const shown = cols.filter((c) => {
    const hit = c === "area" ? (ctx.ix.area(i.id) ? { value: 1 } : undefined) : fieldOf(i, c, ctx.ix);
    return hit && !(hit.value === undefined || hit.value === null || hit.value === "" || (Array.isArray(hit.value) && !hit.value.length));
  });
  const pr = !cols.length ? ctx.ix.progressOf(i) : undefined;
  // the whole card opens the entry; links inside it (a project, a relation) open theirs
  return (
    <div
      data-id={i.id}
      draggable
      onDragStart={(e) => e.dataTransfer.setData("obtion/item", i.id)}
      onClick={(e) => !(e.target as HTMLElement).closest("a,button,select,input") && go(itemHref(i.id).slice(1))}
      className="flex cursor-pointer flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5 text-sm shadow-sm hover:shadow"
    >
      <a href={itemHref(i.id)} draggable={false} className="flex items-start gap-2">
        <ItemIcon item={i} size={14} className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1 font-medium">{i.title || t("untitled")}</span>
      </a>
      {shown.map((c) => (
        <span key={c} className="flex min-w-0 text-xs text-muted-foreground">
          {c === "area" ? <AreaChip id={ctx.ix.area(i.id)!} /> : <CardValue item={i} name={c} ctx={ctx} />}
        </span>
      ))}
      {pr && pr.total ? <ProgressCount done={pr.done} total={pr.total} className="text-xs text-muted-foreground" /> : null}
    </div>
  );
}

function CardValue({ item, name, ctx }: { item: Item; name: string; ctx: EvalCtx }) {
  const { t } = useT();
  if (name === "progress") {
    const pr = ctx.ix.progressOf(item);
    return pr ? <PercentBar done={pr.done} total={pr.total} /> : null;
  }
  const hit = fieldOf(item, name, ctx.ix);
  if (name === "subtasks") return <span>{t("card.subtasks", { count: Number(hit?.value ?? 0) })}</span>;
  if (hit?.prop?.kind === "computed" && hit.prop.computed?.fn !== "count") {
    const pr = ctx.ix.progress(item.id, hit.prop.computed?.of);
    return <PercentBar done={pr.done} total={pr.total} />;
  }
  return <CellValue item={item} name={name} ctx={ctx} />;
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
          <ItemRow item={i} compact />
        </div>
        {(kids.get(i.id) ?? []).map((k) => render(k, depth + 1, new Set([...seen, i.id])))}
      </div>
    );
  return <div className="-mx-2">{roots.map((r) => render(r, 0, new Set()))}</div>;
}

// ---------- gallery ----------

function GalleryView({ items, ctx }: { items: Item[]; ctx: EvalCtx }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 @3xl:grid-cols-4">
      {items.map((i) => (
        <GalleryTile key={i.id} item={i} ctx={ctx} />
      ))}
    </div>
  );
}

function firstImage(item: Item): string | undefined {
  if (item.file) return item.file.thumb ?? (item.file.filetype === "bild" ? item.file.display : undefined);
  const ix = repo.index();
  for (const l of ix.textLinks(item)) {
    const f = ix.get(l.to)?.file;
    if (l.embed && f?.filetype === "bild") return f.thumb ?? f.display;
  }
  return undefined;
}

function GalleryTile({ item, ctx }: { item: Item; ctx: EvalCtx }) {
  const { t, lang } = useT();
  const hash = firstImage(item);
  const url = useBlobUrl(hash, true);
  const f = item.file;
  // nothing to show as a picture: a compact text card (title, status, progress, a line of text), no empty image area
  if (!hash && !f) {
    const schema = ctx.ix.schemaOf(item);
    const st = statusOf(item, schema);
    const pr = ctx.ix.progressOf(item);
    const text = plainText(item.body);
    return (
      <a href={itemHref(item.id)} className="group flex min-w-0 flex-col gap-1.5 self-start rounded-xl border border-line bg-surface p-3 hover:bg-hover">
        <span className="flex min-w-0 items-start gap-1.5 text-sm font-medium">
          <ItemIcon item={item} size={14} className="mt-0.5 shrink-0" />
          <span className="line-clamp-2">{item.title || t("untitled")}</span>
        </span>
        {text && <span className="line-clamp-2 text-xs text-muted-foreground">{text}</span>}
        {(st || (pr && pr.total > 0)) && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {st && <StatusPill option={st.option} group={st.group} small />}
            {pr && pr.total > 0 && <ProgressCount done={pr.done} total={pr.total} className="ml-auto" />}
          </span>
        )}
      </a>
    );
  }
  const meta = f ? [t("filetype." + f.filetype), f.pages ? t("file.pages", { count: f.pages }) : "", f.duration ? fmtDuration(f.duration) : ""].filter(Boolean).join(" · ") : "";
  return (
    <a href={itemHref(item.id)} className="group min-w-0">
      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl border border-line bg-surface-2">
        {url ? (
          <img src={url} alt="" className="size-full object-cover transition-transform group-hover:scale-[1.02]" />
        ) : files.isMissing(hash) || files.isMissing(f?.hash) ? (
          <span className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
            <ItemIcon item={item} size={24} /> {t(files.missingKey(item.created))}
          </span>
        ) : (
          <ItemIcon item={item} size={28} />
        )}
      </div>
      <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs font-medium">
        <ItemIcon item={item} size={12} />
        <span className="truncate">{item.title || t("untitled")}</span>
      </p>
      {meta && <p className="truncate text-xs text-muted-foreground">{meta}</p>}
      {void lang}
    </a>
  );
}

export function fmtDuration(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}
