// A view as a gallery: a tile per entry with its picture (a file, the first image in its text),
// a compact text card where there is none.
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
  if (item.file) return item.file.thumb ?? (item.file.filetype === "bild" ? item.file.display : undefined);
  const ix = repo.index();
  for (const l of ix.textLinks(item)) {
    const f = ix.get(l.to)?.file;
    if (l.embed && f?.filetype === "bild") return f.thumb ?? f.display;
  }
  return undefined;
}

function GalleryTile({ item, ctx }: { item: Item; ctx: EvalCtx }) {
  const { t } = useT();
  const hash = firstImage(item);
  const url = useBlobUrl(hash, true);
  const f = item.file;
  // nothing to show as a picture: a compact text card (title, status, progress, a line of text), no empty image area
  if (!hash && !f) {
    const schema = ctx.ix.schemaOf(item);
    const st = statusOf(item, schema);
    const pr = ctx.ix.progressOf(item);
    const text = plainText(item.body);
    return (
      <a href={itemHref(item.id)} className="group flex min-w-0 flex-col gap-1.5 self-start rounded-xl border border-line bg-surface p-3 hover:bg-hover">
        <span className="flex min-w-0 items-start gap-1.5 text-sm font-medium">
          <ItemIcon item={item} size={14} className="mt-0.5 shrink-0" />
          <span className="line-clamp-2">{titleOf(item, t)}</span>
        </span>
        {text && <span className="line-clamp-2 text-xs text-muted-foreground">{text}</span>}
        {(st || (pr && pr.total > 0)) && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {st && <StatusPill option={st.option} group={st.group} small />}
            {pr && pr.total > 0 && <ProgressCount done={pr.done} total={pr.total} className="ml-auto" />}
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
