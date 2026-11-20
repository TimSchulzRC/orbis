import { fmtDate, fmtNumber } from "@orbis/core/i18n";
import type { Item } from "@orbis/core/model";
import { type EvalCtx, fieldOf } from "@orbis/core/query";
import { itemHref } from "../hooks";
import { useT } from "../i18n";
import { StatusPill, Tag } from "./item-look";
import { ProgressCount } from "./progress";

// Shared by Results, Table and Board; kept apart so those three don't import each other in a circle.

export function defaultColumns(items: Item[], ctx: EvalCtx): string[] {
	const names: string[] = [];
	for (const i of items.slice(0, 50)) {
		for (const p of ctx.ix.schemaOf(i)?.properties ?? [])
			if (!names.includes(p.name)) names.push(p.name);
		for (const n of Object.keys(i.extra)) if (!names.includes(n)) names.push(n);
	}
	return names.slice(0, 6);
}

export function CellValue({ item, name, ctx }: { item: Item; name: string; ctx: EvalCtx }) {
	const { lang } = useT();
	if (name === "tags")
		return (
			<span className="flex flex-wrap gap-1">
				{item.tags.map((x) => (
					<Tag key={x} tag={x} />
				))}
			</span>
		);
	const hit = fieldOf(item, name, ctx.ix);
	// computed progress reads as "2/7", like in rows and on the page (the query value stays a percentage)
	if (hit?.prop?.kind === "computed" && hit.prop.computed?.fn !== "count") {
		const progress = ctx.ix.progress(item.id, hit.prop.computed?.of);
		return (
			<ProgressCount
				className={progress.total ? undefined : "text-muted-foreground"}
				done={progress.done}
				total={progress.total}
			/>
		);
	}
	const empty =
		!hit ||
		hit.value === undefined ||
		hit.value === null ||
		hit.value === "" ||
		(Array.isArray(hit.value) && !hit.value.length);
	if (empty) return <span className="text-faint">–</span>;
	const v = hit.value;
	if (hit.kind === "item") {
		const target = ctx.ix.get(String(v));
		return target ? (
			<a className="hover:underline" href={itemHref(target.id)}>
				{target.title || "–"}
			</a>
		) : (
			<span className="text-faint">–</span>
		);
	}
	if (hit.kind === "select" || hit.kind === "status") {
		const ids = Array.isArray(v) ? (v as string[]) : [String(v)];
		return (
			<span className="flex flex-wrap gap-1">
				{ids.map((id) => {
					const option = hit.prop?.options?.find((o) => o.id === id);
					return option ? (
						<StatusPill key={id} option={option} small />
					) : (
						<span key={id}>{id}</span>
					);
				})}
			</span>
		);
	}
	if (hit.kind === "relation")
		return (
			<span className="flex flex-wrap gap-x-2">
				{(v as string[]).map((id) => {
					const target = ctx.ix.get(id);
					return target ? (
						<a className="hover:underline" href={itemHref(id)} key={id}>
							{target.title}
						</a>
					) : null;
				})}
			</span>
		);
	if (hit.kind === "date")
		return (
			<span className="whitespace-nowrap">
				{String(v)
					.split("/")
					.map((d) => fmtDate(lang, d))
					.join(" – ")}
			</span>
		);
	if (hit.kind === "number")
		return (
			<span className="tabular-nums">{typeof v === "number" ? fmtNumber(lang, v) : String(v)}</span>
		);
	if (hit.kind === "checkbox") return <span>{v ? "✓" : "–"}</span>;
	if (hit.kind === "url")
		return (
			<a className="text-link hover:underline" href={String(v)} rel="noopener" target="_blank">
				{String(v).replace(/^https?:\/\//, "")}
			</a>
		);
	// long text stays two lines in tables and boards; the full text is on the page
	return <span className="line-clamp-2">{Array.isArray(v) ? v.join(", ") : String(v)}</span>;
}
