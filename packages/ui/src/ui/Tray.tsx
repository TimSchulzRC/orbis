// The tray ("Eingang") below every page: how much waits in the inbox (a fill in amber), a field
// to put something down, and the way into the review with how long it takes. Two ways in: the
// tray itself opens its panel to look in (Shelf.tsx; on a phone also a swipe up), the button
// starts the review to sort. The sheets sticking out are the newest entries, part of the tray.
// On a phone it sits above the tab bar; the field opens from its "+" in a sheet. On Heute on a
// desktop with room below the page the panel is pinned open above it, part of the page: the rest
// of the height below Heute (App.tsx).
import { Button as ShadcnButton } from "../components/ui/button";
import { type CSSProperties, useRef } from "react";
import { Check, ChevronDown, ChevronUp, Layers, Plus } from "lucide-react";
import { useT } from "../i18n";
import { cx } from "./bits";
import { Capture } from "./Capture";
import { type InboxEntry, closeShelf, openShelf, useInboxItems, useShelf } from "./inbox";
import { ShelfPanel } from "./Shelf";

const FILL = 10;

export function Tray({ desktop, pinned, onCapture }: { desktop: boolean; pinned?: boolean; onCapture: () => void }) {
  const { t } = useT();
  const entries = useInboxItems();
  const count = entries.length;
  const { open, at } = useShelf();
  const touch = useRef<number | null>(null);
  const tray = (
    <div className={cx("relative flex shrink-0 items-center rounded-xl", !pinned && "group/tray", !desktop && "min-w-0 flex-1")}>
      <ShadcnButton
        variant="plain"
        size="none"
        // pinned it does not close, so nothing to click
        onClick={() => !pinned && (open ? closeShelf() : openShelf())}
        onTouchStart={(e) => (touch.current = e.touches[0]!.clientY)}
        onTouchEnd={(e) => {
          if (touch.current !== null && touch.current - (e.changedTouches[0]?.clientY ?? 0) > 40) (e.preventDefault(), openShelf());
          touch.current = null;
        }}
        aria-expanded={pinned || open}
        aria-label={t("tray.open", { count })}
        className={cx("relative flex min-w-0 items-center gap-2 rounded-xl py-1.5 pr-2 text-left", desktop ? "min-h-11 pl-[136px]" : "min-h-10 pl-[100px]", pinned ? "cursor-default" : cx("hover:bg-hover", open && "bg-hover"), !desktop && "flex-1")}
      >
        <Sheets entries={entries.slice(0, 3)} desktop={desktop} />
        <span className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm font-semibold leading-none">
            {t("tray.title")} · <span className="tabular-nums text-warn">{count}</span>
          </span>
          <Fill count={count} />
        </span>
        {/* pinned it stays, hidden, so the field beside does not move between Heute and other pages */}
        {open && !pinned ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronUp size={14} className={cx("text-muted-foreground", pinned && "invisible")} />}
      </ShadcnButton>
    </div>
  );
  const review = count ? (
    <a
      href="#/review"
      aria-label={desktop ? undefined : t("tray.toReview")}
      className={cx("flex h-10 shrink-0 items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--t-inbox)_45%,transparent)] bg-[color-mix(in_srgb,var(--t-inbox)_12%,transparent)] text-sm font-semibold text-warn hover:bg-[color-mix(in_srgb,var(--t-inbox)_20%,transparent)]", desktop ? "px-3" : "w-10 justify-center")}
    >
      <Layers size={16} />
      {desktop && t("tray.toReview")}
    </a>
  ) : (
    <span className="flex h-10 shrink-0 items-center gap-1.5 px-2 text-sm text-muted-foreground">
      <Check size={15} className="text-ok" /> {t("tray.empty")}
    </span>
  );
  return (
    <>
      {/* the page behind the open panel: dimmed, a click closes */}
      {open && !pinned && <div className="fixed inset-0 z-30 bg-black/40" onClick={closeShelf} aria-hidden />}
      <div className={cx("relative z-40", pinned ? "flex min-h-[308px] flex-1 flex-col" : "shrink-0", desktop ? cx(pinned ? "px-8" : "px-6", "pb-4 pt-2") : "px-3 pb-2 pt-1")} role="region" aria-label={t("tray.title")}>
        <div className={cx("mx-auto", desktop && "max-w-[1040px]", pinned && "flex min-h-0 w-full flex-1 flex-col")}>
          {pinned ? (
            // above the sheets sticking out of the tray, which stay
            <div className="min-h-0 flex-1 pb-10">
              <ShelfPanel desktop pinned />
            </div>
          ) : open && (
            // on a phone an entry takes the whole screen, as a sheet
            <div className={cx(desktop ? "absolute inset-x-6 bottom-full mx-auto max-w-[1040px] pb-10" : at ? "fixed inset-x-0 bottom-0 top-3 z-50 pt-safe" : "absolute inset-x-2 bottom-full pb-7")}>
              <ShelfPanel desktop={desktop} />
            </div>
          )}
          {desktop ? (
            <div className="flex items-center gap-3 rounded-2xl bg-surface p-2 shadow-[0_6px_24px_-12px_rgb(0_0_0/0.25)]">
              {tray}
              <div className="min-w-0 flex-1">
                <Capture anywhere placeholder={t("tray.placeholder")} />
              </div>
              {review}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-2xl bg-surface p-1.5 shadow-sm">
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

/** Back to front: where a sheet rests in the well, and fanned out while the tray is hovered. */
const POSES: { left: [number, number]; rest: [string, string]; fan: [string, string] }[] = [
  { left: [9, 6], rest: ["-8deg", "0 10px"], fan: ["-14deg", "-5px 0"] },
  { left: [18, 12], rest: ["3deg", "0 4px"], fan: ["2deg", "0 -8px"] },
  { left: [30, 20], rest: ["-2deg", "0 -2px"], fan: ["8deg", "0 -6px"] },
];

/**
 * The newest entries as sheets sticking out of a well in the tray, the newest in front, a dot on
 * it. Part of the tray's button: a click on a sheet opens the panel like one on the tray.
 */
function Sheets({ entries, desktop }: { entries: InboxEntry[]; desktop: boolean }) {
  const poses = POSES.slice(POSES.length - entries.length);
  return (
    <span aria-hidden className={cx("absolute inset-y-0 left-0 z-10 block [--well:color-mix(in_srgb,var(--card)_93%,black)] dark:[--well:color-mix(in_srgb,var(--card)_65%,black)]", desktop ? "w-[120px]" : "w-[84px]")}>
      <span className="absolute inset-0 rounded-[11px] border border-line bg-[var(--well)] shadow-[inset_0_3px_8px_rgb(0_0_0/0.12)] dark:shadow-[inset_0_3px_8px_rgb(0_0_0/0.7)]" aria-hidden />
      <span className="absolute -top-px left-0.5 h-[3px] w-[calc(100%-4px)] rounded-b-[3px] bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--t-inbox)_60%,transparent),transparent)]" aria-hidden />
      {/* the sheets end inside the well (long enough that lifted their lower edge stays hidden), above
          they may stick out; cut off by overflow, as a clip-path would let a
          fanned sheet make the page scroll */}
      <span className="pointer-events-none absolute -inset-x-[300px] -top-[300px] bottom-1 overflow-clip">
      <span className="absolute inset-y-0 left-[300px] right-[300px]">
      {[...entries].reverse().map((e, n, all) => {
        const front = n === all.length - 1;
        const { left, rest, fan } = poses[n]!;
        return (
          <span
            key={e.key}
            className={cx(
              "pointer-events-auto absolute rounded-[7px] border shadow-[0_-2px_10px_rgb(0_0_0/0.15)] transition-[rotate,translate] duration-300 ease-[cubic-bezier(.2,.8,.2,1)] [rotate:var(--r)] [translate:var(--t)] group-hover/tray:[rotate:var(--rf)] group-hover/tray:[translate:var(--tf)]",
              desktop ? "-bottom-7 h-[92px] w-[84px]" : "-bottom-6 h-[78px] w-[56px]",
              front ? "border-faint/50 bg-hover" : "border-line bg-surface-2",
            )}
            style={{ left: left[desktop ? 0 : 1], zIndex: n, ...vars({ r: rest[0], t: rest[1], rf: fan[0], tf: fan[1] }) }}
          >
            <span className={cx("absolute left-2.5 h-[3px] rounded-full bg-faint/40", desktop ? "right-[22px] top-3" : "right-3 top-2")} />
            <span className={cx("absolute left-2.5 h-[3px] rounded-full bg-faint/30", desktop ? "right-[22px] top-5" : "right-3 top-4")} />
            <span className={cx("absolute left-2.5 h-[3px] rounded-full bg-faint/25", desktop ? "right-[22px] top-7" : "right-3 top-6")} />
            {front && <span className="absolute right-2 top-2 size-2 rounded-full bg-[var(--t-inbox)] shadow-[0_0_10px_var(--t-inbox)]" />}
          </span>
        );
      })}
      </span>
      </span>
      {/* where they are cut off, the sheets fade into the dark of the well */}
      <span className="pointer-events-none absolute inset-x-px bottom-px z-10 h-4 rounded-b-[10px] bg-[linear-gradient(to_top,var(--well)_6px,transparent)]" aria-hidden />
    </span>
  );
}

const vars = (v: Record<string, string>) => Object.fromEntries(Object.entries(v).map(([k, x]) => [`--${k}`, x])) as CSSProperties;

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
