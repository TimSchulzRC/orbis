import { useState } from "react";
import { Search as SearchIcon } from "lucide-react";
import { type Cond, parseQuery } from "../../shared/query";
import { snippet } from "../../shared/search";
import { useIndex, useRoute, itemHref } from "../hooks";
import { repo } from "../repo";
import { useT, tr } from "../i18n";
import { ItemIcon } from "../ui/bits";
import { Results } from "../ui/Results";
import { shortPath } from "../ui/Row";

/** "type:Gibtsnicht" → "Typ „Gibtsnicht“ gibt es nicht – meintest du „Buch“?" */
function explain(err: string, ix: ReturnType<typeof useIndex>): string {
  const [kind, ...rest] = err.split(":");
  const value = rest.join(":");
  if (kind === "type") {
    const names = [...ix.types.values()].map((x) => x.schema!.name);
    const near = names.find((n) => distance(n.toLowerCase(), value.toLowerCase()) <= 2 || n.toLowerCase().startsWith(value.toLowerCase().slice(0, 3)));
    return near ? tr("search.unknownTypeNear", { name: value, near }) : tr("search.unknownType", { name: value, list: names.join(", ") });
  }
  if (kind === "link") return tr("search.unknownLink", { name: value });
  return err;
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

function onlyText(c: Cond): boolean {
  if ("text" in c) return true;
  if ("and" in c) return c.and.every(onlyText);
  if ("or" in c) return c.or.every(onlyText);
  return false;
}

/** Full-text search; input that reads as a query (typ:, #tag, unter: …) runs as one, and */
export function SearchView() {
  const { t } = useT();
  const ix = useIndex();
  const route = useRoute();
  const [q, setQ] = useState(route.query.get("q") ?? "");
  const parsed = parseQuery(q, ix);
  // A query is anything the parser reads as more than plain words – in every language of the catalogs.
  const isQuery = !!parsed.def.where && !parsed.errors.length && !onlyText(parsed.def.where);
  const hits = !isQuery && q.trim() ? repo.search(q, 60) : [];
  return (
    <div className="page-read">
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 focus-within:border-[var(--focus)]">
        <SearchIcon size={16} className="text-muted" />
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            history.replaceState(null, "", `#/search?q=${encodeURIComponent(e.target.value)}`);
          }}
          placeholder={t("search.placeholder")}
          className="flex-1 bg-transparent text-base outline-none"
        />
      </div>
      {parsed.errors.length > 0 ? (
        <p className="mt-1.5 text-xs text-warn">{t("search.notUnderstood", { list: parsed.errors.map((e) => explain(e, ix)).join(" · ") })}</p>
      ) : (
        <p className="mt-1.5 text-xs text-muted">{t("search.hint")}</p>
      )}
      <div className="mt-5">
        {isQuery ? (
          <Results def={parsed.def} />
        ) : (
          <ul className="space-y-1">
            {hits.map((h) => (
              <li key={h.id}>
                <a href={itemHref(h.id)} className="-mx-2 block rounded-lg px-2 py-1.5 hover:bg-hover">
                  <span className="flex items-center gap-2 font-medium">
                    <ItemIcon item={h} size={15} /> {h.title || t("untitled")}
                  </span>
                  {ix.homePath(h.id).length > 0 && <span className="block truncate pl-6 text-xs text-muted">{shortPath(ix.homePath(h.id))}</span>}
                  {(h.body || h.file?.text) && <span className="mt-0.5 line-clamp-2 block pl-6 text-sm text-muted">{snippet(h.body || h.file?.text || "", q, 180)}</span>}
                </a>
              </li>
            ))}
            {q.trim() && !hits.length && <p className="text-sm text-muted">{t("search.none")}</p>}
          </ul>
        )}
      </div>
    </div>
  );
}
