// The inbox tray below every page; on a desktop it floats over the page, centred in the window. The
// tray opens its panel, the list and an entry to sort; the button beside it (on a phone the "+") a
// quick note. On Heute on a desktop with room, the panel is pinned open as part of the page.
import { useRef } from "react";
import { Check, ChevronDown, ChevronUp, Inbox, Plus } from "lucide-react";
import { useT } from "../i18n";
import { cn } from "../lib/utils";
import { QuickNote, QuickNoteButton, closeQuickNote, openQuickNote, useQuickNote } from "./QuickNote";
import { dismissShelf, openShelf, useInboxItems, useShelf } from "./inbox";
import { InboxPanel } from "../views/Review";
import { Button } from "./primitives";
import { Tip } from "../components/ui/tooltip";
import { Backdrop } from "../components/ui/dialog";

const FILL = 10;
const DAY = 86_400_000;
/** Pixels a finger moves up on the tray to open its panel. */
const SWIPE_UP = 40;

export function Tray({ desktop, pinned }: { desktop: boolean; pinned?: boolean }) {
  const { t } = useT();
  const entries = useInboxItems();
  const count = entries.length;
  const { open, at } = useShelf();
  // the panel over the page (pinned it is part of the page and stays)
  const looking = open && !pinned;
  const writing = useQuickNote();
  const openPanel = () => (writing && closeQuickNote(), openShelf());
  const touch = useRef<number | null>(null);
  const ages = entries.map((e) => age(e.item.created)).sort((a, b) => b - a);
  const tray = (
    <div className={cn("relative flex shrink-0 items-center rounded-xl", !desktop && "min-w-0 flex-[1_0_0%]")}>
      {/* the legend of the marks, while the panel above is shut */}
      <Tip label={t("tray.open", { count })} card={<Legend ages={ages} />} off={looking}>
      <Button
        variant="plain"
        // pinned it does not close, so nothing to click
        onClick={() => (looking ? dismissShelf() : !pinned && openPanel())}
        onTouchStart={(e) => (touch.current = e.touches[0]!.clientY)}
        onTouchEnd={(e) => {
          if (touch.current !== null && touch.current - (e.changedTouches[0]?.clientY ?? 0) > SWIPE_UP) (e.preventDefault(), openPanel());
          touch.current = null;
        }}
        aria-expanded={pinned || open}
        aria-label={t("tray.open", { count })}
        className={cn("relative flex min-w-0 items-center gap-2.5 rounded-xl py-1.5 pl-2.5 pr-2 text-left", desktop ? "min-h-11" : "min-h-10", pinned ? "cursor-default" : cn("hover:bg-hover", looking && "bg-hover"), !desktop && "flex-1")}
      >
        <Inbox size={18} className={cn("shrink-0", count ? "text-muted-foreground" : "text-faint")} aria-hidden />
        <span className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm font-semibold leading-none">
            {t("tray.title")} · <span className="tabular-nums text-warn">{count}</span>
          </span>
          <Fill ages={ages} />
        </span>
        {/* pinned it stays, hidden, so the field beside does not move between Heute and other pages */}
        {looking ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronUp size={14} className={cn("text-muted-foreground", pinned && "invisible")} />}
      </Button>
      </Tip>
    </div>
  );
  const empty = !count && (
    <span className="flex h-10 shrink-0 items-center gap-1.5 px-2 text-sm text-muted-foreground">
      <Check size={15} className="text-ok" /> {t("tray.empty")}
    </span>
  );
  return (
    <>
      {looking && <Backdrop className="z-30" onClick={dismissShelf} aria-hidden />}
      {writing && <Backdrop className="z-30" onClick={closeQuickNote} aria-hidden />}
      <div
        // floating, only the bar and its panel take clicks; the page below shows through
        className={cn("z-40", pinned ? "relative flex min-h-[308px] flex-1 flex-col px-8 pb-4 pt-2" : desktop ? "pointer-events-none fixed inset-x-0 bottom-0 px-6 pb-4" : "relative shrink-0 px-3 pb-2 pt-1")}
        role="region"
        aria-label={t("tray.title")}
      >
        <div className={cn("mx-auto", desktop && "max-w-[1040px]", pinned && "flex min-h-0 w-full flex-1 flex-col")}>
          {pinned ? (
            // with the quick note open the inbox steps back; a click on it is a click beside the card (it lies above the backdrop)
            <div className="flex min-h-0 flex-1 flex-col" onClick={writing ? closeQuickNote : undefined} data-quick-beside>
              <div className={cn("min-h-0 flex-1 pb-10 transition-opacity", writing && "pointer-events-none opacity-30")} inert={writing}>
                <InboxPanel desktop pinned />
              </div>
            </div>
          ) : looking && (
            // on a phone an entry takes the whole screen, as a sheet
            <div className={cn(desktop ? "pointer-events-auto absolute inset-x-6 bottom-full mx-auto max-w-[1040px] pb-10" : at ? "fixed inset-x-0 bottom-0 top-3 z-50 pt-safe" : "absolute inset-x-2 bottom-full pb-7")}>
              <InboxPanel desktop={desktop} />
            </div>
          )}
          {!desktop && writing && (
            <div className="fixed inset-x-0 bottom-0 top-3 z-50 pt-safe">
              <QuickNote desktop={false} />
            </div>
          )}
          {desktop ? (
            <div className="pointer-events-auto relative mx-auto flex w-fit max-w-full items-center gap-2 rounded-2xl border border-line bg-surface p-2 shadow-[0_6px_24px_-12px_rgb(0_0_0/0.35)]">
              {tray}
              <QuickNoteButton />
              {empty}
              {/* the card right above the bar, centred on it */}
              <div className="absolute bottom-full left-1/2 mb-3 w-[min(760px,calc(100vw-3rem))] -translate-x-1/2 empty:hidden">
                <QuickNote desktop />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-2xl bg-surface p-1.5 shadow-sm">
              {tray}
              <Button variant="plain" onClick={openQuickNote} aria-label={t("capture.title")} className="tap flex size-10 shrink-0 items-center justify-center rounded-xl border border-line hover:bg-hover">
                <Plus size={20} />
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** How long an entry has lain: 0 put down today, 1 since yesterday, 2 over a week. */
type Age = 0 | 1 | 2;
function age(created: number, now = Date.now()): Age {
  if (created >= new Date(now).setHours(0, 0, 0, 0)) return 0;
  return now - created > 7 * DAY ? 2 : 1;
}
const AGE_LOOK = ["bg-faint", "bg-inbox", "bg-danger"] as const;
const AGE_TEXT = ["tray.age.today", "tray.age.days", "tray.age.week"] as const;

/** One mark per entry on a track of ten, the oldest first, coloured by how long it has lain; past ten a "+n". */
function Fill({ ages }: { ages: Age[] }) {
  return (
    <span className="flex items-center gap-[3px]" aria-hidden>
      {Array.from({ length: FILL }, (_, n) => (
        <span key={n} className={cn("h-1 w-2.5 rounded-full", n < ages.length ? AGE_LOOK[ages[n]!] : "bg-line")} />
      ))}
      {ages.length > FILL && <span className="ml-0.5 text-[11px] leading-none text-muted-foreground tabular-nums">+{ages.length - FILL}</span>}
    </span>
  );
}

/** What the marks mean, with how many lie in each stretch of time. */
function Legend({ ages }: { ages: Age[] }) {
  const { t } = useT();
  return (
    <div className="w-60">
      <p className="mb-2 font-semibold">{t("tray.age.title")}</p>
      <ul className="space-y-1.5">
        {AGE_LOOK.map((look, a) => (
          <li key={a} className="flex items-center gap-2">
            <span className={cn("h-1 w-2.5 shrink-0 rounded-full", look)} />
            <span className="flex-1 text-muted-foreground">{t(AGE_TEXT[a]!)}</span>
            <span className="tabular-nums">{ages.filter((x) => x === a).length}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
