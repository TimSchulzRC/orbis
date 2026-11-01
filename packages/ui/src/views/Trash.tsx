// The trash of the workspaces seen (chosen like in the inbox), newest first.
import { RotateCcw } from "lucide-react";
import type { Item } from "@obtion/core/model";
import type { Repo } from "@obtion/sync";
import { cascadeCount } from "@obtion/core/trash";
import { isInInbox } from "@obtion/core/placement";
import { notify } from "../ui/feedback";
import { itemHref, useRepo, useDocumentTitle } from "../hooks";
import { useAccounts } from "../accounts";
import { SpaceFilter, SpaceScope, useReplicas } from "../ui/Spaces";
import { useT, titleOf } from "../i18n";
import { Button, Empty } from "../ui/primitives";
import { ItemIcon, RelTime } from "../ui/item-look";

/** What a workspace's trash lists: items deleted together with a root are listed with it and come back with it. */
function trashed(r: Repo): Item[] {
  const withRoot = (i: Item) => !!i.deletedVia && !!r.records.get(i.deletedVia)?.deleted;
  return [...r.records.values()].filter((i) => i.deleted && !withRoot(i) && (i.kind === "info" || i.kind === "datei"));
}

export function TrashView() {
  const { t } = useT();
  const { spaces, shown } = useAccounts();
  useDocumentTitle(t("nav.trash"));
  const repos = useReplicas(shown.map((s) => s.id));
  const items = shown.flatMap((s, n) => trashed(repos[n]!).map((item) => ({ item, space: s }))).sort((a, b) => b.item.updated - a.item.updated);
  return (
    <div className="page-read">
      <h1 className="mb-1 page-title">{t("nav.trash")}</h1>
      <p className="mb-5 text-sm text-muted-foreground">{t("trash.intro")}</p>
      <SpaceFilter />
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

/** One deleted item in its workspace's scope; `space`: the workspace's name, with several. */
function TrashRow({ item: i, space }: { item: Item; space?: string }) {
  const r = useRepo();
  const { t } = useT();
  // where it was: its home and the homes above (so two "R&S" in the trash can be told apart)
  const path: string[] = [];
  let id = i.home ?? Object.keys(i.parents)[0];
  for (let n = 0; id && n < 4; n++) {
    const p = r.records.get(id);
    if (!p) break;
    path.unshift(titleOf(p, t));
    id = p.home ?? Object.keys(p.parents)[0];
  }
  const where = [space, path.join(" › ")].filter(Boolean).join(" · ");
  const children = cascadeCount(r.records, i.id);
  const restore = () => {
    r.restore(i.id);
    // say where it went once the index has it back
    setTimeout(() => {
      const ix = r.index();
      const now = ix.get(i.id);
      const home = now ? ix.homePath(i.id) : [];
      const title = titleOf(i, t);
      notify(home.length ? t("trash.restoredUnder", { title, place: ix.pathText(home) }) : now && isInInbox(now, ix) ? t("trash.restoredInbox", { title }) : t("trash.restored", { title }));
    }, 50);
  };
  return (
    <>
      <ItemIcon item={i} size={15} />
      <span className="flex min-w-0 flex-1 flex-col">
        <a href={itemHref(i.id)} className="truncate hover:underline">
          {titleOf(i, t)}
        </a>
        {where && <span className="truncate text-xs text-muted-foreground">{where}</span>}
      </span>
      {children > 0 && <span className="text-xs text-muted-foreground">{t("trash.withChildren", { count: children })}</span>}
      <span className="text-xs text-muted-foreground">
        <RelTime ts={i.updated} />
      </span>
      <Button onClick={restore}>
        <RotateCcw size={14} /> {t("item.restore")}
      </Button>
    </>
  );
}
