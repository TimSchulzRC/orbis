// The inbox's choices for one entry: "Done", "Sort", "Type", "Tomorrow", "Pin" and, where offered,
// "Delete". Sorting, typing and pinning leave the entry in the inbox; "Done" takes it out.

import type { Item } from "@orbis/core/model";
import { Check, Clock, FolderInput, Pin, Shapes, Trash2, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../i18n";
import { cn } from "../lib/utils";
import { Button, Kbd } from "./primitives";

/**
 * The buttons stay the same and in the same place for every entry. `keys`: their key hints.
 * `waiting`: one back tomorrow comes back now instead of "Tomorrow". Without `onTrash` there is no "Delete".
 * `canDone`: "Done" works (an entry without a type or a place would land right back in the inbox).
 */
export function SortChoices({
	item,
	waiting,
	canDone,
	onDone,
	onPick,
	onTypes,
	onLater,
	onPin,
	onTrash,
	keys,
	className,
}: {
	item: Item;
	waiting?: boolean;
	canDone: boolean;
	onDone: () => void;
	onPick: () => void;
	onTypes: () => void;
	onLater: () => void;
	onPin: () => void;
	onTrash?: () => void;
	keys: boolean;
	className?: string;
}) {
	const { t } = useT();
	const isNote = item.kind === "note";
	const hint = (key: string) =>
		keys && (
			<span className="hidden @[780px]:inline-flex">
				<Kbd>{key}</Kbd>
			</span>
		);
	const tile = (
		icon: ReactNode,
		label: string,
		key: string,
		onClick: () => void,
		opts: {
			primary?: boolean;
			danger?: boolean;
			disabled?: boolean;
			wide?: boolean;
			why?: string;
		} = {},
	) => (
		<Button
			className={cn(
				"tap flex h-9 min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 text-[13px] font-medium disabled:opacity-40",
				opts.primary
					? "border-transparent bg-primary text-primary-foreground hover:bg-primary/90"
					: "border-line bg-surface hover:bg-hover",
				opts.wide && "max-lg:col-span-2",
				opts.danger && "text-danger lg:w-9 lg:flex-none lg:justify-center lg:px-0",
			)}
			disabled={opts.disabled}
			onClick={onClick}
			// delete on a desktop is only its icon: the name and key on hover; a disabled one says why
			title={opts.why ?? (opts.danger && keys ? `${label} (${key})` : undefined)}
			variant="plain"
		>
			{icon}
			<span className={cn("min-w-0 flex-1 truncate px-1 text-center", opts.danger && "lg:sr-only")}>
				{label}
			</span>
			{!opts.danger && hint(key)}
		</Button>
	);
	return (
		<div className={cn("@container flex shrink-0 gap-2 max-lg:grid max-lg:grid-cols-2", className)}>
			{/* "Done" leads once the entry has a type or a place; before, sorting it does */}
			{tile(<Check size={15} />, t("review.doneAction"), "d", onDone, {
				primary: canDone,
				disabled: !canDone,
				why: canDone ? undefined : t("review.doneFirst"),
			})}
			{tile(<FolderInput size={15} />, t("review.placeAction"), "e", onPick, { primary: !canDone })}
			{tile(<Shapes size={15} />, t("review.convertAction"), "y", onTypes, { disabled: !isNote })}
			{waiting
				? tile(<Undo2 size={15} />, t("review.backAction"), "s", onLater)
				: tile(<Clock size={15} />, t("review.laterAction"), "s", onLater)}
			{/* on a phone two to a row: without "Delete" beside it, the last one takes the row */}
			{tile(<Pin size={15} />, t("review.pin"), "a", onPin, { wide: !onTrash })}
			{onTrash && tile(<Trash2 size={15} />, t("triage.delete"), "x", onTrash, { danger: true })}
		</div>
	);
}
