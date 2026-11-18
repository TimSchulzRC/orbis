// The inbox tray below every page; on a desktop it floats over the page, centred in the window. The
// tray opens its panel, the list and an entry to sort; the button beside it (on a phone the "+") the
// panel at a new note. On Heute on a desktop with room, the panel is pinned open as part of the page.

import { Check, ChevronDown, ChevronUp, Inbox, Plus } from "lucide-react";
import { useRef } from "react";
import { Backdrop } from "../components/ui/dialog";
import { Tip } from "../components/ui/tooltip";
import { useT } from "../i18n";
import { cn } from "../lib/utils";
import { InboxPanel } from "../views/Review";
import { dismissShelf, newNote, openShelf, useInboxItems, useShelf } from "./inbox";
import { Button } from "./primitives";

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
	const openPanel = () => openShelf();
	const touch = useRef<number | null>(null);
	const ages = entries.map((e) => age(e.item.created)).sort((a, b) => b - a);
	const tray = (
		<div
			className={cn(
				"relative flex shrink-0 items-center rounded-xl",
				!desktop && "min-w-0 flex-[1_0_0%]",
			)}
		>
			{/* the legend of the marks, while the panel above is shut */}
			<Tip card={<Legend ages={ages} />} label={t("tray.open", { count })} off={looking}>
				<Button
					aria-expanded={pinned || open}
					aria-label={t("tray.open", { count })}
					className={cn(
						"relative flex min-w-0 items-center gap-2.5 rounded-xl py-1.5 pl-2.5 pr-2 text-left",
						desktop ? "min-h-11" : "min-h-10",
						pinned ? "cursor-default" : cn("hover:bg-hover", looking && "bg-hover"),
						!desktop && "flex-1",
					)}
					// pinned it does not close, so nothing to click
					onClick={() => (looking ? dismissShelf() : !pinned && openPanel())}
					onTouchEnd={(e) => {
						if (
							touch.current !== null &&
							touch.current - (e.changedTouches[0]?.clientY ?? 0) > SWIPE_UP
						) {
							e.preventDefault();
							openPanel();
						}
						touch.current = null;
					}}
					onTouchStart={(e) => (touch.current = e.touches[0]!.clientY)}
					variant="plain"
				>
					<Inbox
						aria-hidden
						className={cn("shrink-0", count ? "text-muted-foreground" : "text-faint")}
						size={18}
					/>
					<span className="flex min-w-0 flex-col gap-1.5">
						<span className="text-sm font-semibold leading-none">
							{t("tray.title")} · <span className="tabular-nums text-warn">{count}</span>
						</span>
						<Fill ages={ages} />
					</span>
					{/* pinned it stays, hidden, so the field beside does not move between Heute and other pages */}
					{looking ? (
						<ChevronDown className="text-muted-foreground" size={14} />
					) : (
						<ChevronUp className={cn("text-muted-foreground", pinned && "invisible")} size={14} />
					)}
				</Button>
			</Tip>
		</div>
	);
	const empty = !count && (
		<span className="flex h-10 shrink-0 items-center gap-1.5 px-2 text-sm text-muted-foreground">
			<Check className="text-ok" size={15} /> {t("tray.empty")}
		</span>
	);
	return (
		<>
			{looking && <Backdrop aria-hidden className="z-30" onClick={dismissShelf} />}
			<section
				aria-label={t("tray.title")}
				// floating, only the bar and its panel take clicks; the page below shows through
				className={cn(
					"z-40",
					pinned
						? "relative flex min-h-[308px] flex-1 flex-col px-8 pb-4 pt-2"
						: desktop
							? "pointer-events-none fixed inset-x-0 bottom-0 px-6 pb-4"
							: "relative shrink-0 px-3 pb-2 pt-1",
				)}
			>
				<div
					className={cn(
						"mx-auto",
						desktop && "max-w-[1040px]",
						pinned && "flex min-h-0 w-full flex-1 flex-col",
					)}
				>
					{pinned ? (
						<div className="min-h-0 flex-1 pb-10">
							<InboxPanel desktop pinned />
						</div>
					) : (
						looking && (
							// on a phone an entry takes the whole screen, as a sheet
							<div
								className={cn(
									desktop
										? "pointer-events-auto absolute inset-x-6 bottom-full mx-auto max-w-[1040px] pb-10"
										: at
											? "fixed inset-x-0 bottom-0 top-3 z-50 pt-safe"
											: "absolute inset-x-2 bottom-full pb-7",
								)}
							>
								<InboxPanel desktop={desktop} />
							</div>
						)
					)}
					{desktop ? (
						<div className="pointer-events-auto relative mx-auto flex w-fit max-w-full items-center gap-2 rounded-2xl border border-line bg-surface p-2 shadow-[0_6px_24px_-12px_rgb(0_0_0/0.35)]">
							{tray}
							{/* looks like the inbox's button beside it: no frame of its own, the plus where it has its chevron */}
							<Button
								className="tap-y flex min-h-11 items-center gap-2.5 rounded-xl py-1.5 pl-3 pr-2 text-sm font-semibold hover:bg-hover"
								onClick={() => newNote()}
								variant="plain"
							>
								{t("quick.title")}
								<Plus aria-hidden className="shrink-0 text-muted-foreground" size={16} />
							</Button>
							{empty}
						</div>
					) : (
						<div className="flex items-center gap-2">
							{tray}
							<Button
								aria-label={t("quick.title")}
								className="tap flex size-10 shrink-0 items-center justify-center rounded-xl border border-line hover:bg-hover"
								onClick={() => newNote()}
								variant="plain"
							>
								<Plus size={20} />
							</Button>
						</div>
					)}
				</div>
			</section>
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
		<span aria-hidden className="flex items-center gap-[3px]">
			{Array.from({ length: FILL }, (_, n) => (
				<span
					className={cn("h-1 w-2.5 rounded-full", n < ages.length ? AGE_LOOK[ages[n]!] : "bg-line")}
					// biome-ignore lint/suspicious/noArrayIndexKey: a fixed track of ten slots, never reordered
					key={n}
				/>
			))}
			{ages.length > FILL && (
				<span className="ml-0.5 text-[11px] leading-none text-muted-foreground tabular-nums">
					+{ages.length - FILL}
				</span>
			)}
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
					<li className="flex items-center gap-2" key={look}>
						<span className={cn("h-1 w-2.5 shrink-0 rounded-full", look)} />
						<span className="flex-1 text-muted-foreground">{t(AGE_TEXT[a]!)}</span>
						<span className="tabular-nums">{ages.filter((x) => x === a).length}</span>
					</li>
				))}
			</ul>
		</div>
	);
}
