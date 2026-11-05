import { Backdrop, ModalSurface } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { useEffect, useRef, useState } from "react";
import { Plus, CornerDownLeft, ChevronRight } from "lucide-react";
import type { Item } from "@obtion/core/model";
import { snippet } from "@obtion/core/search";
import { statusOf } from "@obtion/core/traits";
import { itemPath, spaceHref, openItem } from "../hooks";
import { useAccounts } from "../accounts";
import { useReplicas } from "./Spaces";
import { captureSpace } from "./QuickNote";
import { setTheme } from "../theme";
import { useT, setLang, getLang, titleOf } from "../i18n";
import { InTray, ItemIcon, StatusPill, TypeGlyph } from "./item-look";
import { cn } from "../lib/utils";
import { modName } from "../lib/platform";
import { shortPath } from "./Row";
import { createAndOpen } from "../actions";
import { Button } from "./primitives";
import { openSettings } from "./settings-open";
import { openNewType } from "./type-edit";
import { openShelf } from "./inbox";

/** Search hits shown for a query. The palette is the only search, so it lists more than fit at once. */
const MAX_HITS = 30;
/** Recently changed items shown before anything is typed. */
const RECENT_COUNT = 8;

type Entry =
  | { kind: "item"; id: string; space: string }
  | { kind: "create"; type: string | null; title: string }
  | { kind: "nav"; label: string; path: string }
  | { kind: "cmd"; label: string; run: () => void };

export function CommandPalette({ query: initial = "", onClose }: { query?: string; onClose: () => void }) {
  const { t, lang } = useT();
  const [q, setQ] = useState(initial);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { shown } = useAccounts();
  const repos = useReplicas(shown.map((s) => s.id));
  const repoOf = (space: string) => repos[shown.findIndex((s) => s.id === space)] ?? repos[0]!;
  const several = shown.length > 1;
  const nameOf = (space: string) => shown.find((s) => s.id === space)?.name ?? "";
  const navs = [
    [t("nav.today"), "#/"],
    [t("nav.inbox"), "#/inbox"],
    ...shown.flatMap((s, n) => {
      const ix = repos[n]!.index();
      const of = (label: string) => (several ? `${label} · ${s.name}` : label);
      return [
        ...ix.typesInOrder().map((x) => [of(ix.typePlural(x.id)), spaceHref(s.id, itemPath(x.id))]),
        [of(t("nav.files")), spaceHref(s.id, "/files")],
        [of(t("nav.graph")), spaceHref(s.id, "/graph")],
        [of(t("space.settings")), spaceHref(s.id, "/settings")],
      ];
    }),
      [t("nav.activity"), "#/activity"],
      [t("nav.trash"), "#/trash"],
  ];
  const captureIn = captureSpace() ?? shown[0]!.id;
  const repo = repoOf(captureIn);
  const ix = repo.index();
  const pinnedTypes = ix.captureTypes();
  const captureTypes = [...pinnedTypes, ...ix.typesByName().filter((x) => !pinnedTypes.includes(x.id)).map((x) => x.id)];
  const cmds: [string, () => void][] = [
    [t("palette.cmd.sortInbox"), () => openShelf()],
    [t("nav.settings"), openSettings],
    [t("palette.cmd.newType"), () => openNewType(captureIn)],
    [t("palette.cmd.language"), () => setLang(getLang() === "de" ? "en" : "de")],
    ...(["system", "light", "dark"] as const).map((v): [string, () => void] => [t("palette.cmd.theme", { name: t("theme." + v) }), () => setTheme(v)]),
  ];

  const items: Entry[] = (() => {
    const out: Entry[] = [];
    const query = q.trim();
    const lq = query.toLowerCase();
    const matches = (label: string) => label.toLowerCase().split(/\s+/).some((w) => w.startsWith(lq)) || label.toLowerCase().startsWith(lq);
    const toNav = ([label, path]: string[]) => ({ kind: "nav" as const, label: label!, path: path! });
    out.push(...navs.filter(([label]) => query && matches(label!)).map(toNav));
    if (query) out.push(...cmds.filter(([label]) => matches(label)).map(([label, run]) => ({ kind: "cmd" as const, label, run })));
    // interleave the workspaces' hits, since each list is ranked by its own search
    const perSpace = repos.map((spaceRepo, n) => (query ? spaceRepo.search(query, MAX_HITS) : spaceRepo.live()).map((h) => ({ h, space: shown[n]!.id })));
    const hits: { h: Item; space: string }[] = query
      ? Array.from({ length: MAX_HITS }, (_, i) => perSpace.map((list) => list[i])).flat().filter((x) => !!x).slice(0, MAX_HITS)
      : perSpace.flat().sort((a, b) => b.h.updated - a.h.updated).slice(0, RECENT_COUNT);
    out.push(...hits.map(({ h, space }) => ({ kind: "item" as const, id: h.id, space })));
    if (query) out.push(...[null, ...captureTypes].map((type) => ({ kind: "create" as const, type, title: query })));
    else out.push(...navs.map(toNav));
    return out;
  })();

  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (it: Entry) => {
    onClose();
    if (it.kind === "item") openItem(it.id, { space: it.space });
    else if (it.kind === "create") createAndOpen({ type: it.type, title: it.title }, repo, captureIn);
    else if (it.kind === "nav") location.hash = it.path;
    else if (it.kind === "cmd") it.run();
  };

  return (
    <ModalSurface title={t("palette.label")} onClose={onClose}><Backdrop className="flex items-start justify-center p-3 pt-[10vh]" onMouseDown={onClose}>
      <div className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <Input
          variant="bare"
          autoFocus
          value={q}
          onChange={(e) => (setQ(e.target.value), setSel(0))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(items.length - 1, s + 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && q.trim()) (e.preventDefault(), run({ kind: "create", type: null, title: q.trim() }));
            else if (e.key === "Enter" && items[sel]) (e.preventDefault(), run(items[sel]!));
          }}
          placeholder={t("palette.placeholder")}
          className="border-b border-line bg-transparent px-4 py-3.5 text-base outline-none placeholder:text-muted-foreground"
        />
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {items.map((it, i) => {
            const active = i === sel;
            const common = { "data-i": i, onMouseEnter: () => setSel(i), onClick: () => run(it), className: cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm", active && "bg-selected"), key: i };
            if (it.kind === "item") {
              const ix = repoOf(it.space).index();
              const item = ix.get(it.id)!;
              const status = statusOf(item, ix.schemaOf(item));
              const home = ix.homePath(item.id);
              return (
                <Button variant="plain" {...common}>
                  <ItemIcon item={item} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{titleOf(item, t)}</span>
                    {home.length > 0 ? (
                      <span className="block truncate text-xs text-muted-foreground">{shortPath(home)}</span>
                    ) : (
                      q.trim() && item.body && <span className="block truncate text-xs text-muted-foreground">{snippet(item.body, q, 90)}</span>
                    )}
                  </span>
                  <InTray item={item} ix={ix} />
                  {status && <StatusPill option={status.option} group={status.group} small />}
                  {several && <span className="max-w-28 shrink-0 truncate text-xs text-muted-foreground">{nameOf(it.space)}</span>}
                  {active && <CornerDownLeft size={14} className="text-muted-foreground" />}
                </Button>
              );
            }
            if (it.kind === "create")
              return (
                <Button variant="plain" {...common}>
                  <Plus size={16} className="text-muted-foreground" />
                  <span className="flex-1 truncate">
                    {it.type ? t("palette.newTyped", { name: ix.typeName(it.type) }) : t("palette.new")} <span className="font-medium">{t("palette.quoted", { text: it.title })}</span>
                  </span>
                  {it.type && <TypeGlyph schema={ix.types.get(it.type)?.schema} size={14} />}
                  {several && <span className="max-w-28 shrink-0 truncate text-xs text-muted-foreground">{nameOf(captureIn)}</span>}
                </Button>
              );
            if (it.kind === "cmd")
              return (
                <Button variant="plain" {...common}>
                  <ChevronRight size={16} className="text-muted-foreground" />
                  <span className="flex-1">{it.label}</span>
                </Button>
              );
            return (
              <Button variant="plain" {...common}>
                <span className="w-4" />
                <span className="flex-1 text-muted-foreground">{t("palette.goTo", { label: it.label })}</span>
              </Button>
            );
          })}
        </div>
        <div className="flex gap-3 border-t border-line px-4 py-2 text-[11px] text-muted-foreground">
          <span>{t("palette.keys", { mod: modName(lang) })}</span>
        </div>
      </div>
    </Backdrop></ModalSurface>
  );
}
