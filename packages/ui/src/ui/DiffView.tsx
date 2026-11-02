// What changed between two versions of a text, line by line: removed lines red, added lines green,
// a few unchanged lines around each change, "⋯" between changes far apart.
import type { TextDiff } from "@obtion/core/diff";
import { useT } from "../i18n";
import { cn } from "../lib/utils";

export function DiffView({ diff, className }: { diff: TextDiff; className?: string }) {
  const { t } = useT();
  if (!diff.hunks.length) return <p className={cn("text-sm text-muted-foreground", className)}>{t("history.noChange")}</p>;
  return (
    <div data-diff className={cn("overflow-hidden rounded-lg border border-line font-mono text-xs leading-5", className)}>
      {diff.hunks.map((h, i) => (
        <div key={i}>
          {i > 0 && <div className="select-none border-y border-line bg-surface-2 px-2 text-center text-muted-foreground">⋯</div>}
          {h.lines.map((l, j) => (
            <div
              key={j}
              data-op={l.op === " " ? "same" : l.op === "+" ? "added" : "removed"}
              className={cn("flex whitespace-pre-wrap break-words px-2", l.op === "+" && "bg-[color-mix(in_srgb,var(--ok)_14%,transparent)]", l.op === "-" && "bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]")}
            >
              <span aria-hidden className={cn("w-4 shrink-0 select-none", l.op === "+" ? "text-ok" : l.op === "-" ? "text-danger" : "text-muted-foreground")}>
                {l.op === "+" ? "+" : l.op === "-" ? "−" : ""}
              </span>
              <span className="sr-only">{l.op === "+" ? t("history.added") : l.op === "-" ? t("history.removed") : ""}</span>
              <span className="min-w-0 flex-1">{l.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** "+3 −1" in green and red: how many lines a change added and removed. */
export function LineCount({ diff }: { diff: TextDiff }) {
  return (
    <span className="tabular-nums">
      <span className="text-ok">+{diff.added}</span> <span className="text-danger">−{diff.removed}</span>
    </span>
  );
}
