// The table of a view, like Notion: grouped (each group with its chip, count, fold, "…" and
// "+"), cells edited in place, progress as "60 %" with a bar, sub-items indented below their
// parent and folded until opened. Columns keep their width and order per view.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, CornerDownRight, MoreHorizontal, Plus } from "lucide-react";
import { type ViewTab, type Item, type ItemInit, type PropDef, type StatusGroup, titleKey, todayISO } from "@obtion/core/model";
import { type EvalCtx, type Group, type QueryDef, FIELDS, fieldOf, groupId, groupItems, pathBase, typesIn } from "@obtion/core/query";
import { fmtDate, fmtShortDate } from "@obtion/core/i18n";
import { dueOf, firstOfGroup, statusOf, statusProp } from "@obtion/core/traits";
import { repo } from "../repo";
import { itemHref, useIndex, useMediaQuery } from "../hooks";
import { useT } from "../i18n";
import { DateField, InlineText, ItemIcon, MenuItem, Popover, StatusGlyph, StatusPill, cx, pal } from "./bits";
import { PropertyField } from "./Properties";
import { CellValue, defaultColumns } from "./Results";
import { RowStatus, pathLabel, setStatus, shortPath, treeOrder } from "./Row";

/** What a view adds to the query when showing it: its tab (grouping options, widths) and how to save. */
export interface Look {
  key: string; // per-device state: folded groups, opened sub-items
  tab?: ViewTab;
  onLook?: (patch: Partial<ViewTab>) => void;
  /** "+ Task" in each group: new entries of this type (with the group's value). */
  add?: { type: string; init?: ItemInit };
}

// ---------- per-device memory ----------

function useStoredSet(key: string): [Set<string>, (id: string, on: boolean) => void, (ids: string[]) => void] {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const save = (next: Set<string>) => (localStorage.setItem(key, JSON.stringify([...next])), setSet(next));
  return [set, (id, on) => save(new Set(on ? [...set, id] : [...set].filter((x) => x !== id))), (ids) => save(new Set(ids))];
}

// ---------- column widths ----------

const WIDTH: Record<string, number> = { status: 150, select: 130, multiselect: 170, date: 130, range: 230, computed: 160, relation: 190, text: 220, number: 100, checkbox: 80, url: 180, item: 170, tags: 170 };

function defaultWidth(col: string, items: Item[], ctx: EvalCtx): number {
  if (col === "title") return 300;
  if (col === "area") return 130;
  if (col === "project") return 190;
  if (col === "tags") return WIDTH.tags!;
  if ((FIELDS as readonly string[]).includes(col)) return 120;
  for (const i of items.slice(0, 30)) {
    const hit = fieldOf(i, col, ctx.ix);
    if (hit?.prop) return hit.prop.kind === "date" && hit.prop.range ? WIDTH.range! : (WIDTH[hit.prop.kind] ?? 160);
    if (hit) return WIDTH[hit.kind] ?? 160;
  }
  return 160;
}

// ---------- chips ----------

/** "Bereich": the top place as a chip, coloured by its place in the sidebar. */
const AREA_COLORS = ["blue", "green", "violet", "amber", "teal", "pink", "indigo", "brown", "olive", "red"];
export function AreaChip({ id }: { id: string }) {
  const ix = useIndex();
  const item = ix.get(id);
  if (!item) return null;
  const pinned = ix.live.filter((i) => i.pinned).sort((a, b) => (a.pinned! < b.pinned! ? -1 : 1));
  const c = pal(AREA_COLORS[Math.max(0, pinned.findIndex((p) => p.id === id)) % AREA_COLORS.length]);
  return (
    <a href={itemHref(id)} className="inline-flex max-w-full items-center truncate whitespace-nowrap rounded-full px-2 py-px text-xs font-medium hover:underline" style={{ color: `color-mix(in srgb, ${c} 62%, var(--text))`, background: `color-mix(in srgb, ${c} 13%, transparent)` }}>
      {item.title}
    </a>
  );
}

/** Progress as "60 %" with a bar – in the app language. */
export function PercentBar({ done, total }: { done: number; total: number }) {
  const { t, lang } = useT();
  if (!total) return <span className="text-faint">–</span>;
  const share = done / total;
  return (
    <span className="flex w-full items-center gap-2" title={t("progress.title", { done, total })}>
      <span className="w-11 shrink-0 text-right text-xs tabular-nums text-muted">{new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 }).format(share)}</span>
      <span className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={t("progress.label")}>
        <span className="block h-full rounded-full" style={{ width: `${share * 100}%`, background: "var(--ok)" }} />
      </span>
    </span>
  );
}

/** The chip a group starts with: its status or option in colour, the entry it stands for, or "Ohne …". */
export function GroupChip({ g, by, byLabel }: { g: Group; by: string; byLabel: string }) {
  const { t } = useT();
  const ix = useIndex();
  if (by === "statusGroup" && g.key) return <StatusPill option={{ id: g.key, name: t("group." + g.key), group: g.key as StatusGroup, color: undefined }} />;
  if (g.option) return <StatusPill option={g.option} group={by === "status" ? (g.statusGroup as StatusGroup) : undefined} />;
  if (g.ref && by === "area") return <AreaChip id={g.ref} />;
  if (g.ref) {
    const x = ix.get(g.ref);
    return x ? (
      <a href={itemHref(x.id)} className="flex min-w-0 items-center gap-1.5 text-sm font-medium hover:underline">
        <ItemIcon item={x} size={14} className="shrink-0" />
        <span className="truncate">{x.title || t("untitled")}</span>
      </a>
    ) : null;
  }
  if (by === "path") return <span className="truncate text-sm font-medium">{g.path?.length ? pathLabel(g.path) : t("group.thisLevel")}</span>;
  if (!g.key) return <span className="text-sm text-muted">{t("group.without", { name: byLabel })}</span>;
  return <span className="truncate text-sm font-medium">{g.label || g.key}</span>;
}

/** Every group a view can have (with the empty options), for choosing which to show. */
export function viewGroups(items: Item[], def: QueryDef, ctx: EvalCtx): Group[] {
  if (!def.group) return [];
  const typeIds = [...new Set([...typesIn(def.where), ...items.slice(0, 200).map((i) => i.type ?? "")])].filter((id) => ctx.ix.types.has(id));
  return groupItems(items, def.group, ctx, pathBase(def, ctx), { types: typeIds, where: def.where });
}

/** Split a view's groups into the shown ones and the ones hidden by hand. */
export function splitHidden(groups: Group[], tab?: ViewTab): [Group[], Group[]] {
  const hidden = new Set(tab?.hiddenGroups ?? []);
  return [groups.filter((g) => !hidden.has(groupId(g))), groups.filter((g) => hidden.has(groupId(g)))];
}

/** Hide a group in a view, or show it again. */
export function hiddenPatch(tab: ViewTab | undefined, g: Group, hide: boolean): Partial<ViewTab> {
  const ids = (tab?.hiddenGroups ?? []).filter((x) => x !== groupId(g));
  return { hiddenGroups: hide ? [...ids, groupId(g)] : ids };
}

/** Below the last group: "3 ausgeblendete Gruppen" – a click shows them, each can come back. */
export function HiddenGroups({ groups, by, byLabel, onShow }: { groups: Group[]; by: string; byLabel: string; onShow?: (g: Group) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  if (!groups.length) return null;
  return (
    <div className="sticky left-0 w-fit px-2 py-1 text-sm">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="tap-y flex items-center gap-1.5 text-muted hover:text-fg">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {t("view.hiddenGroups", { count: groups.length })}
      </button>
      {open && (
        <ul className="mt-1 space-y-1 pl-5">
          {groups.map((g) => (
            <li key={g.key || "_"} className="flex items-center gap-2">
              <GroupChip g={g} by={by} byLabel={byLabel} />
              <span className="text-xs tabular-nums text-muted">{g.items.length}</span>
              {onShow && (
                <button onClick={() => onShow(g)} className="tap rounded px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg">
                  {t("view.showGroup")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- cells ----------

/** A status or select value: its chip; a click opens the choice right there. */
function OptionCell({ item, prop }: { item: Item; prop: PropDef }) {
  const { t } = useT();
  const v = item.props[prop.id];
  const opt = prop.options?.find((o) => o.id === v);
  const isStatus = prop.kind === "status";
  return (
    <label className="tap-row relative flex min-h-6 w-full cursor-pointer items-center">
      {opt ? <StatusPill option={opt} /> : <span className="text-muted">{t("props.empty")}</span>}
      <select
        value={String(v ?? "")}
        onChange={(e) => (isStatus && e.target.value ? void setStatus(item, e.target.value) : repo.setProp(item.id, prop.id, e.target.value || null))}
        aria-label={prop.name}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {!isStatus && <option value="">–</option>}
        {isStatus
          ? (["todo", "active", "done"] as const).map((g) => (
              <optgroup key={g} label={t("group." + g)}>
                {prop.options!.filter((o) => (o.group ?? "todo") === g).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </optgroup>
            ))
          : prop.options?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
      </select>
    </label>
  );
}

/** A start–end date: shown as one line; a click opens both dates. */
function RangeCell({ item, prop }: { item: Item; prop: PropDef }) {
  const { t, lang } = useT();
  const v = typeof item.props[prop.id] === "string" ? (item.props[prop.id] as string) : "";
  const [a = "", b = ""] = v ? v.split("/") : [];
  const put = (x: string, y: string) => repo.setProp(item.id, prop.id, x || y ? `${x}/${y}` : null);
  return (
    <Popover
      trigger={(p) => (
        <button {...p} className="tap-y w-full truncate text-left tabular-nums hover:text-fg" aria-label={t("props.set", { name: prop.name })}>
          {a || b ? `${a ? fmtDate(lang, a) : "…"} – ${b ? fmtDate(lang, b) : "…"}` : <span className="text-muted">{t("props.empty")}</span>}
        </button>
      )}
    >
      <div className="flex flex-wrap items-center gap-1 p-2 text-sm">
        <DateField value={a || undefined} label={t("props.start")} autoFocus={!a} onChange={(x) => put(x, b)} />
        <span className="text-faint">–</span>
        <DateField value={b || undefined} label={t("props.end")} onChange={(x) => put(a, x)} />
      </div>
    </Popover>
  );
}

/** One cell: the value, edited in place where it is a property of the entry's type. */
export function TableCell({ item, col, ctx }: { item: Item; col: string; ctx: EvalCtx }) {
  const { t } = useT();
  const ix = ctx.ix;
  if (col === "area") {
    const a = ix.area(item.id);
    return a ? <AreaChip id={a} /> : <span className="text-faint">–</span>;
  }
  if (col === "progress") {
    const pr = ix.progressOf(item);
    return pr ? <PercentBar done={pr.done} total={pr.total} /> : <span className="text-faint">–</span>;
  }
  const hit = fieldOf(item, col, ix);
  const p = hit?.prop;
  const own = p && !hit.inverse && ix.schemaOf(item)?.properties.some((x) => x.id === p.id);
  if (p?.kind === "computed" && p.computed?.fn !== "count") {
    const pr = ix.progress(item.id, p.computed?.of);
    return <PercentBar done={pr.done} total={pr.total} />;
  }
  if (!own || !p) return <CellValue item={item} name={col} ctx={ctx} />;
  switch (p.kind) {
    case "status":
    case "select":
      return <OptionCell item={item} prop={p} />;
    case "date":
      return p.range ? (
        <RangeCell item={item} prop={p} />
      ) : (
        <span className="cell-tools block">
          <DateField value={typeof item.props[p.id] === "string" ? (item.props[p.id] as string) : undefined} label={p.name} onChange={(x) => repo.setProp(item.id, p.id, x || null)} />
        </span>
      );
    case "text":
    case "url":
      return <InlineText value={String(item.props[p.id] ?? "")} onCommit={(x) => repo.setProp(item.id, p.id, x.trim() || null)} placeholder={t("props.empty")} label={p.name} className="truncate" />;
    default:
      return (
        <span className="cell-tools flex min-w-0 items-center gap-1 overflow-hidden">
          <PropertyField item={item} prop={p} />
        </span>
      );
  }
}

// ---------- the table ----------

export function GroupedTable({ items, def, ctx, look }: { items: Item[]; def: QueryDef; ctx: EvalCtx; look?: Look }) {
  const { t } = useT();
  const ix = ctx.ix;
  const key = look?.key ?? "";
  const tab = look?.tab;
  const cols = def.columns?.length ? def.columns : defaultColumns(items, ctx);
  const typeIds = [...new Set([...typesIn(def.where), ...items.slice(0, 200).map((i) => i.type ?? "")])].filter((id) => ix.types.has(id));
  const by = def.group;
  const all = by ? groupItems(items, by, ctx, pathBase(def, ctx), tab?.hideEmpty ? undefined : { types: typeIds, where: def.where }).filter((g) => !tab?.hideEmpty || g.items.length) : [{ key: "", items } as Group];
  const [groups, hiddenGroups] = by ? splitHidden(all, tab) : [all, []];
  // grouped by place with everything on this level: one table without a heading
  const heads = !!by && !(by === "path" && all.length === 1 && !all[0]!.key);
  const [folded, fold, setFolded] = useStoredSet(`obtion.fold.${key}`);
  const [opened, open] = useStoredSet(`obtion.open.${key}`);
  // widths: saved per view; while dragging a border only here
  const [live, setLive] = useState<Record<string, number>>({});
  const width = (c: string) => live[c] ?? tab?.widths?.[c] ?? defaultWidth(c, items, ctx);
  // on a phone the title column leaves room for the next one; the table scrolls sideways
  const narrow = useMediaQuery("(max-width: 640px)");
  const titleW = narrow ? Math.min(width("title"), 190) : width("title");
  const total = titleW + cols.reduce((s, c) => s + width(c), 0);
  const label = (c: string) => {
    if ((FIELDS as readonly string[]).includes(c)) return t("field." + c);
    if (c === "tags") return t("item.tags");
    for (const i of items) {
      const hit = fieldOf(i, c, ix);
      if (hit?.prop) return hit.prop.name;
      const free = Object.keys(i.extra).find((n) => n.toLowerCase() === c.toLowerCase());
      if (free) return free;
    }
    return c;
  };
  const byLabel = by ? (by === "status" || by === "statusGroup" || by === "type" || by === "path" ? t("group." + by) : label(by)) : "";
  const [dragCol, setDragCol] = useState<string | null>(null);
  const resize = (c: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = width(c);
    let w = w0;
    const move = (ev: PointerEvent) => ((w = Math.max(60, Math.min(800, Math.round(w0 + ev.clientX - x0)))), setLive((l) => ({ ...l, [c]: w })));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (w !== w0) look?.onLook?.({ widths: { ...(tab?.widths ?? {}), [c]: w } });
      setTimeout(() => setLive((l) => (({ [c]: _, ...rest }) => rest)(l)), 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const sticky = "sticky left-0 z-[1] bg-bg";
  const head = (
    <thead>
      <tr className="text-left text-xs text-muted">
        <th className={cx(sticky, "relative border-b border-line px-2 py-1.5 font-medium")}>
          {t("field.title")}
          {look?.onLook && <Resizer onPointerDown={(e) => resize("title", e)} />}
        </th>
        {cols.map((c) => (
          <th
            key={c}
            draggable={!!look?.onLook}
            onDragStart={() => setDragCol(c)}
            onDragEnd={() => setDragCol(null)}
            onDragOver={(e) => dragCol && e.preventDefault()}
            onDrop={() => {
              if (!dragCol || dragCol === c) return;
              const rest = cols.filter((x) => x !== dragCol);
              const at = rest.indexOf(c) + (cols.indexOf(dragCol) < cols.indexOf(c) ? 1 : 0);
              look?.onLook?.({ columns: [...rest.slice(0, at), dragCol, ...rest.slice(at)] });
            }}
            className="relative truncate whitespace-nowrap border-b border-l border-line px-2 py-1.5 font-medium"
          >
            {label(c)}
            {look?.onLook && <Resizer onPointerDown={(e) => resize(c, e)} />}
          </th>
        ))}
      </tr>
    </thead>
  );
  const colgroup = (
    <colgroup>
      <col style={{ width: titleW }} />
      {cols.map((c) => (
        <col key={c} style={{ width: width(c) }} />
      ))}
    </colgroup>
  );
  const rows = (g: Group) => {
    const order = treeOrder(g.items);
    const out: React.ReactNode[] = [];
    let hideBelow = Infinity;
    order.forEach(({ item: i, depth }, n) => {
      if (depth > hideBelow) return;
      hideBelow = Infinity;
      const kids = countKids(order, n);
      const isOpen = opened.has(i.id);
      if (kids && !isOpen) hideBelow = depth;
      out.push(
        <tr key={i.id} data-id={i.id} className="group/row hover:bg-hover">
          <td className={cx(sticky, "border-b border-line px-2 py-1 align-middle group-hover/row:bg-hover")}>
            <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: depth * 20 }}>
              {kids ? (
                <button onClick={() => open(i.id, !isOpen)} aria-expanded={isOpen} aria-label={t(isOpen ? "table.closeSub" : "table.openSub", { count: kids })} className="tap -ml-1 shrink-0 rounded p-0.5 text-muted hover:bg-surface-2 hover:text-fg">
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : (
                depth > 0 && <span className="w-4 shrink-0" />
              )}
              <a href={itemHref(i.id)} className="flex min-w-0 items-center gap-2 hover:underline">
                <ItemIcon item={i} size={14} className="shrink-0" />
                <span className="truncate font-medium">{i.title || t("untitled")}</span>
              </a>
              {kids > 0 && !isOpen && <span className="shrink-0 text-xs tabular-nums text-muted">{kids}</span>}
            </span>
          </td>
          {cols.map((c) => (
            <td key={c} className="overflow-hidden border-b border-l border-line px-2 py-1 align-middle text-muted">
              <TableCell item={i} col={c} ctx={ctx} />
            </td>
          ))}
        </tr>,
      );
    });
    return out;
  };
  const addInit = (g: Group): ItemInit | undefined => {
    if (!look?.add) return undefined;
    const schema = ix.types.get(look.add.type)?.schema;
    const init: ItemInit = { ...look.add.init, type: look.add.type, props: { ...(look.add.init?.props ?? {}) } };
    if (!by || !g.key) return init;
    if (by === "status" && g.option) init.props![statusProp(schema)?.id ?? ""] = g.option.id;
    else if (by === "statusGroup") {
      const o = firstOfGroup(schema, g.key as StatusGroup);
      if (o) init.props![statusProp(schema)!.id] = o.id;
    } else if (by === "type") init.type = g.key;
    else if (by === "path" && g.path?.length) init.parents = [g.path.at(-1)!];
    else if (g.option) {
      const p = schema?.properties.find((x) => titleKey(x.name) === titleKey(by));
      if (p) init.props![p.id] = p.kind === "multiselect" ? [g.option.id] : g.option.id;
    } else if (g.ref && (by === "project" || by === "area")) init.parents = [g.ref];
    else if (g.ref) {
      const p = schema?.properties.find((x) => titleKey(x.name) === titleKey(by) && x.kind === "relation");
      if (p) init.rels = { [p.id]: [g.ref] };
    }
    return init;
  };
  const allKeys = groups.map((g) => g.key);
  return (
    <div className="-mx-2 overflow-x-auto pb-2 text-sm">
      {groups.map((g) => {
        const isFolded = heads ? folded.has(g.key) : false;
        const init = addInit(g);
        return (
          <section key={g.key || "_"} className={heads ? "mb-5" : undefined} aria-label={heads ? g.label || g.key || byLabel : undefined}>
            {heads && (
              <div className="group/head sticky left-0 flex w-fit max-w-full items-center gap-2 px-2 py-1.5">
                <button onClick={() => fold(g.key, !isFolded)} aria-expanded={!isFolded} aria-label={t(isFolded ? "table.unfold" : "table.fold")} className="tap -ml-1 rounded p-0.5 text-muted hover:bg-hover hover:text-fg">
                  {isFolded ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                </button>
                <GroupChip g={g} by={by} byLabel={byLabel} />
                <span className="text-xs tabular-nums text-muted">{g.items.length}</span>
                <span className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/head:opacity-100 pointer-coarse:opacity-100">
                  <Popover
                    trigger={(p) => (
                      <button {...p} className="tap rounded p-0.5 text-muted hover:bg-hover hover:text-fg" aria-label={t("table.groupMenu")}>
                        <MoreHorizontal size={15} />
                      </button>
                    )}
                  >
                    {(close) => (
                      <>
                        {look?.onLook && <MenuItem onClick={() => (close(), look.onLook!(hiddenPatch(tab, g, true)))}>{t("view.hideGroup")}</MenuItem>}
                        <MenuItem onClick={() => (close(), setFolded(allKeys.filter((k) => k !== g.key)))}>{t("table.foldOthers")}</MenuItem>
                        <MenuItem onClick={() => (close(), setFolded([]))}>{t("table.unfoldAll")}</MenuItem>
                        {look?.onLook && (
                          <MenuItem active={!!tab?.hideEmpty} onClick={() => (close(), look.onLook!({ hideEmpty: !tab?.hideEmpty || undefined }))}>
                            {t("view.hideEmpty")}
                          </MenuItem>
                        )}
                      </>
                    )}
                  </Popover>
                  {init && <NewRowButton init={init} label={t("table.addIn", { name: ix.typeName(init.type ?? null) ?? "" })} compact />}
                </span>
              </div>
            )}
            {!isFolded && (
              <table className="table-fixed border-collapse" style={{ width: total }}>
                {colgroup}
                {head}
                <tbody>{rows(g)}</tbody>
              </table>
            )}
            {!isFolded && init && (
              <div className="sticky left-0 w-fit">
                <NewRowButton init={init} label={t("table.addIn", { name: ix.typeName(init.type ?? null) ?? "" })} />
              </div>
            )}
          </section>
        );
      })}
      {by && <HiddenGroups groups={hiddenGroups} by={by} byLabel={byLabel} onShow={look?.onLook ? (g) => look.onLook!(hiddenPatch(tab, g, false)) : undefined} />}
    </div>
  );
}

function Resizer({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  return <span onPointerDown={onPointerDown} onDragStart={(e) => e.preventDefault()} className="absolute -right-1 top-0 z-[2] h-full w-2 cursor-col-resize touch-none hover:bg-[var(--focus)]/40" aria-hidden />;
}

/** Number of sub-items right after row n (deeper rows until one at the same depth or above). */
function countKids(order: { depth: number }[], n: number): number {
  const d = order[n]!.depth;
  let k = 0;
  for (let m = n + 1; m < order.length && order[m]!.depth > d; m++) if (order[m]!.depth === d + 1) k++;
  return k;
}

/**
 * "+ Task" at the end of a group (and in its head): typing a title and Enter creates the entry
 * with the group's value – nothing is created before there is a title.
 */
function NewRowButton({ init, label, compact }: { init: ItemInit; label: string; compact?: boolean }) {
  const { t } = useT();
  const ix = useIndex();
  const aria = t("view.new", { name: ix.typeName(init.type ?? null) ?? "" });
  const [typing, setTyping] = useState(false);
  const [title, setTitle] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => void (typing && ref.current?.focus()), [typing]);
  const create = () => {
    const v = title.trim();
    if (v) repo.create({ ...init, title: v });
    setTitle("");
    return !!v;
  };
  if (typing)
    return (
      <input
        ref={ref}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => (create(), setTyping(false))}
        onKeyDown={(e) => {
          if (e.key === "Enter") create(); // and the next one
          if (e.key === "Escape") (setTitle(""), setTyping(false));
        }}
        placeholder={t("table.newTitle")}
        aria-label={aria}
        className={cx("field rounded-md border border-line bg-bg px-2 py-1 text-sm outline-none", compact ? "w-48" : "ml-2 mt-1 w-72")}
      />
    );
  return compact ? (
    <button onClick={() => setTyping(true)} className="tap rounded p-0.5 text-muted hover:bg-hover hover:text-fg" aria-label={aria} title={aria}>
      <Plus size={15} />
    </button>
  ) : (
    <button onClick={() => setTyping(true)} aria-label={aria} className="tap-y flex items-center gap-1.5 px-2 py-1.5 text-sm text-muted hover:text-fg">
      <Plus size={14} /> {label}
    </button>
  );
}

// ---------- the list table of a page (design rules § 2.4) ----------

/** A group of a page's list: "Direkt in Relaunch", a sub-project (`ref`, with its status and progress), a status … */
export interface PageGroup {
  key: string;
  label: React.ReactNode;
  ref?: string;
  items: Item[]; // in order; sub-items follow their parent
}

/**
 * The main list of a page as one table in a card: one head row, a row per group (chevron, status
 * of the entry it stands for, name, small bar with percent, "n offen"), rows 40 high with the
 * status shape, the title and small hints (sub-tasks "1/2", where it sits below, "blockiert"),
 * values on the right. Sub-items are indented below their parent. The foot adds an entry and
 * shows the done ones. On a phone the same groups as a list.
 */
export function PageTable({
  groups,
  cols,
  head,
  here,
  foldKey,
  add,
  done,
}: {
  groups: PageGroup[];
  cols: { key: string; label: string }[];
  head: string; // name of the first column ("Task", "Unteraufgabe")
  here: string; // the page: locations are shown relative to it
  foldKey: string;
  add?: { init: ItemInit; label: string };
  done?: { count: number; shown: boolean; toggle: () => void };
}) {
  const { t, lang } = useT();
  const ix = useIndex();
  const narrow = useMediaQuery("(max-width: 767px)");
  const [folded, fold] = useStoredSet(`obtion.fold.${foldKey}`);
  const grouped = groups.length > 1 || !!groups[0]?.ref;
  const openCount = (items: Item[]) => items.filter((i) => statusOf(i, ix.schemaOf(i))?.group !== "done").length;
  const hints = (i: Item, g: PageGroup) => {
    const pr = ix.progressOf(i);
    const rel = (ix.relPath(here, i.id) ?? []).filter((p) => p !== g.ref && !g.items.some((x) => x.id === p));
    const st = statusOf(i, ix.schemaOf(i));
    const blocked = !!st && st.group !== "done" && ix.isBlocked(i);
    return (
      <>
        {pr && pr.total > 0 && <span className="shrink-0 text-xs tabular-nums text-muted">{`${pr.done}/${pr.total}`}</span>}
        {blocked && <span className="shrink-0 text-xs text-warn">{t("row.blocked")}</span>}
        {rel.length > 0 && <span className="min-w-0 truncate text-xs text-muted">{shortPath(rel)}</span>}
      </>
    );
  };
  const value = (i: Item, key: string) => {
    if (key === "due") {
      const d = dueOf(i, ix.schemaOf(i));
      const today = todayISO();
      const st = statusOf(i, ix.schemaOf(i));
      if (!d) return <span className="text-faint">–</span>;
      return <span className={cx("tabular-nums", st?.group !== "done" && d < today ? "text-danger" : d === today ? "text-warn" : "text-fg")}>{d === today ? t("time.today") : fmtShortDate(lang, d)}</span>;
    }
    const hit = fieldOf(i, key, ix);
    if (hit?.prop?.options && typeof hit.value === "string") {
      const o = hit.prop.options.find((x) => x.id === hit.value);
      return o ? <StatusPill option={o} small /> : <span className="text-faint">–</span>;
    }
    return <CellValue item={i} name={key} ctx={{ ix }} />;
  };
  const groupHead = (g: PageGroup, isFolded: boolean) => {
    const ref = g.ref ? ix.get(g.ref) : undefined;
    const st = ref ? statusOf(ref, ix.schemaOf(ref)) : undefined;
    const pr = ref ? ix.progressOf(ref) : undefined;
    return (
      <button onClick={() => fold(g.key, !isFolded)} aria-expanded={!isFolded} className="flex w-full min-w-0 items-center gap-2 text-left text-[13px]">
        <ChevronRight size={13} className={cx("shrink-0 text-faint transition-transform", !isFolded && "rotate-90")} aria-hidden />
        {st && <span className="shrink-0" style={{ color: st.group === "done" ? "var(--ok)" : st.option.color && st.option.color !== "gray" ? pal(st.option.color) : "var(--muted)" }}><StatusGlyph option={st.option} size={14} /></span>}
        <span className="truncate font-semibold">{g.label}</span>
        {pr && pr.total > 0 && (
          <>
            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface-2 dark:bg-hover max-md:w-12" aria-hidden>
              <span className="block h-full rounded-full" style={{ width: `${(pr.done / pr.total) * 100}%`, background: "var(--ok)" }} />
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted">{new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 }).format(pr.done / pr.total)}</span>
          </>
        )}
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted md:ml-0">{t("children.openCount", { count: openCount(g.items) })}</span>
      </button>
    );
  };
  const sub = "bg-[color-mix(in_srgb,var(--surface-2)_45%,var(--surface))]";
  const foot = (add || (done && done.count > 0)) && (
    <div className="flex min-h-10 items-center gap-3 border-t border-line px-3 text-[13px] text-muted">
      {add && <NewRowButton init={add.init} label={add.label} />}
      {done && done.count > 0 && (
        <button onClick={done.toggle} className="tap-y ml-auto whitespace-nowrap hover:text-fg">
          {done.shown ? t("children.doneHide") : narrow ? t("children.doneShort", { count: done.count }) : t("children.doneShow", { count: done.count })}
        </button>
      )}
    </div>
  );
  if (narrow)
    return (
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {groups.map((g, gi) => {
          const isFolded = grouped && folded.has(g.key);
          return (
            <div key={g.key}>
              {grouped && <div className={cx("flex h-9 items-center px-3", sub, gi > 0 && "border-t border-line")}>{groupHead(g, isFolded)}</div>}
              {!isFolded &&
                treeOrder(g.items).map(({ item: i, depth }) => (
                  <div key={i.id} data-id={i.id} className="flex min-h-[52px] items-center gap-2.5 border-t border-line px-3 py-1.5 first:border-t-0" style={{ paddingLeft: 12 + depth * 22 }}>
                    <RowStatus item={i} size={16} />
                    <a href={itemHref(i.id)} className="flex min-w-0 flex-1 flex-col">
                      <span className="line-clamp-2 text-[15px]">{i.title || t("untitled")}</span>
                      <span className="flex min-w-0 items-center gap-2">{hints(i, g)}</span>
                    </a>
                    {cols[0] && <span className="shrink-0 text-xs">{value(i, cols[0].key)}</span>}
                  </div>
                ))}
            </div>
          );
        })}
        {foot}
      </div>
    );
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className={cx("h-8 text-left text-xs text-muted", sub)}>
            <th className="px-3 font-medium">{head}</th>
            {cols.map((c) => (
              <th key={c.key} className="w-[1%] whitespace-nowrap px-3 font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((g) => {
          const isFolded = grouped && folded.has(g.key);
          return (
            <tbody key={g.key}>
              {grouped && (
                <tr className={cx("h-10 border-t border-line", sub)}>
                  <td colSpan={cols.length + 1} className="px-3">
                    {groupHead(g, isFolded)}
                  </td>
                </tr>
              )}
              {!isFolded &&
                treeOrder(g.items).map(({ item: i, depth }) => (
                  <tr key={i.id} data-id={i.id} className="h-10 border-t border-line hover:bg-hover">
                    <td className="max-w-0 px-3">
                      <span className="flex min-w-0 items-center gap-2.5" style={{ paddingLeft: depth * 26 }}>
                        {depth > 0 && <CornerDownRight size={13} className="-mr-1 shrink-0 text-faint" aria-hidden />}
                        <RowStatus item={i} size={16} />
                        <a href={itemHref(i.id)} className="min-w-0 truncate hover:underline">
                          {i.title || t("untitled")}
                        </a>
                        {hints(i, g)}
                      </span>
                    </td>
                    {cols.map((c) => (
                      <td key={c.key} className="w-[1%] whitespace-nowrap px-3">
                        {value(i, c.key)}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          );
        })}
      </table>
      {foot}
    </div>
  );
}
