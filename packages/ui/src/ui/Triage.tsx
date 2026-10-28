// "Sortieren" (design rules § 5): go through entries and decide – place, give a type, delete.
// Works for any list or query block; the inbox is just one. An entry leaves the list as
// soon as it no longer matches the query.
//
// Desktop: one card, the list on the left (one line per entry, nothing grows or appears on
// hover), the selected entry in full on the right with a fixed action bar. Several can be
// marked (box, Space, Shift+j/k); then a bar of the same height acts on all of them.
// Phone: the list; tapping opens the entry on a page of its own (#/inbox/<id>), and after an
// action the next one opens.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronLeft, FolderInput, Shapes, Sparkles, Trash2, Check, X, Plus } from "lucide-react";
import { type Item, SETTINGS_ID, setMeta } from "@obtion/core/model";
import type { Index } from "@obtion/core/graph";
import { onlyBelow } from "@obtion/core/trash";
import { inboxWhere } from "@obtion/core/inbox";
import { runQuery } from "@obtion/core/query";
import { useIndex, useRepo, useSpaceId, itemHref, go, spaceHref, useMediaQuery } from "../hooks";
import { replica, spaceById } from "../accounts";
import { SpaceScope } from "./Spaces";
import { useT } from "../i18n";
import { createType, recentPlaces, rememberPlace } from "../actions";
import { Button, Dialog, ItemIcon, Kbd, RelTime, Tag, TypeGlyph, cx } from "./bits";
import { TagInput } from "./TagInput";
import { ItemPicker } from "./Picker";
import { placeSuggestions } from "./suggest";
import { chooseAction, notify } from "./feedback";
import { Markdown } from "./Markdown";
import { NOTE_ICON } from "./icons";
import { plainText } from "@obtion/core/search";

interface Undo {
  label: string;
  steps: { space: string; id: string; type?: string | null; addedParents?: string[]; deleted?: boolean }[];
}

function revert(u: Undo) {
  for (const s of u.steps) {
    const repo = replica(s.space).repo;
    if (s.deleted) repo.restore(s.id);
    if (s.type !== undefined) repo.setType(s.id, s.type);
    for (const p of s.addedParents ?? []) repo.removeParent(s.id, p);
  }
}

const DAY = 864e5;
/** Age groups: this week, this month, older. */
function ageGroup(created: number, now = Date.now()): "week" | "month" | "older" {
  const days = (now - created) / DAY;
  return days <= 7 ? "week" : days <= 30 ? "month" : "older";
}

/**
 * What can be done with entries: place, give a type, delete – each with one undo (toast, 5 s).
 * Entries may come from several workspaces (`spaceOf`); a place and a type belong to one, so those
 * act on entries of one workspace only (the pickers see to that).
 */
function useTriageActions(spaceOf: (i: Item) => string) {
  const { t } = useT();
  const last = useRef<Undo | null>(null);
  const repoOf = (i: Item) => replica(spaceOf(i)).repo;
  const firstType = (i?: Item) => {
    if (!i) return undefined;
    const repo = repoOf(i);
    return (repo.get(SETTINGS_ID)?.settings?.captureTypes ?? []).find((id) => repo.index().types.has(id));
  };
  const done = (u: Undo) => {
    last.current = u;
    notify.undo(u.label, () => (revert(u), (last.current = null)));
  };
  const short = (i?: Item) => {
    const name = i?.title || i?.file?.name || t("untitled");
    return name.length > 40 ? name.slice(0, 39) + "…" : name;
  };
  const label = (list: Item[], key: string, values: Record<string, unknown> = {}) => (list.length > 1 ? t(key + "Many", { count: list.length, ...values }) : t(key, { ...values, title: short(list[0]), ...("title" in values ? { title: values.title } : {}) }));
  const giveType = (list: Item[], type: string) => {
    const infos = list.filter((i) => i.kind === "info");
    if (!infos.length) return;
    const repo = repoOf(infos[0]!);
    const name = repo.index().typeName(type);
    done({ label: list.length > 1 ? label(infos, "triage.typed", { name }) : t("triage.typedOne", { title: short(infos[0]), name }), steps: infos.map((i) => ({ space: spaceOf(i), id: i.id, type: i.type })) });
    for (const i of infos) repo.setType(i.id, type);
  };
  const trash = async (list: Item[]): Promise<boolean> => {
    // entries with notes below: delete those too, or let them back into the inbox?
    const below = list.reduce((n, i) => n + onlyBelow(repoOf(i).index(), i.id).length, 0);
    let children: "trash" | "inbox" = "trash";
    if (below) {
      const c = await chooseAction({
        title: list.length > 1 ? t("triage.deleteMany", { count: list.length }) : t("delete.title", { title: list[0]!.title || t("untitled") }),
        body: t("delete.children", { count: below }),
        choices: [
          { key: "inbox", label: t("delete.backToInbox") },
          { key: "trash", label: t("delete.all", { count: below + list.length }), primary: true, danger: true },
        ],
      });
      if (!c) return false;
      children = c as "trash" | "inbox";
    }
    done({ label: label(list, children === "inbox" && below ? "triage.trashedKeep" : "triage.trashed", { count: below, title: short(list[0]) }), steps: list.map((i) => ({ space: spaceOf(i), id: i.id, deleted: true })) });
    for (const i of list) repoOf(i).remove(i.id, children);
    return true;
  };
  const place = (list: Item[], parent: string) => {
    if (!list.length) return;
    const repo = repoOf(list[0]!);
    const ok = list.filter((i) => repo.addParent(i.id, parent));
    if (!ok.length) return;
    rememberPlace(parent, repo);
    const where = repo.index().get(parent)?.title ?? "";
    done({ label: ok.length > 1 ? t("triage.placedMany", { count: ok.length, title: where }) : t("triage.placedOne", { title: short(ok[0]), place: where }), steps: ok.map((i) => ({ space: spaceOf(i), id: i.id, addedParents: [parent] })) });
  };
  // "u": takes back the last one (the notice offers the same)
  const undo = () => {
    if (!last.current) return;
    revert(last.current);
    last.current = null;
  };
  return { firstType, giveType, trash, place, undo };
}

/** The pickers an action may need: where to (place) and which type – in the workspace of the entries. */
function usePickers(spaceOf: (i: Item) => string, place: (list: Item[], p: string) => void, giveType: (list: Item[], t: string) => void, after?: () => void) {
  const { t } = useT();
  const [placing, setPlacingRaw] = useState<Item[] | null>(null);
  const [typing, setTypingRaw] = useState<Item[] | null>(null);
  // a place or a type is one workspace's: entries of several are sorted one workspace at a time
  const one = (list: Item[]) => new Set(list.map(spaceOf)).size <= 1 || (notify(t("triage.oneSpace")), false);
  const setPlacing = (list: Item[] | null) => (!list || one(list)) && setPlacingRaw(list);
  const setTyping = (list: Item[] | null) => (!list || one(list)) && setTypingRaw(list);
  const node = (
    <>
      {placing && placing.length > 0 && (
        <SpaceScope id={spaceOf(placing[0]!)}>
          <PlacePicker list={placing} onPick={(p) => (place(placing, p), setPlacingRaw(null), after?.())} onClose={() => setPlacingRaw(null)} />
        </SpaceScope>
      )}
      {typing && typing.length > 0 && (
        <SpaceScope id={spaceOf(typing[0]!)}>
          <TypePicker current={typing.length === 1 ? typing[0]!.type : null} onPick={(type) => (giveType(typing, type), setTypingRaw(null), after?.())} onClose={() => setTypingRaw(null)} />
        </SpaceScope>
      )}
    </>
  );
  return { node, placing, typing, setPlacing, setTyping };
}

function PlacePicker({ list, onPick, onClose }: { list: Item[]; onPick: (p: string) => void; onClose: () => void }) {
  const { t } = useT();
  const repo = useRepo();
  const ix = repo.index();
  return (
    <ItemPicker
      title={list.length > 1 ? t("triage.whereToMany", { count: list.length }) : t("triage.whereTo")}
      suggestions={list.length === 1 ? placeSuggestions(list[0]!, repo) : []}
      exclude={(x) => list.some((p) => x.id === p.id || ix.wouldCycle(p.id, x.id) || !!p.parents[x.id]) || x.kind !== "info"}
      onPick={onPick}
      onCreate={(title) => onPick(repo.create({ title }))}
      onClose={onClose}
    />
  );
}

/** The quiet hint of a row: the agent's suggestion, a mentioned place, or the notes bundled below. */
function rowHint(item: Item, ix: Index, t: (k: string, v?: Record<string, unknown>) => string): { icon: React.ReactNode; text: string } | null {
  const sug = item.suggestion;
  if (sug) {
    const what = [sug.type ? ix.typeName(sug.type) : null, ...(sug.parents ?? []).map((p) => ix.get(p)?.title)].filter(Boolean).join(" · ");
    if (what) return { icon: <Sparkles size={12} />, text: what };
  }
  const mentioned = [...ix.textLinks(item).filter((l) => !l.embed).map((l) => l.to), ...item.refs].map((id) => ix.get(id)).find((x) => x && x.kind === "info");
  if (mentioned) return { icon: <ArrowRight size={12} />, text: mentioned.title };
  const kids = ix.childrenOf(item.id).length;
  if (kids) return { icon: <NOTE_ICON size={12} />, text: t("triage.notes", { count: kids }) };
  return null;
}

/** The mark box: always in the same place, 16 in a 24 area (44 on touch). */
function MarkBox({ on, onToggle, title }: { on: boolean; onToggle: () => void; title: string }) {
  const { t } = useT();
  return (
    <label className="tap-edge relative flex size-6 shrink-0 cursor-pointer items-center justify-center" onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={on} onChange={onToggle} aria-label={t("triage.markNamed", { title })} className="size-4 cursor-pointer accent-[var(--focus)] pointer-coarse:size-[18px]" />
    </label>
  );
}

/** The keys go to one list only (a page may show several): the one used last, else the first. */
let keyOwner: symbol | null = null;

/**
 * `spaceOf`: the workspace of each entry, when they come from several (the inbox); each row then
 * says which, and the entry shows and acts in its own.
 */
export function Triage({ items, spaceOf: given }: { items: Item[]; storageKey?: string; spaceOf?: (i: Item) => string }) {
  const { t } = useT();
  const here = useSpaceId()!;
  const spaceOf = (i: Item) => given?.(i) ?? here;
  // ids are unique within a workspace only (the examples have the same ones everywhere)
  const keyOf = (i: Item) => `${spaceOf(i)}/${i.id}`;
  const ixOf = (i: Item) => replica(spaceOf(i)).repo.index();
  const several = !!given && new Set(items.map(spaceOf)).size > 1;
  const phone = useMediaQuery("(max-width: 767px)");
  const [sel, setSel] = useState(0);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(60);
  const act = useTriageActions(spaceOf);
  const pick = usePickers(spaceOf, act.place, act.giveType, () => setMarked(new Set()));
  const list = useRef<HTMLDivElement>(null);
  const me = useRef(Symbol()).current;
  const claim = () => void (keyOwner = me);
  useEffect(() => {
    keyOwner ??= me;
    return () => void (keyOwner === me && (keyOwner = null));
  }, []);

  // what an action applies to: the marked entries, else the selected one
  const targets = (): Item[] => {
    const m = items.filter((i) => marked.has(keyOf(i)));
    return m.length ? m : items[sel] ? [items[sel]!] : [];
  };
  const toggle = (id: string, on?: boolean) =>
    setMarked((m) => {
      const n = new Set(m);
      if (on ?? !n.has(id)) n.add(id);
      else n.delete(id);
      return n;
    });
  const trash = (l: Item[]) => void act.trash(l).then((ok) => ok && setMarked(new Set()));

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (keyOwner !== me || pick.placing || pick.typing || el.closest("input, textarea, select, [contenteditable=true], .cm-editor, [role=dialog]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const cur = items[sel];
      const k = e.key;
      if (k === "J" || (k === "ArrowDown" && e.shiftKey)) {
        if (cur) toggle(keyOf(cur), true);
        const n = Math.min(items.length - 1, sel + 1);
        if (items[n]) toggle(keyOf(items[n]!), true);
        setSel(n);
      } else if (k === "K" || (k === "ArrowUp" && e.shiftKey)) {
        if (cur) toggle(keyOf(cur), true);
        const n = Math.max(0, sel - 1);
        if (items[n]) toggle(keyOf(items[n]!), true);
        setSel(n);
      } else if (k === "j" || k === "ArrowDown") setSel((s) => Math.min(items.length - 1, s + 1));
      else if (k === "k" || k === "ArrowUp") setSel((s) => Math.max(0, s - 1));
      else if (k === " " && cur) toggle(keyOf(cur));
      else if (k === "Escape" && marked.size) setMarked(new Set());
      else if (k === "e" && cur) pick.setPlacing(targets());
      else if (k === "c" && act.firstType(cur) && cur && new Set(targets().map(spaceOf)).size === 1) (act.giveType(targets(), act.firstType(cur)!), setMarked(new Set()));
      else if (k === "y" && cur) pick.setTyping(targets().filter((i) => i.kind === "info"));
      else if ((k === "x" || k === "Delete") && cur) trash(targets());
      else if (k === "u" || k === "z") act.undo();
      else if ((k === "Enter" || k === "o") && cur) (location.hash = spaceHref(spaceOf(cur), `/i/${encodeURIComponent(cur.id)}`));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });
  useEffect(() => {
    // after an action the entry leaves: the selection stays at its place, so the next one is selected
    if (sel >= items.length && items.length) setSel(items.length - 1);
    list.current?.querySelector(`[data-triage="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel, items.length]);
  // marks of entries that left the list go with them
  useEffect(() => {
    if (marked.size && [...marked].some((id) => !items.some((i) => keyOf(i) === id))) setMarked(new Set([...marked].filter((id) => items.some((i) => keyOf(i) === id))));
  }, [items]);

  const shown = items.slice(0, limit);
  const sorted = [...items].every((x, n, a) => n === 0 || a[n - 1]!.created >= x.created);
  const many = marked.size > 0 ? items.filter((i) => marked.has(keyOf(i))) : null;
  const current = items[sel];

  const rows = (
    <div ref={list} className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label={t("triage.list")}>
      {shown.map((i, n) => {
        const g = ageGroup(i.created);
        const head = sorted && (n === 0 || ageGroup(shown[n - 1]!.created) !== g);
        const count = head ? shown.filter((x) => ageGroup(x.created) === g).length : 0;
        const hint = rowHint(i, ixOf(i), t);
        const on = n === sel && !phone;
        return (
          <div key={keyOf(i)}>
            {head && (
              <p className="px-3 pb-1 pt-3 text-xs font-semibold text-muted md:pl-11">
                {t("triage.age." + g)} <span className="font-normal tabular-nums">{count}</span>
              </p>
            )}
            <div
              data-triage={n}
              role="option"
              aria-selected={on}
              onClick={() => (phone ? (location.hash = spaceHref(spaceOf(i), `/inbox/${encodeURIComponent(i.id)}`)) : setSel(n))}
              className={cx(
                "relative grid cursor-default items-center gap-x-2 px-3 hover:bg-hover",
                phone ? "min-h-12 grid-cols-[44px_minmax(0,1fr)_auto] py-1.5" : "h-10 grid-cols-[24px_minmax(0,1fr)_auto_minmax(64px,auto)]",
                on && "bg-selected before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r before:bg-[var(--focus)]",
              )}
            >
              <MarkBox on={marked.has(keyOf(i))} onToggle={() => toggle(keyOf(i))} title={i.title || i.file?.name || t("untitled")} />
              {phone ? (
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[15px]">{i.title || i.file?.name || t("untitled")}</span>
                  {hint && (
                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted">
                      <span className="shrink-0">{hint.icon}</span>
                      <span className="truncate">{hint.text}</span>
                    </span>
                  )}
                </span>
              ) : (
                <>
                  <span className="truncate text-sm">{i.title || i.file?.name || t("untitled")}</span>
                  <span className="flex max-w-[104px] items-center gap-1 overflow-hidden whitespace-nowrap text-xs text-muted">
                    {hint && (
                      <>
                        <span className="shrink-0">{hint.icon}</span>
                        <span className="truncate">{hint.text}</span>
                      </>
                    )}
                  </span>
                </>
              )}
              <span className="whitespace-nowrap text-right text-xs text-muted">
                {several && <span className="font-medium">{spaceById(spaceOf(i))?.name} · </span>}
                <RelTime ts={i.created} />
              </span>
            </div>
          </div>
        );
      })}
      {items.length > limit && (
        <button onClick={() => setLimit(limit + 60)} className="w-full py-3 text-sm text-muted hover:text-fg">
          {t("query.more", { count: items.length - limit })}
        </button>
      )}
    </div>
  );

  // the bar over the list: order and key hint, or – with marked entries – what to do with them (same height)
  const bar = many ? (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-[color-mix(in_srgb,var(--focus)_8%,var(--surface))] px-3 text-[13px]">
      <MarkBox on onToggle={() => setMarked(new Set())} title={t("triage.unmark")} />
      <b className="whitespace-nowrap font-semibold">{t("triage.marked", { count: many.length })}</b>
      <span className="flex-1" />
      <Button variant="outline" onClick={() => pick.setPlacing(many)} className="h-7 px-2 text-[13px]">
        <FolderInput size={14} /> {t("triage.place")}
      </Button>
      <Button onClick={() => pick.setTyping(many.filter((i) => i.kind === "info"))} aria-label={t("triage.type")} title={t("triage.type")} className="h-7 px-1.5">
        <Shapes size={14} />
      </Button>
      <Button variant="danger" onClick={() => trash(many)} aria-label={t("triage.delete")} title={t("triage.delete")} className="h-7 px-1.5">
        <Trash2 size={14} />
      </Button>
    </div>
  ) : (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 text-[13px] text-muted">
      <span className="flex-1">{sorted ? t("triage.newestFirst") : ""}</span>
      {!phone && (
        <span className="flex items-center gap-1">
          <Kbd>j</Kbd> <Kbd>k</Kbd> {t("triage.keys.move")}
        </span>
      )}
    </div>
  );

  if (phone)
    return (
      <div onPointerDownCapture={claim} className="overflow-hidden rounded-xl border border-line bg-surface">
        {many && bar}
        {rows}
        {pick.node}
      </div>
    );
  return (
    <div onPointerDownCapture={claim} onFocusCapture={claim} className="grid h-[calc(100dvh-170px)] min-h-[520px] grid-cols-[380px_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex min-h-0 min-w-0 flex-col border-r border-line">
        {bar}
        {rows}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        {many ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
            <h2 className="text-xl font-semibold">{t("triage.markedTitle", { count: many.length })}</h2>
            <ul className="mt-3 space-y-1 text-sm">
              {many.map((i) => (
                <li key={keyOf(i)} className="flex items-center gap-2">
                  <ItemIcon item={i} size={14} ix={ixOf(i)} /> <span className="truncate">{i.title || i.file?.name || t("untitled")}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : current ? (
          <SpaceScope id={spaceOf(current)}>
            <Detail item={current} onPlaced={(p) => act.place([current], p)} />
          </SpaceScope>
        ) : null}
        <SpaceScope id={current ? spaceOf(current) : here}>
          <ActionBar
            onPlace={() => pick.setPlacing(targets())}
            onType={() => pick.setTyping(targets().filter((i) => i.kind === "info"))}
            toType={!many && current?.kind === "info" && act.firstType(current) && act.firstType(current) !== current.type ? act.firstType(current) : undefined}
            onToType={(type) => act.giveType(targets(), type)}
            onTrash={() => trash(targets())}
            keys
          />
        </SpaceScope>
      </div>
      {pick.node}
    </div>
  );
}

/** The selected entry in full: title, when and what it mentions, the text, then what helps to decide. */
function Detail({ item, onPlaced }: { item: Item; onPlaced: (p: string) => void }) {
  const { t } = useT();
  const repo = useRepo();
  const ix = repo.index();
  const mentioned = [...new Set([...ix.textLinks(item).filter((l) => !l.embed).map((l) => l.to), ...item.refs])].map((id) => ix.get(id)).filter((x): x is Item => !!x && x.kind === "info");
  const kids = ix.childrenOf(item.id).map((id) => ix.get(id)!).filter(Boolean);
  const sug = item.suggestion;
  const places = useMemo(() => {
    const s = placeSuggestions(item, repo).slice(0, 4).map((x) => ({ id: x.id, why: t("triage.why." + x.reason) }));
    for (const id of recentPlaces(repo)) if (s.length < 4 && !s.some((x) => x.id === id) && id !== item.id && !item.parents[id] && !ix.wouldCycle(item.id, id)) s.push({ id, why: t("triage.why.recent") });
    return s;
  }, [item.id, item.updated]);
  const applySuggestion = () => {
    if (!sug) return;
    if (sug.type && ix.types.has(sug.type)) repo.setType(item.id, sug.type);
    for (const [k, v] of Object.entries(sug.props ?? {})) repo.setProp(item.id, k, v);
    for (const p of sug.parents ?? []) if (ix.get(p)) onPlaced(p);
    repo.change(item.id, (doc) => setMeta(doc, { suggestion: null }));
  };
  const section = "mt-5";
  const k = "mb-1.5 text-xs font-semibold text-muted";
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6 max-md:px-4 max-md:py-4">
      <a href={itemHref(item.id)} className="block text-xl font-semibold leading-[26px] hover:underline max-md:text-[22px] max-md:leading-7">
        {item.title || item.file?.name || t("untitled")}
      </a>
      <p className="mt-1 text-xs text-muted">
        {t("triage.captured")} <RelTime ts={item.created} />
        {mentioned.length > 0 && <> · {t("triage.mentions", { list: mentioned.map((m) => m.title).join(", ") })}</>}
      </p>
      {item.body.trim() ? (
        <div className="mt-4 max-w-[64ch] text-[15px] leading-[1.65]">
          <Markdown src={item.body} />
        </div>
      ) : item.file?.text ? (
        <p className="mt-4 max-w-[64ch] text-[15px] leading-[1.65] text-muted">{plainText(item.file.text).slice(0, 800)}</p>
      ) : null}
      {kids.length > 0 && (
        <div className={section}>
          <p className={k}>{t("below.title")}</p>
          <ul className="space-y-1 text-sm">
            {kids.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <ItemIcon item={c} size={14} /> <a href={itemHref(c.id)} className="truncate hover:underline">{c.title || t("untitled")}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {item.tags.length > 0 && (
      <div className={section}>
        <p className={k}>{t("item.tags")}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {item.tags.map((x) => (
            <Tag key={x} tag={x} onRemove={() => repo.setMember(item.id, "tags", x, false)} />
          ))}
          <TagInput exclude={item.tags} onAdd={(x) => repo.setMember(item.id, "tags", x, true)} />
        </div>
      </div>
      )}
      {sug && (
        <div className={section}>
          <p className={k}>{t("triage.fromAgent")}</p>
          <div className="flex flex-wrap items-center gap-2.5 rounded-[10px] bg-surface-2 px-3 py-2 text-sm">
            <Sparkles size={15} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 basis-48">
              {[sug.type ? ix.typeName(sug.type) : null, ...(sug.parents ?? []).map((p) => ix.get(p)?.title)].filter(Boolean).join(" · ")}
              {sug.note && <span className="text-muted"> – {sug.note}</span>}
            </span>
            <Button variant="outline" onClick={applySuggestion} className="h-7 shrink-0 px-2 text-[13px]">
              <Check size={13} /> {t("triage.accept")}
            </Button>
            <button onClick={() => repo.change(item.id, (doc) => setMeta(doc, { suggestion: null }))} className="tap shrink-0 rounded p-1 text-faint hover:bg-hover hover:text-fg" aria-label={t("triage.dismiss")}>
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      {places.length > 0 && (
        <div className={section}>
          <p className={k}>{t("triage.placeIn")}</p>
          <div className="flex flex-wrap gap-1.5">
            {places.map((p) => (
              <button key={p.id} onClick={() => onPlaced(p.id)} className="tap-y inline-flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 text-[13px] hover:bg-hover">
                <FolderInput size={13} className="text-muted" /> {ix.get(p.id)?.title}
                <span className="text-xs text-muted">{p.why}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The fixed action bar under the detail: Einordnen (primary), Typ wählen, Zur Karte, Löschen; key hints below. */
function ActionBar({ onPlace, onType, toType, onToType, onTrash, keys }: { onPlace: () => void; onType: () => void; toType?: string; onToType: (t: string) => void; onTrash: () => void; keys?: boolean }) {
  const { t } = useT();
  const ix = useIndex();
  return (
    <div className="shrink-0 border-t border-line">
      <div className="flex items-center gap-1.5 px-7 py-3">
        <Button variant="primary" onClick={onPlace}>
          <FolderInput size={15} /> {t("triage.place")} <Kbd>e</Kbd>
        </Button>
        <Button variant="outline" onClick={onType}>
          {t("triage.type")} <Kbd>y</Kbd>
        </Button>
        {toType && (
          <Button variant="outline" onClick={() => onToType(toType)}>
            <TypeGlyph schema={ix.types.get(toType)?.schema} size={14} /> {t("triage.toType", { name: ix.typeName(toType) })} <Kbd>c</Kbd>
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="danger" onClick={onTrash}>
          <Trash2 size={15} /> {t("triage.delete")} <Kbd>x</Kbd>
        </Button>
      </div>
      {keys && (
        <p className="flex flex-wrap gap-x-3 px-7 pb-3 text-xs text-muted">
          <span>
            <Kbd>j</Kbd> <Kbd>k</Kbd> {t("triage.keys.next")}
          </span>
          <span>
            <Kbd>{t("triage.keys.space")}</Kbd> {t("triage.keys.select")}
          </span>
          <span>
            <Kbd>u</Kbd> {t("triage.keys.undo")}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * Phone: one inbox entry on a page of its own (#/inbox/<id>): "‹ Eingang" and "2 von 6" on top, the
 * entry, the actions fixed at the bottom. After an action the next entry opens; after the last one
 * back to the list. Swiping left or right goes to the next or the previous one.
 */
export function InboxEntry({ id }: { id: string }) {
  const { t } = useT();
  const here = useSpaceId()!;
  const ix = useIndex();
  const items = runQuery({ where: inboxWhere(ix), sort: [{ key: "created", desc: true }] }, { ix }).items;
  // the list as it was when this entry opened: "next" stays the one below it, also after it left
  const order = useRef<string[]>([]);
  if (!order.current.length || !order.current.includes(id)) order.current = items.map((i) => i.id);
  const at = order.current.indexOf(id);
  const item = ix.get(id);
  const next = order.current.slice(at + 1).find((x) => items.some((i) => i.id === x)) ?? order.current.slice(0, at).reverse().find((x) => items.some((i) => i.id === x && x !== id));
  const prev = order.current.slice(0, at).reverse().find((x) => items.some((i) => i.id === x));
  const open = (x?: string) => (x ? location.replace(`#/inbox/${encodeURIComponent(x)}`) : go("/inbox"));
  const act = useTriageActions(() => here);
  const pick = usePickers(() => here, act.place, act.giveType, () => open(next));
  const touch = useRef<number | null>(null);
  if (!item || item.deleted)
    return (
      <div className="page-read text-center text-muted">
        <a href="#/inbox" className="underline">{t("kind.inbox")}</a>
      </div>
    );
  const pos = items.findIndex((i) => i.id === id);
  return (
    <div
      className="flex h-full flex-col"
      onTouchStart={(e) => (touch.current = e.touches[0]!.clientX)}
      onTouchEnd={(e) => {
        const dx = (e.changedTouches[0]?.clientX ?? 0) - (touch.current ?? 0);
        if (Math.abs(dx) > 70) open(dx < 0 ? next : prev);
        touch.current = null;
      }}
    >
      <div className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line px-1">
        <a href="#/inbox" className="tap flex items-center gap-1 rounded-lg px-2 text-[15px] font-semibold">
          <ChevronLeft size={20} /> {t("nav.inbox")}
        </a>
        <span className="ml-auto pr-3 text-xs tabular-nums text-muted">{pos >= 0 ? t("triage.position", { at: pos + 1, count: items.length }) : ""}</span>
      </div>
      <Detail item={item} onPlaced={(p) => (act.place([item], p), open(next))} />
      <div className="grid shrink-0 grid-cols-[1.6fr_1fr_1fr_52px] gap-2 border-t border-line bg-surface px-3 py-2.5 pb-safe">
        <Button variant="primary" onClick={() => pick.setPlacing([item])} className="h-11 px-1.5">
          <FolderInput size={16} /> {t("triage.place")}
        </Button>
        <Button variant="outline" onClick={() => pick.setTyping([item])} className="h-11 px-1.5">
          {t("triage.typeShort")}
        </Button>
        {act.firstType(item) && act.firstType(item) !== item.type ? (
          <Button variant="outline" onClick={() => (act.giveType([item], act.firstType(item)!), open(next))} className="h-11 px-1.5">
            {ix.typeName(act.firstType(item)!)}
          </Button>
        ) : (
          <span />
        )}
        <Button variant="danger" onClick={() => void act.trash([item]).then((ok) => ok && open(next))} aria-label={t("triage.delete")} className="h-11 px-0">
          <Trash2 size={17} />
        </Button>
      </div>
      {pick.node}
    </div>
  );
}

/** Choose a type by keyboard: type to filter, arrows, Enter, 1–9; "Neuer Typ …" at the end. */
export function TypePicker({ current, onPick, onClose }: { current: string | null; onPick: (id: string) => void; onClose: () => void }) {
  const { t } = useT();
  const repo = useRepo();
  const ix = repo.index();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const types = [...ix.types.values()].sort((a, b) => a.schema!.name.localeCompare(b.schema!.name)).filter((x) => !q.trim() || x.schema!.name.toLowerCase().includes(q.trim().toLowerCase()));
  const exact = types.some((x) => x.schema!.name.toLowerCase() === q.trim().toLowerCase());
  const rows: { id?: string; create?: string }[] = [...types.map((x) => ({ id: x.id })), ...(q.trim() && !exact ? [{ create: q.trim() }] : [{ create: "" }])];
  const pick = (r?: (typeof rows)[number]) => {
    if (!r) return;
    if (r.id) return onPick(r.id);
    const name = r.create?.trim() || prompt(t("types.new"))?.trim();
    if (name) onPick(createType(name, repo));
  };
  return (
    <Dialog title={t("triage.chooseType")} onClose={onClose}>
      <input
        autoFocus
        value={q}
        onChange={(e) => (setQ(e.target.value), setSel(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(rows.length - 1, s + 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
          else if (e.key === "Enter") (e.preventDefault(), pick(rows[sel]));
          else if (!q && /^[1-9]$/.test(e.key) && rows[Number(e.key) - 1]?.id) (e.preventDefault(), pick(rows[Number(e.key) - 1]));
        }}
        placeholder={t("triage.typeFilter")}
        className="mb-2 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-[var(--focus)]"
      />
      <div role="listbox" className="flex flex-col">
        {rows.map((r, n) => {
          const x = r.id ? ix.types.get(r.id) : undefined;
          return (
            <button
              key={r.id ?? "new"}
              role="option"
              aria-selected={n === sel}
              onMouseEnter={() => setSel(n)}
              onClick={() => pick(r)}
              className={cx("flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", n === sel && "bg-selected", !r.id && "mt-1 border-t border-line pt-2")}
            >
              {x ? <TypeGlyph schema={x.schema} size={15} /> : <Plus size={15} className="text-muted" />}
              <span className="min-w-0 flex-1 truncate">{x ? x.schema!.name : r.create ? t("triage.newTypeNamed", { name: r.create }) : t("triage.newType")}</span>
              {x && r.id === current && <Check size={14} className="text-ok" />}
              {x && n < 9 && !q && <Kbd>{n + 1}</Kbd>}
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}

