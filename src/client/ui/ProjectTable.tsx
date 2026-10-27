// Projects with their progress and next task (design rules § 2.4) – on Start and in query blocks
// with "spalten:fortschritt,nächste" (an overview's "Aktive Projekte").
import { useState } from "react";
import { ChevronRight, CornerDownRight } from "lucide-react";
import { type Item, todayISO } from "../../shared/model";
import { dueOf } from "../../shared/traits";
import { itemHref, useIndex, useMediaQuery } from "../hooks";
import { useT } from "../i18n";
import { DueLabel, cx } from "./bits";
import { RowStatus } from "./Row";

/**
 * Active projects (design rules § 2.4): project · progress (bar and percent) · next task. Sub-
 * projects folded below their project; the next task only in the top visible row of a tree.
 * On a phone a list with a small bar and "Nächste: …" as second line.
 */
export function ProjectTable({ items }: { items: Item[] }) {
  const ix = useIndex();
  const { t, lang } = useT();
  const phone = useMediaQuery("(max-width: 767px)");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const ids = new Set(items.map((i) => i.id));
  const parentOf = (i: Item) => [...ix.homePath(i.id)].reverse().find((p) => ids.has(p));
  const tops = items.filter((i) => !parentOf(i));
  const kids = (id: string) => items.filter((i) => parentOf(i) === id);
  const rows: { item: Item; depth: number }[] = [];
  const walk = (i: Item, depth: number) => {
    rows.push({ item: i, depth });
    if (open.has(i.id)) for (const k of kids(i.id)) walk(k, depth + 1);
  };
  tops.forEach((i) => walk(i, 0));
  const today = todayISO();
  const shownNext = new Set<string>();
  const nextOf = (i: Item) => {
    const n = ix.nextTask(i.id, today);
    if (!n || shownNext.has(n.id)) return undefined;
    shownNext.add(n.id);
    return n;
  };
  const pct = (i: Item) => {
    const pr = ix.progressOf(i);
    if (!pr || !pr.total) return null;
    return (
      <span className="flex items-center gap-2">
        <span className={cx("h-1.5 overflow-hidden rounded-full bg-surface-2 dark:bg-hover", phone ? "w-10" : "w-14")}>
          <span className="block h-full rounded-full" style={{ width: `${(pr.done / pr.total) * 100}%`, background: "var(--ok)" }} />
        </span>
        <span className="text-xs tabular-nums text-muted">{new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 }).format(pr.done / pr.total)}</span>
      </span>
    );
  };
  const chevron = (i: Item) =>
    kids(i.id).length ? (
      <button onClick={() => setOpen(new Set(open.has(i.id) ? [...open].filter((x) => x !== i.id) : [...open, i.id]))} aria-expanded={open.has(i.id)} aria-label={t(open.has(i.id) ? "start.hideSub" : "start.showSub")} className="tap shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-fg">
        <ChevronRight size={14} className={cx("transition-transform", open.has(i.id) && "rotate-90")} />
      </button>
    ) : (
      <span className="w-[18px] shrink-0" />
    );
  // on a phone the top projects only (no unfolding), each with its next task
  if (phone)
    return (
      <div>
        {tops.map((i) => {
          const n = nextOf(i);
          return (
            <div key={i.id} className="flex min-h-[52px] items-center gap-2.5 border-t border-line px-3.5 py-1.5 first:border-t-0">
              <RowStatus item={i} size={16} />
              <a href={itemHref(i.id)} className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px]">{i.title || t("untitled")}</span>
                <span className="truncate text-xs text-muted">{n ? t("row.next", { title: n.title || t("untitled") }) : [ix.homePath(i.id).slice(-1).map((p) => ix.get(p)?.title)[0], ix.progressOf(i)?.total ? "" : t("start.noTasks")].filter(Boolean).join(" · ")}</span>
              </a>
              {pct(i) ?? <span className="text-faint">–</span>}
            </div>
          );
        })}
      </div>
    );
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="h-8 bg-[color-mix(in_srgb,var(--surface-2)_45%,var(--surface))] text-left text-xs text-muted">
          <th className="px-3.5 font-medium">{t("start.project")}</th>
          <th className="w-[1%] whitespace-nowrap px-3 font-medium">{t("field.progress")}</th>
          <th className="w-[38%] px-3.5 font-medium">{t("start.nextTask")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ item: i, depth }) => {
          const n = nextOf(i);
          const nd = n ? dueOf(n, ix.schemaOf(n)) : undefined;
          return (
            <tr key={i.id} data-id={i.id} className="h-10 border-t border-line hover:bg-hover">
              <td className="max-w-0 px-3.5">
                <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: depth * 22 }}>
                  {depth > 0 && <CornerDownRight size={13} className="-mr-1 shrink-0 text-faint" aria-hidden />}
                  {chevron(i)}
                  <RowStatus item={i} size={16} />
                  <a href={itemHref(i.id)} className="min-w-0 truncate hover:underline">
                    {i.title || t("untitled")}
                  </a>
                </span>
              </td>
              <td className="whitespace-nowrap px-3">{pct(i) ?? <span className="text-faint">–</span>}</td>
              <td className="max-w-0 px-3.5">
                {n ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <a href={itemHref(n.id)} className="min-w-0 truncate hover:underline">
                      {n.title || t("untitled")}
                    </a>
                    {nd && <DueLabel due={nd} />}
                  </span>
                ) : (
                  <span className="text-xs text-muted">{ix.progressOf(i)?.total ? "" : t("start.noTasks")}</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

