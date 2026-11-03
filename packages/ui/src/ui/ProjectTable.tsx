// Rendered for query blocks with "spalten:fortschritt,nächste" (design rules § 2.4).
import { Table as ShadcnTable, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/table";
import { useContext, useState } from "react";
import { ChevronRight, CornerDownRight } from "lucide-react";
import { type Item, todayISO } from "@obtion/core/model";
import { dueOf } from "@obtion/core/traits";
import { itemHref, useIndex, usePhone } from "../hooks";
import { useT, titleOf } from "../i18n";
import { DueLabel, EmptyDash } from "./item-look";
import { PercentBar } from "./progress";
import { cn, toggled } from "../lib/utils";
import { RowStatus } from "./Row";
import { Button, InCard } from "./primitives";

/** A next task shared within a tree shows only in its top visible row. */
export function ProjectTable({ items }: { items: Item[] }) {
  const ix = useIndex();
  const { t } = useT();
  const phone = usePhone();
  // in a card: the outer cells line up with the card's own padding (its heading)
  const inCard = useContext(InCard);
  const left = inCard ? "pl-4 max-sm:pl-3" : "pl-3.5";
  const right = inCard ? "pr-4 max-sm:pr-3" : "pr-3.5";
  const [open, setOpen] = useState<Set<string>>(new Set());
  const ids = new Set(items.map((i) => i.id));
  const parentOf = (i: Item) => [...ix.homePath(i.id)].reverse().find((p) => ids.has(p));
  const tops = items.filter((i) => !parentOf(i));
  const childrenOf = (id: string) => items.filter((i) => parentOf(i) === id);
  const rows: { item: Item; depth: number }[] = [];
  const walk = (i: Item, depth: number) => {
    rows.push({ item: i, depth });
    if (open.has(i.id)) for (const child of childrenOf(i.id)) walk(child, depth + 1);
  };
  tops.forEach((i) => walk(i, 0));
  const today = todayISO();
  const shownNext = new Set<string>();
  const nextOf = (i: Item) => {
    const next = ix.nextTask(i.id, today);
    if (!next || shownNext.has(next.id)) return undefined;
    shownNext.add(next.id);
    return next;
  };
  const noTasksNote = (i: Item) => (ix.progressOf(i)?.total ? "" : t("start.noTasks"));
  const progressCell = (i: Item) => {
    const progress = ix.progressOf(i);
    return progress?.total ? <PercentBar done={progress.done} total={progress.total} inline barClass={phone ? "w-10" : "w-14"} /> : <EmptyDash />;
  };
  const chevron = (i: Item) => {
    if (!childrenOf(i.id).length) return <span className="w-[18px] shrink-0" />;
    const isOpen = open.has(i.id);
    return (
      <Button variant="plain" onClick={() => setOpen(toggled(open, i.id))} aria-expanded={isOpen} aria-label={t(isOpen ? "start.hideSub" : "start.showSub")} className="tap shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-fg">
        <ChevronRight size={14} className={cn("transition-transform", isOpen && "rotate-90")} />
      </Button>
    );
  };
  /** Without a next task, the phone row names where the project lives instead. */
  const phoneHint = (i: Item) => {
    const place = ix.homePath(i.id).slice(-1).map((p) => ix.get(p)?.title)[0];
    return [place, noTasksNote(i)].filter(Boolean).join(" · ");
  };
  // phones show only the top projects, without unfolding
  if (phone)
    return (
      <div>
        {tops.map((i) => {
          const next = nextOf(i);
          return (
            <div key={i.id} className={cn("flex min-h-[52px] items-center gap-2.5 border-t border-line py-1.5 first:border-t-0", left, right)}>
              <RowStatus item={i} size={16} />
              <a href={itemHref(i.id)} className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px]">{titleOf(i, t)}</span>
                <span className="truncate text-xs text-muted-foreground">{next ? t("row.next", { title: titleOf(next, t) }) : phoneHint(i)}</span>
              </a>
              {progressCell(i)}
            </div>
          );
        })}
      </div>
    );
  return (
    <ShadcnTable className="w-full border-collapse text-sm">
      <TableHeader>
        <TableRow className="h-8 bg-[color-mix(in_srgb,var(--surface-2)_45%,var(--surface))] text-left text-xs text-muted-foreground">
          <TableHead className={cn("pr-3.5 font-medium", left)}>{t("start.project")}</TableHead>
          <TableHead className="w-[1%] whitespace-nowrap px-3 font-medium">{t("field.progress")}</TableHead>
          <TableHead className={cn("w-[38%] pl-3.5 font-medium", right)}>{t("start.nextTask")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ item: i, depth }) => {
          const next = nextOf(i);
          const nextDue = next ? dueOf(next, ix.schemaOf(next)) : undefined;
          return (
            <TableRow key={i.id} data-id={i.id} className="h-10 border-t border-line hover:bg-hover">
              <TableCell className={cn("max-w-0 pr-3.5", left)}>
                <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: depth * 22 }}>
                  {depth > 0 && <CornerDownRight size={13} className="-mr-1 shrink-0 text-faint" aria-hidden />}
                  {chevron(i)}
                  <RowStatus item={i} size={16} />
                  <a href={itemHref(i.id)} className="min-w-0 truncate hover:underline">
                    {titleOf(i, t)}
                  </a>
                </span>
              </TableCell>
              <TableCell className="whitespace-nowrap px-3">{progressCell(i)}</TableCell>
              <TableCell className={cn("max-w-0 pl-3.5", right)}>
                {next ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <a href={itemHref(next.id)} className="min-w-0 truncate hover:underline">
                      {titleOf(next, t)}
                    </a>
                    {nextDue && <DueLabel due={nextDue} />}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">{noTasksNote(i)}</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </ShadcnTable>
  );
}

