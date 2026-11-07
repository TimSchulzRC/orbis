// "Verlauf": the kept versions of an item's text (the server keeps one per editing session), with
// when and by whom, what each changed against the one before or against the text now – and
// "Wiederherstellen", which writes the old text as a new change: undoable, in the activity.
import { useEffect, useMemo, useState } from "react";
import type { HistoryList, TextVersion, VersionText } from "@obtion/core/api";
import { textDiff } from "@obtion/core/diff";
import { fmtDateTime } from "@obtion/core/i18n";
import { type Item, replaceBody, touch } from "@obtion/core/model";
import { spaceCall } from "../accounts";
import { useRepo, useSpaceId } from "../hooks";
import { useT, titleOf } from "../i18n";
import { cn } from "../lib/utils";
import { Button, Dialog, Seg } from "./primitives";
import { RelTime } from "./item-look";
import { who } from "./actor";
import { DiffView, LineCount } from "./DiffView";
import { notify } from "./toasts";

type Load<T> = { state: "loading" } | { state: "error" } | { state: "ok"; value: T };

export function HistoryDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const { t, lang } = useT();
  const r = useRepo();
  const space = useSpaceId();
  const [list, setList] = useState<Load<TextVersion[]>>({ state: "loading" });
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [picked, setPicked] = useState<number | null>(null);
  const [against, setAgainst] = useState<"previous" | "now">("previous");

  useEffect(() => {
    if (!space) return setList({ state: "error" });
    let gone = false;
    spaceCall<HistoryList>(space, `/api/history?doc=${encodeURIComponent(item.id)}`).then(
      (h) => !gone && setList({ state: "ok", value: h.versions }),
      () => !gone && setList({ state: "error" }),
    );
    return () => void (gone = true);
  }, [space, item.id]);

  const versions = list.state === "ok" ? list.value : [];
  const shown = picked !== null ? versions.find((v) => v.id === picked) : versions.at(-1);
  // the one before in the list: numbers have gaps where older versions thinned out
  const previous = shown ? versions[versions.indexOf(shown) - 1] : undefined;

  // the texts the comparison needs: the picked version and the one before it
  useEffect(() => {
    if (!space) return;
    for (const v of [shown, previous]) {
      if (!v || texts[v.id] !== undefined) continue;
      spaceCall<VersionText>(space, `/api/history?doc=${encodeURIComponent(item.id)}&version=${v.id}`).then(
        (x) => setTexts((m) => ({ ...m, [v.id]: x.text })),
        () => setList({ state: "error" }),
      );
    }
  }, [space, shown?.id, previous?.id]);

  const text = shown ? texts[shown.id] : undefined;
  const before = previous ? texts[previous.id] : "";
  const diff = useMemo(() => {
    if (text === undefined || before === undefined) return undefined;
    return against === "now" ? textDiff(text, item.body) : textDiff(before, text);
  }, [text, before, against, item.body]);
  const same = text !== undefined && text === item.body;

  const restore = () => {
    if (!shown || text === undefined) return;
    const step = r.ownStep(() => r.change(item.id, (d) => (replaceBody(d, text), touch(d))));
    if (step) notify.undo(t("history.restored", { n: shown.n }), () => void r.undo(step));
    onClose();
  };

  return (
    <Dialog title={t("history.title", { title: titleOf(item, t) })} onClose={onClose} wide>
      {list.state === "loading" ? (
        <p className="text-sm text-muted-foreground">{t("history.loading")}</p>
      ) : list.state === "error" ? (
        <p className="text-sm text-muted-foreground">{t("history.offline")}</p>
      ) : !versions.length ? (
        <p className="text-sm text-muted-foreground">{t("history.empty")}</p>
      ) : (
        <div className="flex gap-4 max-md:flex-col">
          <ol aria-label={t("history.versions")} className="flex shrink-0 flex-col gap-0.5 md:max-h-[60vh] md:w-52 md:overflow-y-auto max-md:max-h-48 max-md:overflow-y-auto">
            {[...versions].reverse().map((v, i, newest) => {
              const w = who(v.origin, t);
              const delta = v.len - (newest[i + 1]?.len ?? 0);
              return (
                <li key={v.id}>
                  <Button
                    variant="plain"
                    aria-current={v.id === shown?.id || undefined}
                    onClick={() => setPicked(v.id)}
                    className={cn("tap block w-full whitespace-normal rounded-lg px-2.5 py-1.5 text-left font-normal hover:bg-surface-2", v.id === shown?.id && "bg-surface-2")}
                  >
                    <span className="block text-sm font-medium">
                      {t("history.version", { n: v.n })}
                      {i === 0 && item.body === texts[v.id] && <span className="font-normal text-muted-foreground"> · {t("history.current")}</span>}
                    </span>
                    <span className="block text-xs text-muted-foreground" title={fmtDateTime(lang, v.ts)}>
                      <RelTime ts={v.ts} />
                      {w && ` · ${v.origin ? w.label : t("history.unknown")}`}
                      {` · ${delta >= 0 ? "+" : "−"}${t("history.chars", { count: Math.abs(delta) })}`}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ol>
          <div className="min-w-0 flex-1">
            {shown && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="mr-auto text-sm">
                  <span className="font-medium">{t("history.version", { n: shown.n })}</span>
                  <span className="text-muted-foreground"> · {fmtDateTime(lang, shown.ts)}</span>
                  {diff && diff.hunks.length > 0 && (
                    <span className="text-muted-foreground">
                      {" · "}
                      <LineCount diff={diff} />
                    </span>
                  )}
                </div>
                <Seg label={t("history.compare")} value={against} onChange={setAgainst} options={[{ value: "previous", label: t("history.toPrevious") }, { value: "now", label: t("history.toNow") }]} />
              </div>
            )}
            {diff ? (
              against === "now" && same ? <p className="text-sm text-muted-foreground">{t("history.same")}</p> : <DiffView diff={diff} className="max-h-[52vh] overflow-y-auto" />
            ) : (
              <p className="text-sm text-muted-foreground">{t("history.loading")}</p>
            )}
            {shown && text !== undefined && !same && (
              <div className="mt-3 flex justify-end">
                <Button variant="outline" onClick={restore}>
                  {t("history.restore")}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
