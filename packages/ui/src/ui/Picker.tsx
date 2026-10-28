import { Button as ShadcnButton } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import { type Item, META_TYPE } from "@obtion/core/model";
import { isOverview } from "@obtion/core/placement";
import { useT } from "../i18n";
import { useIndex, useRepo } from "../hooks";
import { Dialog, ItemIcon, cx } from "./bits";

/** Pick an item: suggestions first, then search as you type. Optionally create a new one. */
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
  suggestions?: { id: string; reason: string }[];
  onCreate?: (title: string) => void;
}) {
  const { t } = useT();
  const repo = useRepo();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const ok = (i: Item) => (!exclude || !exclude(i)) && (!filter || filter(i)) && i.type !== META_TYPE;
  const sugg = q.trim() ? [] : suggestions.filter((s) => repo.get(s.id) && ok(repo.get(s.id)!));
  // overviews (items with children) first: they are the usual places
  const ix = repo.index();
  const found = (q.trim() ? repo.search(q, 60) : repo.live().sort((a, b) => b.updated - a.updated))
    .filter(ok)
    .sort((a, b) => Number(isOverview(b, ix)) - Number(isOverview(a, ix)))
    .filter((i) => !sugg.some((s) => s.id === i.id))
    .slice(0, 12);
  const rows: { id?: string; reason?: string; create?: string }[] = [...sugg, ...found.map((i) => ({ id: i.id }))];
  if (onCreate && q.trim() && !found.some((i) => i.title.toLowerCase() === q.trim().toLowerCase())) rows.push({ create: q.trim() });
  const pick = (r?: (typeof rows)[number]) => {
    if (!r) return;
    if (r.create) onCreate!(r.create);
    else onPick(r.id!);
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <Input
        autoFocus
        value={q}
        onChange={(e) => (setQ(e.target.value), setSel(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(rows.length - 1, s + 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
          else if (e.key === "Enter") (e.preventDefault(), pick(rows[sel]));
        }}
        placeholder={t("picker.search")}
        className="mb-2 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-[var(--focus)]"
      />
      {sugg.length > 0 && <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{t("picker.suggested")}</p>}
      <div className="flex flex-col">
        {rows.map((r, i) => {
          const item = r.id ? repo.get(r.id) : undefined;
          return (
            <ShadcnButton variant="plain" size="none"
              key={r.id ?? "create"}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(r)}
              className={cx("flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", i === sel && "bg-selected", i === sugg.length && sugg.length > 0 && "mt-2")}
            >
              {item ? <ItemIcon item={item} size={15} /> : <Plus size={15} className="text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{item ? item.title || t("untitled") : t("picker.create", { title: r.create })}</span>
              {r.reason && (
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  {r.reason === "agent" && <Sparkles size={11} />}
                  {t("picker.reason." + r.reason)}
                </span>
              )}
              {item && !r.reason && <PathHint item={item} />}
            </ShadcnButton>
          );
        })}
        {!rows.length && <p className="px-2 py-2 text-sm text-muted-foreground">{t("picker.none")}</p>}
      </div>
    </Dialog>
  );
}

function PathHint({ item }: { item: Item }) {
  const ix = useIndex();
  const path = ix.homePath(item.id);
  if (!path.length) return null;
  return <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{path.map((id) => ix.get(id)?.title).join(" › ")}</span>;
}
