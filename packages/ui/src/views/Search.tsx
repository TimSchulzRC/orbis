import { Input } from "../components/ui/input";
import { useState } from "react";
import { Search as SearchIcon } from "lucide-react";
import { type Cond, parseQuery } from "@obtion/core/query";
import { snippet } from "@obtion/core/search";
import type { Index } from "@obtion/core/graph";
import { useRoute, itemPath, spaceHref, useDocumentTitle } from "../hooks";
import { useAccounts } from "../accounts";
import { SpaceScope, useReplicas } from "../ui/Spaces";
import { useT, tr, titleOf } from "../i18n";
import { InTray, ItemIcon } from "../ui/item-look";
import { Results } from "../ui/Results";
import { shortPath } from "../ui/Row";

/** "type:Gibtsnicht" → "Typ „Gibtsnicht“ gibt es nicht – meintest du „Buch“?" */
function explain(err: string, ix: Index): string {
  const [kind, ...rest] = err.split(":");
  const value = rest.join(":");
  if (kind === "type") {
    const names = [...ix.types.values()].map((x) => x.schema.name);
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

/** Input that parses as a query runs as one in each workspace that understands it (types and places are per workspace). */
export function SearchView() {
  const { t } = useT();
  useDocumentTitle(t("nav.search"));
  const { shown } = useAccounts();
  const repos = useReplicas(shown.map((s) => s.id));
  const route = useRoute();
  const [q, setQ] = useState(route.query.get("q") ?? "");
  const per = shown.map((s, n) => {
    const ix = repos[n]!.index();
    return { space: s, repo: repos[n]!, ix, parsed: parseQuery(q, ix) };
  });
  // A query is anything the parser reads as more than plain words – in every language of the catalogs.
  const understood = per.filter((p) => !!p.parsed.def.where && !p.parsed.errors.length && !onlyText(p.parsed.def.where));
  const isQuery = understood.length > 0;
  const errors = isQuery ? undefined : (per.find((p) => p.parsed.errors.length) ?? per[0]);
  const hits = per.map((p) => ({ ...p, hits: !isQuery && q.trim() ? p.repo.search(q, 60) : [] }));
  const several = shown.length > 1;
  return (
    <div className="page-read">
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 focus-within:border-focus">
        <SearchIcon size={16} className="text-muted-foreground" />
        <Input
          variant="bare"
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
      {errors && errors.parsed.errors.length > 0 ? (
        <p className="mt-1.5 text-xs text-warn">{t("search.notUnderstood", { list: errors.parsed.errors.map((e) => explain(e, errors.ix)).join(" · ") })}</p>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">{t("search.hint")}</p>
      )}
      <div className="mt-5">
        {isQuery ? (
          understood.map((p) => (
            <SpaceScope key={p.space.id} id={p.space.id}>
              {several && <h2 className="mb-1 mt-6 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground first:mt-0">{p.space.name}</h2>}
              <Results def={p.parsed.def} />
            </SpaceScope>
          ))
        ) : (
          <ul className="space-y-1">
            {hits.flatMap(({ space, ix, hits }) => [
              several && hits.length > 0 && (
                <li key={space.id} className="pt-4 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground first:pt-0">
                  {space.name}
                </li>
              ),
              ...hits.map((h) => (
              <li key={`${space.id}/${h.id}`}>
                <a href={spaceHref(space.id, itemPath(h.id))} className="-mx-2 block rounded-lg px-2 py-1.5 hover:bg-hover">
                  <span className="flex items-center gap-2 font-medium">
                    <ItemIcon item={h} size={15} /> {titleOf(h, t)} <InTray item={h} ix={ix} />
                  </span>
                  {ix.homePath(h.id).length > 0 && <span className="block truncate pl-6 text-xs text-muted-foreground">{shortPath(ix.homePath(h.id))}</span>}
                  {(h.body || h.file?.text) && <span className="mt-0.5 line-clamp-2 block pl-6 text-sm text-muted-foreground">{snippet(h.body || h.file?.text || "", q, 180)}</span>}
                </a>
              </li>
              )),
            ])}
            {q.trim() && hits.every((x) => !x.hits.length) && <p className="text-sm text-muted-foreground">{t("search.none")}</p>}
          </ul>
        )}
      </div>
    </div>
  );
}
