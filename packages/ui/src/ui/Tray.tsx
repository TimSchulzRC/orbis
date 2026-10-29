import { Button as ShadcnButton } from "../components/ui/button";
// The tray ("Ablage") below every page: how much waits in the inbox (a fill in amber), a field
// to put something down, and the way into the review with how long it takes. Two ways in: the
// tray itself opens its panel to look in (Shelf.tsx; on a phone also a swipe up), the button
// starts the review to sort. The sheets sticking out are the newest entries, each opens itself.
// On a phone it sits above the tab bar; the field opens from its "+" in a sheet.
import { useRef } from "react";
import { Check, ChevronDown, ChevronUp, Layers, Plus } from "lucide-react";
import { useT } from "../i18n";
import { RelTime, cx } from "./bits";
import { Capture } from "./Capture";
import { type InboxEntry, closeShelf, openShelf, reviewMinutes, useInboxItems, useShelf } from "./inbox";
import { ShelfPanel } from "./Shelf";
import { spaceById, useAccounts } from "../accounts";

const FILL = 10;

export function Tray({ desktop, onCapture }: { desktop: boolean; onCapture: () => void }) {
  const { t } = useT();
  const entries = useInboxItems();
  const count = entries.length;
  const { open, at } = useShelf();
  const touch = useRef<number | null>(null);
  const tray = (
    <div className={cx("relative flex shrink-0 items-center rounded-xl", !desktop && "min-w-0 flex-1")}>
      <Sheets entries={entries.slice(0, 3)} />
      <ShadcnButton
        variant="plain"
        size="none"
        onClick={() => (open ? closeShelf() : openShelf())}
        onTouchStart={(e) => (touch.current = e.touches[0]!.clientY)}
        onTouchEnd={(e) => {
          if (touch.current !== null && touch.current - (e.changedTouches[0]?.clientY ?? 0) > 40) (e.preventDefault(), openShelf());
          touch.current = null;
        }}
        aria-expanded={open}
        aria-label={t("tray.open", { count })}
        className={cx("flex min-w-0 items-center gap-2 rounded-xl py-1.5 pl-[58px] pr-2 text-left hover:bg-hover", !desktop && "flex-1", open && "bg-hover")}
      >
        <span className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm font-semibold leading-none">
            {t("tray.title")} <span className="tabular-nums text-warn">{count}</span>
          </span>
          <Fill count={count} />
        </span>
        {open ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronUp size={14} className="text-muted-foreground" />}
      </ShadcnButton>
    </div>
  );
  const review = count ? (
    <a href="#/review" className="flex h-10 shrink-0 items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--t-inbox)_45%,transparent)] bg-[color-mix(in_srgb,var(--t-inbox)_12%,transparent)] px-3.5 text-sm font-semibold text-warn hover:bg-[color-mix(in_srgb,var(--t-inbox)_20%,transparent)]">
      <Layers size={16} />
      {desktop ? (
        <>
          {t("review.title")} <span className="font-normal opacity-80">· {t("tray.minutes", { count: reviewMinutes(count) })}</span>
        </>
      ) : (
        <span aria-label={`${t("review.title")} · ${t("tray.minutes", { count: reviewMinutes(count) })}`}>{t("tray.minutesShort", { count: reviewMinutes(count) })}</span>
      )}
    </a>
  ) : (
    <span className="flex h-10 shrink-0 items-center gap-1.5 px-2 text-sm text-muted-foreground">
      <Check size={15} className="text-ok" /> {t("tray.empty")}
    </span>
  );
  return (
    <>
      {/* the page behind the open panel: dimmed, a click closes */}
      {open && <div className="fixed inset-0 z-30 bg-black/40" onClick={closeShelf} aria-hidden />}
      <div className={cx("relative z-40 shrink-0", desktop ? "px-6 pb-4 pt-2" : "px-3 pb-2 pt-1")} role="region" aria-label={t("tray.title")}>
        <div className={cx("mx-auto", desktop && "max-w-[1040px]")}>
          {open && (
            // on a phone an entry takes the whole screen, as a sheet
            <div className={cx(desktop ? "absolute inset-x-6 bottom-full mx-auto max-w-[1040px] pb-2" : at ? "fixed inset-x-0 bottom-0 top-3 z-50 pt-safe" : "absolute inset-x-2 bottom-full pb-1")}>
              <ShelfPanel desktop={desktop} />
            </div>
          )}
          {desktop ? (
            <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-2 shadow-[0_6px_24px_-12px_rgb(0_0_0/0.25)]">
              {tray}
              <div className="min-w-0 flex-1">
                <Capture anywhere append placeholder={t("tray.placeholder")} />
              </div>
              {review}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface p-1.5 shadow-sm">
              {tray}
              {review}
              <ShadcnButton variant="plain" size="none" onClick={onCapture} aria-label={t("capture.title")} className="tap flex size-10 shrink-0 items-center justify-center rounded-xl border border-line hover:bg-hover">
                <Plus size={20} />
              </ShadcnButton>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The newest entries as sheets sticking out of the tray, one a little above the other: its title
 * on hover (and focus), a click opens it in the panel. A dot while anything waits.
 */
function Sheets({ entries }: { entries: InboxEntry[] }) {
  const { t } = useT();
  const { shown } = useAccounts();
  return (
    <span className="absolute bottom-1.5 left-1.5 z-10 block h-9 w-11">
      <span className="absolute inset-x-0 bottom-0 h-3 rounded-b-lg border border-t-0 border-line bg-surface-2" aria-hidden />
      {/* oldest of them at the back, the newest in front */}
      {[...entries].reverse().map((e, n, all) => {
        const front = n === all.length - 1;
        const angle = (n - (all.length - 1) / 2) * 6;
        return (
          <ShadcnButton
            key={e.key}
            variant="plain"
            size="none"
            onClick={() => openShelf(e.key)}
            aria-label={t("tray.openEntry", { title: e.item.title || e.item.file?.name || t("untitled") })}
            className="group absolute bottom-1.5 h-6 w-7 rounded-[5px] border border-line bg-surface shadow-sm transition-transform hover:-translate-y-1 focus-visible:-translate-y-1"
            style={{ left: 6 + n * 3, rotate: `${angle}deg`, zIndex: n }}
          >
            <span className="absolute inset-x-1 top-1.5 h-px bg-line" aria-hidden />
            <span className="absolute inset-x-1 top-3 h-px bg-line" aria-hidden />
            {front && <span className="absolute -right-1 -top-1 size-2 rounded-full bg-[var(--t-inbox)]" aria-hidden />}
            <span className="pointer-events-none absolute bottom-full left-0 mb-2 hidden w-max max-w-[280px] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left shadow-lg group-hover:block group-focus-visible:block" style={{ rotate: `${-angle}deg` }}>
              <span className="block truncate text-[13px] font-semibold text-fg">{e.item.title || e.item.file?.name || t("untitled")}</span>
              <span className="block text-xs text-muted-foreground">
                {shown.length > 1 && <>{spaceById(e.space)?.name} · </>}
                <RelTime ts={e.item.created} />
              </span>
            </span>
          </ShadcnButton>
        );
      })}
    </span>
  );
}

/** How full the tray is: one of ten marks per entry, amber. */
function Fill({ count }: { count: number }) {
  return (
    <span className="flex gap-[3px]" aria-hidden>
      {Array.from({ length: FILL }, (_, n) => (
        <span key={n} className={cx("h-1 w-2.5 rounded-full", n < count ? "bg-[var(--t-inbox)]" : "bg-line")} />
      ))}
    </span>
  );
}
