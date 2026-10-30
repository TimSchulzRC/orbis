// A view as a board: a column per option (status, a select …), cards to drag between them,
// optionally in rows by a second grouping.
import { useState } from "react";
import { ChevronDown, ChevronRight, EyeOff } from "lucide-react";
import { type Item, type StatusGroup } from "@obtion/core/model";
import { type QueryDef, type EvalCtx, type Group as QGroup, fieldOf, groupItems, viewTypeIds } from "@obtion/core/query";
import { firstOfGroup, statusProp } from "@obtion/core/traits";
import { useRepo, itemHref, openItem } from "../hooks";
import { useT, titleOf } from "../i18n";
import { ItemIcon } from "./item-look";
import { cn } from "../lib/utils";
import { PercentBar, ProgressCount } from "./progress";
import { setStatus } from "./Row";
import type { Look } from "./Table";
import { AreaChip, GroupChip, HiddenGroups, fieldLabel, hiddenPatch, splitHidden } from "./groups";
import { Button, IconButton } from "./primitives";
import { CellValue } from "./Results";

export function BoardView({ items, def, ctx, look }: { items: Item[]; def: QueryDef; ctx: EvalCtx; look?: Look }) {
  const { t } = useT();
  const ix = ctx.ix;
  const by = def.group && def.group !== "path" ? def.group : "status";
  const tab = look?.tab;
  // every option is a column, also an empty one – a place to drag to ("Erledigt" before anything is done)
  const typeIds = viewTypeIds(def.where, items, ix, items.length);
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
  const byLabel = fieldLabel(by, t);
  const subLabel = tab?.subgroup ? fieldLabel(tab.subgroup, t) : "";
  return (
    <div ref={scroller} className={cn("-mx-2 overflow-x-auto pb-2", more && "[mask-image:linear-gradient(to_right,black_88%,transparent)]")}>
      {lanes.map((lane) => {
        const inLane = new Set(lane.items.map((i) => i.id));
        const isFolded = folded.has(lane.key);
        return (
          <section key={lane.key || "_"} className={tab?.subgroup ? "mb-4" : undefined}>
            {tab?.subgroup && (
              <div className="sticky left-0 flex w-fit items-center gap-2 px-2 py-1.5">
                <Button variant="plain" onClick={() => setFolded((f) => new Set(isFolded ? [...f].filter((k) => k !== lane.key) : [...f, lane.key]))} aria-expanded={!isFolded} aria-label={t(isFolded ? "table.unfold" : "table.fold")} className="tap -ml-1 rounded p-0.5 text-muted-foreground hover:bg-hover hover:text-fg">
                  {isFolded ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                </Button>
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
                      className={cn("flex w-64 shrink-0 flex-col gap-1.5 rounded-xl bg-surface-2/60 p-2", !cards.length && !tab?.subgroup && "w-44", over === k && "ring-2 ring-focus")}
                    >
                      <p className="group/head flex items-center gap-2 px-1">
                        <GroupChip g={col} by={by} byLabel={byLabel} />
                        <span className="text-xs tabular-nums text-muted-foreground">{cards.length}</span>
                        {look?.onLook && (
                          <IconButton size="xs" icon={EyeOff} iconSize={13} onClick={() => look.onLook!(hiddenPatch(tab, col, true))} label={t("view.hideColumn")} className="ml-auto opacity-0 focus-visible:opacity-100 group-hover/head:opacity-100 pointer-coarse:opacity-100" />
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
      onClick={(e) => !(e.target as HTMLElement).closest("a,button,select,input") && openItem(i.id)}
      className="flex cursor-pointer flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5 text-sm shadow-sm hover:shadow"
    >
      <a href={itemHref(i.id)} draggable={false} className="flex items-start gap-2">
        <ItemIcon item={i} size={14} className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1 font-medium">{titleOf(i, t)}</span>
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
