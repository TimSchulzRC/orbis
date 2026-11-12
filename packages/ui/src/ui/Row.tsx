import { fmtBytes } from "@obtion/core/i18n";
import { type Item, STATUS_GROUPS } from "@obtion/core/model";
import { dueOf, isDone, statusOf, statusProp } from "@obtion/core/traits";
import type { Repo } from "@obtion/sync";
import { useItemHref, useRepo } from "../hooks";
import { titleOf, tr, useT } from "../i18n";
import { cn } from "../lib/utils";
import { repo as current } from "../repo";
import { confirmAction, notify } from "./feedback";
import { DueLabel, ItemIcon, pal, StatusGlyph } from "./item-look";
import { Button, MenuItem, Popover } from "./primitives";
import { ProgressCount } from "./progress";

/** Status choice as a small menu, options under their group (like the status pill in Notion). */
export function StatusMenu({
	item,
	trigger,
}: {
	item: Item;
	trigger: (p: { onClick: () => void; "aria-expanded": boolean }) => React.ReactNode;
}) {
	const { t } = useT();
	const repo = useRepo();
	const ix = repo.index();
	const schema = ix.schemaOf(item);
	const statusProperty = statusProp(schema);
	const selected = statusProperty ? item.props[statusProperty.id] : undefined;
	return (
		<Popover trigger={trigger}>
			{(close) =>
				STATUS_GROUPS.map((g) => (
					<div key={g}>
						<p className="px-2.5 pb-0.5 pt-1.5 text-xs text-muted-foreground">{t(`group.${g}`)}</p>
						{(statusProperty?.options ?? [])
							.filter((o) => (o.group ?? "todo") === g)
							.map((o) => (
								<MenuItem
									active={o.id === selected}
									icon={<StatusGlyph option={o} size={14} />}
									key={o.id}
									onClick={() => (close(), void setStatus(item, o.id, repo))}
								>
									{o.name}
								</MenuItem>
							))}
					</div>
				))
			}
		</Popover>
	);
}

/** Open entries with a status somewhere below (they would stay open if this is closed). */
function openBelow(item: Item, repo: Repo = current): Item[] {
	const ix = repo.index();
	return ix.items(ix.descendants(item.id)).filter((x) => {
		const s = statusOf(x, ix.schemaOf(x));
		return !!s && s.group !== "done";
	});
}

/**
 * Set a status the careful way: closing something with open entries below asks first, and
 * closing says "Done · Undo". Returns false if the user said no.
 */
export async function setStatus(
	item: Item,
	optionId: string,
	repo: Repo = current,
): Promise<boolean> {
	const ix = repo.index();
	const schema = ix.schemaOf(item);
	const statusProperty = statusProp(schema);
	const option = statusProperty?.options?.find((o) => o.id === optionId);
	if (!statusProperty || !option) return false;
	const before = item.props[statusProperty.id];
	const closing = (option.group ?? "todo") === "done" && !isDone(item, schema);
	if (closing) {
		const open = openBelow(item, repo);
		if (open.length) {
			const ok = await confirmAction({
				title: tr("tick.openTitle", { title: titleOf(item) }),
				body: tr("tick.openBody", {
					count: open.length,
					titles: open
						.slice(0, 3)
						.map((x) => `„${x.title}“`)
						.join(", "),
				}),
				yes: tr("tick.closeAnyway", { name: option.name }),
			});
			if (!ok) return false;
		}
	}
	repo.setProp(item.id, statusProperty.id, optionId);
	if (closing)
		notify.undo(tr("tick.done", { title: titleOf(item), name: option.name }), () =>
			repo.setProp(item.id, statusProperty.id, (before as string) ?? null),
		);
	return true;
}

export function Group({
	heading,
	count,
	first,
	children,
}: {
	heading?: React.ReactNode;
	count?: number;
	first?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div className={first ? undefined : "mt-2"}>
			{heading !== undefined && (
				<p className="truncate px-2 pb-1 pt-2 text-xs font-semibold text-muted-foreground">
					{heading}
					{count !== undefined && ` · ${count}`}
				</p>
			)}
			{children}
		</div>
	);
}

export function pathLabel(ids: string[], repo: Repo = current) {
	return repo.index().pathText(ids);
}

/** Where an entry lives, short: the last two places of its home path ("… › Frankreich › Nordlicht"). */
export function shortPath(ids: string[], keep = 2, repo: Repo = current): string {
	const label = pathLabel(ids.slice(-keep), repo);
	return ids.length > keep ? `… › ${label}` : label;
}

export function ItemRow({
	item,
	path,
	sub,
	note,
}: {
	item: Item;
	path?: string[]; // ancestors to show under the title
	sub?: number; // depth as sub-item
	note?: React.ReactNode; // a second line, e.g. a project's next task
}) {
	const { t, lang } = useT();
	const repo = useRepo();
	const hrefOf = useItemHref();
	const ix = repo.index();
	const schema = ix.schemaOf(item);
	const status = statusOf(item, schema);
	const done = status?.group === "done";
	const due = dueOf(item, schema);
	const progress = ix.progressOf(item);
	const blocked = !!status && !done && ix.isBlocked(item);
	return (
		<div
			className={cn(
				"tap-row group flex min-h-11 items-center gap-2.5 rounded-lg px-2 py-1 hover:bg-hover max-md:min-h-[52px]",
				!!sub && "pl-[calc(8px+var(--depth)*24px)] max-sm:pl-[calc(8px+var(--depth)*14px)]",
			)}
			data-id={item.id}
			style={sub ? ({ "--depth": sub } as React.CSSProperties) : undefined}
		>
			<RowStatus item={item} />
			<a
				className="flex min-w-0 flex-1 flex-col justify-center self-stretch"
				href={hrefOf(item.id)}
			>
				{/* on a phone the title may take two lines: its telling part is often at the end */}
				<span
					className={cn(
						"block text-sm max-md:text-[15px] max-sm:line-clamp-2 sm:truncate",
						done && "text-muted-foreground line-through",
					)}
				>
					{titleOf(item, t)}
				</span>
				{path && path.length > 0 && (
					<span className="block truncate text-xs text-muted-foreground" title={pathLabel(path)}>
						{shortPath(path)}
					</span>
				)}
				{note && <span className="block truncate text-xs text-muted-foreground">{note}</span>}
			</a>
			{/* the shape tells the status; words only for what deviates */}
			{blocked && <span className="shrink-0 text-xs text-warn">{t("row.blocked")}</span>}
			{progress && progress.total > 0 && (
				<ProgressCount
					className="w-10 shrink-0 text-right text-xs text-muted-foreground"
					done={progress.done}
					total={progress.total}
				/>
			)}
			{due && <DueLabel done={done} due={due} />}
			{item.file && (
				<span className="shrink-0 text-xs text-muted-foreground">
					{fmtBytes(lang, item.file.size)}
				</span>
			)}
		</div>
	);
}

/** A click opens the status menu, whatever its type; the type's icon follows. Without a status only the icon. */
export function RowStatus({ item, size = 17 }: { item: Item; size?: number }) {
	const { t } = useT();
	const repo = useRepo();
	const ix = repo.index();
	const st = statusOf(item, ix.schemaOf(item));
	if (!st) return <ItemIcon item={item} size={size - 1} />;
	// the shape in the option's colour (as on its pill): open grey, running amber, done green …
	const done = st.group === "done";
	const color = done
		? "var(--ok)"
		: st.option.color && st.option.color !== "gray"
			? pal(st.option.color)
			: undefined;
	// the type's icon follows, so a project and a task look different
	return (
		<>
			<StatusMenu
				item={item}
				trigger={(p) => (
					<Button
						variant="plain"
						{...p}
						aria-label={t("row.status", { name: st.option.name })}
						className="tap-edge shrink-0 text-muted-foreground"
						title={st.option.name}
					>
						<span style={{ color }}>
							<StatusGlyph option={st.option} size={size} />
						</span>
					</Button>
				)}
			/>
			<ItemIcon item={item} size={size - 3} />
		</>
	);
}

/** Keep the given order, but put sub-items right after their listed parent (any depth). */
export function treeOrder(items: Item[], repo: Repo = current): { item: Item; depth: number }[] {
	const ix = repo.index();
	const ids = new Set(items.map((i) => i.id));
	const parentOf = (i: Item) => ix.parentsOf(i.id).find((p) => ids.has(p));
	const kids = new Map<string, Item[]>();
	const roots: Item[] = [];
	for (const i of items) {
		const p = parentOf(i);
		if (p) (kids.get(p) ?? kids.set(p, []).get(p)!).push(i);
		else roots.push(i);
	}
	const out: { item: Item; depth: number }[] = [];
	const seen = new Set<string>();
	const walk = (i: Item, depth: number) => {
		if (seen.has(i.id)) return;
		seen.add(i.id);
		out.push({ item: i, depth });
		for (const k of kids.get(i.id) ?? []) walk(k, depth + 1);
	};
	for (const r of roots) walk(r, 0);
	for (const i of items) walk(i, 0); // cycles or parents outside: never lose an item
	return out;
}
