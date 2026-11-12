// One change of the activity log in words ("Status: Offen → Erledigt"), what it did to a text, and
// the day headings of the updates list. Used by the activity page and the side panel.

import type { EventText } from "@obtion/core/api";
import { addDays, todayISO } from "@obtion/core/date";
import { textDiff } from "@obtion/core/diff";
import type { Index } from "@obtion/core/graph";
import type { T } from "@obtion/core/i18n";
import { fmtDate } from "@obtion/core/i18n";
import { type Item, optionNames, type Value } from "@obtion/core/model";
import type { ActivityEvent, FieldChange } from "@obtion/core/protocol";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { spaceCall } from "../accounts";
import { useT } from "../i18n";
import { cn } from "../lib/utils";
import { DiffView, LineCount } from "./DiffView";
import { Button } from "./primitives";

/** Meta parts in a row, "·" between them, never at the start of a wrapped line. */
export const META =
	"flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground [&>*+*]:before:mr-1.5 [&>*+*]:before:content-['·']";

/** "Today", "Yesterday", else the weekday and date (with the year when it is another one). */
export function useDayLabel() {
	const { t, lang } = useT();
	const today = todayISO();
	return (day: string) =>
		day === today
			? t("time.today")
			: day === addDays(today, -1)
				? t("updates.yesterday")
				: fmtDate(lang, day, {
						weekday: "long",
						day: "numeric",
						month: "long",
						year: day.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric",
					});
}

/** The property `id` of the item's type, also when it was removed since. */
function propDef(ix: Index, item: Item | undefined, id: string) {
	const schema = ix.schemaOf(item);
	return (
		schema?.properties.find((p) => p.id === id) ??
		schema?.removedProperties.find((p) => p.id === id)
	);
}

export function describe(c: FieldChange, item: Item | undefined, ix: Index, t: T): string {
	const title = (id: string) => ix.get(id)?.title ?? ix.all.get(id)?.title ?? "?";
	const list = (x: unknown) => ((x as string[]) ?? []).map(title).join(", ");
	const added = (c.to as string[]) ?? [];
	const removed = (c.from as string[]) ?? [];
	// what was added, what was removed (each only if any)
	const addedRemoved = (plus: string, minus: string) =>
		[added.length && plus, removed.length && minus].filter(Boolean).join(", ");
	if (c.field.startsWith("p:")) {
		const prop = propDef(ix, item, c.field.slice(2));
		const show = (x: unknown) => {
			if (x === undefined || x === null || x === "") return "–";
			if (prop?.options) return optionNames(prop, x as Value).join(", ");
			return String(x);
		};
		return `${prop?.name ?? c.field.slice(2)}: ${show(c.from)} → ${show(c.to)}`;
	}
	if (c.field.startsWith("x:")) {
		const show = (x: unknown) =>
			x === undefined ? "–" : Array.isArray(x) ? x.join(", ") : String(x);
		return `${c.field.slice(2)}: ${show(c.from)} → ${show(c.to)}`;
	}
	if (c.field.startsWith("r:")) {
		const name = propDef(ix, item, c.field.slice(2))?.name ?? "?";
		return addedRemoved(`${name} +${list(added)}`, `${name} −${list(removed)}`);
	}
	switch (c.field) {
		case "body":
			return t("activity.editedText");
		case "rules":
			return t("activity.rules");
		case "update":
			return c.to === undefined
				? t("activity.updateDeleted", { text: String(c.from).slice(0, 140) })
				: t("activity.update", { text: String(c.to).slice(0, 140) });
		case "tags":
			return addedRemoved(
				t("activity.tagged", { tags: added.map((x) => "#" + x).join(" ") }),
				t("activity.untagged", { tags: removed.map((x) => "#" + x).join(" ") }),
			);
		case "refs":
			return addedRemoved(
				`${t("item.refs")} +${list(added)}`,
				`${t("item.refs")} −${list(removed)}`,
			);
		case "parents":
			return addedRemoved(
				t("activity.placed", { list: list(added) }),
				t("activity.unplaced", { list: list(removed) }),
			);
		case "type":
			return c.to
				? t("activity.typed", { name: ix.typeName(String(c.to)) ?? "?" })
				: t("activity.untyped");
		case "home":
			return t("activity.home", { title: c.to ? title(String(c.to)) : "–" });
		case "title":
			return c.from
				? t("activity.renamed", { from: String(c.from), to: String(c.to ?? "") })
				: t("activity.named");
		case "views":
			return t("activity.views");
		case "schema":
			return t("activity.schema");
		case "file":
			return t("activity.fileReplaced");
		case "suggestion":
			return c.to ? t("activity.suggested") : t("activity.suggestionDone");
		case "op":
			return c.to === "undone" ? t("activity.undone") : "";
		default:
			return c.field;
	}
}

/**
 * What an entry did to a text, fetched when asked for: the lines removed and added. `onRestore`
 * writes the text before the entry back, offered while that is not the text `current`ly there.
 */
export function BodyDiff({
	e,
	space,
	prose,
	onRestore,
	current,
}: {
	e: ActivityEvent;
	space: string;
	prose?: boolean;
	onRestore?: (before: string) => void;
	current?: string;
}) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	const [got, setGot] = useState<EventText | null | undefined>(undefined);
	const [tries, setTries] = useState(0);
	// an entry still growing (typing) changes its time: fetch again then; the one shown stays meanwhile
	useEffect(() => {
		if (!open) return;
		let gone = false;
		spaceCall<EventText>(space, `/api/history?event=${e.id}`).then(
			(x) => !gone && setGot(x),
			() => !gone && setGot(null),
		);
		return () => void (gone = true);
	}, [open, space, e.id, e.ts, tries]);
	const diff = useMemo(() => (got ? textDiff(got.before, got.after) : undefined), [got]);
	const region = useId();
	return (
		<div>
			<Button
				aria-controls={region}
				aria-expanded={open}
				className="tap-y inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-fg"
				onClick={() => setOpen(!open)}
				variant="plain"
			>
				<ChevronRight className={cn("transition-transform", open && "rotate-90")} size={12} />
				{t(open ? "activity.hideDiff" : "activity.showDiff")}
				{diff && (
					<span className="ml-1">
						<LineCount diff={diff} />
					</span>
				)}
			</Button>
			<div id={region}>
				{/* only the short notes are announced, never the whole comparison */}
				<p className="text-xs text-muted-foreground" role="status">
					{open && got === undefined && t("history.loading")}
					{open && got === null && (
						<>
							{t("activity.diffMissing")}{" "}
							<Button
								className="tap-y underline hover:text-fg"
								onClick={() => setTries(tries + 1)}
								variant="plain"
							>
								{t("updates.retry")}
							</Button>
						</>
					)}
				</p>
				{open && diff && (
					// its own scroll area, so reachable by keyboard
					<DiffView
						className={cn(
							"mt-1 max-h-80 overflow-y-auto focus-visible:ring-2 focus-visible:ring-ring outline-none",
							prose && "font-sans text-[13px]",
						)}
						diff={diff}
						label={t("activity.diffLabel")}
						tabIndex={0}
						words={prose}
					/>
				)}
				{open && got && onRestore && got.before !== current && (
					<Button
						className="tap-y mt-1 text-xs text-muted-foreground underline hover:text-fg"
						onClick={() => onRestore(got.before)}
						variant="plain"
					>
						{t("history.restoreBefore")}
					</Button>
				)}
			</div>
		</div>
	);
}

/**
 * Rows by day, as a line with a dot per row: the updates and the changes of a page look alike.
 * `rows` are in order, newest first; `day` names the local day of one.
 */
export function DayList<R>({
	rows,
	day,
	render,
}: {
	rows: R[];
	day: (r: R) => string;
	render: (r: R) => {
		key: string | number;
		dot?: string;
		dotColor?: string;
		props?: Record<string, unknown>;
		body: ReactNode;
	};
}) {
	const dayLabel = useDayLabel();
	const id = useId();
	const days = new Map<string, R[]>();
	for (const r of rows) {
		const d = day(r);
		const list = days.get(d);
		if (list) list.push(r);
		else days.set(d, [r]);
	}
	return (
		<>
			{[...days].map(([d, list]) => (
				<section aria-labelledby={`${id}-${d}`} className="mt-3 first:mt-0" key={d}>
					<h3
						className="sticky top-0 z-10 -mx-4 bg-surface/95 px-4 py-1 text-xs font-medium text-muted-foreground backdrop-blur"
						id={`${id}-${d}`}
					>
						{dayLabel(d)}
					</h3>
					<ol className="ml-1 mt-1 space-y-4 border-l border-line pl-5">
						{list.map((r) => {
							const row = render(r);
							return (
								<li className="relative" key={row.key} {...row.props}>
									<span
										aria-hidden
										className={cn(
											"absolute -left-[25px] top-1.5 size-2.5 rounded-full border-2 border-surface",
											row.dot ?? "bg-faint",
										)}
										style={row.dotColor ? { background: row.dotColor } : undefined}
									/>
									{row.body}
								</li>
							);
						})}
					</ol>
				</section>
			))}
		</>
	);
}
