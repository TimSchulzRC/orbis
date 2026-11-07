import type { Item } from "@obtion/core/model";
import type { EvalCtx } from "@obtion/core/query";
import { fmtDuration } from "@obtion/core/i18n";
import { statusOf } from "@obtion/core/traits";
import { plainText } from "@obtion/core/search";
import { repo } from "../repo";
import { itemHref } from "../hooks";
import { useT, titleOf } from "../i18n";
import { files, useBlobUrl } from "../files";
import { ItemIcon, StatusPill } from "./item-look";
import { ProgressCount } from "./progress";

export function GalleryView({ items, ctx }: { items: Item[]; ctx: EvalCtx }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 @3xl:grid-cols-4">
      {items.map((i) => (
        <GalleryTile key={i.id} item={i} ctx={ctx} />
      ))}
    </div>
  );
}

function firstImage(item: Item): string | undefined {
  if (item.file) return item.file.thumb ?? (item.file.filetype === "image" ? item.file.display : undefined);
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
      <a href={itemHref(item.id)} className="group flex min-w-0 flex-col gap-1.5 self-start rounded-xl border border-line bg-surface p-3 hover:bg-hover">
        <span className="flex min-w-0 items-start gap-1.5 text-sm font-medium">
          <ItemIcon item={item} size={14} className="mt-0.5 shrink-0" />
          <span className="line-clamp-2">{titleOf(item, t)}</span>
        </span>
        {text && <span className="line-clamp-2 text-xs text-muted-foreground">{text}</span>}
        {(status || hasProgress) && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {status && <StatusPill option={status.option} group={status.group} small />}
            {hasProgress && <ProgressCount done={progress.done} total={progress.total} className="ml-auto" />}
          </span>
        )}
      </a>
    );
  }
  const meta = f ? [t("filetype." + f.filetype), f.pages ? t("file.pages", { count: f.pages }) : "", f.duration ? fmtDuration(f.duration) : ""].filter(Boolean).join(" · ") : "";
  return (
    <a href={itemHref(item.id)} className="group min-w-0">
      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl border border-line bg-surface-2">
        {url ? (
          <img src={url} alt="" className="size-full object-cover transition-transform group-hover:scale-[1.02]" />
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
