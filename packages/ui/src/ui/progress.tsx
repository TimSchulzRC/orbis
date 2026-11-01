import { Progress as ShadcnProgress } from "../components/ui/progress";
import { fmtPercent } from "@obtion/core/i18n";
import { tr, useT } from "../i18n";
import { cn } from "../lib/utils";
import { EmptyDash } from "./item-look";

export function Progress({ done, total, className }: { done: number; total: number; className?: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <ShadcnProgress value={pct} className={cn("h-1.5 bg-secondary [&_[data-slot=progress-indicator]]:bg-[var(--ok)]", className)} title={tr("progress.title", { done, total })} aria-label={tr("progress.label")} aria-valuetext={`${done}/${total}`} />
  );
}

export function ProgressCount({ done, total, className }: { done: number; total: number; className?: string }) {
  return (
    <span className={cn("tabular-nums", className)} title={total ? tr("progress.title", { done, total }) : undefined}>
      {total ? `${done}/${total}` : "–"}
    </span>
  );
}

/** `inline` (rows, group heads) puts a short bar of `barClass` first, else the share leads and the bar fills the rest. */
export function PercentBar({ done, total, inline, barClass }: { done: number; total: number; inline?: boolean; barClass?: string }) {
  const { t, lang } = useT();
  if (!total) return inline ? null : <EmptyDash />;
  const share = done / total;
  const fill = <span className="block h-full rounded-full" style={{ width: `${share * 100}%`, background: "var(--ok)" }} />;
  if (inline)
    return (
      <span className="flex shrink-0 items-center gap-2">
        <span className={cn("h-1.5 shrink-0 overflow-hidden rounded-full bg-surface-2 dark:bg-hover", barClass)} aria-hidden>{fill}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtPercent(lang, share)}</span>
      </span>
    );
  return (
    <span className="flex w-full items-center gap-2" title={t("progress.title", { done, total })}>
      <span className="w-11 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{fmtPercent(lang, share)}</span>
      <span className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={t("progress.label")}>
        {fill}
      </span>
    </span>
  );
}

/** Design rules § 2.3. */
export function ProgressBand({ done, total, desc }: { done: number; total: number; desc: string }) {
  const { lang } = useT();
  if (!total) return null;
  const share = done / total;
  return (
    <div className="mt-[18px] flex flex-wrap items-center gap-x-3 gap-y-1">
      <div
        className="h-2 w-[280px] overflow-hidden rounded-full bg-surface-2 max-md:w-auto max-md:flex-1 dark:bg-hover"
        role="progressbar"
        aria-valuenow={Math.round(share * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={desc}
      >
        <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: "var(--ok)" }} />
      </div>
      <span className="text-[15px] font-semibold tabular-nums">{fmtPercent(lang, share)}</span>
      <span className="text-[13px] text-muted-foreground">{desc}</span>
    </div>
  );
}
