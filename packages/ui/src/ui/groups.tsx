import type { T } from "@obtion/core/i18n";
import { type Item, type StatusGroup, titleKey, type ViewTab } from "@obtion/core/model";
import {
	type EvalCtx,
	FIELDS,
	type Group,
	groupId,
	groupItems,
	pathBase,
	type QueryDef,
	viewTypeIds,
} from "@obtion/core/query";
import { cmpKey } from "@obtion/core/sortkey";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { itemHref, useIndex } from "../hooks";
import { titleOf, useT } from "../i18n";
import { ItemIcon, pal, StatusPill, tint } from "./item-look";
import { Button } from "./primitives";
import { pathLabel } from "./Row";

/** Built-in keys in the app language, others as the view's `fields` name them. */
export function fieldLabel(
	key: string,
	t: T,
	fields: { key: string; label: string }[] = [],
): string {
	if (key === "status" || key === "statusGroup" || key === "type" || key === "path")
		return t(`group.${key}`);
	if ((FIELDS as readonly string[]).includes(key)) return t(`field.${key}`);
	if (key === "tags") return t("item.tags");
	return fields.find((f) => titleKey(f.key) === titleKey(key))?.label ?? key;
}

/** AreaChip colours follow the area's position in the sidebar. */
const AREA_COLORS = [
	"blue",
	"green",
	"violet",
	"amber",
	"teal",
	"pink",
	"indigo",
	"brown",
	"olive",
	"red",
];
export function AreaChip({ id }: { id: string }) {
	const ix = useIndex();
	const item = ix.get(id);
	if (!item) return null;
	const pinned = ix.live.filter((i) => i.pinned).sort((a, b) => cmpKey(a.pinned!, b.pinned!));
	const position = Math.max(
		0,
		pinned.findIndex((p) => p.id === id),
	);
	const color = pal(AREA_COLORS[position % AREA_COLORS.length]);
	return (
		<a
			className="inline-flex max-w-full items-center truncate whitespace-nowrap rounded-full px-2 py-px text-xs font-medium hover:underline"
			href={itemHref(id)}
			style={tint(color)}
		>
			{item.title}
		</a>
	);
}

export function GroupChip({ g, by, byLabel }: { g: Group; by: string; byLabel: string }) {
	const { t } = useT();
	const ix = useIndex();
	if (by === "statusGroup" && g.key)
		return (
			<StatusPill
				option={{
					id: g.key,
					name: t(`group.${g.key}`),
					group: g.key as StatusGroup,
					color: undefined,
				}}
			/>
		);
	if (g.option)
		return (
			<StatusPill
				group={by === "status" ? (g.statusGroup as StatusGroup) : undefined}
				option={g.option}
			/>
		);
	if (g.ref && by === "area") return <AreaChip id={g.ref} />;
	if (g.ref) {
		const target = ix.get(g.ref);
		return target ? (
			<a
				className="flex min-w-0 items-center gap-1.5 text-sm font-medium hover:underline"
				href={itemHref(target.id)}
			>
				<ItemIcon className="shrink-0" item={target} size={14} />
				<span className="truncate">{titleOf(target, t)}</span>
			</a>
		) : null;
	}
	if (by === "path")
		return (
			<span className="truncate text-sm font-medium">
				{g.path?.length ? pathLabel(g.path) : t("group.thisLevel")}
			</span>
		);
	if (!g.key)
		return (
			<span className="text-sm text-muted-foreground">{t("group.without", { name: byLabel })}</span>
		);
	return <span className="truncate text-sm font-medium">{g.label || g.key}</span>;
}

/** Includes empty options, for choosing which groups to show. */
export function viewGroups(items: Item[], def: QueryDef, ctx: EvalCtx): Group[] {
	if (!def.group) return [];
	return groupItems(items, def.group, ctx, pathBase(def, ctx), {
		types: viewTypeIds(def.where, items, ctx.ix),
		where: def.where,
	});
}

export function splitHidden(groups: Group[], tab?: ViewTab): [Group[], Group[]] {
	const hidden = new Set(tab?.hiddenGroups ?? []);
	return [
		groups.filter((g) => !hidden.has(groupId(g))),
		groups.filter((g) => hidden.has(groupId(g))),
	];
}

export function hiddenPatch(tab: ViewTab | undefined, g: Group, hide: boolean): Partial<ViewTab> {
	const ids = (tab?.hiddenGroups ?? []).filter((x) => x !== groupId(g));
	return { hiddenGroups: hide ? [...ids, groupId(g)] : ids };
}

export function HiddenGroups({
	groups,
	by,
	byLabel,
	onShow,
}: {
	groups: Group[];
	by: string;
	byLabel: string;
	onShow?: (g: Group) => void;
}) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	if (!groups.length) return null;
	return (
		<div className="sticky left-0 w-fit px-2 py-1 text-sm">
			<Button
				aria-expanded={open}
				className="tap-y flex items-center gap-1.5 text-muted-foreground hover:text-fg"
				onClick={() => setOpen(!open)}
				variant="plain"
			>
				{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
				{t("view.hiddenGroups", { count: groups.length })}
			</Button>
			{open && (
				<ul className="mt-1 space-y-1 pl-5">
					{groups.map((g) => (
						<li className="flex items-center gap-2" key={g.key || "_"}>
							<GroupChip by={by} byLabel={byLabel} g={g} />
							<span className="text-xs tabular-nums text-muted-foreground">{g.items.length}</span>
							{onShow && (
								<Button
									className="tap rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-hover hover:text-fg"
									onClick={() => onShow(g)}
									variant="plain"
								>
									{t("view.showGroup")}
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
