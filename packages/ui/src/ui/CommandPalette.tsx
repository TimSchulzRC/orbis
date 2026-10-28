import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Sparkles, CornerDownLeft, ChevronRight } from "lucide-react";
import { SETTINGS_ID } from "@obtion/core/model";
import { snippet } from "@obtion/core/search";
import { statusOf } from "@obtion/core/traits";
import type { Item } from "@obtion/core/model";
import { go, spaceHref } from "../hooks";
import { useAccounts } from "../accounts";
import { useReplicas } from "./Spaces";
import { captureSpace } from "./Capture";
import { setTheme } from "../theme";
import { useT, setLang, getLang } from "../i18n";
import { ItemIcon, StatusPill, TypeGlyph, cx, modName, useModal } from "./bits";
import { shortPath } from "./Row";
import { askAgent, createAndOpen } from "../actions";

type Entry =
  | { kind: "item"; id: string; space: string }
  | { kind: "create"; type: string | null; title: string }
  | { kind: "ask"; text: string }
  | { kind: "nav"; label: string; path: string }
  | { kind: "cmd"; label: string; run: () => void };

/**
 * Search and go anywhere, over the workspaces seen: their entries, their pages (named with the
 * workspace when there are several), creating something new (in the workspace a capture goes to)
 * and asking the agent.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModal(dialogRef, onClose);
  const { t, lang } = useT();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { shown } = useAccounts();
  const repos = useReplicas(shown.map((s) => s.id));
  const repoOf = (space: string) => repos[shown.findIndex((s) => s.id === space)] ?? repos[0]!;
  const several = shown.length > 1;
  const nameOf = (space: string) => shown.find((s) => s.id === space)?.name ?? "";
  const navs = useMemo(
    () => [
      [t("nav.inbox"), "#/inbox"],
      ...shown.flatMap((s, n) => {
        const ix = repos[n]!.index();
        const of = (label: string) => (several ? `${label} · ${s.name}` : label);
        return [
          ...ix.typesInOrder().map((x) => [of(ix.typePlural(x.id)), spaceHref(s.id, `/i/${encodeURIComponent(x.id)}`)]),
          [of(t("nav.files")), spaceHref(s.id, "/files")],
          [of(t("nav.types")), spaceHref(s.id, "/types")],
          [of(t("nav.activity")), spaceHref(s.id, "/activity")],
          [of(t("nav.graph")), spaceHref(s.id, "/graph")],
          [of(t("nav.trash")), spaceHref(s.id, "/trash")],
          [several ? `${t("space.settings")} · ${s.name}` : t("space.settings"), spaceHref(s.id, "/workspace")],
        ];
      }),
      [t("nav.settings"), "#/settings"],
    ],
    [],
  );
  // something new goes where a capture from anywhere goes
  const cs = captureSpace() ?? shown[0]!.id;
  const repo = repoOf(cs);
  const ix = repo.index();
  const pinnedTypes = (repo.get(SETTINGS_ID)?.settings?.captureTypes ?? []).filter((id) => ix.types.has(id));
  // "Neu: …" for every type – the pinned ones first, then the others by name (own types like "Buch" too)
  const captureTypes = [...pinnedTypes, ...[...ix.types.values()].filter((x) => !pinnedTypes.includes(x.id)).sort((a, b) => a.schema!.name.localeCompare(b.schema!.name)).map((x) => x.id)];
  // actions, found by typing their name
  const cmds: [string, () => void][] = [
    [t("palette.cmd.sortInbox"), () => go("/inbox")],
    [t("palette.cmd.newType"), () => (location.hash = spaceHref(cs, "/types?new=1"))],
    [t("palette.cmd.language"), () => setLang(getLang() === "de" ? "en" : "de")],
    ...(["system", "light", "dark"] as const).map((v): [string, () => void] => [t("palette.cmd.theme", { name: t("theme." + v) }), () => setTheme(v)]),
  ];

  const items: Entry[] = useMemo(() => {
    const out: Entry[] = [];
    const query = q.trim();
    const lq = query.toLowerCase();
    const words = (label: string) => label.toLowerCase().split(/\s+/).some((w) => w.startsWith(lq)) || label.toLowerCase().startsWith(lq);
    const nav = navs.filter(([label]) => query && words(label!));
    out.push(...nav.map(([label, path]) => ({ kind: "nav" as const, label: label!, path: path! })));
    if (query) out.push(...cmds.filter(([label]) => words(label)).map(([label, run]) => ({ kind: "cmd" as const, label, run })));
    // the hits of every workspace seen, taking turns (each ranked by its own search)
    const per = repos.map((r, n) => (query ? r.search(query, 10) : r.live()).map((h) => ({ h, space: shown[n]!.id })));
    const hits: { h: Item; space: string }[] = query
      ? Array.from({ length: 10 }, (_, i) => per.map((list) => list[i])).flat().filter((x) => !!x).slice(0, 10)
      : per.flat().sort((a, b) => b.h.updated - a.h.updated).slice(0, 8);
    out.push(...hits.map(({ h, space }) => ({ kind: "item" as const, id: h.id, space })));
    if (query) {
      // after the hits: all hits on the search page, then creating something new, then the agent
      if (hits.length >= 10) out.push({ kind: "nav", label: t("palette.allHits"), path: `#/search?q=${encodeURIComponent(query)}` });
      out.push(...[null, ...captureTypes].map((type) => ({ kind: "create" as const, type, title: query })));
      out.push({ kind: "ask", text: query });
    }
    if (!query) for (const [label, path] of navs) out.push({ kind: "nav", label: label!, path: path! });
    return out;
  }, [q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (it: Entry) => {
    onClose();
    if (it.kind === "item") location.hash = spaceHref(it.space, `/i/${encodeURIComponent(it.id)}`);
    else if (it.kind === "create") createAndOpen({ type: it.type, title: it.title }, repo, cs);
    else if (it.kind === "nav") location.hash = it.path;
    else if (it.kind === "cmd") it.run();
    else askAgent(it.text);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-3 pt-[10vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div ref={dialogRef} className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t("palette.label")}>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(items.length - 1, s + 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && q.trim()) (e.preventDefault(), run({ kind: "create", type: null, title: q.trim() }));
            else if (e.key === "Enter" && items[sel]) (e.preventDefault(), run(items[sel]!));
          }}
          placeholder={t("palette.placeholder")}
          className="border-b border-line bg-transparent px-4 py-3.5 text-base outline-none placeholder:text-muted"
        />
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {items.map((it, i) => {
            const active = i === sel;
            const common = { "data-i": i, onMouseEnter: () => setSel(i), onClick: () => run(it), className: cx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm", active && "bg-selected"), key: i };
            if (it.kind === "item") {
              const ix = repoOf(it.space).index();
              const n = ix.get(it.id)!;
              const st = statusOf(n, ix.schemaOf(n));
              return (
                <button {...common}>
                  <ItemIcon item={n} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{n.title || t("untitled")}</span>
                    {ix.homePath(n.id).length > 0 ? (
                      <span className="block truncate text-xs text-muted">{shortPath(ix.homePath(n.id))}</span>
                    ) : (
                      q.trim() && n.body && <span className="block truncate text-xs text-muted">{snippet(n.body, q, 90)}</span>
                    )}
                  </span>
                  {st && <StatusPill option={st.option} group={st.group} small />}
                  {several && <span className="max-w-28 shrink-0 truncate text-xs text-muted">{nameOf(it.space)}</span>}
                  {active && <CornerDownLeft size={14} className="text-muted" />}
                </button>
              );
            }
            if (it.kind === "create")
              return (
                <button {...common}>
                  <Plus size={16} className="text-muted" />
                  <span className="flex-1 truncate">
                    {it.type ? t("palette.newTyped", { name: ix.typeName(it.type) }) : t("palette.new")} <span className="font-medium">{t("palette.quoted", { text: it.title })}</span>
                  </span>
                  {it.type && <TypeGlyph schema={ix.types.get(it.type)?.schema} size={14} />}
                  {several && <span className="max-w-28 shrink-0 truncate text-xs text-muted">{nameOf(cs)}</span>}
                </button>
              );
            if (it.kind === "ask")
              return (
                <button {...common}>
                  <Sparkles size={16} className="text-muted" />
                  <span className="flex-1 truncate">
                    {t("palette.ask")} <span className="font-medium">{it.text}</span>
                  </span>
                </button>
              );
            if (it.kind === "cmd")
              return (
                <button {...common}>
                  <ChevronRight size={16} className="text-muted" />
                  <span className="flex-1">{it.label}</span>
                </button>
              );
            return (
              <button {...common}>
                <span className="w-4" />
                <span className="flex-1 text-muted">{t("palette.goTo", { label: it.label })}</span>
              </button>
            );
          })}
        </div>
        <div className="flex gap-3 border-t border-line px-4 py-2 text-[11px] text-muted">
          <span>{t("palette.keys", { mod: modName(lang) })}</span>
        </div>
      </div>
    </div>
  );
}
