import { type Item, META_TYPE, titleKey } from "@obtion/core/model";
import { belowOf, canPlaceIn } from "@obtion/core/placement";
import { Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { Input } from "../components/ui/input";
import { useIndex, useRepo } from "../hooks";
import { titleOf, useT } from "../i18n";
import { cn } from "../lib/utils";
import { ItemIcon } from "./item-look";
import { Button, Dialog } from "./primitives";
import { type PickReason, placeSuggestions } from "./suggest";

const SEARCH_HITS = 60;
const MAX_ROWS = 12;

/** Suggestions first, then search as you type. */
export function ItemPicker({
	title,
	onPick,
	onClose,
	exclude,
	filter,
	suggestions = [],
	onCreate,
}: {
	title: string;
	onPick: (id: string) => void;
	onClose: () => void;
	exclude?: (i: Item) => boolean;
	filter?: (i: Item) => boolean;
	suggestions?: { id: string; reason: PickReason }[];
	onCreate?: (title: string) => void;
}) {
	const { t } = useT();
	const repo = useRepo();
	const [q, setQ] = useState("");
	const [sel, setSel] = useState(0);
	const allowed = (i: Item) => !exclude?.(i) && (!filter || filter(i)) && i.type !== META_TYPE;
	const suggested = q.trim()
		? []
		: suggestions.filter((s) => repo.get(s.id) && allowed(repo.get(s.id)!));
	// items with entries below first: they are the usual places
	const ix = repo.index();
	const found = (
		q.trim() ? repo.search(q, SEARCH_HITS) : [...repo.live()].sort((a, b) => b.updated - a.updated)
	)
		.filter(allowed)
		.sort((a, b) => Number(belowOf(b.id, ix).length > 0) - Number(belowOf(a.id, ix).length > 0))
		.filter((i) => !suggested.some((s) => s.id === i.id))
		.slice(0, MAX_ROWS);
	const rows: { id?: string; reason?: PickReason; create?: string }[] = [
		...suggested,
		...found.map((i) => ({ id: i.id })),
	];
	if (onCreate && q.trim() && !found.some((i) => i.title.toLowerCase() === titleKey(q)))
		rows.push({ create: q.trim() });
	const pick = (row?: (typeof rows)[number]) => {
		if (!row) return;
		if (row.create) onCreate!(row.create);
		else onPick(row.id!);
	};
	return (
		<Dialog onClose={onClose} title={title}>
			<Input
				autoFocus
				className="mb-2 focus:border-focus"
				onChange={(e) => (setQ(e.target.value), setSel(0))}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown")
						e.preventDefault(), setSel((s) => Math.min(rows.length - 1, s + 1));
					else if (e.key === "ArrowUp") e.preventDefault(), setSel((s) => Math.max(0, s - 1));
					else if (e.key === "Enter") e.preventDefault(), pick(rows[sel]);
				}}
				placeholder={t("picker.search")}
				value={q}
			/>
			{suggested.length > 0 && (
				<p className="px-2 pb-1 text-xs font-medium text-muted-foreground">
					{t("picker.suggested")}
				</p>
			)}
			<div className="flex flex-col">
				{rows.map((row, i) => {
					const item = row.id ? repo.get(row.id) : undefined;
					return (
						<Button
							className={cn(
								"flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
								i === sel && "bg-selected",
								i === suggested.length && suggested.length > 0 && "mt-2",
							)}
							key={row.id ?? "create"}
							onClick={() => pick(row)}
							onMouseEnter={() => setSel(i)}
							variant="plain"
						>
							{item ? (
								<ItemIcon item={item} size={15} />
							) : (
								<Plus className="text-muted-foreground" size={15} />
							)}
							<span className="min-w-0 flex-1 truncate">
								{item ? titleOf(item, t) : t("picker.create", { title: row.create })}
							</span>
							{row.reason && (
								<span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
									{row.reason === "agent" && <Sparkles size={11} />}
									{t(`picker.reason.${row.reason}`)}
								</span>
							)}
							{item && !row.reason && <PathHint item={item} />}
						</Button>
					);
				})}
				{!rows.length && (
					<p className="px-2 py-2 text-sm text-muted-foreground">{t("picker.none")}</p>
				)}
			</div>
		</Dialog>
	);
}

function PathHint({ item }: { item: Item }) {
	const ix = useIndex();
	const path = ix.homePath(item.id);
	if (!path.length) return null;
	return (
		<span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
			{ix.pathText(path)}
		</span>
	);
}

/** Offers only places all entries may go below; they must share one workspace. */
export function PlacePicker({
	list,
	title,
	onPick,
	onClose,
}: {
	list: Item[];
	title?: string;
	onPick: (place: string) => void;
	onClose: () => void;
}) {
	const { t } = useT();
	const repo = useRepo();
	const ix = repo.index();
	return (
		<ItemPicker
			exclude={(x) => list.some((p) => !canPlaceIn(p, x, ix))}
			onClose={onClose}
			onCreate={(name) => onPick(repo.create({ title: name }))}
			onPick={onPick}
			suggestions={list.length === 1 ? placeSuggestions(list[0]!, repo) : []}
			title={
				title ??
				(list.length > 1 ? t("triage.whereToMany", { count: list.length }) : t("triage.whereTo"))
			}
		/>
	);
}
