// "Sortieren" (design rules § 5): go through entries and decide – place, give a type, delete.
// Works for any list or query block; the inbox is just one. An entry leaves the list as
// soon as it no longer matches the query. The actions live in TriageActions.tsx.
//
// Desktop: one card, the list on the left (one line per entry, nothing grows or appears on
// hover), the selected entry in full on the right with a fixed action bar. Several can be
// marked (box, Space, Shift+j/k); then a bar of the same height acts on all of them.
// Phone: the list; tapping opens the entry. (The inbox has its own ways: the tray's panel to look
// in, the review to sort – views/Review.tsx.)
import { Checkbox } from "../components/ui/checkbox";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, FolderInput, Shapes, Sparkles, Trash2, Check, X } from "lucide-react";
import { type Item, setMeta } from "@obtion/core/model";
import type { Index } from "@obtion/core/graph";
import { useIndex, useRepo, useSpaceId, useItemHref, spaceHref, useDesktop, openItem, isTypingTarget, useWindowKeys } from "../hooks";
import { useT, titleOf } from "../i18n";
import { recentPlaces } from "../actions";
import { Card, Button, Kbd } from "./primitives";
import { ItemIcon, RelTime, Tag, TypeGlyph, BelowList } from "./item-look";
import { cn, toggled } from "../lib/utils";
import { TagInput } from "./TagInput";
import { placeSuggestions } from "./suggest";
import { Markdown } from "./Markdown";
import { NOTE_ICON } from "./icons";
import { plainText } from "@obtion/core/search";
import { DAY_MS } from "@obtion/core/date";
import { usePickers, useTriageActions } from "./TriageActions";
import type { T } from "@obtion/core/i18n";
import { filePreview } from "./text";

/** Age groups: this week, this month, older. */
function ageGroup(created: number, now = Date.now()): "week" | "month" | "older" {
  const days = (now - created) / DAY_MS;
  return days <= 7 ? "week" : days <= 30 ? "month" : "older";
}

/** The quiet hint of a row: the agent's suggestion, a mentioned place, or the notes bundled below. */
function rowHint(item: Item, ix: Index, t: T): { icon: React.ReactNode; text: string } | null {
  const sug = item.suggestion;
  if (sug) {
    const what = [sug.type ? ix.typeName(sug.type) : null, ...(sug.parents ?? []).map((p) => ix.get(p)?.title)].filter(Boolean).join(" · ");
    if (what) return { icon: <Sparkles size={12} />, text: what };
  }
  const mentioned = ix.items(ix.mentions(item)).find((x) => x.kind === "info");
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
      <Checkbox checked={on} onCheckedChange={onToggle} aria-label={t("triage.markNamed", { title })} className="size-4 cursor-pointer pointer-coarse:size-[18px]" />
    </label>
  );
}

/** The keys go to one list only (a page may show several): the one used last, else the first. */
let keyOwner: symbol | null = null;

export function Triage({ items }: { items: Item[] }) {
  const { t } = useT();
  const here = useSpaceId()!;
  const ix = useIndex();
  const spaceOf = (_: Item) => here;
  const keyOf = (i: Item) => i.id;
  const phone = !useDesktop();
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
    setMarked((m) => (on === undefined || on !== m.has(id) ? toggled(m, id) : m));
  const trash = (l: Item[]) => void act.trash(l).then((ok) => ok && setMarked(new Set()));

  useWindowKeys((e) => {
    if (keyOwner !== me || pick.placing || pick.typing || isTypingTarget(e.target as Element) || e.metaKey || e.ctrlKey || e.altKey) return;
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
    else if ((k === "Enter" || k === "o") && cur) openItem(cur.id, { space: spaceOf(cur) });
    else return;
    e.preventDefault();
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
        const hint = rowHint(i, ix, t);
        const on = n === sel && !phone;
        return (
          <div key={keyOf(i)}>
            {head && (
              <p className="px-3 pb-1 pt-3 text-xs font-semibold text-muted-foreground lg:pl-11">
                {t("triage.age." + g)} <span className="font-normal tabular-nums">{count}</span>
              </p>
            )}
            <div
              data-triage={n}
              role="option"
              aria-selected={on}
              onClick={() => (phone ? openItem(i.id, { space: here }) : setSel(n))}
              className={cn(
                "relative grid cursor-default items-center gap-x-2 px-3 hover:bg-hover",
                phone ? "min-h-12 grid-cols-[44px_minmax(0,1fr)_auto] py-1.5" : "h-10 grid-cols-[24px_minmax(0,1fr)_auto_minmax(64px,auto)]",
                on && "bg-selected before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r before:bg-focus",
              )}
            >
              <MarkBox on={marked.has(keyOf(i))} onToggle={() => toggle(keyOf(i))} title={titleOf(i, t)} />
              {phone ? (
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[15px]">{titleOf(i, t)}</span>
                  {hint && (
                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      <span className="shrink-0">{hint.icon}</span>
                      <span className="truncate">{hint.text}</span>
                    </span>
                  )}
                </span>
              ) : (
                <>
                  <span className="truncate text-sm">{titleOf(i, t)}</span>
                  <span className="flex max-w-[104px] items-center gap-1 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
                    {hint && (
                      <>
                        <span className="shrink-0">{hint.icon}</span>
                        <span className="truncate">{hint.text}</span>
                      </>
                    )}
                  </span>
                </>
              )}
              <span className="whitespace-nowrap text-right text-xs text-muted-foreground">
                <RelTime ts={i.created} />
              </span>
            </div>
          </div>
        );
      })}
      {items.length > limit && (
        <Button variant="plain" onClick={() => setLimit(limit + 60)} className="w-full py-3 text-sm text-muted-foreground hover:text-fg">
          {t("query.more", { count: items.length - limit })}
        </Button>
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
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 text-[13px] text-muted-foreground">
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
      <Card onPointerDownCapture={claim} className="overflow-hidden">
        {many && bar}
        {rows}
        {pick.node}
      </Card>
    );
  return (
    <Card onPointerDownCapture={claim} onFocusCapture={claim} className="grid h-[calc(100dvh-170px)] min-h-[520px] grid-cols-[380px_minmax(0,1fr)] overflow-hidden">
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
                  <ItemIcon item={i} size={14} /> <span className="truncate">{titleOf(i, t)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : current ? (
          <Detail item={current} onPlaced={(p) => act.place([current], p)} />
        ) : null}
        <ActionBar
          onPlace={() => pick.setPlacing(targets())}
          onType={() => pick.setTyping(targets().filter((i) => i.kind === "info"))}
          toType={!many && current?.kind === "info" && act.firstType(current) && act.firstType(current) !== current.type ? act.firstType(current) : undefined}
          onToType={(type) => act.giveType(targets(), type)}
          onTrash={() => trash(targets())}
        />
      </div>
      {pick.node}
    </Card>
  );
}

/** The selected entry in full: title, when and what it mentions, the text, then what helps to decide. */
function Detail({ item, onPlaced }: { item: Item; onPlaced: (p: string) => void }) {
  const { t } = useT();
  const repo = useRepo();
  const hrefOf = useItemHref();
  const ix = repo.index();
  const mentioned = ix.items(new Set(ix.mentions(item))).filter((x) => x.kind === "info");
  const kids = ix.items(ix.childrenOf(item.id));
  const sug = item.suggestion;
  const places = useMemo(() => {
    const s = placeSuggestions(item, repo).slice(0, 4).map((x) => ({ id: x.id, why: t("triage.why." + x.reason) }));
    for (const id of recentPlaces(repo)) if (s.length < 4 && !s.some((x) => x.id === id) && id !== item.id && !item.parents[id] && !ix.wouldCycle(item.id, id)) s.push({ id, why: t("triage.why.recent") });
    return s;
  }, [item, repo, ix, t]);
  const applySuggestion = () => {
    if (!sug) return;
    if (sug.type && ix.types.has(sug.type)) repo.setType(item.id, sug.type);
    for (const [k, v] of Object.entries(sug.props ?? {})) repo.setProp(item.id, k, v);
    for (const p of sug.parents ?? []) if (ix.get(p)) onPlaced(p);
    repo.change(item.id, (doc) => setMeta(doc, { suggestion: null }));
  };
  const section = "mt-5";
  const k = "mb-1.5 text-xs font-semibold text-muted-foreground";
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
      <a href={hrefOf(item.id)} className="block text-xl font-semibold leading-[26px] hover:underline">
        {titleOf(item, t)}
      </a>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("triage.captured")} <RelTime ts={item.created} />
        {mentioned.length > 0 && <> · {t("triage.mentions", { list: mentioned.map((m) => m.title).join(", ") })}</>}
      </p>
      {item.body.trim() ? (
        <div className="mt-4 max-w-[64ch] text-[15px] leading-[1.65]">
          <Markdown src={item.body} />
        </div>
      ) : item.file?.text ? (
        <p className="mt-4 max-w-[64ch] text-[15px] leading-[1.65] text-muted-foreground">{filePreview(item.file.text)}</p>
      ) : null}
      <BelowList items={kids} className={section} />
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
            <Sparkles size={15} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 basis-48">
              {[sug.type ? ix.typeName(sug.type) : null, ...(sug.parents ?? []).map((p) => ix.get(p)?.title)].filter(Boolean).join(" · ")}
              {sug.note && <span className="text-muted-foreground"> – {sug.note}</span>}
            </span>
            <Button variant="outline" onClick={applySuggestion} className="h-7 shrink-0 px-2 text-[13px]">
              <Check size={13} /> {t("triage.accept")}
            </Button>
            <Button variant="plain" onClick={() => repo.change(item.id, (doc) => setMeta(doc, { suggestion: null }))} className="tap shrink-0 rounded p-1 text-faint hover:bg-hover hover:text-fg" aria-label={t("triage.dismiss")}>
              <X size={14} />
            </Button>
          </div>
        </div>
      )}
      {places.length > 0 && (
        <div className={section}>
          <p className={k}>{t("triage.placeIn")}</p>
          <div className="flex flex-wrap gap-1.5">
            {places.map((p) => (
              <Button variant="plain" key={p.id} onClick={() => onPlaced(p.id)} className="tap-y inline-flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 text-[13px] hover:bg-hover">
                <FolderInput size={13} className="text-muted-foreground" /> {ix.get(p.id)?.title}
                <span className="text-xs text-muted-foreground">{p.why}</span>
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The fixed action bar under the detail: Einordnen (primary), Typ wählen, Zur Karte, Löschen; key hints below. */
function ActionBar({ onPlace, onType, toType, onToType, onTrash }: { onPlace: () => void; onType: () => void; toType?: string; onToType: (t: string) => void; onTrash: () => void }) {
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
      <p className="flex flex-wrap gap-x-3 px-7 pb-3 text-xs text-muted-foreground">
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
    </div>
  );
}
