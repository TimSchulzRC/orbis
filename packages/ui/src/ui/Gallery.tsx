import { fmtDuration } from "@orbis/core/i18n";
import type { Item } from "@orbis/core/model";
import type { EvalCtx } from "@orbis/core/query";
import { plainText } from "@orbis/core/search";
import { statusOf } from "@orbis/core/traits";
import { files, useBlobUrl } from "../files";
import { itemHref } from "../hooks";
import { titleOf, useT } from "../i18n";
import { repo } from "../repo";
import { ItemIcon, StatusPill } from "./item-look";
import { ProgressCount } from "./progress";

export function GalleryView({ items, ctx }: { items: Item[]; ctx: EvalCtx }) {
	return (
		<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 @3xl:grid-cols-4">
			{items.map((i) => (
				<GalleryTile ctx={ctx} item={i} key={i.id} />
			))}
		</div>
	);
}

function firstImage(item: Item): string | undefined {
	if (item.file)
		return item.file.thumb ?? (item.file.filetype === "image" ? item.file.display : undefined);
	const ix = repo.index();
	for (const link of ix.textLinks(item)) {
		const file = ix.get(link.to)?.file;
		if (link.embed && file?.filetype === "image") return file.thumb ?? file.display;
	}
	return undefined;
}

function GalleryTile({ item, ctx }: { item: Item; ctx: EvalCtx }) {
	const { t } = useT();
	const hash = firstImage(item);
	const url = useBlobUrl(hash, true);
	const f = item.file;
	// no picture: a compact text card rather than an empty image area
	if (!hash && !f) {
		const schema = ctx.ix.schemaOf(item);
		const status = statusOf(item, schema);
		const progress = ctx.ix.progressOf(item);
		const hasProgress = !!progress && progress.total > 0;
		const text = plainText(item.body);
		return (
			<a
				className="group flex min-w-0 flex-col gap-1.5 self-start rounded-xl border border-line bg-surface p-3 hover:bg-hover"
				href={itemHref(item.id)}
			>
				<span className="flex min-w-0 items-start gap-1.5 text-sm font-medium">
					<ItemIcon className="mt-0.5 shrink-0" item={item} size={14} />
					<span className="line-clamp-2">{titleOf(item, t)}</span>
				</span>
				{text && <span className="line-clamp-2 text-xs text-muted-foreground">{text}</span>}
				{(status || hasProgress) && (
					<span className="flex items-center gap-2 text-xs text-muted-foreground">
						{status && <StatusPill group={status.group} option={status.option} small />}
						{hasProgress && (
							<ProgressCount className="ml-auto" done={progress.done} total={progress.total} />
						)}
					</span>
				)}
			</a>
		);
	}
	const meta = f
		? [
				t(`filetype.${f.filetype}`),
				f.pages ? t("file.pages", { count: f.pages }) : "",
				f.duration ? fmtDuration(f.duration) : "",
			]
				.filter(Boolean)
				.join(" · ")
		: "";
	return (
		<a className="group min-w-0" href={itemHref(item.id)}>
			<div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl border border-line bg-surface-2">
				{url ? (
					<img
						alt=""
						className="size-full object-cover transition-transform group-hover:scale-[1.02]"
						src={url}
					/>
				) : files.isMissing(hash) || files.isMissing(f?.hash) ? (
					<span className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
						<ItemIcon item={item} size={24} /> {t(files.missingKey(item.created))}
					</span>
				) : (
					<ItemIcon item={item} size={28} />
				)}
			</div>
			<p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs font-medium">
				<ItemIcon item={item} size={12} />
				<span className="truncate">{titleOf(item, t)}</span>
			</p>
			{meta && <p className="truncate text-xs text-muted-foreground">{meta}</p>}
		</a>
	);
}
