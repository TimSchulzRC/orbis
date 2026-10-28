import { RotateCcw } from "lucide-react";
import type { Item } from "@obtion/core/model";
import { cascadeCount } from "@obtion/core/trash";
import { isInInbox } from "@obtion/core/placement";
import { notify } from "../ui/feedback";
import { useRepo } from "../hooks";
import { SpaceEyebrow } from "../ui/Spaces";
import { useT } from "../i18n";
import { Button, Empty, ItemIcon, RelTime } from "../ui/bits";

export function TrashView() {
  const r = useRepo();
  const { t } = useT();
  // Items deleted together with a root are listed with it and come back with it.
  const withRoot = (i: Item) => !!i.deletedVia && !!r.records.get(i.deletedVia)?.deleted;
  const items = [...r.records.values()].filter((i) => i.deleted && !withRoot(i) && (i.kind === "info" || i.kind === "datei")).sort((a, b) => b.updated - a.updated);
  // where it was: its home and the homes above (so two "R&S" in the trash can be told apart)
  const pathOf = (i: Item) => {
    const out: string[] = [];
    let id = i.home ?? Object.keys(i.parents)[0];
    for (let n = 0; id && n < 4; n++) {
      const p = r.records.get(id);
      if (!p) break;
      out.unshift(p.title || t("untitled"));
      id = p.home ?? Object.keys(p.parents)[0];
    }
    return out;
  };
  const restore = (i: Item) => {
    r.restore(i.id);
    // say where it went once the index has it back
    setTimeout(() => {
      const ix = r.index();
      const now = ix.get(i.id);
      const path = now ? ix.homePath(i.id).map((p) => ix.get(p)?.title) : [];
      const title = i.title || t("untitled");
      notify(path.length ? t("trash.restoredUnder", { title, place: path.join(" › ") }) : now && isInInbox(now, ix) ? t("trash.restoredInbox", { title }) : t("trash.restored", { title }));
    }, 50);
  };
  return (
    <div className="page-read">
      <SpaceEyebrow />
      <h1 className="mb-1 page-title">{t("nav.trash")}</h1>
      <p className="mb-5 text-sm text-muted-foreground">{t("trash.intro")}</p>
      {items.length ? (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-3 py-2">
              <ItemIcon item={i} size={15} />
              <span className="flex min-w-0 flex-1 flex-col">
                <a href={`#/i/${encodeURIComponent(i.id)}`} className="truncate hover:underline">
                  {i.title || t("untitled")}
                </a>
                {pathOf(i).length > 0 && <span className="truncate text-xs text-muted-foreground">{pathOf(i).join(" › ")}</span>}
              </span>
              {cascadeCount(r.records, i.id) > 0 && <span className="text-xs text-muted-foreground">{t("trash.withChildren", { count: cascadeCount(r.records, i.id) })}</span>}
              <span className="text-xs text-muted-foreground">
                <RelTime ts={i.updated} />
              </span>
              <Button onClick={() => restore(i)}>
                <RotateCcw size={14} /> {t("item.restore")}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title={t("trash.empty")} />
      )}
    </div>
  );
}
