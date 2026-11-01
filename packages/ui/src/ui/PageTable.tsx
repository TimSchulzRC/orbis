// A page's main list as one table in a card, a plain list on phones (design rules § 2.4).
import { Table as ShadcnTable, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/table";
import { ChevronRight, CornerDownRight } from "lucide-react";
import type { Item, ItemInit } from "@obtion/core/model";
import { fieldOf } from "@obtion/core/query";
import { dueOf, statusOf } from "@obtion/core/traits";
import { itemHref, useIndex, usePhone, useStoredSet } from "../hooks";
import { useT, titleOf } from "../i18n";
import { DueLabel, EmptyDash, StatusGlyph, StatusPill, statusColor } from "./item-look";
import { Button, Card } from "./primitives";
import { PercentBar, ProgressCount } from "./progress";
import { cn } from "../lib/utils";
import { CellValue } from "./Results";
import { RowStatus, shortPath, treeOrder } from "./Row";
import { KEYS } from "./storage";
import { NewRowButton } from "./Table";

/** `ref` is set when the group stands for an entry, such as a sub-project. */
export interface PageGroup {
  key: string;
  label: React.ReactNode;
  ref?: string;
  items: Item[]; // in order; sub-items follow their parent
}

export function PageTable({
  groups,
  cols,
  head,
  here,
  foldKey,
  add,
  done,
}: {
  groups: PageGroup[];
  cols: { key: string; label: string }[];
  head: string;
  here: string; // id of the page, locations are shown relative to it
  foldKey: string;
  add?: { init: ItemInit; label: string };
  done?: { count: number; shown: boolean; toggle: () => void };
}) {
  const { t } = useT();
  const ix = useIndex();
  const narrow = usePhone();
  const [folded, fold] = useStoredSet(KEYS.fold(foldKey));
  const grouped = groups.length > 1 || !!groups[0]?.ref;
  const isDone = (i: Item) => statusOf(i, ix.schemaOf(i))?.group === "done";
  const openCount = (items: Item[]) => items.filter((i) => !isDone(i)).length;
  const hints = (i: Item, g: PageGroup) => {
    const progress = ix.progressOf(i);
    const rel = (ix.relPath(here, i.id) ?? []).filter((p) => p !== g.ref && !g.items.some((x) => x.id === p));
    const status = statusOf(i, ix.schemaOf(i));
    const blocked = !!status && status.group !== "done" && ix.isBlocked(i);
    return (
      <>
        {progress && progress.total > 0 && <ProgressCount done={progress.done} total={progress.total} className="shrink-0 text-xs text-muted-foreground" />}
        {blocked && <span className="shrink-0 text-xs text-warn">{t("row.blocked")}</span>}
        {rel.length > 0 && <span className="min-w-0 truncate text-xs text-muted-foreground">{shortPath(rel)}</span>}
      </>
    );
  };
  const value = (i: Item, key: string) => {
    if (key === "due") {
      const due = dueOf(i, ix.schemaOf(i));
      return due ? <DueLabel due={due} done={isDone(i)} cell /> : <EmptyDash />;
    }
    const hit = fieldOf(i, key, ix);
    if (hit?.prop?.options && typeof hit.value === "string") {
      const option = hit.prop.options.find((x) => x.id === hit.value);
      return option ? <StatusPill option={option} small /> : <EmptyDash />;
    }
    return <CellValue item={i} name={key} ctx={{ ix }} />;
  };
  const groupHead = (g: PageGroup, isFolded: boolean) => {
    const ref = g.ref ? ix.get(g.ref) : undefined;
    const status = ref ? statusOf(ref, ix.schemaOf(ref)) : undefined;
    const progress = ref ? ix.progressOf(ref) : undefined;
    return (
      <Button variant="plain" onClick={() => fold(g.key, !isFolded)} aria-expanded={!isFolded} className="flex w-full min-w-0 items-center gap-2 text-left text-[13px]">
        <ChevronRight size={13} className={cn("shrink-0 text-faint transition-transform", !isFolded && "rotate-90")} aria-hidden />
        {status && <span className="shrink-0" style={{ color: statusColor(status.option, status.group === "done") ?? "var(--muted-foreground)" }}><StatusGlyph option={status.option} size={14} /></span>}
        <span className="truncate font-semibold">{g.label}</span>
        {progress && <PercentBar done={progress.done} total={progress.total} inline barClass="w-16 max-md:w-12" />}
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground md:ml-0">{t("children.openCount", { count: openCount(g.items) })}</span>
      </Button>
    );
  };
  const sub = "bg-[color-mix(in_srgb,var(--surface-2)_45%,var(--surface))]";
  const hasDone = !!done && done.count > 0;
  const doneLabel = !done ? "" : done.shown ? t("children.doneHide") : t(narrow ? "children.doneShort" : "children.doneShow", { count: done.count });
  const foot = (add || hasDone) && (
    <div className="flex min-h-10 items-center gap-3 border-t border-line px-3 text-[13px] text-muted-foreground">
      {add && <NewRowButton init={add.init} label={add.label} />}
      {hasDone && (
        <Button variant="plain" onClick={done.toggle} className="tap-y ml-auto whitespace-nowrap hover:text-fg">
          {doneLabel}
        </Button>
      )}
    </div>
  );
  if (narrow)
    return (
      <Card className="overflow-hidden">
        {groups.map((g, gi) => {
          const isFolded = grouped && folded.has(g.key);
          return (
            <div key={g.key}>
              {grouped && <div className={cn("flex h-9 items-center px-3", sub, gi > 0 && "border-t border-line")}>{groupHead(g, isFolded)}</div>}
              {!isFolded &&
                treeOrder(g.items).map(({ item: i, depth }) => (
                  <div key={i.id} data-id={i.id} className="flex min-h-[52px] items-center gap-2.5 border-t border-line px-3 py-1.5 first:border-t-0" style={{ paddingLeft: 12 + depth * 22 }}>
                    <RowStatus item={i} size={16} />
                    <a href={itemHref(i.id)} className="flex min-w-0 flex-1 flex-col">
                      <span className="line-clamp-2 text-[15px]">{titleOf(i, t)}</span>
                      <span className="flex min-w-0 items-center gap-2">{hints(i, g)}</span>
                    </a>
                    {cols[0] && <span className="shrink-0 text-xs">{value(i, cols[0].key)}</span>}
                  </div>
                ))}
            </div>
          );
        })}
        {foot}
      </Card>
    );
  return (
    <Card className="overflow-hidden">
      <ShadcnTable className="w-full border-collapse text-sm">
        <TableHeader>
          <TableRow className={cn("h-8 text-left text-xs text-muted-foreground", sub)}>
            <TableHead className="px-3 font-medium">{head}</TableHead>
            {cols.map((c) => (
              <TableHead key={c.key} className="w-[1%] whitespace-nowrap px-3 font-medium">
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        {groups.map((g) => {
          const isFolded = grouped && folded.has(g.key);
          return (
            <TableBody key={g.key}>
              {grouped && (
                <TableRow className={cn("h-10 border-t border-line", sub)}>
                  <TableCell colSpan={cols.length + 1} className="px-3">
                    {groupHead(g, isFolded)}
                  </TableCell>
                </TableRow>
              )}
              {!isFolded &&
                treeOrder(g.items).map(({ item: i, depth }) => (
                  <TableRow key={i.id} data-id={i.id} className="h-10 border-t border-line hover:bg-hover">
                    <TableCell className="max-w-0 px-3">
                      <span className="flex min-w-0 items-center gap-2.5" style={{ paddingLeft: depth * 26 }}>
                        {depth > 0 && <CornerDownRight size={13} className="-mr-1 shrink-0 text-faint" aria-hidden />}
                        <RowStatus item={i} size={16} />
                        <a href={itemHref(i.id)} className="min-w-0 truncate hover:underline">
                          {titleOf(i, t)}
                        </a>
                        {hints(i, g)}
                      </span>
                    </TableCell>
                    {cols.map((c) => (
                      <TableCell key={c.key} className="w-[1%] whitespace-nowrap px-3">
                        {value(i, c.key)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
            </TableBody>
          );
        })}
      </ShadcnTable>
      {foot}
    </Card>
  );
}
