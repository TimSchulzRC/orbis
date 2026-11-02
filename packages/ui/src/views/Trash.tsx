import { useState } from "react";
import { RotateCcw } from "lucide-react";
import type { Item } from "@obtion/core/model";
import type { Repo } from "@obtion/sync";
import { cascadeCount } from "@obtion/core/trash";
import { isInInbox } from "@obtion/core/placement";
import { notify } from "../ui/feedback";
import { useItemHref, useRepo, useDocumentTitle } from "../hooks";
import { useAccounts } from "../accounts";
import { SpaceFilter, SpaceScope, useReplicas } from "../ui/Spaces";
import { useT, titleOf } from "../i18n";
import { Button, Empty } from "../ui/primitives";
import { ItemIcon, RelTime } from "../ui/item-look";

/** Items deleted together with a root are listed with it and come back with it. */
function trashed(repo: Repo): Item[] {
  const withRoot = (i: Item) => !!i.deletedVia && !!repo.records.get(i.deletedVia)?.deleted;
  return [...repo.records.values()].filter((i) => i.deleted && !withRoot(i) && (i.kind === "info" || i.kind === "datei"));
}

export function TrashView() {
  const { t } = useT();
  const { spaces } = useAccounts();
  useDocumentTitle(t("nav.trash"));
  // its own choice of workspaces; null: all
  const [only, setOnly] = useState<string[] | null>(null);
  const chosen = spaces.filter((s) => !only || only.includes(s.id));
  const repos = useReplicas(chosen.map((s) => s.id));
  const items = chosen.flatMap((s, n) => trashed(repos[n]!).map((item) => ({ item, space: s }))).sort((a, b) => b.item.updated - a.item.updated);
  return (
    <div className="page-read">
      <h1 className="mb-1 page-title">{t("nav.trash")}</h1>
      <p className="mb-5 text-sm text-muted-foreground">{t("trash.intro")}</p>
      <SpaceFilter value={only} onChange={setOnly} />
      {items.length ? (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {items.map(({ item, space }) => (
            <li key={`${space.id}:${item.id}`} className="flex items-center gap-3 px-3 py-2">
              <SpaceScope id={space.id}>
                <TrashRow item={item} space={spaces.length > 1 ? space.name : undefined} />
              </SpaceScope>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title={t("trash.empty")} />
      )}
    </div>
  );
}

/** `space`: the workspace's name, with several. */
function TrashRow({ item, space }: { item: Item; space?: string }) {
  const repo = useRepo();
  const itemHref = useItemHref();
  const { t } = useT();
  // where it was: its home and the homes above (so two "R&S" in the trash can be told apart)
  const path: string[] = [];
  let id = item.home ?? Object.keys(item.parents)[0];
  for (let n = 0; id && n < 4; n++) {
    const place = repo.records.get(id);
    if (!place) break;
    path.unshift(titleOf(place, t));
    id = place.home ?? Object.keys(place.parents)[0];
  }
  const where = [space, path.join(" › ")].filter(Boolean).join(" · ");
  const children = cascadeCount(repo.records, item.id);
  const restore = () => {
    repo.restore(item.id);
    // say where it went once the index has it back
    setTimeout(() => {
      const ix = repo.index();
      const now = ix.get(item.id);
      const home = now ? ix.homePath(item.id) : [];
      const title = titleOf(item, t);
      if (home.length) notify(t("trash.restoredUnder", { title, place: ix.pathText(home) }));
      else notify(now && isInInbox(now, ix) ? t("trash.restoredInbox", { title }) : t("trash.restored", { title }));
    }, 50);
  };
  return (
    <>
      <ItemIcon item={item} size={15} />
      <span className="flex min-w-0 flex-1 flex-col">
        <a href={itemHref(item.id)} className="truncate hover:underline">
          {titleOf(item, t)}
        </a>
        {where && <span className="truncate text-xs text-muted-foreground">{where}</span>}
      </span>
      {children > 0 && <span className="text-xs text-muted-foreground">{t("trash.withChildren", { count: children })}</span>}
      <span className="text-xs text-muted-foreground">
        <RelTime ts={item.updated} />
      </span>
      <Button onClick={restore}>
        <RotateCcw size={14} /> {t("item.restore")}
      </Button>
    </>
  );
}
